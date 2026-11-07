/** R14.9 — Telegram campaign validation and click-registration tests. */

import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import express from "express";

import { AdvertisementManager } from "../advertisement/AdvertisementManager.js";
import {
    ADVERTISEMENT_DESTINATION_TYPES,
    AdvertisementValidationError,
    validateTelegramDestinationUrl
} from "../advertisement/AdvertisementValidator.js";
import {
    ADVERTISEMENT_HISTORY_EVENTS,
    AdvertisementHistoryService
} from "../advertisement/AdvertisementHistoryService.js";
import { AdvertisementRedirectService } from "../advertisement/AdvertisementRedirectService.js";
import { AdvertisementScheduler } from "../advertisement/AdvertisementScheduler.js";
import { registerAdvertisementRoutes } from "../console/registerAdvertisementRoutes.js";

const TESTNET_AND_MAINNET = ["testnet", "mainnet"];

function tinyJpeg() {

    return Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x00, 0x01, 0x02, 0x03]);

}

function createStack(network) {

    const dataDir = mkdtempSync(join(tmpdir(), `wheelwin-ads-r149-${network}-`));
    const manager = new AdvertisementManager({ dataDir });

    manager.initialize();

    const history = new AdvertisementHistoryService({
        historyDir: manager.getHistoryDir()
    });

    history.initialize();

    const redirect = new AdvertisementRedirectService({
        advertisementManager: manager,
        historyService: history,
        nowFn: () => 1_000_000
    });

    redirect.initialize();

    const app = express();

    app.use(express.json());

    registerAdvertisementRoutes(app, {
        authService: { allowsOpenAccess: () => true },
        advertisementManager: manager,
        advertisementRedirectService: redirect
    });

    const server = http.createServer(app);

    return {
        manager,
        history,
        redirect,
        server,
        dataDir,
        async listen() {

            await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
            this.baseUrl = `http://127.0.0.1:${server.address().port}`;

        },
        async close() {

            redirect.shutdown();
            await new Promise((resolve, reject) => server.close(
                (error) => error ? reject(error) : resolve()
            ));
            rmSync(dataDir, { recursive: true, force: true });

        }
    };

}

