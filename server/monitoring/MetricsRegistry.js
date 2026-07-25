/**
 * R7.0E — In-memory metrics registry (gauges + counters). Read-only to gameplay.
 */

export class MetricsRegistry {

    constructor() {

        this._gauges = new Map();

        this._counters = new Map();

        this._labels = new Map();

    }

    setGauge(name, value, labels = null) {

        if (!Number.isFinite(value)) {

            return;

        }

        this._gauges.set(name, value);

        if (labels) {

            this._labels.set(name, Object.freeze({ ...labels }));

        }

    }

    getGauge(name) {

        return this._gauges.has(name) ? this._gauges.get(name) : null;

    }

    incrementCounter(name, amount = 1) {

        if (!Number.isFinite(amount) || amount === 0) {

            return;

        }

        this._counters.set(name, (this._counters.get(name) ?? 0) + amount);

    }

    setCounter(name, value) {

        if (!Number.isFinite(value)) {

            return;

        }

        this._counters.set(name, value);

    }

    getCounter(name) {

        return this._counters.get(name) ?? 0;

    }

    /**
     * @returns {{ gauges: object, counters: object }}
     */
    toObject() {

        const gauges = {};

        const counters = {};

        for (const [key, value] of this._gauges) {

            gauges[key] = value;

        }

        for (const [key, value] of this._counters) {

            counters[key] = value;

        }

        return { gauges, counters };

    }

    clear() {

        this._gauges.clear();

        this._counters.clear();

        this._labels.clear();

    }

}
