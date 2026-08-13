/**
 * R14.6 — AdvertisementHistoryService.
 * Append-only JSONL proof-of-delivery events (impressions / clicks).
 * No analytics aggregation. No personal data.
 */

import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync
} from "node:fs";
import { join } from "node:path";

import {
    ADVERTISEMENT_SLOT_DURATION_SECONDS
} from "./advertisementTypes.js";
import { resolveDefaultAdvertisementDataDir } from "./AdvertisementStorage.js";

export const ADVERTISEMENT_HISTORY_EVENTS = Object.freeze({
    AD_STARTED: "AD_STARTED",
    IMPRESSION_CONFIRMED: "IMPRESSION_CONFIRMED",
    CLICK: "CLICK"
});

function dayKey(date = new Date()) {

    const iso = date instanceof Date
        ? date.toISOString()
        : new Date(date).toISOString();

    return iso.slice(0, 10);

}

function toIso(value) {

    if (value instanceof Date) {

        return value.toISOString();

    }

    if (typeof value === "number" && Number.isFinite(value)) {

        return new Date(value).toISOString();

    }

    if (typeof value === "string" && value.trim()) {

        const parsed = Date.parse(value);

        if (Number.isFinite(parsed)) {

            return new Date(parsed).toISOString();

        }

        return value;

    }

    return new Date().toISOString();

}

/**
 * Strip any accidental PII keys before persistence.
 */
function sanitizeHistoryRecord(record) {

    const forbidden = [
        "playerId",
        "playerIds",
        "wallet",
        "walletAddress",
        "nickname",
        "username",
        "userId",
        "socketId",
        "telegramId",
        "personalData"
    ];

    const next = { ...record };

    for (const key of forbidden) {

        delete next[key];

    }

    return next;

}

export class AdvertisementHistoryService {

    constructor({
        logger = null,
        historyDir = null,
        dataDir = null
    } = {}) {

        this._logger = logger;
        this._historyDir = historyDir
            || (dataDir ? join(dataDir, "history") : null)
            || join(resolveDefaultAdvertisementDataDir(), "history");
        this._initialized = false;

    }

    get historyDir() {

        return this._historyDir;

    }

    initialize({ historyDir = null } = {}) {

        if (historyDir) {

            this._historyDir = historyDir;

        }

        mkdirSync(this._historyDir, { recursive: true });
        this._initialized = true;

        this._logger?.info?.(
            `AdvertisementHistoryService ready | historyDir=${this._historyDir}`
        );

        return { historyDir: this._historyDir };

    }

    resolveJsonlPath(at = new Date()) {

        return join(
            this._historyDir,
            `advertisement-history-${dayKey(at)}.jsonl`
        );

    }

    appendEvent(record, at = new Date()) {

        this._assertReady();

        const payload = sanitizeHistoryRecord({
            ...record,
            recordedAt: toIso(at)
        });

        const absolute = this.resolveJsonlPath(at);

        mkdirSync(this._historyDir, { recursive: true });
        appendFileSync(absolute, `${JSON.stringify(payload)}\n`, "utf8");

        return {
            absolutePath: absolute,
            record: payload
        };

    }

    recordAdStarted({
        advertisementId,
        filename = null,
        startedAt = Date.now(),
        duration = ADVERTISEMENT_SLOT_DURATION_SECONDS
    } = {}) {

        if (!advertisementId) {

            return null;

        }

        return this.appendEvent({
            event: ADVERTISEMENT_HISTORY_EVENTS.AD_STARTED,
            advertisementId,
            filename,
            startedAt: toIso(startedAt),
            duration
        }, startedAt);

    }

    confirmImpression({
        advertisementId,
        filename = null,
        startedAt,
        completedAt = Date.now(),
        duration = ADVERTISEMENT_SLOT_DURATION_SECONDS
    } = {}) {

        if (!advertisementId || startedAt == null) {

            return null;

        }

        return this.appendEvent({
            event: ADVERTISEMENT_HISTORY_EVENTS.IMPRESSION_CONFIRMED,
            advertisementId,
            filename,
            startedAt: toIso(startedAt),
            completedAt: toIso(completedAt),
            duration
        }, completedAt);

    }

    recordClick({
        advertisementId,
        filename = null,
        timestamp = Date.now()
    } = {}) {

        if (!advertisementId) {

            return null;

        }

        return this.appendEvent({
            event: ADVERTISEMENT_HISTORY_EVENTS.CLICK,
            advertisementId,
            filename,
            timestamp: toIso(timestamp)
        }, timestamp);

    }

    /**
     * Read JSONL history (tests / future analytics). Ignores per-event .json files.
     */
    readJsonlEvents({ day = null } = {}) {

        this._assertReady();

        if (!existsSync(this._historyDir)) {

            return [];

        }

        const files = readdirSync(this._historyDir)
            .filter((name) => name.startsWith("advertisement-history-")
                && name.endsWith(".jsonl"))
            .filter((name) => (day ? name.includes(day) : true))
            .sort();

        const events = [];

        for (const name of files) {

            const text = readFileSync(join(this._historyDir, name), "utf8");

            for (const line of text.split(/\r?\n/)) {

                if (!line.trim()) {

                    continue;

                }

                try {

                    events.push(JSON.parse(line));

                } catch {

                    // Skip corrupt lines.

                }

            }

        }

        return events;

    }

    _assertReady() {

        if (!this._initialized) {

            throw new Error("AdvertisementHistoryService is not initialized");

        }

    }

}