for (const network of TESTNET_AND_MAINNET) {

    const stack = createStack(network);

    try {

        await stack.listen();

        const websiteResponse = await fetch(`${stack.baseUrl}/console/advertisements`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                filename: "1_website.jpg",
                contentBase64: tinyJpeg().toString("base64"),
                advertiserName: "Website Campaign",
                destinationUrl: "https://example.com/offer"
            })
        });

        assert.equal(websiteResponse.status, 201);

        const website = await websiteResponse.json();

        assert.equal(
            website.destinationType,
            ADVERTISEMENT_DESTINATION_TYPES.WEBSITE
        );
        assert.equal(website.destinationUrl, "https://example.com/offer");

        const telegramResponse = await fetch(`${stack.baseUrl}/console/advertisements`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                filename: "2_telegram.jpg",
                contentBase64: tinyJpeg().toString("base64"),
                advertiserName: "Telegram Campaign",
                destinationType: ADVERTISEMENT_DESTINATION_TYPES.TELEGRAM,
                destinationUrl: "https://t.me/example_bot?start=example"
            })
        });

        assert.equal(telegramResponse.status, 201);

        const telegram = await telegramResponse.json();

        assert.equal(telegram.destinationType, "TELEGRAM");
        assert.equal(telegram.destinationUrl, "https://t.me/example_bot?start=example");

        const editedResponse = await fetch(
            `${stack.baseUrl}/console/advertisements/${telegram.id}`,
            {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    destinationType: "TELEGRAM",
                    destinationUrl: "tg://resolve?domain=example_bot&start=updated"
                })
            }
        );

        assert.equal(editedResponse.status, 200);

        const edited = await editedResponse.json();

        assert.equal(edited.destinationType, "TELEGRAM");
        assert.equal(edited.destinationUrl, "https://t.me/example_bot?start=updated");

        const detailResponse = await fetch(
            `${stack.baseUrl}/console/advertisements/${edited.id}`
        );

        assert.equal(detailResponse.status, 200);

        const detail = await detailResponse.json();

        assert.equal(detail.destinationType, "TELEGRAM");
        assert.equal(detail.destinationUrl, edited.destinationUrl);

        const scheduler = new AdvertisementScheduler({
            selectionEngine: { selectNext: () => edited },
            nowFn: () => 1_000_000,
            setIntervalFn: () => 1,
            clearIntervalFn: () => {}
        });

        scheduler.initialize();
        scheduler.start();

        const snapshot = scheduler.getCurrentSnapshot();

        assert.equal(snapshot.destinationType, "TELEGRAM");
        assert.equal(snapshot.telegramLink, edited.destinationUrl);
        assert.equal(snapshot.destinationUrl, null);
        scheduler.shutdown();

        const legacy = {
            id: "ad_legacy",
            filename: "3_legacy.jpg",
            advertiserName: "Legacy Website",
            destinationUrl: "https://legacy.example/path",
            status: "ACTIVE",
            priority: 3
        };

        stack.manager._storage.saveCampaign(legacy);

        assert.equal(
            stack.manager.listCampaignsForScheduler()
                .find((campaign) => campaign.id === legacy.id).destinationUrl,
            legacy.destinationUrl
        );

        const legacyResponse = await fetch(
            `${stack.baseUrl}/advertisements/click/${legacy.id}`,
            { redirect: "manual" }
        );

        assert.equal(legacyResponse.status, 302);
        assert.equal(
            legacyResponse.headers.get("location"),
            "https://legacy.example/path"
        );

        const firstClick = await fetch(
            `${stack.baseUrl}/advertisements/click/${edited.id}`,
            { method: "POST" }
        );

        assert.equal(firstClick.status, 200);
        assert.equal(firstClick.headers.get("location"), null);
        assert.deepEqual(await firstClick.json(), {
            recorded: true,
            duplicate: false
        });

        const repeatedClick = await fetch(
            `${stack.baseUrl}/advertisements/click/${edited.id}`,
            { method: "POST" }
        );

        assert.deepEqual(await repeatedClick.json(), {
            recorded: false,
            duplicate: true
        });

        const clickEvents = stack.history.readJsonlEvents().filter(
            (event) => event.event === ADVERTISEMENT_HISTORY_EVENTS.CLICK
                && event.advertisementId === edited.id
        );

        assert.equal(clickEvents.length, 1);

        const websitePost = await fetch(
            `${stack.baseUrl}/advertisements/click/${website.id}`,
            { method: "POST" }
        );

        assert.equal(websitePost.status, 400);

        console.log(`  ${network}. Website, Telegram, legacy and deduplicated click paths pass`);

    } finally {

        await stack.close();

    }

}

assert.equal(
    validateTelegramDestinationUrl("https://t.me/example_channel"),
    "https://t.me/example_channel"
);
assert.equal(
    validateTelegramDestinationUrl("https://t.me/+INVITE_CODE"),
    "https://t.me/+INVITE_CODE"
);
assert.equal(
    validateTelegramDestinationUrl("https://t.me/joinchat/INVITE_CODE"),
    "https://t.me/joinchat/INVITE_CODE"
);
assert.equal(
    validateTelegramDestinationUrl("tg://join?invite=INVITE_CODE"),
    "https://t.me/+INVITE_CODE"
);
assert.equal(
    validateTelegramDestinationUrl("https://t.me/example_bot?start=example"),
    "https://t.me/example_bot?start=example"
);

for (const invalid of [
    "https://t.me.evil.example/example_bot",
    "https://example.com/t.me/example_bot",
    "http://t.me/example_bot",
    "javascript:alert(1)",
    "tg://proxy?server=example.com"
]) {

    assert.throws(
        () => validateTelegramDestinationUrl(invalid),
        (error) => error instanceof AdvertisementValidationError
            && error.code === "INVALID_TELEGRAM_LINK"
    );

}

const sharedServerEntry = readFileSync(
    new URL("../app.js", import.meta.url),
    "utf8"
);

assert.match(sharedServerEntry, /import \{ registerAdvertisementRoutes \}/);
assert.match(sharedServerEntry, /registerAdvertisementRoutes\(this\._expressApp/);

console.log("advertisement.r149.telegram.test.js: all assertions passed");
