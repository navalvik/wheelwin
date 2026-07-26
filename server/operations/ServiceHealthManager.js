/**
 * R9.0B — Aggregated service health view (read-only providers).
 */

export class ServiceHealthManager {

    constructor() {

        this._latest = null;

    }

    /**
     * @param {object} ctx
     */
    assess(ctx = {}) {

        const health = ctx.health ?? {};

        const monitoring = ctx.monitoring ?? {};

        const deployment = ctx.deployment ?? {};

        const ga = ctx.ga ?? {};

        let score = 100;

        if (health.ready === false || health.status === "not_ready") {

            score -= 40;

        } else if (health.status === "degraded") {

            score -= 15;

        }

        if (monitoring.enabled === false) {

            score -= 10;

        }

        if (deployment.overall === "unhealthy") {

            score -= 30;

        }

        if (ga.rollbackRecommended === true) {

            score -= 20;

        }

        score = Math.max(0, Math.min(100, score));

        this._latest = Object.freeze({
            assessedAt: Date.now(),
            score,
            healthStatus: health.status ?? null,
            healthReady: health.ready === true,
            monitoringEnabled: monitoring.enabled !== false,
            deploymentOverall: deployment.overall ?? null,
            gaLifecycle: ga.lifecycle ?? null
        });

        return this._latest;

    }

    getLatest() {

        return this._latest;

    }

}
