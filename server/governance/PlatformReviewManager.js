/**
 * R9.0C — Periodic platform review generation.
 */

import { createPlatformReview } from "./models/PlatformReview.js";

export class PlatformReviewManager {

    constructor() {

        /** @type {ReturnType<typeof createPlatformReview>[]} */
        this._reviews = [];

    }

    clear() {

        this._reviews = [];

    }

    list() {

        return [...this._reviews].sort((a, b) => b.timestamp - a.timestamp);

    }

    getLatest() {

        return this._reviews.length
            ? this._reviews[this._reviews.length - 1]
            : null;

    }

    /**
     * @param {{
     *   audit?: object|null,
     *   compliance?: object|null,
     *   risk?: object|null,
     *   ctx?: object
     * }} input
     */
    review(input = {}) {

        const ctx = input.ctx ?? {};

        const audit = input.audit ?? {};

        const compliance = input.compliance ?? {};

        const risk = input.risk ?? {};

        const operations = ctx.operations ?? {};

        const recommendations = [];

        if ((compliance.failed ?? 0) > 0) {

            recommendations.push(
                "Resolve failed compliance items before next audit cycle."
            );

        }

        if ((risk.critical ?? 0) > 0) {

            recommendations.push(
                "Address CRITICAL risks immediately."
            );

        }

        if ((operations.incidentSummary?.openCritical ?? 0) > 0) {

            recommendations.push(
                "Close open CRITICAL operational incidents."
            );

        }

        if (recommendations.length === 0) {

            recommendations.push(
                "Continue scheduled governance cycles and evidence retention."
            );

        }

        const score = Math.round(
            (
                (audit.score ?? 0)
                + (compliance.score ?? 0)
                + (risk.score ?? 0)
                + (operations.operationalScore ?? 0)
            ) / 4
        );

        const review = createPlatformReview({
            operationalHealth: {
                score: operations.operationalScore ?? null,
                lifecycle: operations.lifecycle ?? null,
                healthStatus: ctx.health?.status ?? null
            },
            kpiOverview: {
                ...(operations.kpiSummary ?? {})
            },
            slaOverview: {
                ...(operations.slaSummary ?? {})
            },
            incidentSummary: {
                ...(operations.incidentSummary ?? {})
            },
            maintenanceHistory: {
                maintenanceActive: operations.maintenanceActive === true,
                maintenanceState: operations.maintenanceState ?? null
            },
            releaseHistory: {
                version: ctx.release?.version ?? null,
                channel: ctx.release?.channel ?? null,
                certification: ctx.certification?.status ?? null,
                gaLifecycle: ctx.ga?.lifecycle ?? null
            },
            riskSummary: {
                score: risk.score ?? null,
                critical: risk.critical ?? 0,
                high: risk.high ?? 0,
                highestSeverity: risk.highestSeverity ?? null
            },
            complianceSummary: {
                score: compliance.score ?? null,
                passed: compliance.passed ?? 0,
                warned: compliance.warned ?? 0,
                failed: compliance.failed ?? 0,
                compliant: compliance.compliant === true
            },
            recommendations,
            score
        });

        this._reviews.push(review);

        return review;

    }

    summary() {

        const latest = this.getLatest();

        return Object.freeze({
            total: this._reviews.length,
            latestId: latest?.id ?? null,
            latestScore: latest?.score ?? null,
            latestAt: latest?.timestamp ?? null
        });

    }

}
