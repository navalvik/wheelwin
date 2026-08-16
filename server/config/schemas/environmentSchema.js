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
        suggestedFix:
            "Set CLIENT_ORIGIN to a comma-separated list of frontend origins "
            + "(e.g. http://localhost:5173,http://192.168.0.104:5173,"
            + "https://wheelwin-nine.vercel.app). In development, localhost, "
            + "127.0.0.1, and private LAN IPs are also allowed automatically; "
            + "list production domains explicitly."
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
    FAILURE_POLICY_ENABLED: Object.freeze({
        key: "FAILURE_POLICY_ENABLED",
        type: "boolean",
        required: false,
        category: "Failure Policy",
        suggestedFix: "Set FAILURE_POLICY_ENABLED to true or false."
    }),
    RETRY_MAX_ATTEMPTS: Object.freeze({
        key: "RETRY_MAX_ATTEMPTS",
        type: "integer",
        required: false,
        min: 1,
        category: "Failure Policy",
        suggestedFix: "Set RETRY_MAX_ATTEMPTS to an integer >= 1."
    }),
    RETRY_INITIAL_DELAY_MS: Object.freeze({
        key: "RETRY_INITIAL_DELAY_MS",
        type: "integer",
        required: false,
        min: 0,
        category: "Failure Policy",
        suggestedFix: "Set RETRY_INITIAL_DELAY_MS to an integer >= 0."
    }),
    RETRY_MAX_DELAY_MS: Object.freeze({
        key: "RETRY_MAX_DELAY_MS",
        type: "integer",
        required: false,
        min: 1,
        category: "Failure Policy",
        suggestedFix: "Set RETRY_MAX_DELAY_MS to an integer >= 1."
    }),
    BACKOFF_STRATEGY: Object.freeze({
        key: "BACKOFF_STRATEGY",
        type: "enum",
        required: false,
        allowed: Object.freeze([
            "fixed",
            "linear",
            "exponential",
            "exponential_jitter"
        ]),
        category: "Failure Policy",
        suggestedFix:
            "Set BACKOFF_STRATEGY to fixed, linear, exponential, or exponential_jitter."
    }),
    CIRCUIT_BREAKER_ENABLED: Object.freeze({
        key: "CIRCUIT_BREAKER_ENABLED",
        type: "boolean",
        required: false,
        category: "Failure Policy",
        suggestedFix: "Set CIRCUIT_BREAKER_ENABLED to true or false."
    }),
    CIRCUIT_FAILURE_THRESHOLD: Object.freeze({
        key: "CIRCUIT_FAILURE_THRESHOLD",
        type: "integer",
        required: false,
        min: 1,
        category: "Failure Policy",
        suggestedFix: "Set CIRCUIT_FAILURE_THRESHOLD to an integer >= 1."
    }),
    CIRCUIT_RECOVERY_TIMEOUT_MS: Object.freeze({
        key: "CIRCUIT_RECOVERY_TIMEOUT_MS",
        type: "integer",
        required: false,
        min: 1,
        category: "Failure Policy",
        suggestedFix: "Set CIRCUIT_RECOVERY_TIMEOUT_MS to an integer >= 1."
    }),
    CIRCUIT_SUCCESS_THRESHOLD: Object.freeze({
        key: "CIRCUIT_SUCCESS_THRESHOLD",
        type: "integer",
        required: false,
        min: 1,
        category: "Failure Policy",
        suggestedFix: "Set CIRCUIT_SUCCESS_THRESHOLD to an integer >= 1."
    }),
    FAILURE_HISTORY_LIMIT: Object.freeze({
        key: "FAILURE_HISTORY_LIMIT",
        type: "integer",
        required: false,
        min: 1,
        category: "Failure Policy",
        suggestedFix: "Set FAILURE_HISTORY_LIMIT to an integer >= 1."
    }),
    HEALTH_ENABLED: Object.freeze({
        key: "HEALTH_ENABLED",
        type: "boolean",
        required: false,
        category: "Deployment",
        suggestedFix: "Set HEALTH_ENABLED to true or false."
    }),
    READINESS_ENABLED: Object.freeze({
        key: "READINESS_ENABLED",
        type: "boolean",
        required: false,
        category: "Deployment",
        suggestedFix: "Set READINESS_ENABLED to true or false."
    }),
    LIVENESS_ENABLED: Object.freeze({
        key: "LIVENESS_ENABLED",
        type: "boolean",
        required: false,
        category: "Deployment",
        suggestedFix: "Set LIVENESS_ENABLED to true or false."
    }),
    STARTUP_PROBE_ENABLED: Object.freeze({
        key: "STARTUP_PROBE_ENABLED",
        type: "boolean",
        required: false,
        category: "Deployment",
        suggestedFix: "Set STARTUP_PROBE_ENABLED to true or false."
    }),
    PROBE_REFRESH_INTERVAL_MS: Object.freeze({
        key: "PROBE_REFRESH_INTERVAL_MS",
        type: "integer",
        required: false,
        min: 50,
        category: "Deployment",
        suggestedFix: "Set PROBE_REFRESH_INTERVAL_MS to an integer >= 50."
    }),
    DEPLOYMENT_PROFILE: Object.freeze({
        key: "DEPLOYMENT_PROFILE",
        type: "enum",
        required: false,
        allowed: Object.freeze(["development", "staging", "production"]),
        category: "Deployment",
        suggestedFix: "Set DEPLOYMENT_PROFILE to development, staging, or production."
    }),
    RELEASE_CHANNEL: Object.freeze({
        key: "RELEASE_CHANNEL",
        type: "enum",
        required: false,
        allowed: Object.freeze([
            "development",
            "internal",
            "rc",
            "beta",
            "production"
        ]),
        category: "Release",
        suggestedFix:
            "Set RELEASE_CHANNEL to development, internal, rc, beta, or production."
    }),
    RELEASE_OUTPUT_DIRECTORY: Object.freeze({
        key: "RELEASE_OUTPUT_DIRECTORY",
        type: "string",
        required: false,
        category: "Release",
        suggestedFix: "Set RELEASE_OUTPUT_DIRECTORY to a relative or absolute path."
    }),
    RELEASE_SIGNING_ENABLED: Object.freeze({
        key: "RELEASE_SIGNING_ENABLED",
        type: "boolean",
        required: false,
        category: "Release",
        suggestedFix: "Set RELEASE_SIGNING_ENABLED to true or false."
    }),
    RELEASE_GENERATE_CHECKSUMS: Object.freeze({
        key: "RELEASE_GENERATE_CHECKSUMS",
        type: "boolean",
        required: false,
        category: "Release",
        suggestedFix: "Set RELEASE_GENERATE_CHECKSUMS to true or false."
    }),
    RELEASE_INCLUDE_DOCS: Object.freeze({
        key: "RELEASE_INCLUDE_DOCS",
        type: "boolean",
        required: false,
        category: "Release",
        suggestedFix: "Set RELEASE_INCLUDE_DOCS to true or false."
    }),
    RELEASE_INCLUDE_REPORTS: Object.freeze({
        key: "RELEASE_INCLUDE_REPORTS",
        type: "boolean",
        required: false,
        category: "Release",
        suggestedFix: "Set RELEASE_INCLUDE_REPORTS to true or false."
    }),
    CLOSED_BETA_ENABLED: Object.freeze({
        key: "CLOSED_BETA_ENABLED",
        type: "boolean",
        required: false,
        category: "ClosedBeta",
        suggestedFix: "Set CLOSED_BETA_ENABLED to true or false."
    }),
    CLOSED_BETA_REQUIRE_CERTIFICATION: Object.freeze({
        key: "CLOSED_BETA_REQUIRE_CERTIFICATION",
        type: "boolean",
        required: false,
        category: "ClosedBeta",
        suggestedFix:
            "Set CLOSED_BETA_REQUIRE_CERTIFICATION to true or false."
    }),
    CLOSED_BETA_MAX_PARTICIPANTS: Object.freeze({
        key: "CLOSED_BETA_MAX_PARTICIPANTS",
        type: "integer",
        required: false,
        min: 1,
        category: "ClosedBeta",
        suggestedFix:
            "Set CLOSED_BETA_MAX_PARTICIPANTS to a positive integer."
    }),
    LAUNCH_READINESS_ENABLED: Object.freeze({
        key: "LAUNCH_READINESS_ENABLED",
        type: "boolean",
        required: false,
        category: "Launch",
        suggestedFix: "Set LAUNCH_READINESS_ENABLED to true or false."
    }),
    LAUNCH_REQUIRE_MAINNET_FOR_GA: Object.freeze({
        key: "LAUNCH_REQUIRE_MAINNET_FOR_GA",
        type: "boolean",
        required: false,
        category: "Launch",
        suggestedFix: "Set LAUNCH_REQUIRE_MAINNET_FOR_GA to true or false."
    }),
    GA_RELEASE_ENABLED: Object.freeze({
        key: "GA_RELEASE_ENABLED",
        type: "boolean",
        required: false,
        category: "GA",
        suggestedFix: "Set GA_RELEASE_ENABLED to true or false."
    }),
    GA_ROLLOUT_MODE: Object.freeze({
        key: "GA_ROLLOUT_MODE",
        type: "enum",
        required: false,
        allowed: Object.freeze(["single", "staged"]),
        category: "GA",
        suggestedFix: "Set GA_ROLLOUT_MODE to single or staged."
    }),
    GA_VERIFY_AFTER_RELEASE: Object.freeze({
        key: "GA_VERIFY_AFTER_RELEASE",
        type: "boolean",
        required: false,
        category: "GA",
        suggestedFix: "Set GA_VERIFY_AFTER_RELEASE to true or false."
    }),
    GA_POST_LAUNCH_MONITORING_HOURS: Object.freeze({
        key: "GA_POST_LAUNCH_MONITORING_HOURS",
        type: "integer",
        required: false,
        min: 1,
        category: "GA",
        suggestedFix:
            "Set GA_POST_LAUNCH_MONITORING_HOURS to a positive integer."
    }),
    GA_REQUIRE_CERTIFICATION: Object.freeze({
        key: "GA_REQUIRE_CERTIFICATION",
        type: "boolean",
        required: false,
        category: "GA",
        suggestedFix: "Set GA_REQUIRE_CERTIFICATION to true or false."
    }),
    OPERATIONS_ENABLED: Object.freeze({
        key: "OPERATIONS_ENABLED",
        type: "boolean",
        required: false,
        category: "Operations",
        suggestedFix: "Set OPERATIONS_ENABLED to true or false."
    }),
    SLA_AVAILABILITY_TARGET: Object.freeze({
        key: "SLA_AVAILABILITY_TARGET",
        type: "number",
        required: false,
        category: "Operations",
        suggestedFix: "Set SLA_AVAILABILITY_TARGET to a ratio between 0 and 1."
    }),
    SLA_LATENCY_TARGET_MS: Object.freeze({
        key: "SLA_LATENCY_TARGET_MS",
        type: "integer",
        required: false,
        min: 1,
        category: "Operations",
        suggestedFix: "Set SLA_LATENCY_TARGET_MS to a positive integer."
    }),
    SLA_RECOVERY_TARGET: Object.freeze({
        key: "SLA_RECOVERY_TARGET",
        type: "number",
        required: false,
        category: "Operations",
        suggestedFix: "Set SLA_RECOVERY_TARGET to a ratio between 0 and 1."
    }),
    MAINTENANCE_DEFAULT_DURATION_MINUTES: Object.freeze({
        key: "MAINTENANCE_DEFAULT_DURATION_MINUTES",
        type: "integer",
        required: false,
        min: 1,
        category: "Operations",
        suggestedFix:
            "Set MAINTENANCE_DEFAULT_DURATION_MINUTES to a positive integer."
    }),
    VERSION_SUPPORT_WINDOW_DAYS: Object.freeze({
        key: "VERSION_SUPPORT_WINDOW_DAYS",
        type: "integer",
        required: false,
        min: 1,
        category: "Operations",
        suggestedFix:
            "Set VERSION_SUPPORT_WINDOW_DAYS to a positive integer."
    }),
    GOVERNANCE_ENABLED: Object.freeze({
        key: "GOVERNANCE_ENABLED",
        type: "boolean",
        required: false,
        category: "Governance",
        suggestedFix: "Set GOVERNANCE_ENABLED to true or false."
    }),
    AUDIT_INTERVAL_DAYS: Object.freeze({
        key: "AUDIT_INTERVAL_DAYS",
        type: "integer",
        required: false,
        min: 1,
        category: "Governance",
        suggestedFix: "Set AUDIT_INTERVAL_DAYS to a positive integer."
    }),
    COMPLIANCE_REQUIRED: Object.freeze({
        key: "COMPLIANCE_REQUIRED",
        type: "boolean",
        required: false,
        category: "Governance",
        suggestedFix: "Set COMPLIANCE_REQUIRED to true or false."
    }),
    RISK_REVIEW_INTERVAL_DAYS: Object.freeze({
        key: "RISK_REVIEW_INTERVAL_DAYS",
        type: "integer",
        required: false,
        min: 1,
        category: "Governance",
        suggestedFix:
            "Set RISK_REVIEW_INTERVAL_DAYS to a positive integer."
    }),
    EVIDENCE_RETENTION_DAYS: Object.freeze({
        key: "EVIDENCE_RETENTION_DAYS",
        type: "integer",
        required: false,
        min: 1,
        category: "Governance",
        suggestedFix: "Set EVIDENCE_RETENTION_DAYS to a positive integer."
    }),
    PLATFORM_REVIEW_INTERVAL_DAYS: Object.freeze({
        key: "PLATFORM_REVIEW_INTERVAL_DAYS",
        type: "integer",
        required: false,
        min: 1,
        category: "Governance",
        suggestedFix:
            "Set PLATFORM_REVIEW_INTERVAL_DAYS to a positive integer."
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
    // R7.67A — testnet defaults to game when unset; mainnet defaults to v4.
    GAME_ESCROW_MODE: Object.freeze({
        key: "GAME_ESCROW_MODE",
        type: "enum",
        required: false,
        allowed: Object.freeze(["v4", "game"]),
        category: "TON",
        suggestedFix: "Set GAME_ESCROW_MODE to game (testnet default) or v4 (rollback / mainnet default)."
    }),
    // R7.67B — public address pin for deployer identity mismatch checks.
    TON_DEPLOYER_EXPECTED_ADDRESS: Object.freeze({
        key: "TON_DEPLOYER_EXPECTED_ADDRESS",
        type: "string",
        required: false,
        category: "TON",
        suggestedFix: "Set TON_DEPLOYER_EXPECTED_ADDRESS to the expected deployer wallet friendly address."
    }),
    // R17.8V.2P.H — Deployment cost snapshot foundation (default off; no runtime wiring yet).
    DEPLOYMENT_COST_SNAPSHOT_ENABLED: Object.freeze({
        key: "DEPLOYMENT_COST_SNAPSHOT_ENABLED",
        type: "boolean",
        required: false,
        defaultValue: false,
        category: "TON",
        suggestedFix:
            "Set DEPLOYMENT_COST_SNAPSHOT_ENABLED to true only after capture wiring. Default false."
    }),
    // R17.8V.2P.M — Deployment reimbursement worker foundation (default off; no TON send).
    DEPLOYMENT_REIMBURSEMENT_ENABLED: Object.freeze({
        key: "DEPLOYMENT_REIMBURSEMENT_ENABLED",
        type: "boolean",
        required: false,
        defaultValue: false,
        category: "TON",
        suggestedFix:
            "Set DEPLOYMENT_REIMBURSEMENT_ENABLED to true only after transfer wiring. Default false."
    }),
    // R17.8V.2P.M — Reimbursement wallet address pin only (never a mnemonic).
    TON_REIMBURSEMENT_EXPECTED_ADDRESS: Object.freeze({
        key: "TON_REIMBURSEMENT_EXPECTED_ADDRESS",
        type: "string",
        required: false,
        category: "TON",
        suggestedFix:
            "Set TON_REIMBURSEMENT_EXPECTED_ADDRESS to the reimbursement wallet friendly address (address pin only)."
    }),
    // R7.68 — Mainnet readiness profile (does not enable mainnet by itself).
    TON_MAINNET_ENDPOINT: Object.freeze({
        key: "TON_MAINNET_ENDPOINT",
        type: "string",
        required: false,
        category: "TON",
        suggestedFix: "Set TON_MAINNET_ENDPOINT to the mainnet TonCenter JSON-RPC URL."
    }),
    TON_MAINNET_ORACLE_ADDRESS: Object.freeze({
        key: "TON_MAINNET_ORACLE_ADDRESS",
        type: "string",
        required: false,
        category: "TON",
        suggestedFix: "Set TON_MAINNET_ORACLE_ADDRESS to the mainnet oracle wallet."
    }),
    // R7.70A.2 — Testnet oracle pin (temporary deployer-as-oracle for settlement validation).
    TON_TESTNET_ORACLE_ADDRESS: Object.freeze({
        key: "TON_TESTNET_ORACLE_ADDRESS",
        type: "string",
        required: false,
        category: "TON",
        suggestedFix:
            "Set TON_TESTNET_ORACLE_ADDRESS to the Testnet oracle bounceable address "
            + "(falls back to TON_ORACLE_ADDRESS / GAME_ESCROW_ORACLE)."
    }),
    TON_ORACLE_ADDRESS: Object.freeze({
        key: "TON_ORACLE_ADDRESS",
        type: "string",
        required: false,
        category: "TON",
        suggestedFix:
            "Optional shared oracle fallback. Prefer TON_TESTNET_ORACLE_ADDRESS on Testnet."
    }),
    TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS: Object.freeze({
        key: "TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS",
        type: "string",
        required: false,
        category: "TON",
        suggestedFix: "Set TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS to the expected mainnet deployer address."
    }),
    TON_MAINNET_GAME_ESCROW_MODE: Object.freeze({
        key: "TON_MAINNET_GAME_ESCROW_MODE",
        type: "enum",
        required: false,
        allowed: Object.freeze(["v4", "game"]),
        category: "TON",
        suggestedFix: "Keep TON_MAINNET_GAME_ESCROW_MODE=v4 until Mainnet GameEscrow cutover."
    }),
    TON_GAME_ESCROW_ARTIFACT_SHA256: Object.freeze({
        key: "TON_GAME_ESCROW_ARTIFACT_SHA256",
        type: "string",
        required: false,
        category: "TON",
        suggestedFix: "Set TON_GAME_ESCROW_ARTIFACT_SHA256 to the SHA256 of GameEscrow.code.boc."
    }),
    // R8.1A — Mainnet dry-run diagnostics (does not enable Mainnet gameplay).
    TON_MAINNET_DRY_RUN_DEBUG: Object.freeze({
        key: "TON_MAINNET_DRY_RUN_DEBUG",
        type: "boolean",
        required: false,
        category: "TON",
        suggestedFix:
            "Set TON_MAINNET_DRY_RUN_DEBUG to true to print TON_MAINNET_DRY_RUN_DEBUG "
            + "readiness diagnostics (network, wallet, artifact, escrow mode)."
    }),
    // R8.1B — Mainnet wallet identity diagnostics (does not enable Mainnet gameplay).
    TON_MAINNET_WALLET_IDENTITY_DEBUG: Object.freeze({
        key: "TON_MAINNET_WALLET_IDENTITY_DEBUG",
        type: "boolean",
        required: false,
        category: "TON",
        suggestedFix:
            "Set TON_MAINNET_WALLET_IDENTITY_DEBUG to true to print "
            + "TON_MAINNET_WALLET_IDENTITY_DEBUG (derived vs expected address; no mnemonic)."
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
    }),
    WALLET_CONNECTION_DURATION_MS: Object.freeze({
        key: "WALLET_CONNECTION_DURATION_MS",
        type: "integer",
        required: false,
        min: 1,
        category: "Payments",
        suggestedFix: "Set WALLET_CONNECTION_DURATION_MS to a positive integer."
    }),
    GAME_CONTRACT_DEPLOY_TIMEOUT_MS: Object.freeze({
        key: "GAME_CONTRACT_DEPLOY_TIMEOUT_MS",
        type: "integer",
        required: false,
        min: 1,
        category: "Payments",
        suggestedFix: "Set GAME_CONTRACT_DEPLOY_TIMEOUT_MS to a positive integer."
    }),
    GAME_START_AUTHORIZATION_DURATION_MS: Object.freeze({
        key: "GAME_START_AUTHORIZATION_DURATION_MS",
        type: "integer",
        required: false,
        min: 1,
        category: "Payments",
        suggestedFix: "Set GAME_START_AUTHORIZATION_DURATION_MS to a positive integer."
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
    "Metrics",
    "Failure Policy",
    "Deployment",
    "Release"
]);
