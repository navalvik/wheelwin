/**
 * Process-local, bounded scheduler for independent Testnet blockchain reads.
 *
 * At 50 active rooms a burst of TonCenter HTTP 542 must NOT produce
 * 100 simultaneous fallback RPC requests. Schedule each provider separately,
 * with a concurrency ceiling and a minimum inter-request start interval.
 *
 * This is neither a transaction signer nor an authorization mechanism.
 * Cross-instance deployments need an external shared quota/coordinator.
 */
export class RoomWalletProviderBudgetError extends Error {
    constructor(code) {
        super(code);
        this.name = "RoomWalletProviderBudgetError";
        this.code = code;
        this.retryable = true;
    }
}

export class RoomWalletProviderBudget {
    constructor({
        concurrencyPerProvider = 2,
        spacingMs = 1_200,
        maxQueuedPerProvider = 64,
        now = () => Date.now()
    } = {}) {
        if (!Number.isInteger(concurrencyPerProvider) || concurrencyPerProvider < 1
            || concurrencyPerProvider > 4
            || !Number.isInteger(spacingMs) || spacingMs < 0
            || !Number.isInteger(maxQueuedPerProvider) || maxQueuedPerProvider < 1
            || maxQueuedPerProvider > 256
            || typeof now !== "function") {
            throw new TypeError("Invalid Room Wallet provider request budget");
        }
        this._concurrency = concurrencyPerProvider;
        this._spacingMs = spacingMs;
        this._maxQueued = maxQueuedPerProvider;
        this._now = now;
        this._providers = new Map();
    }

    schedule(provider, request) {
        if (provider !== "tonapi" && provider !== "toncenter-v3") {
            return Promise.reject(new RoomWalletProviderBudgetError("UNKNOWN_PROVIDER"));
        }
        if (typeof request !== "function") {
            return Promise.reject(new RoomWalletProviderBudgetError("REQUEST_NOT_FUNCTION"));
        }
        let state = this._providers.get(provider);
        if (!state) {
            state = {
                pending: [],
                active: 0,
                nextStartAt: 0,
                timer: null,
                started: 0,
                rejected: 0,
                peakActive: 0,
                peakQueued: 0
            };
            this._providers.set(provider, state);
        }

        if (state.pending.length >= this._maxQueued) {
            state.rejected++;
            return Promise.reject(new RoomWalletProviderBudgetError("PROVIDER_QUEUE_FULL"));
        }

        const result = new Promise((resolve, reject) => {
            state.pending.push({ request, resolve, reject });
            state.peakQueued = Math.max(state.peakQueued, state.pending.length);
        });
        this._pump(state);
        return result;
    }

    _pump(state) {
        if (state.timer || state.active >= this._concurrency || state.pending.length === 0) {
            return;
        }
        const now = this._now();
        const waitMs = Math.max(0, state.nextStartAt - now);
        if (waitMs > 0) {
            state.timer = setTimeout(() => {
                state.timer = null;
                this._pump(state);
            }, waitMs);
            return;
        }

        const task = state.pending.shift();
        state.active++;
        state.started++;
        state.peakActive = Math.max(state.peakActive, state.active);
        state.nextStartAt = this._now() + this._spacingMs;

        Promise.resolve()
            .then(() => task.request())
            .then(task.resolve, task.reject)
            .finally(() => {
                state.active--;
                this._pump(state);
            });

        // Permit another concurrently running request only after the spacing.
        this._pump(state);
    }

    snapshot() {
        const stats = {};
        for (const [provider, state] of this._providers) {
            stats[provider] = Object.freeze({
                active: state.active,
                queued: state.pending.length,
                started: state.started,
                rejected: state.rejected,
                peakActive: state.peakActive,
                peakQueued: state.peakQueued
            });
        }
        return Object.freeze(stats);
    }
}
