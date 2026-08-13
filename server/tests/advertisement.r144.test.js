/**
 * R14.4 — Advertisement scheduler + sync protocol tests.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AdvertisementManager } from "../advertisement/AdvertisementManager.js";
import { AdvertisementScheduler } from "../advertisement/AdvertisementScheduler.js";
import { AdvertisementSelectionEngine } from "../advertisement/AdvertisementSelectionEngine.js";
import {
    ADVERTISEMENT_MESSAGE_CHANNEL,
    ADVERTISEMENT_MESSAGE_TYPES,
    buildCurrentAdSnapshot,
    calculateAdvertisementRemainingMs
} from "../advertisement/AdvertisementSyncProtocol.js";
import { ADVERTISEMENT_STATUS } from "../advertisement/advertisementTypes.js";
import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_MESSAGE_CHANNEL } from "../socket/events.js";

function tinyJpeg() {

    return Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x00, 0x01, 0x02, 0x03]);

}

function createHarness({ slotDurationMs = 20_000 } = {}) {

    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-ads-r144-"));
    const manager = new AdvertisementManager({ dataDir });

    manager.initialize();

    const selectionEngine = new AdvertisementSelectionEngine({
        advertisementManager: manager
    });

    let now = 1_000_000;
    const timers = new Map();
    let timerSeq = 0;

    const setIntervalFn = (fn, ms) => {

        const id = ++timerSeq;

        timers.set(id, { fn, ms, nextAt: now + ms });

        return id;

    };

    const clearIntervalFn = (id) => {

        timers.delete(id);

    };

    const advance = (ms) => {

        now += ms;

        for (const timer of timers.values()) {

            while (timer.nextAt <= now) {

                timer.nextAt += timer.ms;
                timer.fn();

            }

        }

    };

    const busEvents = [];

    const eventBus = {
        emit(envelope) {

            busEvents.push(envelope);

        }
    };

    const scheduler = new AdvertisementScheduler({
        eventBus,
        selectionEngine,
        slotDurationMs,
        nowFn: () => now,
        setIntervalFn,
        clearIntervalFn
    });

    return {
        dataDir,
        manager,
        selectionEngine,
        scheduler,
        busEvents,
        advance,
        nowFn: () => now,
        createCampaign(filename, extras = {}) {

            return manager.createCampaign({
                filename,
                bytes: tinyJpeg(),
                advertiserName: extras.advertiserName ?? "Adv",
                destinationUrl: extras.destinationUrl ?? "https://example.com",
                priority: extras.priority,
                role: "Administrator",
                status: extras.status,
                createdBy: "Administrator"
            });

        },
        cleanup() {

            scheduler.shutdown();
            rmSync(dataDir, { recursive: true, force: true });

        }
    };

}

{
    const harness = createHarness({ slotDurationMs: 50 });

    try {

        harness.scheduler.initialize();
        const snapshot = harness.scheduler.start();

        assert.equal(harness.scheduler.isRunning(), true);
        assert.ok(snapshot);
        assert.equal(typeof snapshot.startedAt, "number");
        assert.equal(typeof snapshot.duration, "number");
        assert.equal(typeof snapshot.remainingMs, "number");
        console.log("  1. Scheduler starts correctly");

    } finally {

        harness.cleanup();

    }

}

{
    const harness = createHarness();

    try {

        harness.createCampaign("1_banner.jpg");
        harness.createCampaign("2_partner.jpg");

        const eligible = harness.selectionEngine.listEligibleCampaigns();

        assert.equal(eligible.length, 2);
        assert.equal(eligible.every((c) => c.status === "ACTIVE"), true);

        harness.scheduler.initialize();
        const snap = harness.scheduler.start();

        assert.equal(snap.advertisementId, "ad_001");
        assert.equal(snap.filename, "1_banner.jpg");
        console.log("  2. Active advertisements are selected");

    } finally {

        harness.cleanup();

    }

}

{
    const harness = createHarness();

    try {

        const active = harness.createCampaign("1_ok.jpg");
        const disabled = harness.createCampaign("2_off.jpg");

        harness.manager.disableCampaign(disabled.id, {
            role: "Administrator"
        });

        harness.manager.updateCampaign(
            active.id,
            { status: ADVERTISEMENT_STATUS.WAITING_OWNER_RENEWAL },
            { role: "Administrator" }
        );

        const third = harness.createCampaign("3_live.jpg");

        const eligible = harness.selectionEngine.listEligibleCampaigns();

        assert.equal(eligible.length, 1);
        assert.equal(eligible[0].id, third.id);
        assert.equal(
            eligible.some((c) => c.status === ADVERTISEMENT_STATUS.DISABLED),
            false
        );
        assert.equal(
            eligible.some(
                (c) => c.status === ADVERTISEMENT_STATUS.WAITING_OWNER_RENEWAL
            ),
            false
        );
        console.log("  3. Disabled campaigns are ignored");

    } finally {

        harness.cleanup();

    }

}

{
    const harness = createHarness();

    try {

        harness.createCampaign("3_high.jpg", { priority: 3 });
        harness.createCampaign("1_low.jpg", { priority: 1 });
        harness.createCampaign("2_mid.jpg", { priority: 2 });

        const ordered = harness.selectionEngine.listEligibleCampaigns();

        assert.deepEqual(
            ordered.map((c) => c.filename),
            ["1_low.jpg", "2_mid.jpg", "3_high.jpg"]
        );

        const first = harness.selectionEngine.selectNext();
        const second = harness.selectionEngine.selectNext({
            previousId: first.id
        });
        const third = harness.selectionEngine.selectNext({
            previousId: second.id
        });

        assert.equal(first.filename, "1_low.jpg");
        assert.equal(second.filename, "2_mid.jpg");
        assert.equal(third.filename, "3_high.jpg");
        console.log("  4. Priority ordering works");

    } finally {

        harness.cleanup();

    }

}

{
    const harness = createHarness({ slotDurationMs: 100 });

    try {

        harness.createCampaign("1_a.jpg");
        harness.createCampaign("2_b.jpg");

        harness.scheduler.initialize();
        const first = harness.scheduler.start();

        assert.equal(first.advertisementId, "ad_001");

        harness.advance(100);

        const second = harness.scheduler.getCurrentSnapshot();

        assert.equal(second.advertisementId, "ad_002");
        assert.equal(second.filename, "2_b.jpg");

        harness.advance(100);

        const third = harness.scheduler.getCurrentSnapshot();

        assert.equal(third.advertisementId, "ad_001");
        console.log("  5. Server switches advertisement after slot duration");

    } finally {

        harness.cleanup();

    }

}

{
    const harness = createHarness();

    try {

        harness.createCampaign("1_snap.jpg");
        harness.scheduler.initialize();
        const snap = harness.scheduler.start();

        assert.equal(typeof snap.advertisementId, "string");
        assert.equal(typeof snap.bannerId, "string");
        assert.equal(typeof snap.filename, "string");
        assert.equal(typeof snap.startedAt, "number");
        assert.equal(typeof snap.duration, "number");
        assert.equal(typeof snap.remainingMs, "number");
        assert.ok(Array.isArray(snap.eligiblePages));

        const rebuilt = buildCurrentAdSnapshot({
            advertisementId: "ad_001",
            filename: "1_snap.jpg",
            startedAt: snap.startedAt,
            duration: 20
        }, snap.startedAt + 5_000);

        assert.equal(rebuilt.remainingMs, 15_000);
        assert.equal(
            calculateAdvertisementRemainingMs(snap.startedAt, 20, snap.startedAt),
            20_000
        );

        assert.equal(
            ADVERTISEMENT_MESSAGE_TYPES.ADVERTISEMENT_CHANGED,
            "ADVERTISEMENT_CHANGED"
        );
        assert.equal(
            ADVERTISEMENT_MESSAGE_TYPES.CURRENT_AD,
            "CURRENT_AD"
        );
        console.log("  6. CURRENT_AD snapshot contains required fields");

    } finally {

        harness.cleanup();

    }

}

{
    const snap = buildCurrentAdSnapshot({
        advertisementId: "ad_001",
        filename: "1_x.jpg",
        startedAt: 1000,
        duration: 20
    }, 1000);

    assert.equal(snap.clientAuthority.maySelectAdvertisement, false);
    assert.equal(snap.clientAuthority.mayRunIndependentTimer, false);
    assert.equal(snap.clientAuthority.mayRunIndependentRotation, false);
    assert.equal(snap.clientAuthority.mayRenderServerSnapshot, true);
    assert.equal(snap.clientAuthority.mayComputeRemainingFromSnapshot, true);

    // Remaining time is derived from server startedAt+duration — not a client clock.
    assert.equal(
        calculateAdvertisementRemainingMs(1000, 20, 6000),
        15_000
    );
    console.log("  7. Client timers are not used");

}

{
    assert.equal(GAME_MESSAGE_CHANNEL, "game:message");
    assert.notEqual(ADVERTISEMENT_MESSAGE_CHANNEL, GAME_MESSAGE_CHANNEL);
    assert.equal(ADVERTISEMENT_MESSAGE_CHANNEL, "advertisement:message");

    assert.equal(EVENT_TYPES.ADVERTISEMENT_CHANGED, "ADVERTISEMENT_CHANGED");
    assert.equal(
        EVENT_TYPES.ADVERTISEMENT_SYNC_REQUEST,
        "ADVERTISEMENT_SYNC_REQUEST"
    );
    assert.equal(
        EVENT_TYPES.ADVERTISEMENT_SYNC_RESPONSE,
        "ADVERTISEMENT_SYNC_RESPONSE"
    );
    assert.equal(
        EVENT_SOURCES.ADVERTISEMENT_SCHEDULER,
        "AdvertisementScheduler"
    );

    // Gameplay / payment / room event names remain intact.
    assert.equal(EVENT_TYPES.PHYSICS_UPDATED, "PHYSICS_UPDATED");
    assert.equal(EVENT_TYPES.CLOCK_UPDATE, "CLOCK_UPDATE");
    assert.equal(EVENT_TYPES.PAYMENT_STARTED, "PAYMENT_STARTED");
    assert.equal(EVENT_TYPES.ROOM_CREATED, "ROOM_CREATED");
    assert.equal(EVENT_TYPES.GAME_STATE_CHANGED, "GAME_STATE_CHANGED");

    const harness = createHarness({ slotDurationMs: 50 });

    try {

        harness.createCampaign("1_bus.jpg");
        harness.scheduler.initialize();
        harness.scheduler.start();

        assert.ok(harness.busEvents.length >= 1);
        assert.equal(
            harness.busEvents[0].type,
            EVENT_TYPES.ADVERTISEMENT_CHANGED
        );
        assert.equal(
            harness.busEvents[0].source,
            EVENT_SOURCES.ADVERTISEMENT_SCHEDULER
        );
        console.log("  8. Existing gameplay websocket events are untouched");

    } finally {

        harness.cleanup();

    }

}

console.log("advertisement.r144.test.js: all assertions passed");
