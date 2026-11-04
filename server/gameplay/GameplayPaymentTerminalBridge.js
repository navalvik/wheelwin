import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";

const TERMINAL_PAYOUT_STATUSES = new Set([
    "BOTH_PAYOUTS_SETTLED_FROM_DUAL_FINALITY",
    "COMPLETE",
    "PAYOUT_COMPLETE"
]);

/** Adapts confirmed payment-runtime payout results to the existing gameplay audit gate. */
export class GameplayPaymentTerminalBridge {
    constructor({ eventBus } = {}) {
        if (typeof eventBus?.emit !== "function") {
            throw new TypeError("GAMEPLAY_PAYMENT_TERMINAL_EVENT_BUS_REQUIRED");
        }
        this._eventBus = eventBus;
        this._gameByPayout = new Map();
        this._terminalPayouts = new Map();
        this._published = new Set();
    }

    trackPayout({ gameId, payoutId } = {}) {
        if (typeof gameId !== "string" || !gameId
            || typeof payoutId !== "string" || !payoutId) return false;
        const existing = this._gameByPayout.get(payoutId);
        if (existing && existing !== gameId) return false;
        this._gameByPayout.set(payoutId, gameId);
        return this._publishIfReady(payoutId);
    }

    observePayoutOutcome({ payoutId, status } = {}) {
        if (typeof payoutId !== "string" || !payoutId
            || !TERMINAL_PAYOUT_STATUSES.has(status)) return false;
        this._terminalPayouts.set(payoutId, status);
        return this._publishIfReady(payoutId);
    }

    _publishIfReady(payoutId) {
        const gameId = this._gameByPayout.get(payoutId);
        const status = this._terminalPayouts.get(payoutId);
        if (!gameId || !status || this._published.has(payoutId)) return false;

        this._published.add(payoutId);
        this._gameByPayout.delete(payoutId);
        this._terminalPayouts.delete(payoutId);
        this._eventBus.emit({
            source: EVENT_SOURCES.APPLICATION,
            type: EVENT_TYPES.PAYMENT_COMPLETED,
            payload: { gameId, payoutId, status }
        });
        return true;
    }
}
