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

    validateBooleanField(
        collector,
        ENVIRONMENT_SCHEMA.METRICS_ENABLED,
        env.METRICS_ENABLED
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

}
