import {
    DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS
} from "../lifecycle/ApplicationLifecycleStates.js";
import {
    LOG_FORMATS,
    LOG_LEVELS,
    defaultLogLevelForProfile,
    normalizeLogLevel
} from "../logging/levels.js";
import { parseBooleanStrict, parseIntegerStrict, isMissing } from "./parseHelpers.js";

export { LOG_LEVELS };

export function isDevelopment(nodeEnv) {

    return nodeEnv === "development";

}

export function isProduction(nodeEnv) {

    return nodeEnv === "production";

}

function resolveProfile(nodeEnv) {

    if (nodeEnv === "production") {

        return "production";

    }

    if (nodeEnv === "staging") {

        return "staging";

    }

    return "development";

}

function resolveLoggingConfig(env, profile, fallbackLevel) {

    const level = normalizeLogLevel(
        env.LOG_LEVEL,
        fallbackLevel ?? defaultLogLevelForProfile(profile)
    );

    const formatRaw = String(env.LOG_FORMAT || "").trim().toLowerCase();

    const format = formatRaw === LOG_FORMATS.CONSOLE
        ? LOG_FORMATS.CONSOLE
        : formatRaw === LOG_FORMATS.JSON || formatRaw === ""
            ? (profile === "development" ? LOG_FORMATS.CONSOLE : LOG_FORMATS.JSON)
            : null;

    if (format === null) {

        throw new Error("LOG_FORMAT must be json or console");

    }

    const enableConsole = isMissing(env.LOG_ENABLE_CONSOLE)
        ? true
        : parseBooleanStrict(env.LOG_ENABLE_CONSOLE).value === true;

    if (!isMissing(env.LOG_ENABLE_CONSOLE)
        && parseBooleanStrict(env.LOG_ENABLE_CONSOLE).ok !== true) {

        throw new Error("LOG_ENABLE_CONSOLE must be true or false");

    }

    const enableFileParse = parseBooleanStrict(env.LOG_ENABLE_FILE);

    if (!isMissing(env.LOG_ENABLE_FILE) && enableFileParse.ok !== true) {

        throw new Error("LOG_ENABLE_FILE must be true or false");

    }

    const enableFile = isMissing(env.LOG_ENABLE_FILE)
        ? profile !== "development"
        : enableFileParse.value === true;

    const directory = typeof env.LOG_DIRECTORY === "string"
        && env.LOG_DIRECTORY.trim()
        ? env.LOG_DIRECTORY.trim()
        : (enableFile ? "logs" : null);

    if (enableFile && !directory) {

        throw new Error("LOG_DIRECTORY is required when LOG_ENABLE_FILE=true");

    }

    const maxFileSizeMb = isMissing(env.LOG_MAX_FILE_SIZE_MB)
        ? 10
        : parseIntegerStrict(env.LOG_MAX_FILE_SIZE_MB).value;

    if (maxFileSizeMb == null || maxFileSizeMb <= 0) {

        throw new Error("LOG_MAX_FILE_SIZE_MB must be a positive integer");

    }

    const maxFiles = isMissing(env.LOG_MAX_FILES)
        ? 10
        : parseIntegerStrict(env.LOG_MAX_FILES).value;

    if (maxFiles == null || maxFiles <= 0) {

        throw new Error("LOG_MAX_FILES must be a positive integer");

    }

    const maxAgeDays = isMissing(env.LOG_MAX_AGE_DAYS)
        ? 14
        : parseIntegerStrict(env.LOG_MAX_AGE_DAYS).value;

    if (maxAgeDays == null || maxAgeDays <= 0) {

        throw new Error("LOG_MAX_AGE_DAYS must be a positive integer");

    }

    return {
        level,
        directory,
        maxFileSizeMb,
        maxFiles,
        maxAgeDays,
        format,
        enableConsole,
        enableFile
    };

}

function resolvePositiveInt(env, key, fallback) {

    if (isMissing(env[key])) {

        return fallback;

    }

    const parsed = parseIntegerStrict(env[key]);

    if (!parsed.ok || parsed.value <= 0) {

        throw new Error(`${key} must be a positive integer`);

    }

    return parsed.value;

}

