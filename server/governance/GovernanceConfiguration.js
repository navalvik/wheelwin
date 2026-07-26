/**
 * R9.0C — Platform governance configuration (observational only).
 */

export const GOVERNANCE_LIFECYCLE = Object.freeze({
    PLATFORM_ACTIVE: "PLATFORM_ACTIVE",
    AUDIT_WINDOW: "AUDIT_WINDOW",
    COMPLIANCE_VALIDATION: "COMPLIANCE_VALIDATION",
    RISK_REVIEW: "RISK_REVIEW",
    PLATFORM_REVIEW: "PLATFORM_REVIEW",
    GOVERNANCE_APPROVED: "GOVERNANCE_APPROVED",
    NEXT_AUDIT_CYCLE: "NEXT_AUDIT_CYCLE"
});

export const GOVERNANCE_LIFECYCLE_ORDER = Object.freeze([
    GOVERNANCE_LIFECYCLE.PLATFORM_ACTIVE,
    GOVERNANCE_LIFECYCLE.AUDIT_WINDOW,
    GOVERNANCE_LIFECYCLE.COMPLIANCE_VALIDATION,
    GOVERNANCE_LIFECYCLE.RISK_REVIEW,
    GOVERNANCE_LIFECYCLE.PLATFORM_REVIEW,
    GOVERNANCE_LIFECYCLE.GOVERNANCE_APPROVED,
    GOVERNANCE_LIFECYCLE.NEXT_AUDIT_CYCLE
]);

export const COMPLIANCE_STATUS = Object.freeze({
    PASSED: "PASSED",
    WARNING: "WARNING",
    FAILED: "FAILED"
});

export const RISK_SEVERITY = Object.freeze({
    LOW: "LOW",
    MEDIUM: "MEDIUM",
    HIGH: "HIGH",
    CRITICAL: "CRITICAL"
});

export const RISK_CATEGORY = Object.freeze({
    OPERATIONAL: "Operational",
    INFRASTRUCTURE: "Infrastructure",
    RELEASE: "Release",
    PAYMENT: "Payment",
    RECOVERY: "Recovery",
    MONITORING: "Monitoring",
    GOVERNANCE: "Governance"
});

export const POLICY_APPROVAL = Object.freeze({
    DRAFT: "DRAFT",
    APPROVED: "APPROVED",
    SUPERSEDED: "SUPERSEDED",
    RETIRED: "RETIRED"
});

export const CHANGE_STATUS = Object.freeze({
    PROPOSED: "PROPOSED",
    REVIEWED: "REVIEWED",
    APPROVED: "APPROVED",
    REJECTED: "REJECTED",
    RECORDED: "RECORDED"
});

export const DECISION_STATUS = Object.freeze({
    PENDING: "PENDING",
    APPROVED: "APPROVED",
    CONDITIONAL: "CONDITIONAL",
    REJECTED: "REJECTED"
});

/**
 * @param {object} [env]
 */
export function resolveGovernanceConfig(env = process.env) {

    const parseFlag = (key, fallback) => {

        const raw = env[key];

        if (raw === undefined || raw === null || raw === "") {

            return fallback;

        }

        const v = String(raw).trim().toLowerCase();

        if (v === "true" || v === "1" || v === "yes") {

            return true;

        }

        if (v === "false" || v === "0" || v === "no") {

            return false;

        }

        throw new Error(`${key} must be true or false`);

    };

    const parsePositiveInt = (key, fallback) => {

        const raw = env[key];

        if (raw === undefined || raw === null || raw === "") {

            return fallback;

        }

        const n = Number(raw);

        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {

            throw new Error(`${key} must be a positive integer`);

        }

        return n;

    };

    return Object.freeze({
        enabled: parseFlag("GOVERNANCE_ENABLED", true),
        auditIntervalDays: parsePositiveInt("AUDIT_INTERVAL_DAYS", 30),
        complianceRequired: parseFlag("COMPLIANCE_REQUIRED", true),
        riskReviewIntervalDays: parsePositiveInt(
            "RISK_REVIEW_INTERVAL_DAYS",
            30
        ),
        evidenceRetentionDays: parsePositiveInt(
            "EVIDENCE_RETENTION_DAYS",
            365
        ),
        platformReviewIntervalDays: parsePositiveInt(
            "PLATFORM_REVIEW_INTERVAL_DAYS",
            90
        ),
        reportRelativePath:
            "docs/release/R9.0C-Platform-Governance-Report.md",
        maxTrailEntries: 1000,
        maxArchiveEntries: 500
    });

}

export const GovernanceConfiguration = Object.freeze({
    GOVERNANCE_LIFECYCLE,
    GOVERNANCE_LIFECYCLE_ORDER,
    COMPLIANCE_STATUS,
    RISK_SEVERITY,
    RISK_CATEGORY,
    POLICY_APPROVAL,
    CHANGE_STATUS,
    DECISION_STATUS,
    resolveGovernanceConfig
});
