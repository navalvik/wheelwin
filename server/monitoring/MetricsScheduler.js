/**
 * R7.0E — Schedules collector runs asynchronously (setInterval + setImmediate).
 */

export class MetricsScheduler {

    constructor() {

        this._timers = new Map();

        this._running = false;

    }

    /**
     * @param {import("./MetricCollector.js").MetricCollector} collector
     * @param {(collector) => void} tick
     */
    register(collector, tick) {

        this.unregister(collector.name);

        const handle = setInterval(() => {

            setImmediate(() => {

                try {

                    tick(collector);

                } catch {

                    // never throw into the timer
                }

            });

        }, Math.max(50, collector.intervalMs));

        // Allow process to exit with open intervals in tests if unref'd
        if (typeof handle.unref === "function") {

            handle.unref();

        }

        this._timers.set(collector.name, handle);

        this._running = true;

    }

    unregister(name) {

        const handle = this._timers.get(name);

        if (handle) {

            clearInterval(handle);

            this._timers.delete(name);

        }

        if (this._timers.size === 0) {

            this._running = false;

        }

    }

    clear() {

        for (const name of [...this._timers.keys()]) {

            this.unregister(name);

        }

    }

    isRunning() {

        return this._running === true;

    }

    getRegisteredNames() {

        return [...this._timers.keys()];

    }

}
