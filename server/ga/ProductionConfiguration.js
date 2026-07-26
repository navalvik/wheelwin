/**
 * R9.0A — General Availability configuration (observational only).
 */

export const GA_LIFECYCLE = Object.freeze({
    READY_FOR_RELEASE: "READY_FOR_RELEASE",
    RELEASE_STARTED: "RELEASE_STARTED",
    ROLLOUT: "ROLLOUT",
    PRODUCTION_VERIFICATION: "PRODUCTION_VERIFICATION",
    GA_ACTIVE: "GA_ACTIVE",
    POST_LAUNCH_MONITORING: "POST_LAUNCH_MONITORING",
    STABLE_RELEASE: "STABLE_RELEASE"
});

export const GA_LIFECYCLE_ORDER = Object.freeze([
    GA_LIFECYCLE.READY_FOR_RELEASE,
    GA_LIFECYCLE.RELEASE_STARTED,
    GA_LIFECYCLE.ROLLOUT,
    GA_LIFECYCLE.PRODUCTION_VERIFICATION,
    GA_LIFECYCLE.GA_ACTIVE,
    GA_LIFECYCLE.POST_LAUNCH_MONITORING,
    GA_LIFECYCLE.STABLE_RELEASE
]);

export const ROLLOUT_STAGES = Object.freeze({
    INTERNAL: "INTERNAL",
    REGIONAL: "REGIONAL",
    GLOBAL: "GLOBAL",
    COMPLETED: "COMPLETED"
});

export const ROLLOUT_STAGE_ORDER = Object.freeze([
    ROLLOUT_STAGES.INTERNAL,
    ROLLOUT_STAGES.REGIONAL,
    ROLLOUT_STAGES.GLOBAL,
    ROLLOUT_STAGES.COMPLETED
]);

export const ROLLOUT_MODES = Object.freeze({
    SINGLE: "single",
    STAGED: "staged"
});

export const VERIFICATION_STATUS = Object.freeze({
    PENDING: "PENDING",
    RUNNING: "RUNNING",
    PASSED: "PASSED",
    PASSED_WITH_WARNINGS: "PASSED_WITH_WARNINGS",
    FAILED: "FAILED"
});

export const CHECK_STATUS = Object.freeze({
    PASS: "PASS",
    FAIL: "FAIL",
    WARN: "WARN",
    SKIP: "SKIP"
});

export const ROLLBACK_SEVERITY = Object.freeze({
    CRITICAL: "CRITICAL",
    HIGH: "HIGH",
    MEDIUM: "MEDIUM",
    LOW: "LOW"
});

/**
 * @param {object} [env]
 */
export function resolveGaConfig(env = process.env) {

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

    const modeRaw = env.GA_ROLLOUT_MODE === undefined
        || env.GA_ROLLOUT_MODE === null
        || env.GA_ROLLOUT_MODE === ""
        ? ROLLOUT_MODES.SINGLE
        : String(env.GA_ROLLOUT_MODE).trim().toLowerCase();

    if (!Object.values(ROLLOUT_MODES).includes(modeRaw)) {

        throw new Error("GA_ROLLOUT_MODE must be single or staged");

    }

    return Object.freeze({
        enabled: parseFlag("GA_RELEASE_ENABLED", true),
        rolloutMode: modeRaw,
        verifyAfterRelease: parseFlag("GA_VERIFY_AFTER_RELEASE", true),
        postLaunchMonitoringHours: parsePositiveInt(
            "GA_POST_LAUNCH_MONITORING_HOURS",
            72
        ),
        requireCertification: parseFlag("GA_REQUIRE_CERTIFICATION", true),
        reportRelativePath:
            "docs/release/R9.0A-General-Availability-Release-Report.md"
    });

}

export const ProductionConfiguration = Object.freeze({
    GA_LIFECYCLE,
    GA_LIFECYCLE_ORDER,
    ROLLOUT_STAGES,
    ROLLOUT_STAGE_ORDER,
    ROLLOUT_MODES,
    VERIFICATION_STATUS,
    CHECK_STATUS,
    ROLLBACK_SEVERITY,
    resolveGaConfig
});