function resolveMonitoringConfig(env, profile) {

    const enabledParse = parseBooleanStrict(env.MONITORING_ENABLED);

    if (!isMissing(env.MONITORING_ENABLED) && enabledParse.ok !== true) {

        throw new Error("MONITORING_ENABLED must be true or false");

    }

    const enabled = isMissing(env.MONITORING_ENABLED)
        ? true
        : enabledParse.value === true;

    const defaultInterval = resolvePositiveInt(
        env,
        "METRICS_COLLECTION_INTERVAL_MS",
        1000
    );

    const prometheusEnabledParse = parseBooleanStrict(env.PROMETHEUS_ENABLED);

    if (!isMissing(env.PROMETHEUS_ENABLED) && prometheusEnabledParse.ok !== true) {

        throw new Error("PROMETHEUS_ENABLED must be true or false");

    }

    const prometheusEnabled = isMissing(env.PROMETHEUS_ENABLED)
        ? false
        : prometheusEnabledParse.value === true;

    const prometheusPath = typeof env.PROMETHEUS_PATH === "string"
        && env.PROMETHEUS_PATH.trim()
        ? env.PROMETHEUS_PATH.trim()
        : "/metrics";

    if (!prometheusPath.startsWith("/")) {

        throw new Error("PROMETHEUS_PATH must start with /");

    }

    const prometheusPort = isMissing(env.PROMETHEUS_PORT)
        ? null
        : resolvePositiveInt(env, "PROMETHEUS_PORT", 0);

    if (prometheusPort != null
        && (prometheusPort < 1 || prometheusPort > 65535)) {

        throw new Error("PROMETHEUS_PORT must be between 1 and 65535");

    }

    return {
        enabled,
        intervals: {
            runtimeMs: resolvePositiveInt(
                env,
                "RUNTIME_COLLECTION_INTERVAL_MS",
                defaultInterval
            ),
            gameplayMs: resolvePositiveInt(
                env,
                "METRICS_COLLECTION_INTERVAL_MS",
                defaultInterval
            ),
            simulationMs: resolvePositiveInt(
                env,
                "SIMULATION_COLLECTION_INTERVAL_MS",
                500
            ),
            paymentMs: resolvePositiveInt(
                env,
                "PAYMENT_COLLECTION_INTERVAL_MS",
                5000
            ),
            recoveryMs: resolvePositiveInt(
                env,
                "RECOVERY_COLLECTION_INTERVAL_MS",
                5000
            ),
            systemMs: resolvePositiveInt(
                env,
                "SYSTEM_COLLECTION_INTERVAL_MS",
                5000
            )
        },
        prometheusEnabled,
        prometheusPort,
        prometheusPath,
        profile
    };

}

const BACKOFF_STRATEGIES = new Set([
    "fixed",
    "linear",
    "exponential",
    "exponential_jitter"
]);

function resolveNonNegativeInt(env, key, fallback) {

    if (isMissing(env[key])) {

        return fallback;

    }

    const parsed = parseIntegerStrict(env[key]);

    if (!parsed.ok || parsed.value < 0) {

        throw new Error(`${key} must be a non-negative integer`);

    }

    return parsed.value;

}

