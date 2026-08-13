/**
 * R14.6 — Advertisement history + click tracking tests.
 */

import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import express from "express";

import {
    ADVERTISEMENT_HISTORY_EVENTS,
    AdvertisementHistoryService
} from "../advertisement/AdvertisementHistoryService.js";
import { AdvertisementManager } from "../advertisement/AdvertisementManager.js";
import { AdvertisementRedirectService } from "../advertisement/AdvertisementRedirectService.js";
import { AdvertisementScheduler } from "../advertisement/AdvertisementScheduler.js";
import { AdvertisementSelectionEngine } from "../advertisement/AdvertisementSelectionEngine.js";
import { registerAdvertisementRoutes } from "../console/registerAdvertisementRoutes.js";

function tinyJpeg() {

    return Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x00, 0x01, 0x02, 0x03]);

}

function createStack({ slotDurationMs = 100, debounceMs = 3_000 } = {}) {

    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-ads-r146-"));
    const manager = new AdvertisementManager({ dataDir });

    manager.initialize();

    const history = new AdvertisementHistoryService({
        historyDir: manager.getHistoryDir()
    });

    history.initialize();

    const redirect = new AdvertisementRedirectService({
        advertisementManager: manager,
        historyService: history,
        debounceMs,
        nowFn: () => now
    });

    redirect.initialize();

    const selection = new AdvertisementSelectionEngine({
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

    const scheduler = new AdvertisementScheduler({
        selectionEngine: selection,
        historyService: history,
        slotDurationMs,
        nowFn: () => now,
        setIntervalFn,
        clearIntervalFn
    });

    const app = express();

    registerAdvertisementRoutes(app, {
        authService: null,
        advertisementManager: manager,
        advertisementRedirectService: redirect
    });

    const server = http.createServer(app);

    return {
        dataDir,
        manager,
        history,
        redirect,
        scheduler,
        server,
        advance,
        nowFn: () => now,
        setNow(value) {

            now = value;

        },
        create(filename, extras = {}) {

            return manager.createCampaign({
                filename,
                bytes: tinyJpeg(),
                advertiserName: "Adv",
                destinationUrl: extras.destinationUrl ?? "https://example.com/offer",
                expiresAt: extras.expiresAt ?? "2099-01-01T00:00:00.000Z",
                role: "Administrator",
                createdBy: "Administrator"
            });

        },
        async listen() {

            await new Promise((resolve) => {

                server.listen(0, "127.0.0.1", resolve);

            });

            this.baseUrl = `http://127.0.0.1:${server.address().port}`;

            return this.baseUrl;

        },
        async close() {

            scheduler.shutdown();
            redirect.shutdown();

            await new Promise((resolve, reject) => {

                server.close((error) => (error ? reject(error) : resolve()));

            });

            rmSync(dataDir, { recursive: true, force: true });

        }
    };

}

{
    const stack = createStack({ slotDurationMs: 100 });

    try {

        stack.create("1_full.jpg");
        stack.scheduler.initialize();
        stack.scheduler.start();

        let events = stack.history.readJsonlEvents();

        assert.ok(
            events.some((e) => e.event === ADVERTISEMENT_HISTORY_EVENTS.AD_STARTED)
        );
        assert.equal(
            events.some(
                (e) => e.event === ADVERTISEMENT_HISTORY_EVENTS.IMPRESSION_CONFIRMED
            ),
            false
        );

        stack.advance(100);

        events = stack.history.readJsonlEvents();

        assert.ok(
            events.some(
                (e) => e.event === ADVERTISEMENT_HISTORY_EVENTS.IMPRESSION_CONFIRMED
            )
        );

        const impression = events.find(
            (e) => e.event === ADVERTISEMENT_HISTORY_EVENTS.IMPRESSION_CONFIRMED
        );

        assert.equal(impression.advertisementId, "ad_001");
        assert.equal(impression.filename, "1_full.jpg");
        assert.equal(typeof impression.startedAt, "string");
        assert.equal(typeof impression.completedAt, "string");
        assert.equal(typeof impression.duration, "number");
        assert.equal(impression.playerId, undefined);
        assert.equal(impression.wallet, undefined);
        console.log("  1. Completed slot creates impression event");

    } finally {

        stack.scheduler.shutdown();
        rmSync(stack.dataDir, { recursive: true, force: true });

    }

}

{
    const stack = createStack({ slotDurationMs: 100 });

    try {

        stack.create("1_short.jpg");
        stack.scheduler.initialize();
        stack.scheduler.start();

        // Incomplete: refresh before full slot.
        stack.scheduler.refresh("refresh");

        const events = stack.history.readJsonlEvents();

        assert.equal(
            events.some(
                (e) => e.event === ADVERTISEMENT_HISTORY_EVENTS.IMPRESSION_CONFIRMED
            ),
            false
        );
        console.log("  2. Incomplete display does not create impression");

    } finally {

        stack.scheduler.shutdown();
        rmSync(stack.dataDir, { recursive: true, force: true });

    }

}

{
    const stack = createStack({ debounceMs: 5_000 });

    await stack.listen();

    try {

        const campaign = stack.create("1_click.jpg", {
            destinationUrl: "https://example.com/landing"
        });

        const response = await fetch(
            `${stack.baseUrl}/advertisements/click/${campaign.id}`,
            { redirect: "manual" }
        );

        assert.equal(response.status, 302);
        assert.equal(
            response.headers.get("location"),
            "https://example.com/landing"
        );

        const events = stack.history.readJsonlEvents();
        const clicks = events.filter(
            (e) => e.event === ADVERTISEMENT_HISTORY_EVENTS.CLICK
        );

        assert.equal(clicks.length, 1);
        assert.equal(clicks[0].advertisementId, campaign.id);
        assert.equal(clicks[0].filename, "1_click.jpg");
        assert.equal(clicks[0].playerId, undefined);
        console.log("  3. Click endpoint stores CLICK event");
        console.log("  4. Click endpoint redirects correctly");

        const invalid = await fetch(
            `${stack.baseUrl}/advertisements/click/ad_missing`,
            { redirect: "manual" }
        );

        assert.equal(invalid.status, 404);
        console.log("  5. Invalid advertisement ID rejected");

        const dup = await fetch(
            `${stack.baseUrl}/advertisements/click/${campaign.id}`,
            { redirect: "manual" }
        );

        assert.equal(dup.status, 302);
        assert.equal(
            stack.history.readJsonlEvents().filter(
                (e) => e.event === ADVERTISEMENT_HISTORY_EVENTS.CLICK
            ).length,
            1
        );
        console.log("  6. Duplicate click protection works");

        const historyDir = stack.history.historyDir;
        const files = readdirSync(historyDir)
            .filter((name) => name.endsWith(".jsonl"));

        assert.ok(files.length >= 1);

        const text = readFileSync(join(historyDir, files[0]), "utf8");

        assert.ok(text.includes("CLICK"));
        assert.ok(text.trim().length > 0);
        console.log("  7. JSONL history append works");

    } finally {

        await stack.close();

    }

}

console.log("advertisement.r146.test.js: all assertions passed");
