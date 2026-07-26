/**
 * R8.0E — Automatic launch decision computation.
 */

import {
    LAUNCH_DECISION,
    BLOCKER_SEVERITY
} from "./LaunchConfiguration.js";
import { createLaunchDecision } from "./models/LaunchDecision.js";

export class LaunchDecisionManager {

    /**
     * @param {{
     *   openBeta: object,
     *   production: object,
     *   evidenceHash?: string|null
     * }} input
     */
    decide(input) {

        const openBeta = input.openBeta ?? {};

        const production = input.production ?? {};

        const openBlockers = [...(openBeta.blockers ?? [])];

        const prodBlockers = [...(production.blockers ?? [])];

        const seen = new Set();

        const blockers = [];

        for (const b of [...openBlockers, ...prodBlockers]) {

            if (seen.has(b.id)) {

                continue;

            }

            seen.add(b.id);

            blockers.push(b);

        }

        const openCritical = openBlockers.filter(
            (b) => b.severity === BLOCKER_SEVERITY.CRITICAL
        );

        const prodCritical = prodBlockers.filter(
            (b) => b.severity === BLOCKER_SEVERITY.CRITICAL
        );

        const openBetaReady = openBeta.ready === true
            && openCritical.length === 0;

        // Only CRITICAL production blockers prevent Production Ready
        const productionReady = production.ready === true
            && prodCritical.length === 0
            && openBetaReady;

        const gaReady = openBetaReady
            && prodCritical.length === 0
            && (production.score ?? 0) >= 70;

        let decision = LAUNCH_DECISION.NOT_READY;

        let reason = "Launch evaluation incomplete or below thresholds";

        if (openCritical.length > 0) {

            decision = LAUNCH_DECISION.BLOCKED;

            reason = `${openCritical.length} CRITICAL Open Beta blocker(s)`;

        } else if (productionReady) {

            decision = LAUNCH_DECISION.READY_FOR_PRODUCTION;

            reason = "All CRITICAL gates passed; production readiness met";

        } else if (gaReady) {

            decision = LAUNCH_DECISION.READY_FOR_GA;

            reason = "Open Beta gates passed; GA review criteria met";

        } else if (openBetaReady) {

            decision = LAUNCH_DECISION.READY_FOR_OPEN_BETA;

            reason = prodCritical.length > 0
                ? `Open Beta ready; ${prodCritical.length} CRITICAL production gate(s) remain`
                : "Open Beta entry gates passed";

        } else if (openBlockers.length > 0) {

            decision = LAUNCH_DECISION.NOT_READY;

            reason = `${openBlockers.length} Open Beta gate(s) still failing`;

        }

        const score = Math.round(
            ((openBeta.score ?? 0) + (production.score ?? 0)) / 2
        );

        return createLaunchDecision({
            decision,
            score,
            reason,
            blockers,
            openBetaReady,
            gaReady,
            productionReady,
            evidenceHash: input.evidenceHash ?? null
        });

    }

}