function resolveFailurePolicyConfig(env) {

    const enabledParse = parseBooleanStrict(env.FAILURE_POLICY_ENABLED);

    if (!isMissing(env.FAILURE_POLICY_ENABLED) && enabledParse.ok !== true) {

        throw new Error("FAILURE_POLICY_ENABLED must be true or false");

    }

    const enabled = isMissing(env.FAILURE_POLICY_ENABLED)
        ? true
        : enabledParse.value === true;

    const circuitEnabledParse = parseBooleanStrict(env.CIRCUIT_BREAKER_ENABLED);

    if (!isMissing(env.CIRCUIT_BREAKER_ENABLED)
        && circuitEnabledParse.ok !== true) {

        throw new Error("CIRCUIT_BREAKER_ENABLED must be true or false");

    }

    const circuitBreakerEnabled = isMissing(env.CIRCUIT_BREAKER_ENABLED)
        ? true
        : circuitEnabledParse.value === true;

    const backoffRaw = isMissing(env.BACKOFF_STRATEGY)
        ? "exponential_jitter"
        : String(env.BACKOFF_STRATEGY).trim().toLowerCase();

    if (!BACKOFF_STRATEGIES.has(backoffRaw)) {

        throw new Error(
            "BACKOFF_STRATEGY must be fixed, linear, exponential, or exponential_jitter"
        );

    }

    const initialDelayMs = resolveNonNegativeInt(
        env,
        "RETRY_INITIAL_DELAY_MS",
        200
    );

    const maxDelayMs = resolvePositiveInt(env, "RETRY_MAX_DELAY_MS", 30_000);

    if (maxDelayMs < initialDelayMs) {

        throw new Error(
            "RETRY_MAX_DELAY_MS must be greater than or equal to RETRY_INITIAL_DELAY_MS"
        );

    }

    return {
        enabled,
        maxAttempts: resolvePositiveInt(env, "RETRY_MAX_ATTEMPTS", 3),
        initialDelayMs,
        maxDelayMs,
        backoffStrategy: backoffRaw,
        circuitBreakerEnabled,
        circuitFailureThreshold: resolvePositiveInt(
            env,
            "CIRCUIT_FAILURE_THRESHOLD",
            5
        ),
        circuitRecoveryTimeoutMs: resolvePositiveInt(
            env,
            "CIRCUIT_RECOVERY_TIMEOUT_MS",
            30_000
        ),
        circuitSuccessThreshold: resolvePositiveInt(
            env,
            "CIRCUIT_SUCCESS_THRESHOLD",
            2
        ),
        historyLimit: resolvePositiveInt(env, "FAILURE_HISTORY_LIMIT", 100)
    };

}

function resolveDeploymentConfig(env, profile) {

    const parseFlag = (key, fallback = true) => {

        const parsed = parseBooleanStrict(env[key]);

        if (!isMissing(env[key]) && parsed.ok !== true) {

            throw new Error(`${key} must be true or false`);

        }

        return isMissing(env[key]) ? fallback : parsed.value === true;

    };

    const deploymentProfileRaw = isMissing(env.DEPLOYMENT_PROFILE)
        ? profile
        : String(env.DEPLOYMENT_PROFILE).trim().toLowerCase();

    if (!["development", "staging", "production"].includes(deploymentProfileRaw)) {

        throw new Error(
            "DEPLOYMENT_PROFILE must be development, staging, or production"
        );

    }

    const probeRefresh = isMissing(env.PROBE_REFRESH_INTERVAL_MS)
        ? null
        : resolvePositiveInt(env, "PROBE_REFRESH_INTERVAL_MS", 1000);

    if (probeRefresh != null && probeRefresh < 50) {

        throw new Error("PROBE_REFRESH_INTERVAL_MS must be >= 50");

    }

    return {
        profile: deploymentProfileRaw,
        healthEnabled: parseFlag("HEALTH_ENABLED", true),
        readinessEnabled: parseFlag("READINESS_ENABLED", true),
        livenessEnabled: parseFlag("LIVENESS_ENABLED", true),
        startupEnabled: parseFlag("STARTUP_PROBE_ENABLED", true),
        probeRefreshIntervalMs: probeRefresh
    };

}

function resolveReleaseConfig(env) {

    const parseFlag = (key, fallback = true) => {

        const parsed = parseBooleanStrict(env[key]);

        if (!isMissing(env[key]) && parsed.ok !== true) {

            throw new Error(`${key} must be true or false`);

        }

        return isMissing(env[key]) ? fallback : parsed.value === true;

    };

    const channelRaw = isMissing(env.RELEASE_CHANNEL)
        ? "development"
        : String(env.RELEASE_CHANNEL).trim().toLowerCase();

    const allowedChannels = [
        "development",
        "internal",
        "rc",
        "beta",
        "production"
    ];

    if (!allowedChannels.includes(channelRaw)) {

        throw new Error(
            "RELEASE_CHANNEL must be development, internal, rc, beta, or production"
        );

    }

    const outputDirectory = isMissing(env.RELEASE_OUTPUT_DIRECTORY)
        ? "release"
        : String(env.RELEASE_OUTPUT_DIRECTORY).trim();

    if (!outputDirectory) {

        throw new Error("RELEASE_OUTPUT_DIRECTORY must not be empty");

    }

    return {
        channel: channelRaw,
        outputDirectory,
        signingEnabled: parseFlag("RELEASE_SIGNING_ENABLED", false),
        generateChecksums: parseFlag("RELEASE_GENERATE_CHECKSUMS", true),
        includeDocs: parseFlag("RELEASE_INCLUDE_DOCS", true),
        includeReports: parseFlag("RELEASE_INCLUDE_REPORTS", true)
    };

}

