/**
 * R9.0A — Rollback recommendation coordinator (CRITICAL only).
 */

import { ROLLBACK_SEVERITY } from "./ProductionConfiguration.js";
import { createRollbackDecision } from "./models/RollbackDecision.js";

export class RollbackCoordinator {

    /**
     * @param {{
     *   verification?: object|null,
     *   incidents?: object|null,
     *   closedBeta?: object|null,
     *   health?: object|null,
     *   payments?: object|null,
     *   settlement?: object|null,
     *   security?: object|null,
     *   infrastructure?: object|null,
     *   explicitTriggers?: object[]
     * }} ctx
     */
    evaluate(ctx = {}) {

        const triggers = [];

        const push = (id, category, detail) => {

            triggers.push(Object.freeze({
                id,
                category,
                severity: ROLLBACK_SEVERITY.CRITICAL,
                detail: String(detail).slice(0, 200)
            }));

        };

        for (const t of ctx.explicitTriggers ?? []) {

            if (t.severity === ROLLBACK_SEVERITY.CRITICAL) {

                push(
                    t.id || "explicit",
                    t.category || "explicit",
                    t.detail || t.reason || "Critical trigger"
                );

            }

        }

        const verification = ctx.verification ?? null;

        if (verification?.status === "FAILED") {

            const critical = (verification.checks ?? []).filter(
                (c) => c.status === "FAIL"
                    && c.severity === ROLLBACK_SEVERITY.CRITICAL
            );

            if (critical.length > 0) {

                push(
                    "critical_verification_failure",
                    "deployment",
                    `${critical.length} CRITICAL verification check(s) failed`
                );

            }

        }

        const openCritical = Number(
            ctx.incidents?.openCritical
            ?? ctx.closedBeta?.incidents?.openCritical
            ?? 0
        );

        if (openCritical > 0) {

            push(
                "critical_production_incident",
                "incident",
                `${openCritical} open CRITICAL incident(s)`
            );

        }

        if (ctx.payments?.criticalFailure === true
            || Number(ctx.payments?.criticalFailures ?? 0) > 0) {

            push(
                "critical_payment_failure",
                "payment",
                "Critical payment failure observed"
            );

        }

        if (ctx.settlement?.criticalFailure === true
            || Number(ctx.settlement?.criticalFailures ?? 0) > 0) {

            push(
                "critical_settlement_failure",
                "settlement",
                "Critical settlement failure observed"
            );

        }

        if (ctx.security?.criticalEvent === true
            || Number(ctx.security?.criticalEvents ?? 0) > 0) {

            push(
                "critical_security_event",
                "security",
                "Critical security event observed"
            );

        }

        if (ctx.infrastructure?.criticalFailure === true
            || ctx.health?.status === "not_ready"
            || (ctx.health?.ready === false
                && ctx.health?.shuttingDown !== true
                && ctx.allowNotReady !== true)) {

            // Only count infrastructure if explicitly marked critical
            // or deployment overall unhealthy
            if (ctx.infrastructure?.criticalFailure === true
                || ctx.deployment?.overall === "unhealthy") {

                push(
                    "critical_infrastructure_failure",
                    "infrastructure",
                    "Critical infrastructure failure observed"
                );

            }

        }

        const recommend = triggers.length > 0;

        return createRollbackDecision({
            recommend,
            severity: recommend ? ROLLBACK_SEVERITY.CRITICAL : null,
            triggers,
            reason: recommend
                ? `${triggers.length} CRITICAL rollback trigger(s)`
                : "No CRITICAL rollback triggers"
        });

    }

}
