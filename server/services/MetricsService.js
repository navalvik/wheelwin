export class MetricsService {

    constructor({ enabled = false }) {

        this._enabled = enabled;

        this._records = new Map();

        this._counters = new Map();

        this._initialized = false;

    }

    initialize() {

        this._initialized = true;

    }

    shutdown() {

        this._records.clear();

        this._counters.clear();

        this._initialized = false;

    }

    isEnabled() {

        return this._enabled;

    }

    record(name, durationMs) {

        if (!this._enabled || !this._initialized) {

            return;

        }

        if (!Number.isFinite(durationMs) || durationMs < 0) {

            return;

        }

        let record = this._records.get(name);

        if (!record) {

            record = {
                count: 0,
                totalMs: 0,
                minMs: Infinity,
                maxMs: 0,
                lastMs: 0
            };

            this._records.set(name, record);

        }

        record.count += 1;

        record.totalMs += durationMs;

        record.minMs = Math.min(record.minMs, durationMs);

        record.maxMs = Math.max(record.maxMs, durationMs);

        record.lastMs = durationMs;

    }

    /**
     * C4.5 — Monotonic production counter (games started/completed, reconnects,
     * payments, audits, cleanup, etc.). Additive to the timing recorder above.
     */
    increment(name, amount = 1) {

        if (!this._enabled || !this._initialized) {

            return;

        }

        if (!Number.isFinite(amount) || amount <= 0) {

            return;

        }

        this._counters.set(name, (this._counters.get(name) ?? 0) + amount);

    }

    getCounter(name) {

        return this._counters.get(name) ?? 0;

    }

    time(name, operation) {

        const startedAt = performance.now();

        const result = operation();

        this.record(name, performance.now() - startedAt);

        return result;

    }

    async timeAsync(name, operation) {

        const startedAt = performance.now();

        const result = await operation();

        this.record(name, performance.now() - startedAt);

        return result;

    }

    getSnapshot() {

        const metrics = {};

        for (const [name, record] of this._records) {

            metrics[name] = {
                count: record.count,
                totalMs: Number(record.totalMs.toFixed(3)),
                averageMs: record.count > 0
                    ? Number((record.totalMs / record.count).toFixed(3))
                    : 0,
                minMs: record.minMs === Infinity
                    ? 0
                    : Number(record.minMs.toFixed(3)),
                maxMs: Number(record.maxMs.toFixed(3)),
                lastMs: Number(record.lastMs.toFixed(3))
            };

        }

        const counters = {};

        for (const [name, value] of this._counters) {

            counters[name] = value;

        }

        return {
            enabled: this._enabled,
            metrics,
            counters
        };

    }

}
