/**
 * R8.0D — Closed Beta configuration constants and env resolution.
 * Observational only — does not affect gameplay.
 */

export const BETA_LIFECYCLE = Object.freeze({
    NOT_STARTED: "NOT_STARTED",
    INVITATION: "INVITATION",
    ACTIVE: "ACTIVE",
    MONITORING: "MONITORING",
    READY_FOR_REVIEW: "READY_FOR_REVIEW",
    COMPLETED: "COMPLETED",
    OPEN_BETA_READY: "OPEN_BETA_READY"
});

export const BETA_LIFECYCLE_ORDER = Object.freeze([
    BETA_LIFECYCLE.NOT_STARTED,
    BETA_LIFECYCLE.INVITATION,
    BETA_LIFECYCLE.ACTIVE,
    BETA_LIFECYCLE.MONITORING,
    BETA_LIFECYCLE.READY_FOR_REVIEW,
    BETA_LIFECYCLE.COMPLETED,
    BETA_LIFECYCLE.OPEN_BETA_READY
]);

export const BETA_READINESS = Object.freeze({
    NOT_READY: "NOT_READY",
    NEEDS_ATTENTION: "NEEDS_ATTENTION",
    READY_FOR_OPEN_BETA: "READY_FOR_OPEN_BETA"
});

export const PARTICIPANT_TAGS = Object.freeze([
    "internal",
    "qa",
    "trusted",
    "community"
]);

export const PARTICIPANT_APPROVAL = Object.freeze({
    INVITED: "INVITED",
    PENDING: "PENDING",
    APPROVED: "APPROVED",
    ACTIVE: "ACTIVE",
    SUSPENDED: "SUSPENDED",
    REVOKED: "REVOKED"
});

export const FEEDBACK_CATEGORIES = Object.freeze([
    "Gameplay",
    "Performance",
    "UI",
    "Blockchain",
    "Networking",
    "Audio",
    "Visual",
    "Other"
]);

export const FEEDBACK_SEVERITY = Object.freeze({
    CRITICAL: "CRITICAL",
    HIGH: "HIGH",
    MEDIUM: "MEDIUM",
    LOW: "LOW"
});

export const FEEDBACK_STATUS = Object.freeze({
    OPEN: "OPEN",
    ACKNOWLEDGED: "ACKNOWLEDGED",
    INVESTIGATING: "INVESTIGATING",
    RESOLVED: "RESOLVED",
    REJECTED: "REJECTED"
});

export const INCIDENT_SEVERITY = Object.freeze({
    CRITICAL: "CRITICAL",
    HIGH: "HIGH",
    MEDIUM: "MEDIUM",
    LOW: "LOW"
});

export const INCIDENT_STATUS = Object.freeze({
    OPEN: "OPEN",
    INVESTIGATING: "INVESTIGATING",
    MITIGATED: "MITIGATED",
    RESOLVED: "RESOLVED",
    WONT_FIX: "WONT_FIX"
});

/**
 * @param {object} [env]
 * @returns {Readonly<{
 *   enabled: boolean,
 *   requireCertification: boolean,
 *   maxParticipants: number,
 *   maxCrashReports: number,
 *   maxFeedback: number,
 *   maxIncidents: number,
 *   reportRelativePath: string
 * }>}
 */
export function resolveBetaConfig(env = process.env) {

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

        if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {

            throw new Error(`${key} must be a positive integer`);

        }

        return n;

    };

    return Object.freeze({
        enabled: parseFlag("CLOSED_BETA_ENABLED", true),
        requireCertification: parseFlag(
            "CLOSED_BETA_REQUIRE_CERTIFICATION",
            true
        ),
        maxParticipants: parsePositiveInt("CLOSED_BETA_MAX_PARTICIPANTS", 500),
        maxCrashReports: parsePositiveInt("CLOSED_BETA_MAX_CRASH_REPORTS", 200),
        maxFeedback: parsePositiveInt("CLOSED_BETA_MAX_FEEDBACK", 500),
        maxIncidents: parsePositiveInt("CLOSED_BETA_MAX_INCIDENTS", 200),
        reportRelativePath: "docs/release/R8.0D-Closed-Beta-Report.md"
    });

}

export const BetaConfiguration = Object.freeze({
    BETA_LIFECYCLE,
    BETA_LIFECYCLE_ORDER,
    BETA_READINESS,
    PARTICIPANT_TAGS,
    PARTICIPANT_APPROVAL,
    FEEDBACK_CATEGORIES,
    FEEDBACK_SEVERITY,
    FEEDBACK_STATUS,
    INCIDENT_SEVERITY,
    INCIDENT_STATUS,
    resolveBetaConfig
});
