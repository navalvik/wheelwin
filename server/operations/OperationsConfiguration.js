/**
 * R9.0B — Post-launch operations configuration (observational only).
 */

export const SERVICE_LIFECYCLE = Object.freeze({
    GA_ACTIVE: "GA_ACTIVE",
    NORMAL_OPERATION: "NORMAL_OPERATION",
    MAINTENANCE_SCHEDULED: "MAINTENANCE_SCHEDULED",
    MAINTENANCE_ACTIVE: "MAINTENANCE_ACTIVE",
    POST_MAINTENANCE_VERIFICATION: "POST_MAINTENANCE_VERIFICATION",
    SERVICE_RETIREMENT: "SERVICE_RETIREMENT"
});

export const SERVICE_LIFECYCLE_ORDER = Object.freeze([
    SERVICE_LIFECYCLE.GA_ACTIVE,
    SERVICE_LIFECYCLE.NORMAL_OPERATION,
    SERVICE_LIFECYCLE.MAINTENANCE_SCHEDULED,
    SERVICE_LIFECYCLE.MAINTENANCE_ACTIVE,
    SERVICE_LIFECYCLE.POST_MAINTENANCE_VERIFICATION,
    SERVICE_LIFECYCLE.NORMAL_OPERATION,
    SERVICE_LIFECYCLE.SERVICE_RETIREMENT
]);

export const VERSION_SUPPORT_STATUS = Object.freeze({
    ACTIVE: "ACTIVE",
    SUPPORTED: "SUPPORTED",
    DEPRECATED: "DEPRECATED",
    RETIRED: "RETIRED"
});

export const SLA_STATUS = Object.freeze({
    PASSED: "PASSED",
    WARNING: "WARNING",
    FAILED: "FAILED"
});

export const INCIDENT_SEVERITY = Object.freeze({
    LOW: "LOW",
    MEDIUM: "MEDIUM",
    HIGH: "HIGH",
    CRITICAL: "CRITICAL"
});

export const ESCALATION_LEVEL = Object.freeze({
    LEVEL_1: "LEVEL_1",
    LEVEL_2: "LEVEL_2",
    LEVEL_3: "LEVEL_3",
    ROOT_CAUSE_ANALYSIS: "ROOT_CAUSE_ANALYSIS"
});

export const MAINTENANCE_TYPE = Object.freeze({
    SCHEDULED: "SCHEDULED",
    EMERGENCY: "EMERGENCY"
});

export const MAINTENANCE_OUTCOME = Object.freeze({
    PENDING: "PENDING",
    IN_PROGRESS: "IN_PROGRESS",
    VERIFIED: "VERIFIED",
    COMPLETED: "COMPLETED",
    FAILED: "FAILED",
    CANCELLED: "CANCELLED"
});

/**
 * @param {object} [env]
 */
export function resolveOperationsConfig(env = process.env) {

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

    const parseNumber = (key, fallback, { min = null, integer = false } = {}) => {

        const raw = env[key];

        if (raw === undefined || raw === null || raw === "") {

            return fallback;

        }

        const n = Number(raw);

        if (!Number.isFinite(n)) {

            throw new Error(`${key} must be a number`);

        }

        if (integer && !Number.isInteger(n)) {

            throw new Error(`${key} must be an integer`);

        }

        if (min != null && n < min) {

            throw new Error(`${key} must be >= ${min}`);

        }

        return n;

    };

    return Object.freeze({
        enabled: parseFlag("OPERATIONS_ENABLED", true),
        slaAvailabilityTarget: parseNumber(
            "SLA_AVAILABILITY_TARGET",
            0.995,
            { min: 0 }
        ),
        slaLatencyTargetMs: parseNumber(
            "SLA_LATENCY_TARGET_MS",
            250,
            { min: 1, integer: true }
        ),
        slaRecoveryTarget: parseNumber(
            "SLA_RECOVERY_TARGET",
            0.95,
            { min: 0 }
        ),
        slaSettlementTarget: parseNumber(
            "SLA_SETTLEMENT_TARGET",
            0.95,
            { min: 0 }
        ),
        maintenanceDefaultDurationMinutes: parseNumber(
            "MAINTENANCE_DEFAULT_DURATION_MINUTES",
            60,
            { min: 1, integer: true }
        ),
        versionSupportWindowDays: parseNumber(
            "VERSION_SUPPORT_WINDOW_DAYS",
            90,
            { min: 1, integer: true }
        ),
        reportRelativePath:
            "docs/release/R9.0B-Post-Launch-Operations-Report.md",
        maxTrendSamples: 100,
        maxIncidents: 500
    });

}

export const OperationsConfiguration = Object.freeze({
    SERVICE_LIFECYCLE,
    VERSION_SUPPORT_STATUS,
    SLA_STATUS,
    INCIDENT_SEVERITY,
    ESCALATION_LEVEL,
    MAINTENANCE_TYPE,
    MAINTENANCE_OUTCOME,
    resolveOperationsConfig
});
