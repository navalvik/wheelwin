/**
 * R7.0C — Environment variable schema validation (types, ranges, booleans).
 */

import { ENVIRONMENT_SCHEMA } from "../schemas/environmentSchema.js";
import {
    assertPresent,
    isMissing,
    parseBooleanStrict,
    parseIntegerStrict
} from "../parseHelpers.js";

function validateIntegerField(collector, schema, raw) {

    if (!assertPresent(collector, schema, raw)) {

        return;

    }

    if (!schema.required && isMissing(raw)) {

        return;

    }

    const parsed = parseIntegerStrict(raw);

    if (!parsed.ok) {

        collector.add({
            key: schema.key,
            reason: "Invalid integer",
            expectedType: schema.type,
            received: raw,
            suggestedFix: schema.suggestedFix
        });

        return;

    }

    if (schema.min !== undefined && parsed.value < schema.min) {

        collector.add({
            key: schema.key,
            reason: `Value below minimum (${schema.min})`,
            expectedType: schema.type,
            received: raw,
            suggestedFix: schema.suggestedFix
        });

    }

    if (schema.max !== undefined && parsed.value > schema.max) {

        collector.add({
            key: schema.key,
            reason: `Value above maximum (${schema.max})`,
            expectedType: schema.type,
            received: raw,
            suggestedFix: schema.suggestedFix
        });

    }

}

function validateBooleanField(collector, schema, raw) {

    if (isMissing(raw)) {

        return;

    }

    const parsed = parseBooleanStrict(raw);

    if (!parsed.ok) {

        collector.add({
            key: schema.key,
            reason: "Invalid boolean",
            expectedType: "true|false",
            received: raw,
            suggestedFix: schema.suggestedFix
        });

    }

}

function validateEnumField(collector, schema, raw) {

    if (!schema.required && isMissing(raw)) {

        return;

    }

    if (schema.required && isMissing(raw)) {

        assertPresent(collector, schema, raw);

        return;

    }

    if (!schema.allowed.includes(String(raw))) {

        collector.add({
            key: schema.key,
            reason: "Invalid enum value",
            expectedType: schema.allowed.join("|"),
            received: raw,
            suggestedFix: schema.suggestedFix
        });

    }

}

function validateStringField(collector, schema, raw) {

    if (!assertPresent(collector, schema, raw)) {

        return;

    }

    if (!schema.required && isMissing(raw)) {

        return;

    }

    if (typeof raw !== "string" && typeof raw !== "number") {

        collector.add({
            key: schema.key,
            reason: "Invalid string",
            expectedType: schema.type,
            received: raw,
            suggestedFix: schema.suggestedFix
        });

    }

}

/**
 * @param {import("../ConfigurationError.js").ConfigurationIssueCollector} collector
 * @param {NodeJS.ProcessEnv} env
 */
