/**
 * R14.4 / R14.6 / R14.7 — AdvertisementScheduler (server-authoritative advertising clock).
 *
 * Owns the global rotation timer. Clients must not select or rotate ads.
 * R14.6 — confirms impressions only after a full slot duration elapses.
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
        lifecycleManager = null,
        historyService = null,
        slotDurationMs = ADVERTISEMENT_SLOT_DURATION_MS,
        nowFn = () => Date.now(),
        setIntervalFn = setInterval,
        clearIntervalFn = clearInterval
    } = {}) {

        this._logger = logger;
        this._eventBus = eventBus;
        this._selectionEngine = selectionEngine
            ?? new AdvertisementSelectionEngine({ advertisementManager });
        this._lifecycleManager = lifecycleManager;
        this._historyService = historyService;
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
        this._pendingSlot = null;
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
        this._pendingSlot = null;
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

    onChanged(listener) {

        if (typeof listener === "function") {

            this._changeListeners.add(listener);

        }

        return () => this._changeListeners.delete(listener);

    }

    /**
     * Force an immediate reselection.
     * Incomplete slots do not confirm impressions.
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

        try {

            this._lifecycleManager?.processExpirations?.(
                new Date(this._nowFn())
            );

        } catch {

            // Lifecycle failures must not stop advertisement rotation.

        }

        const nowMs = this._nowFn();

        this._maybeConfirmImpression(reason, nowMs);

        const previousId = this._current?.advertisementId ?? null;
        const selected = this._selectionEngine.selectNext({
            previousId
        });

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
            this._pendingSlot = null;

        } else {

            this._current = {
                advertisementId: selected.id,
                filename: selected.filename ?? null,
                destinationUrl: selected.destinationUrl ?? null,
                priority: selected.priority ?? null,
                startedAt: nowMs,
                duration
            };

            this._pendingSlot = {
                advertisementId: selected.id,
                filename: selected.filename ?? null,
                startedAt: nowMs,
                duration
            };

            try {

                this._historyService?.recordAdStarted?.({
                    advertisementId: selected.id,
                    filename: selected.filename ?? null,
                    startedAt: nowMs,
                    duration
                });

            } catch {

                // History failures must not stop the clock.

            }

        }

        const snapshot = this.getCurrentSnapshot(nowMs);

        this._emitChanged(snapshot, reason);

        return snapshot;

    }

    _maybeConfirmImpression(reason, nowMs) {

        if (reason !== "tick" || !this._pendingSlot?.advertisementId) {

            return;

        }

        const startedAt = Number(this._pendingSlot.startedAt);
        const elapsed = nowMs - startedAt;

        if (elapsed + 25 < this._slotDurationMs) {

            return;

        }

        try {

            this._historyService?.confirmImpression?.({
                advertisementId: this._pendingSlot.advertisementId,
                filename: this._pendingSlot.filename ?? null,
                startedAt,
                completedAt: nowMs,
                duration: this._pendingSlot.duration
                    ?? this.getSlotDurationSeconds()
            });

        } catch {

            // History failures must not stop the clock.

        }

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