function resolveClosedBetaConfig(env) {

    const parseFlag = (key, fallback) => {

        const parsed = parseBooleanStrict(env[key]);

        if (!isMissing(env[key]) && parsed.ok !== true) {

            throw new Error(`${key} must be true or false`);

        }

        return isMissing(env[key]) ? fallback : parsed.value === true;

    };

    let maxParticipants = 500;

    if (!isMissing(env.CLOSED_BETA_MAX_PARTICIPANTS)) {

        const n = Number(env.CLOSED_BETA_MAX_PARTICIPANTS);

        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {

            throw new Error(
                "CLOSED_BETA_MAX_PARTICIPANTS must be a positive integer"
            );

        }

        maxParticipants = n;

    }

    return {
        enabled: parseFlag("CLOSED_BETA_ENABLED", true),
        requireCertification: parseFlag(
            "CLOSED_BETA_REQUIRE_CERTIFICATION",
            true
        ),
        maxParticipants
    };

}

function resolveLaunchConfig(env) {

    const parseFlag = (key, fallback) => {

        const parsed = parseBooleanStrict(env[key]);

        if (!isMissing(env[key]) && parsed.ok !== true) {

            throw new Error(`${key} must be true or false`);

        }

        return isMissing(env[key]) ? fallback : parsed.value === true;

    };

    return {
        enabled: parseFlag("LAUNCH_READINESS_ENABLED", true),
        requireMainnetForGa: parseFlag("LAUNCH_REQUIRE_MAINNET_FOR_GA", true)
    };

}

export function loadProductionConfig(env = process.env, serverConfig = null) {

    const nodeEnv = serverConfig?.nodeEnv || env.NODE_ENV || "development";

    const development = isDevelopment(nodeEnv);

    const profile = resolveProfile(nodeEnv);

    const defaultLogLevel = defaultLogLevelForProfile(profile);

    const logging = resolveLoggingConfig(env, profile, defaultLogLevel);

    const monitoring = resolveMonitoringConfig(env, profile);

    const failurePolicy = resolveFailurePolicyConfig(env);

    const deployment = resolveDeploymentConfig(env, profile);

    const release = resolveReleaseConfig(env);

    const closedBeta = resolveClosedBetaConfig(env);

    const launch = resolveLaunchConfig(env);

    const rawTimeout = env.GRACEFUL_SHUTDOWN_TIMEOUT_MS;

    let gracefulShutdownTimeoutMs = DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS;

    if (rawTimeout !== undefined && rawTimeout !== "") {

        const parsed = Number(rawTimeout);

        if (!Number.isFinite(parsed) || parsed <= 0) {

            throw new Error(
                "GRACEFUL_SHUTDOWN_TIMEOUT_MS must be a positive number"
            );

        }

        gracefulShutdownTimeoutMs = parsed;

    }

    return {
        nodeEnv,
        isDevelopment: development,
        isProduction: isProduction(nodeEnv),
        logLevel: logging.level,
        logging,
        monitoring,
        failurePolicy,
        deployment,
        release,
        closedBeta,
        launch,
        metricsEnabled: development || env.METRICS_ENABLED === "true",
        runStartupDemonstrations: development
            && env.STARTUP_DEMONSTRATIONS !== "false",
        // Per-tick SimulationLoop tracing is an explicit opt-in debug flag, not a
        // general development log. The loop ticks continuously (even with no
        // active game), so logging every tick floods stdout and can stall the
        // event loop when the output consumer drains slowly — which starves the
        // Socket.IO lobby pipeline. Off by default; enable only when debugging.
        debugSimulationLoop: env.DEBUG_SIMULATION_LOOP === "true",
        // R7.0B — max wait for in-flight work during graceful drain.
        gracefulShutdownTimeoutMs
    };

}