export function validateEnvironment(collector, env) {

    validateIntegerField(collector, ENVIRONMENT_SCHEMA.PORT, env.PORT);

    validateStringField(collector, ENVIRONMENT_SCHEMA.HOST, env.HOST);

    validateStringField(
        collector,
        ENVIRONMENT_SCHEMA.CLIENT_ORIGIN,
        env.CLIENT_ORIGIN
    );

    validateEnumField(collector, ENVIRONMENT_SCHEMA.NODE_ENV, env.NODE_ENV);

    validateIntegerField(
        collector,
        ENVIRONMENT_SCHEMA.ROOM_MAX_PLAYERS,
        env.ROOM_MAX_PLAYERS
    );

    validateIntegerField(
        collector,
        ENVIRONMENT_SCHEMA.ROOM_MAX_CONCURRENT,
        env.ROOM_MAX_CONCURRENT
    );

    validateIntegerField(
        collector,
        ENVIRONMENT_SCHEMA.GRACEFUL_SHUTDOWN_TIMEOUT_MS,
        env.GRACEFUL_SHUTDOWN_TIMEOUT_MS
    );

    validateEnumField(collector, ENVIRONMENT_SCHEMA.LOG_LEVEL, env.LOG_LEVEL);

    validateEnumField(collector, ENVIRONMENT_SCHEMA.LOG_FORMAT, env.LOG_FORMAT);

    validateBooleanField(
        collector,
        ENVIRONMENT_SCHEMA.LOG_ENABLE_CONSOLE,
        env.LOG_ENABLE_CONSOLE
    );

    validateBooleanField(
        collector,
        ENVIRONMENT_SCHEMA.LOG_ENABLE_FILE,
        env.LOG_ENABLE_FILE
    );

    validateIntegerField(
        collector,
        ENVIRONMENT_SCHEMA.LOG_MAX_FILE_SIZE_MB,
        env.LOG_MAX_FILE_SIZE_MB
    );

    validateIntegerField(
        collector,
        ENVIRONMENT_SCHEMA.LOG_MAX_FILES,
        env.LOG_MAX_FILES
    );

    validateIntegerField(
        collector,
        ENVIRONMENT_SCHEMA.LOG_MAX_AGE_DAYS,
        env.LOG_MAX_AGE_DAYS
    );

    validateBooleanField(
        collector,
        ENVIRONMENT_SCHEMA.MONITORING_ENABLED,
        env.MONITORING_ENABLED
    );

    validateIntegerField(
        collector,
        ENVIRONMENT_SCHEMA.METRICS_COLLECTION_INTERVAL_MS,
        env.METRICS_COLLECTION_INTERVAL_MS
    );

    validateIntegerField(
        collector,
        ENVIRONMENT_SCHEMA.RUNTIME_COLLECTION_INTERVAL_MS,
        env.RUNTIME_COLLECTION_INTERVAL_MS
    );

    validateIntegerField(
        collector,
        ENVIRONMENT_SCHEMA.SIMULATION_COLLECTION_INTERVAL_MS,
        env.SIMULATION_COLLECTION_INTERVAL_MS
    );

    validateIntegerField(
        collector,
        ENVIRONMENT_SCHEMA.PAYMENT_COLLECTION_INTERVAL_MS,
        env.PAYMENT_COLLECTION_INTERVAL_MS
    );

    validateIntegerField(
        collector,
        ENVIRONMENT_SCHEMA.RECOVERY_COLLECTION_INTERVAL_MS,
        env.RECOVERY_COLLECTION_INTERVAL_MS
    );

    validateIntegerField(
        collector,
        ENVIRONMENT_SCHEMA.SYSTEM_COLLECTION_INTERVAL_MS,
        env.SYSTEM_COLLECTION_INTERVAL_MS
    );

    validateBooleanField(
        collector,
        ENVIRONMENT_SCHEMA.PROMETHEUS_ENABLED,
        env.PROMETHEUS_ENABLED
    );

    validateIntegerField(
        collector,
        ENVIRONMENT_SCHEMA.PROMETHEUS_PORT,
        env.PROMETHEUS_PORT
    );

    validateBooleanField(
        collector,
        ENVIRONMENT_SCHEMA.METRICS_ENABLED,
        env.METRICS_ENABLED
    );

    validateBooleanField(
        collector,
        ENVIRONMENT_SCHEMA.FAILURE_POLICY_ENABLED,
        env.FAILURE_POLICY_ENABLED
    );

    validateIntegerField(
        collector,
        ENVIRONMENT_SCHEMA.RETRY_MAX_ATTEMPTS,
        env.RETRY_MAX_ATTEMPTS
    );

    validateIntegerField(
        collector,
        ENVIRONMENT_SCHEMA.RETRY_INITIAL_DELAY_MS,
        env.RETRY_INITIAL_DELAY_MS
    );

    validateIntegerField(
        collector,
        ENVIRONMENT_SCHEMA.RETRY_MAX_DELAY_MS,
        env.RETRY_MAX_DELAY_MS
    );

    validateEnumField(
        collector,
        ENVIRONMENT_SCHEMA.BACKOFF_STRATEGY,
        env.BACKOFF_STRATEGY
    );

    validateBooleanField(
        collector,
        ENVIRONMENT_SCHEMA.CIRCUIT_BREAKER_ENABLED,
        env.CIRCUIT_BREAKER_ENABLED
    );

    validateIntegerField(
        collector,
        ENVIRONMENT_SCHEMA.CIRCUIT_FAILURE_THRESHOLD,
        env.CIRCUIT_FAILURE_THRESHOLD
    );

    validateIntegerField(
        collector,
        ENVIRONMENT_SCHEMA.CIRCUIT_RECOVERY_TIMEOUT_MS,
        env.CIRCUIT_RECOVERY_TIMEOUT_MS
    );

    validateIntegerField(
        collector,
        ENVIRONMENT_SCHEMA.CIRCUIT_SUCCESS_THRESHOLD,
        env.CIRCUIT_SUCCESS_THRESHOLD
    );

    validateIntegerField(
        collector,
        ENVIRONMENT_SCHEMA.FAILURE_HISTORY_LIMIT,
        env.FAILURE_HISTORY_LIMIT
    );

    validateBooleanField(
        collector,
        ENVIRONMENT_SCHEMA.HEALTH_ENABLED,
        env.HEALTH_ENABLED
    );

    validateBooleanField(
        collector,
        ENVIRONMENT_SCHEMA.READINESS_ENABLED,
        env.READINESS_ENABLED
    );

    validateBooleanField(
        collector,
        ENVIRONMENT_SCHEMA.LIVENESS_ENABLED,
        env.LIVENESS_ENABLED
    );

    validateBooleanField(
        collector,
        ENVIRONMENT_SCHEMA.STARTUP_PROBE_ENABLED,
        env.STARTUP_PROBE_ENABLED
    );

    validateIntegerField(
        collector,
        ENVIRONMENT_SCHEMA.PROBE_REFRESH_INTERVAL_MS,
        env.PROBE_REFRESH_INTERVAL_MS
    );

    validateEnumField(
        collector,
        ENVIRONMENT_SCHEMA.DEPLOYMENT_PROFILE,
        env.DEPLOYMENT_PROFILE
    );

    validateEnumField(
        collector,
        ENVIRONMENT_SCHEMA.RELEASE_CHANNEL,
        env.RELEASE_CHANNEL
    );

    validateStringField(
        collector,
        ENVIRONMENT_SCHEMA.RELEASE_OUTPUT_DIRECTORY,
        env.RELEASE_OUTPUT_DIRECTORY
    );

    validateBooleanField(
        collector,
        ENVIRONMENT_SCHEMA.RELEASE_SIGNING_ENABLED,
        env.RELEASE_SIGNING_ENABLED
    );

    validateBooleanField(
        collector,
        ENVIRONMENT_SCHEMA.RELEASE_GENERATE_CHECKSUMS,
        env.RELEASE_GENERATE_CHECKSUMS
    );

    validateBooleanField(
        collector,
        ENVIRONMENT_SCHEMA.RELEASE_INCLUDE_DOCS,
        env.RELEASE_INCLUDE_DOCS
    );

    validateBooleanField(
        collector,
        ENVIRONMENT_SCHEMA.RELEASE_INCLUDE_REPORTS,
        env.RELEASE_INCLUDE_REPORTS
    );

    validateBooleanField(
        collector,
        ENVIRONMENT_SCHEMA.CLOSED_BETA_ENABLED,
        env.CLOSED_BETA_ENABLED
    );

    validateBooleanField(
        collector,
        ENVIRONMENT_SCHEMA.CLOSED_BETA_REQUIRE_CERTIFICATION,
        env.CLOSED_BETA_REQUIRE_CERTIFICATION
    );

    validateIntegerField(
        collector,
        ENVIRONMENT_SCHEMA.CLOSED_BETA_MAX_PARTICIPANTS,
        env.CLOSED_BETA_MAX_PARTICIPANTS
    );

    validateBooleanField(
        collector,
        ENVIRONMENT_SCHEMA.LAUNCH_READINESS_ENABLED,
        env.LAUNCH_READINESS_ENABLED
    );

    validateBooleanField(
        collector,
        ENVIRONMENT_SCHEMA.LAUNCH_REQUIRE_MAINNET_FOR_GA,
        env.LAUNCH_REQUIRE_MAINNET_FOR_GA
    );

    validateBooleanField(
        collector,
        ENVIRONMENT_SCHEMA.GA_RELEASE_ENABLED,
        env.GA_RELEASE_ENABLED
    );

    validateEnumField(
        collector,
        ENVIRONMENT_SCHEMA.GA_ROLLOUT_MODE,
        env.GA_ROLLOUT_MODE
    );

    validateBooleanField(
        collector,
        ENVIRONMENT_SCHEMA.GA_VERIFY_AFTER_RELEASE,
        env.GA_VERIFY_AFTER_RELEASE
    );

    validateIntegerField(
        collector,
        ENVIRONMENT_SCHEMA.GA_POST_LAUNCH_MONITORING_HOURS,
        env.GA_POST_LAUNCH_MONITORING_HOURS
    );

    validateBooleanField(
        collector,
        ENVIRONMENT_SCHEMA.GA_REQUIRE_CERTIFICATION,
        env.GA_REQUIRE_CERTIFICATION
    );

    validateBooleanField(
        collector,
        ENVIRONMENT_SCHEMA.OPERATIONS_ENABLED,
        env.OPERATIONS_ENABLED
    );

    // Float SLA targets — accept numeric strings
    for (const [schema, raw] of [
        [ENVIRONMENT_SCHEMA.SLA_AVAILABILITY_TARGET, env.SLA_AVAILABILITY_TARGET],
        [ENVIRONMENT_SCHEMA.SLA_RECOVERY_TARGET, env.SLA_RECOVERY_TARGET]
    ]) {

        if (!isMissing(raw)) {

            const n = Number(raw);

            if (!Number.isFinite(n) || n < 0 || n > 1) {

                collector.add({
                    key: schema.key,
                    reason: "Invalid ratio (expected 0..1)",
                    expectedType: "number",
                    received: raw,
                    suggestedFix: schema.suggestedFix
                });

            }

        }

    }

    validateIntegerField(
        collector,
        ENVIRONMENT_SCHEMA.SLA_LATENCY_TARGET_MS,
        env.SLA_LATENCY_TARGET_MS
    );

    validateIntegerField(
        collector,
        ENVIRONMENT_SCHEMA.MAINTENANCE_DEFAULT_DURATION_MINUTES,
        env.MAINTENANCE_DEFAULT_DURATION_MINUTES
    );

    validateIntegerField(
        collector,
        ENVIRONMENT_SCHEMA.VERSION_SUPPORT_WINDOW_DAYS,
        env.VERSION_SUPPORT_WINDOW_DAYS
    );

    validateBooleanField(
        collector,
        ENVIRONMENT_SCHEMA.GOVERNANCE_ENABLED,
        env.GOVERNANCE_ENABLED
    );

    validateIntegerField(
        collector,
        ENVIRONMENT_SCHEMA.AUDIT_INTERVAL_DAYS,
        env.AUDIT_INTERVAL_DAYS
    );

    validateBooleanField(
        collector,
        ENVIRONMENT_SCHEMA.COMPLIANCE_REQUIRED,
        env.COMPLIANCE_REQUIRED
    );

    validateIntegerField(
        collector,
        ENVIRONMENT_SCHEMA.RISK_REVIEW_INTERVAL_DAYS,
        env.RISK_REVIEW_INTERVAL_DAYS
    );

    validateIntegerField(
        collector,
        ENVIRONMENT_SCHEMA.EVIDENCE_RETENTION_DAYS,
        env.EVIDENCE_RETENTION_DAYS
    );

    validateIntegerField(
        collector,
        ENVIRONMENT_SCHEMA.PLATFORM_REVIEW_INTERVAL_DAYS,
        env.PLATFORM_REVIEW_INTERVAL_DAYS
    );

    validateBooleanField(
        collector,
        ENVIRONMENT_SCHEMA.STARTUP_DEMONSTRATIONS,
        env.STARTUP_DEMONSTRATIONS
    );

    validateBooleanField(
        collector,
        ENVIRONMENT_SCHEMA.DEBUG_SIMULATION_LOOP,
        env.DEBUG_SIMULATION_LOOP
    );

    validateBooleanField(
        collector,
        ENVIRONMENT_SCHEMA.EVENT_BUS_LOGGING,
        env.EVENT_BUS_LOGGING
    );

    validateStringField(
        collector,
        ENVIRONMENT_SCHEMA.TON_NETWORK,
        env.TON_NETWORK
    );

    validateIntegerField(
        collector,
        ENVIRONMENT_SCHEMA.TON_POLL_INTERVAL_MS,
        env.TON_POLL_INTERVAL_MS
    );

    if (!isMissing(env.TON_DEPLOY_MODE)) {

        const mode = String(env.TON_DEPLOY_MODE).trim().toLowerCase();

        if (mode !== "stub" && mode !== "live") {

            collector.add({
                key: ENVIRONMENT_SCHEMA.TON_DEPLOY_MODE.key,
                reason: "Invalid deploy mode",
                expectedType: "stub|live",
                received: env.TON_DEPLOY_MODE,
                suggestedFix: ENVIRONMENT_SCHEMA.TON_DEPLOY_MODE.suggestedFix
            });

        }

    }

    // R7.67A — refuse ambiguous GAME_ESCROW_MODE when the variable is present.
    if (!isMissing(env.GAME_ESCROW_MODE)) {

        const mode = String(env.GAME_ESCROW_MODE).trim().toLowerCase();

        if (mode !== "v4" && mode !== "game") {

            collector.add({
                key: ENVIRONMENT_SCHEMA.GAME_ESCROW_MODE.key,
                reason: "Ambiguous or invalid escrow mode",
                expectedType: "v4|game",
                received: env.GAME_ESCROW_MODE,
                suggestedFix: ENVIRONMENT_SCHEMA.GAME_ESCROW_MODE.suggestedFix
            });

        }

    }

    // R7.68 / R8.1A — Mainnet profile escrow mode must be explicit when set.
    if (!isMissing(env.TON_MAINNET_GAME_ESCROW_MODE)) {

        const mode = String(env.TON_MAINNET_GAME_ESCROW_MODE).trim().toLowerCase();

        if (mode !== "v4" && mode !== "game") {

            collector.add({
                key: ENVIRONMENT_SCHEMA.TON_MAINNET_GAME_ESCROW_MODE.key,
                reason: "Ambiguous or invalid mainnet escrow mode",
                expectedType: "v4|game",
                received: env.TON_MAINNET_GAME_ESCROW_MODE,
                suggestedFix: ENVIRONMENT_SCHEMA.TON_MAINNET_GAME_ESCROW_MODE.suggestedFix
            });

        }

    }

    validateBooleanField(
        collector,
        ENVIRONMENT_SCHEMA.TON_MAINNET_DRY_RUN_DEBUG,
        env.TON_MAINNET_DRY_RUN_DEBUG
    );

    validateBooleanField(
        collector,
        ENVIRONMENT_SCHEMA.TON_MAINNET_WALLET_IDENTITY_DEBUG,
        env.TON_MAINNET_WALLET_IDENTITY_DEBUG
    );

    validateIntegerField(
        collector,
        ENVIRONMENT_SCHEMA.SETUP_DURATION_MS,
        env.SETUP_DURATION_MS
    );

    validateIntegerField(
        collector,
        ENVIRONMENT_SCHEMA.RESULT_SESSION_DURATION_MS,
        env.RESULT_SESSION_DURATION_MS
    );

    validateIntegerField(
        collector,
        ENVIRONMENT_SCHEMA.PAYMENT_SESSION_DURATION_MS,
        env.PAYMENT_SESSION_DURATION_MS
    );

    validateIntegerField(
        collector,
        ENVIRONMENT_SCHEMA.WALLET_CONNECTION_DURATION_MS,
        env.WALLET_CONNECTION_DURATION_MS
    );

    validateIntegerField(
        collector,
        ENVIRONMENT_SCHEMA.GAME_CONTRACT_DEPLOY_TIMEOUT_MS,
        env.GAME_CONTRACT_DEPLOY_TIMEOUT_MS
    );

    validateIntegerField(
        collector,
        ENVIRONMENT_SCHEMA.GAME_START_AUTHORIZATION_DURATION_MS,
        env.GAME_START_AUTHORIZATION_DURATION_MS
    );

}
