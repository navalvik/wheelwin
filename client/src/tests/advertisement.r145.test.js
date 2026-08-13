/**
 * R14.5 — Advertisement client slot + page gating + safe fallback tests.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { APP_PAGES } from "../game/sessionRecovery/recoveryFlow.js";
import { SOCKET_MESSAGE_CHANNEL } from "../socket/socketEvents.js";
import {
    ADVERTISEMENT_MESSAGE_CHANNEL,
    ADVERTISEMENT_SOCKET_EVENTS,
    AdvertisementSyncClient,
    BRAND_ONLY_ADVERTISEMENT_PAGES,
    EXTERNAL_ADVERTISEMENT_PAGES,
    WHEELWIN_FALLBACK_BANNER_SRC,
    buildAdvertisementAssetUrl,
    calculateRemainingMsFromSnapshot,
    isBrandOnlyAdvertisementPage,
    isExternalAdvertisementPage,
    resolveAdvertisementRenderModel
} from "../ads/AdvertisementSyncClient.js";
import {
    isSafeAdvertisementDestination,
    isTelegramAdvertisementUrl,
    openAdvertisementDestination
} from "../ads/openAdvertisementDestination.js";

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = join(here, "..", "ads", "advertisement.css");
const css = readFileSync(cssPath, "utf8");

function createFakeSocket() {

    const listeners = new Map();

    return {
        connected: true,
        emitted: [],
        on(event, handler) {

            listeners.set(event, handler);

        },
        off(event, handler) {

            if (listeners.get(event) === handler) {

                listeners.delete(event);

            }

        },
        emit(event, payload) {

            this.emitted.push({ event, payload });

        },
        _push(event, message) {

            const handler = listeners.get(event);

            if (typeof handler === "function") {

                handler(message);

            }

        }
    };

}

{
    const model = resolveAdvertisementRenderModel({
        page: APP_PAGES.WELCOME,
        snapshot: {
            advertisementId: "ad_001",
            filename: "1_banner.gif",
            destinationUrl: "https://example.com",
            startedAt: 1_000,
            duration: 20
        }
    });

    assert.equal(model.mode, "external");
    assert.equal(model.src, "/advertisements/assets/1_banner.gif");
    assert.equal(model.destinationUrl, "/advertisements/click/ad_001");
    assert.equal(model.objectFit, "contain");
    assert.equal(model.advertisementId, "ad_001");
    console.log("  1. Advertisement snapshot renders");

}

{
    const empty = resolveAdvertisementRenderModel({
        page: APP_PAGES.WELCOME,
        snapshot: null
    });

    assert.equal(empty.mode, "fallback");
    assert.equal(empty.src, WHEELWIN_FALLBACK_BANNER_SRC);
    assert.equal(empty.clickable, false);

    const blank = resolveAdvertisementRenderModel({
        page: APP_PAGES.LOBBY,
        snapshot: { advertisementId: null, filename: null }
    });

    assert.equal(blank.mode, "fallback");
    assert.equal(blank.src, WHEELWIN_FALLBACK_BANNER_SRC);
    console.log("  2. No advertisement fallback renders WheelWin banner");

}

{
    const client = new AdvertisementSyncClient();
    const socket = createFakeSocket();

    client.ensureAttached(socket);
    client.applyServerSnapshot({
        advertisementId: "ad_001",
        filename: "1_a.jpg",
        startedAt: 1000,
        duration: 20
    });

    // Client must not invent a "next" advertisement.
    assert.equal(client.getSnapshot()?.advertisementId, "ad_001");
    assert.equal(
        typeof client.selectNext,
        "undefined"
    );
    assert.equal(
        Object.prototype.hasOwnProperty.call(client, "rotate"),
        false
    );

    // Sync request only — no client-side selection emit.
    client.requestSync();
    assert.ok(
        socket.emitted.some(
            (entry) => entry.event
                === ADVERTISEMENT_SOCKET_EVENTS.ADVERTISEMENT_SYNC_REQUEST
        )
    );
    assert.equal(
        socket.emitted.some((entry) => entry.event === SOCKET_MESSAGE_CHANNEL),
        false
    );

    client.detach();
    console.log("  3. Client does not select next advertisement");

}

{
    assert.deepEqual(
        [...EXTERNAL_ADVERTISEMENT_PAGES],
        [APP_PAGES.WELCOME, APP_PAGES.LOBBY, APP_PAGES.RESULT]
    );

    assert.equal(isExternalAdvertisementPage(APP_PAGES.WELCOME), true);
    assert.equal(isExternalAdvertisementPage(APP_PAGES.LOBBY), true);
    assert.equal(isExternalAdvertisementPage(APP_PAGES.RESULT), true);

    const welcome = resolveAdvertisementRenderModel({
        page: APP_PAGES.WELCOME,
        snapshot: {
            advertisementId: "ad_001",
            filename: "1_ok.jpg"
        }
    });

    assert.equal(welcome.mode, "external");
    console.log("  4. External advertisement pages are gated correctly");

}

{
    for (const page of BRAND_ONLY_ADVERTISEMENT_PAGES) {

        assert.equal(isBrandOnlyAdvertisementPage(page), true);
        assert.equal(isExternalAdvertisementPage(page), false);

        const model = resolveAdvertisementRenderModel({
            page,
            snapshot: {
                advertisementId: "ad_001",
                filename: "1_ignored.jpg",
                destinationUrl: "https://example.com"
            }
        });

        assert.equal(model.mode, "fallback");
        assert.equal(model.src, WHEELWIN_FALLBACK_BANNER_SRC);
    }

    assert.equal(
        resolveAdvertisementRenderModel({
            page: APP_PAGES.PAYMENT,
            snapshot: { advertisementId: "ad_001", filename: "1_x.jpg" }
        }).mode,
        "fallback"
    );
    assert.equal(
        resolveAdvertisementRenderModel({
            page: APP_PAGES.GAMEPLAY,
            snapshot: { advertisementId: "ad_001", filename: "1_x.jpg" }
        }).mode,
        "fallback"
    );
    console.log("  5. Payment/Game pages keep WheelWin banner");

}

{
    assert.match(css, /object-fit:\s*contain/);
    assert.equal(
        resolveAdvertisementRenderModel({
            page: APP_PAGES.RESULT,
            snapshot: { advertisementId: "ad_002", filename: "2_p.png" }
        }).objectFit,
        "contain"
    );
    console.log("  6. Image rendering uses contain behavior");

}

{
    assert.doesNotThrow(() => {

        resolveAdvertisementRenderModel({});
        resolveAdvertisementRenderModel({ page: null, snapshot: undefined });
        resolveAdvertisementRenderModel({
            page: APP_PAGES.WELCOME,
            snapshot: { advertisementId: "ad_001", filename: "../x.jpg" },
            imageFailed: true
        });
        buildAdvertisementAssetUrl("../etc/passwd.jpg");
        calculateRemainingMsFromSnapshot(null);
        calculateRemainingMsFromSnapshot({ startedAt: "bad", duration: "x" });
    });

    assert.equal(buildAdvertisementAssetUrl("../x.jpg"), null);

    const failed = resolveAdvertisementRenderModel({
        page: APP_PAGES.WELCOME,
        snapshot: { advertisementId: "ad_001", filename: "1_missing.jpg" },
        imageFailed: true
    });

    assert.equal(failed.mode, "fallback");

    const client = new AdvertisementSyncClient();

    assert.doesNotThrow(() => {

        client._handleMessage(null);
        client._handleMessage({ type: "PHYSICS_UPDATE", payload: {} });
        client._handleMessage({
            type: "ADVERTISEMENT_CHANGED",
            payload: null
        });

    });

    assert.equal(ADVERTISEMENT_MESSAGE_CHANNEL, "advertisement:message");
    assert.notEqual(ADVERTISEMENT_MESSAGE_CHANNEL, SOCKET_MESSAGE_CHANNEL);

    assert.equal(isTelegramAdvertisementUrl("https://t.me/example"), true);
    assert.equal(isSafeAdvertisementDestination("javascript:alert(1)"), false);
    assert.equal(
        isSafeAdvertisementDestination("/advertisements/click/ad_001"),
        true
    );

    const opened = [];

    openAdvertisementDestination("/advertisements/click/ad_001", {
        open: (url) => opened.push(url),
        telegramWebApp: null
    });

    assert.equal(opened.length, 1);
    assert.match(opened[0], /\/advertisements\/click\/ad_001$/);

    const tgOpened = [];

    openAdvertisementDestination("/advertisements/click/ad_002", {
        open: () => {

            throw new Error("should use telegram openLink");

        },
        telegramWebApp: {
            openLink(url) {

                tgOpened.push(url);

            }
        }
    });

    assert.equal(tgOpened.length, 1);
    assert.match(tgOpened[0], /\/advertisements\/click\/ad_002$/);
    console.log("  7. Missing advertisement data does not crash UI");

}

console.log("advertisement.r145.test.js: all assertions passed");
