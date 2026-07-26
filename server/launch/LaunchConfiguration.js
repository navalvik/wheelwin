/**
 * R8.0E — Launch readiness configuration (observational only).
 */

export const LAUNCH_LIFECYCLE = Object.freeze({
    NOT_EVALUATED: "NOT_EVALUATED",
    CLOSED_BETA_REVIEW: "CLOSED_BETA_REVIEW",
    OPEN_BETA_APPROVED: "OPEN_BETA_APPROVED",
    OPEN_BETA_RUNNING: "OPEN_BETA_RUNNING",
    GA_REVIEW: "GA_REVIEW",
    GA_APPROVED: "GA_APPROVED",
    PRODUCTION_READY: "PRODUCTION_READY"
});

export const LAUNCH_LIFECYCLE_ORDER = Object.freeze([
    LAUNCH_LIFECYCLE.NOT_EVALUATED,
    LAUNCH_LIFECYCLE.CLOSED_BETA_REVIEW,
    LAUNCH_LIFECYCLE.OPEN_BETA_APPROVED,
    LAUNCH_LIFECYCLE.OPEN_BETA_RUNNING,
    LAUNCH_LIFECYCLE.GA_REVIEW,
    LAUNCH_LIFECYCLE.GA_APPROVED,
    LAUNCH_LIFECYCLE.PRODUCTION_READY
]);

export const LAUNCH_DECISION = Object.freeze({
    NOT_READY: "NOT_READY",
    READY_FOR_OPEN_BETA: "READY_FOR_OPEN_BETA",
    READY_FOR_GA: "READY_FOR_GA",
    READY_FOR_PRODUCTION: "READY_FOR_PRODUCTION",
    BLOCKED: "BLOCKED"
});

export const GATE_STATUS = Object.freeze({
    PASS: "PASS",
    FAIL: "FAIL",
    WARN: "WARN",
    SKIP: "SKIP"
});

export const BLOCKER_SEVERITY = Object.freeze({
    CRITICAL: "CRITICAL",
    HIGH: "HIGH",
    MEDIUM: "MEDIUM",
    LOW: "LOW"
});

export const OPEN_BETA_THRESHOLDS = Object.freeze({
    maxCrashRate: 0.05,
    minRecoverySuccessRate: 0.95,
    minSettlementSuccessRate: 0.95,
    maxAverageLatencyMs: 250
});

export const PRODUCTION_THRESHOLDS = Object.freeze({
    minDocumentationCompleteness: 0.9,
    minOperationalScore: 80
});

/**
 * @param {object} [env]
 */
export function resolveLaunchConfig(env = process.env) {

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

    return Object.freeze({
        enabled: parseFlag("LAUNCH_READINESS_ENABLED", true),
        openBetaReportRelativePath:
            "docs/release/R8.0E-Open-Beta-Readiness-Report.md",
        productionReportRelativePath:
            "docs/release/R8.0E-Production-Launch-Readiness-Report.md",
        closedBetaReportRelativePath:
            "docs/release/R8.0D-Closed-Beta-Report.md",
        requireMainnetForGa: parseFlag("LAUNCH_REQUIRE_MAINNET_FOR_GA", true),
        thresholds: Object.freeze({
            ...OPEN_BETA_THRESHOLDS,
            ...PRODUCTION_THRESHOLDS
        })
    });

}

export const LaunchConfiguration = Object.freeze({
    LAUNCH_LIFECYCLE,
    LAUNCH_LIFECYCLE_ORDER,
    LAUNCH_DECISION,
    GATE_STATUS,
    BLOCKER_SEVERITY,
    OPEN_BETA_THRESHOLDS,
    PRODUCTION_THRESHOLDS,
    resolveLaunchConfig
});
