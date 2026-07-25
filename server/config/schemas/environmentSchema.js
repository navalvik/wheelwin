/**
 * R7.0C — Environment / server configuration schema metadata.
 */

export const ENVIRONMENT_SCHEMA = Object.freeze({
    PORT: Object.freeze({
        key: "PORT",
        type: "integer",
        required: true,
        min: 1,
        max: 65535,
        category: "Server",
        suggestedFix: "Set PORT to an integer between 1 and 65535 (e.g. 3001)."
    }),
    HOST: Object.freeze({
        key: "HOST",
        type: "string",
        required: true,
        category: "Server",
        suggestedFix: "Set HOST (e.g. 0.0.0.0)."
    }),
    CLIENT_ORIGIN: Object.freeze({
        key: "CLIENT_ORIGIN",
        type: "string",
        required: true,
        category: "Server",
        suggestedFix: "Set CLIENT_ORIGIN to the frontend origin (e.g. http://localhost:5173)."
    }),
    NODE_ENV: Object.freeze({
        key: "NODE_ENV",
        type: "enum",
        required: false,
        allowed: Object.freeze(["development", "staging", "production"]),
        defaultValue: "development",
        category: "Server",
        suggestedFix: "Set NODE_ENV to development, staging, or production."
    }),
    ROOM_MAX_PLAYERS: Object.freeze({
        key: "ROOM_MAX_PLAYERS",
        type: "integer",
        required: true,
        min: 1,
        category: "Simulation",
        suggestedFix: "Set ROOM_MAX_PLAYERS to a positive integer (e.g. 3)."
    }),
    ROOM_MAX_CONCURRENT: Object.freeze({
        key: "ROOM_MAX_CONCURRENT",
        type: "integer",
        required: false,
        min: 1,
        category: "Simulation",
        suggestedFix: "Set ROOM_MAX_CONCURRENT to a positive integer."
    }),
    GRACEFUL_SHUTDOWN_TIMEOUT_MS: Object.freeze({
        key: "GRACEFUL_SHUTDOWN_TIMEOUT_MS",
        type: "integer",
        required: false,
        min: 1,
        category: "Lifecycle",
        suggestedFix: "Set GRACEFUL_SHUTDOWN_TIMEOUT_MS to a positive integer (e.g. 30000)."
    }),
    LOG_LEVEL: Object.freeze({
        key: "LOG_LEVEL",
        type: "enum",
        required: false,
        allowed: Object.freeze([
            "fatal",
            "error",
            "warn",
            "info",
            "debug",
            "trace"
        ]),
        category: "Logging",
        suggestedFix: "Set LOG_LEVEL to fatal, error, warn, info, debug, or trace."
    }),
    LOG_DIRECTORY: Object.freeze({
        key: "LOG_DIRECTORY",
        type: "string",
        required: false,
        category: "Logging",
        suggestedFix: "Set LOG_DIRECTORY to a writable directory path (e.g. logs)."
    }),
    LOG_MAX_FILE_SIZE_MB: Object.freeze({
        key: "LOG_MAX_FILE_SIZE_MB",
        type: "integer",
        required: false,
        min: 1,
        category: "Logging",
        suggestedFix: "Set LOG_MAX_FILE_SIZE_MB to a positive integer."
    }),
    LOG_MAX_FILES: Object.freeze({
        key: "LOG_MAX_FILES",
        type: "integer",
        required: false,
        min: 1,
        category: "Logging",
        suggestedFix: "Set LOG_MAX_FILES to a positive integer."
    }),
    LOG_MAX_AGE_DAYS: Object.freeze({
        key: "LOG_MAX_AGE_DAYS",
        type: "integer",
        required: false,
        min: 1,
        category: "Logging",
        suggestedFix: "Set LOG_MAX_AGE_DAYS to a positive integer."
    }),
    LOG_FORMAT: Object.freeze({
        key: "LOG_FORMAT",
        type: "enum",
        required: false,
        allowed: Object.freeze(["json", "console"]),
        category: "Logging",
        suggestedFix: "Set LOG_FORMAT to json or console."
    }),
    LOG_ENABLE_CONSOLE: Object.freeze({
        key: "LOG_ENABLE_CONSOLE",
        type: "boolean",
        required: false,
        category: "Logging",
        suggestedFix: "Set LOG_ENABLE_CONSOLE to true or false."
    }),
    LOG_ENABLE_FILE: Object.freeze({
        key: "LOG_ENABLE_FILE",
        type: "boolean",
        required: false,
        category: "Logging",
        suggestedFix: "Set LOG_ENABLE_FILE to true or false."
    }),
    MONITORING_ENABLED: Object.freeze({
        key: "MONITORING_ENABLED",
        type: "boolean",
        required: false,
        category: "Metrics",
        suggestedFix: "Set MONITORING_ENABLED to true or false."
    }),
    METRICS_COLLECTION_INTERVAL_MS: Object.freeze({
        key: "METRICS_COLLECTION_INTERVAL_MS",
        type: "integer",
        required: false,
        min: 50,
        category: "Metrics",
        suggestedFix: "Set METRICS_COLLECTION_INTERVAL_MS to an integer >= 50."
    }),
    RUNTIME_COLLECTION_INTERVAL_MS: Object.freeze({
        key: "RUNTIME_COLLECTION_INTERVAL_MS",
        type: "integer",
        required: false,
        min: 50,
        category: "Metrics",
        suggestedFix: "Set RUNTIME_COLLECTION_INTERVAL_MS to an integer >= 50."
    }),
    SIMULATION_COLLECTION_INTERVAL_MS: Object.freeze({
        key: "SIMULATION_COLLECTION_INTERVAL_MS",
        type: "integer",
        required: false,
        min: 50,
        category: "Metrics",
        suggestedFix: "Set SIMULATION_COLLECTION_INTERVAL_MS to an integer >= 50."
    }),
    PAYMENT_COLLECTION_INTERVAL_MS: Object.freeze({
        key: "PAYMENT_COLLECTION_INTERVAL_MS",
        type: "integer",
        required: false,
        min: 50,
        category: "Metrics",
        suggestedFix: "Set PAYMENT_COLLECTION_INTERVAL_MS to an integer >= 50."
    }),
    RECOVERY_COLLECTION_INTERVAL_MS: Object.freeze({
        key: "RECOVERY_COLLECTION_INTERVAL_MS",
        type: "integer",
        required: false,
        min: 50,
        category: "Metrics",
        suggestedFix: "Set RECOVERY_COLLECTION_INTERVAL_MS to an integer >= 50."
    }),
    SYSTEM_COLLECTION_INTERVAL_MS: Object.freeze({
        key: "SYSTEM_COLLECTION_INTERVAL_MS",
        type: "integer",
        required: false,
        min: 50,
        category: "Metrics",
        suggestedFix: "Set SYSTEM_COLLECTION_INTERVAL_MS to an integer >= 50."
    }),
    PROMETHEUS_ENABLED: Object.freeze({
        key: "PROMETHEUS_ENABLED",
        type: "boolean",
        required: false,
        category: "Metrics",
        suggestedFix: "Set PROMETHEUS_ENABLED to true or false."
    }),
    PROMETHEUS_PORT: Object.freeze({
        key: "PROMETHEUS_PORT",
        type: "integer",
        required: false,
        min: 1,
        max: 65535,
        category: "Metrics",
        suggestedFix: "Set PROMETHEUS_PORT to an integer between 1 and 65535."
    }),
    PROMETHEUS_PATH: Object.freeze({
        key: "PROMETHEUS_PATH",
        type: "string",
        required: false,
        category: "Metrics",
        suggestedFix: "Set PROMETHEUS_PATH to a path starting with / (e.g. /metrics)."
    }),
    METRICS_ENABLED: Object.freeze({
        key: "METRICS_ENABLED",
        type: "boolean",
        required: false,
        category: "Metrics",
        suggestedFix: "Set METRICS_ENABLED to true or false."
    }),
    STARTUP_DEMONSTRATIONS: Object.freeze({
        key: "STARTUP_DEMONSTRATIONS",
        type: "boolean",
        required: false,
        category: "Server",
        suggestedFix: "Set STARTUP_DEMONSTRATIONS to true or false."
    }),
    DEBUG_SIMULATION_LOOP: Object.freeze({
        key: "DEBUG_SIMULATION_LOOP",
        type: "boolean",
        required: false,
        category: "Simulation",
        suggestedFix: "Set DEBUG_SIMULATION_LOOP to true or false."
    }),
    EVENT_BUS_LOGGING: Object.freeze({
        key: "EVENT_BUS_LOGGING",
        type: "boolean",
        required: false,
        category: "Logging",
        suggestedFix: "Set EVENT_BUS_LOGGING to true or false."
    }),
    TON_NETWORK: Object.freeze({
        key: "TON_NETWORK",
        type: "string",
        required: true,
        category: "TON",
        suggestedFix: "Set TON_NETWORK to testnet or mainnet."
    }),
    TON_POLL_INTERVAL_MS: Object.freeze({
        key: "TON_POLL_INTERVAL_MS",
        type: "integer",
        required: false,
        min: 200,
        category: "TON",
        suggestedFix: "Set TON_POLL_INTERVAL_MS to an integer >= 200."
    }),
    TON_DEPLOY_MODE: Object.freeze({
        key: "TON_DEPLOY_MODE",
        type: "enum",
        required: false,
        allowed: Object.freeze(["stub", "live"]),
        category: "TON",
        suggestedFix: "Set TON_DEPLOY_MODE to stub or live."
    }),
    SETUP_DURATION_MS: Object.freeze({
        key: "SETUP_DURATION_MS",
        type: "integer",
        required: false,
        min: 1,
        category: "Recovery",
        suggestedFix: "Set SETUP_DURATION_MS to a positive integer."
    }),
    RESULT_SESSION_DURATION_MS: Object.freeze({
        key: "RESULT_SESSION_DURATION_MS",
        type: "integer",
        required: false,
        min: 1,
        category: "Recovery",
        suggestedFix: "Set RESULT_SESSION_DURATION_MS to a positive integer."
    }),
    PAYMENT_SESSION_DURATION_MS: Object.freeze({
        key: "PAYMENT_SESSION_DURATION_MS",
        type: "integer",
        required: false,
        min: 1,
        category: "Payments",
        suggestedFix: "Set PAYMENT_SESSION_DURATION_MS to a positive integer."
    })
});

export const CONFIGURATION_CATEGORIES = Object.freeze([
    "Server",
    "Lifecycle",
    "Logging",
    "Developer Console",
    "Authentication",
    "TON",
    "Payments",
    "Recovery",
    "Simulation",
    "Metrics"
]);
