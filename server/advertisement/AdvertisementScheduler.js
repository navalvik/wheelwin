/**
 * R14.4 — AdvertisementScheduler (server-authoritative advertising clock).
 *
 * Owns the global rotation timer. Clients must not select or rotate ads.
 * No display-history persistence in this stage (runtime state only).
 */

import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import {
    ADVERTISEMENT_SLOT_DURATION_MS,
    ADVERTISEMENT_SLOT_DURATION_SECONDS
} from "./advertisementTypes.js";
import { AdvertisementSelectionEngine } from "./AdvertisementSelectionEngine.js";
import {
    ADVERTISEMENT_MESSAGE_TYPES,
    buildCurrentAdSnapshot
} from "./AdvertisementSyncProtocol.js";

export class AdvertisementScheduler {

    constructor({
        logger = null,
        eventBus = null,
        advertisementManager = null,
        selectionEngine = null,
        slotDurationMs = ADVERTISEMENT_SLOT_DURATION_MS,
        nowFn = () => Date.now(),
        setIntervalFn = setInterval,
        clearIntervalFn = clearInterval
    } = {}) {

        this._logger = logger;
        this._eventBus = eventBus;
        this._selectionEngine = selectionEngine
            ?? new AdvertisementSelectionEngine({ advertisementManager });
        this._slotDurationMs = Number(slotDurationMs) > 0
            ? Number(slotDurationMs)
            : ADVERTISEMENT_SLOT_DURATION_MS;
        this._nowFn = nowFn;
        this._setIntervalFn = setIntervalFn;
        this._clearIntervalFn = clearIntervalFn;

        this._initialized = false;
        this._running = false;
        this._timer = null;
        this._current = null;
        this._changeListeners = new Set();

    }

    initialize() {

        this._initialized = true;
        this._logger?.info?.("AdvertisementScheduler ready");

        return { slotDurationMs: this._slotDurationMs };

    }

    start() {

        this._assertReady();

        if (this._running) {

            return this.getCurrentSnapshot();

        }

        this._running = true;
        this._advance("start");

        this._timer = this._setIntervalFn(() => {

            this._advance("tick");

        }, this._slotDurationMs);

        this._logger?.info?.(
            `AdvertisementScheduler started | slotDurationMs=${this._slotDurationMs}`
        );

        return this.getCurrentSnapshot();

    }

    stop() {

        if (this._timer != null) {

            this._clearIntervalFn(this._timer);
            this._timer = null;

        }

        this._running = false;

    }

    shutdown() {

        this.stop();
        this._current = null;
        this._changeListeners.clear();
        this._initialized = false;

    }

    isRunning() {

        return this._running === true;

    }

    getSlotDurationSeconds() {

        return Math.round(this._slotDurationMs / 1000)
            || ADVERTISEMENT_SLOT_DURATION_SECONDS;

    }

    /**
     * Runtime snapshot for sync / broadcast. remainingMs is server-derived.
     */
    getCurrentSnapshot(nowMs = this._nowFn()) {

        if (!this._current) {

            return buildCurrentAdSnapshot({
                advertisementId: null,
                filename: null,
                startedAt: nowMs,
                duration: this.getSlotDurationSeconds()
            }, nowMs);

        }

        return buildCurrentAdSnapshot(this._current, nowMs);

    }

    /**
     * Test / bridge hook — synchronous listener without EventBus.
     */
    onChanged(listener) {

        if (typeof listener === "function") {

            this._changeListeners.add(listener);

        }

        return () => this._changeListeners.delete(listener);

    }

    /**
     * Force an immediate reselection (e.g. after campaign mutations).
     */
    refresh(reason = "refresh") {

        this._assertReady();
        return this._advance(reason);

    }

    _assertReady() {

        if (!this._initialized) {

            throw new Error("AdvertisementScheduler is not initialized");

        }

    }

    _advance(reason = "tick") {

        const previousId = this._current?.advertisementId ?? null;
        const selected = this._selectionEngine.selectNext({
            previousId
        });

        const nowMs = this._nowFn();
        const duration = this.getSlotDurationSeconds();

        if (!selected) {

            this._current = {
                advertisementId: null,
                filename: null,
                destinationUrl: null,
                priority: null,
                startedAt: nowMs,
                duration
            };

        } else {

            this._current = {
                advertisementId: selected.id,
                filename: selected.filename ?? null,
                destinationUrl: selected.destinationUrl ?? null,
                priority: selected.priority ?? null,
                startedAt: nowMs,
                duration
            };

        }

        const snapshot = this.getCurrentSnapshot(nowMs);

        this._emitChanged(snapshot, reason);

        return snapshot;

    }

    _emitChanged(snapshot, reason) {

        for (const listener of this._changeListeners) {

            try {

                listener(snapshot, reason);

            } catch {

                // Listener failures must not stop the clock.

            }

        }

        if (!this._eventBus) {

            return;

        }

        this._eventBus.emit({
            source: EVENT_SOURCES.ADVERTISEMENT_SCHEDULER,
            type: EVENT_TYPES.ADVERTISEMENT_CHANGED,
            payload: {
                messageType: ADVERTISEMENT_MESSAGE_TYPES.ADVERTISEMENT_CHANGED,
                reason,
                snapshot
            }
        });

    }

}
