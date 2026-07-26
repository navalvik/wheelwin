/**
 * R9.0C — Immutable governance policy registry.
 */

import { createGovernancePolicy } from "./models/GovernancePolicy.js";
import { POLICY_APPROVAL } from "./GovernanceConfiguration.js";

export const DEFAULT_POLICIES = Object.freeze([
    Object.freeze({
        id: "operational-readiness",
        version: "1.0",
        description: "Platform must maintain operational readiness signals",
        validationRules: Object.freeze([
            "health.ready",
            "operations.enabled"
        ]),
        reviewIntervalDays: 90
    }),
    Object.freeze({
        id: "release-governance",
        version: "1.0",
        description: "Releases must be certified before GA/production use",
        validationRules: Object.freeze([
            "certification.passed",
            "release.artifacts"
        ]),
        reviewIntervalDays: 90
    }),
    Object.freeze({
        id: "configuration-consistency",
        version: "1.0",
        description: "Runtime configuration must be validated and consistent",
        validationRules: Object.freeze([
            "configuration.present",
            "configuration.profile"
        ]),
        reviewIntervalDays: 60
    }),
    Object.freeze({
        id: "monitoring-completeness",
        version: "1.0",
        description: "Monitoring collectors must be operational",
        validationRules: Object.freeze([
            "monitoring.enabled"
        ]),
        reviewIntervalDays: 30
    }),
    Object.freeze({
        id: "evidence-completeness",
        version: "1.0",
        description: "Operational and governance evidence must be retained",
        validationRules: Object.freeze([
            "evidence.present"
        ]),
        reviewIntervalDays: 90
    }),
    Object.freeze({
        id: "recovery-readiness",
        version: "1.0",
        description: "Failure recovery policies must be available",
        validationRules: Object.freeze([
            "recovery.available"
        ]),
        reviewIntervalDays: 90
    }),
    Object.freeze({
        id: "security-checklist",
        version: "1.0",
        description: "Security surfaces must remain non-debug in production profiles",
        validationRules: Object.freeze([
            "security.baseline"
        ]),
        reviewIntervalDays: 30
    }),
    Object.freeze({
        id: "documentation-completeness",
        version: "1.0",
        description: "Release and governance documentation must exist",
        validationRules: Object.freeze([
            "docs.release",
            "docs.governance"
        ]),
        reviewIntervalDays: 90
    })
]);

export class GovernancePolicyManager {

    constructor() {

        /** @type {Map<string, ReturnType<typeof createGovernancePolicy>>} */
        this._policies = new Map();

    }

    clear() {

        this._policies.clear();

    }

    loadDefaults(now = Date.now()) {

        this.clear();

        for (const p of DEFAULT_POLICIES) {

            this.register({
                ...p,
                effectiveDate: now,
                approvalStatus: POLICY_APPROVAL.APPROVED
            });

        }

        return this.list();

    }

    /**
     * @param {Parameters<typeof createGovernancePolicy>[0]} input
     */
    register(input) {

        const policy = createGovernancePolicy(input);

        this._policies.set(policy.id, policy);

        return policy;

    }

    get(id) {

        return this._policies.get(id) ?? null;

    }

    list() {

        return [...this._policies.values()];

    }

    summary() {

        const byStatus = Object.create(null);

        for (const s of Object.values(POLICY_APPROVAL)) {

            byStatus[s] = 0;

        }

        for (const p of this._policies.values()) {

            byStatus[p.approvalStatus] = (byStatus[p.approvalStatus] ?? 0) + 1;

        }

        return Object.freeze({
            total: this._policies.size,
            approved: byStatus[POLICY_APPROVAL.APPROVED] ?? 0,
            byStatus: Object.freeze({ ...byStatus })
        });

    }

}
