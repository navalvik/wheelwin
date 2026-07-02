export class MetricsService {

    constructor({ enabled = false }) {

        this._enabled = enabled;

        this._records = new Map();

        this._initialized = false;

    }

    initialize() {

        this._initialized = true;

    }

    shutdown() {

        this._records.clear();

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

        return {
            enabled: this._enabled,
            metrics
        };

    }

}
