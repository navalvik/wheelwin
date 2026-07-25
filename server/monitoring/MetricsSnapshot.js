/**
 * R7.0E — Immutable metrics snapshot for health / console / exporters.
 */

export class MetricsSnapshot {

    /**
     * @param {{
     *   collectedAt: number,
     *   enabled: boolean,
     *   lifecycleState: string|null,
     *   collectors: object,
     *   runtime: object,
     *   gameplay: object,
     *   simulation: object,
     *   payments: object,
     *   recovery: object,
     *   developer: object,
     *   failure?: object,
     *   system: object,
     *   gauges: object,
     *   counters: object
     * }} input
     */
    constructor(input) {

        this.collectedAt = input.collectedAt;

        this.enabled = input.enabled === true;

        this.lifecycleState = input.lifecycleState ?? null;

        this.collectors = Object.freeze({ ...(input.collectors ?? {}) });

        this.runtime = Object.freeze({ ...(input.runtime ?? {}) });

        this.gameplay = Object.freeze({ ...(input.gameplay ?? {}) });

        this.simulation = Object.freeze({ ...(input.simulation ?? {}) });

        this.payments = Object.freeze({ ...(input.payments ?? {}) });

        this.recovery = Object.freeze({ ...(input.recovery ?? {}) });

        this.developer = Object.freeze({ ...(input.developer ?? {}) });

        this.failure = Object.freeze({ ...(input.failure ?? {}) });

        this.system = Object.freeze({ ...(input.system ?? {}) });

        this.gauges = Object.freeze({ ...(input.gauges ?? {}) });

        this.counters = Object.freeze({ ...(input.counters ?? {}) });

        Object.freeze(this);

    }

    /**
     * Safe summary — no secrets, no absolute paths.
     */
    toSafeSummary() {

        return Object.freeze({
            enabled: this.enabled,
            collectedAt: this.collectedAt,
            freshnessMs: Math.max(0, Date.now() - this.collectedAt),
            lifecycleState: this.lifecycleState,
            collectors: this.collectors,
            runtime: this.runtime,
            gameplay: this.gameplay,
            simulation: this.simulation,
            payments: this.payments,
            recovery: this.recovery,
            developer: this.developer,
            failure: this.failure,
            system: this.system
        });

    }

}
