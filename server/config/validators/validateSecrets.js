/**
 * R7.0C — Secret presence / strength validation (never logs secret values).
 */

import { DEVELOPER_SCHEMA } from "../schemas/developerSchema.js";
import { isMissing, parseBooleanStrict, parseIntegerStrict } from "../parseHelpers.js";
import { isInsecureSecretDefault } from "../secrets.js";

function requiresHardenedAuth(nodeEnv) {

    return nodeEnv === "production" || nodeEnv === "staging";

}

/**
 * @param {import("../ConfigurationError.js").ConfigurationIssueCollector} collector
 * @param {NodeJS.ProcessEnv} env
 * @param {{
 *   nodeEnv: string,
 *   tonDeployMode: string,
 *   developer: { enabled: boolean, configured: boolean }
 * }} context
 */
export function validateSecrets(collector, env, context) {

    const nodeEnv = context.nodeEnv || "development";

    const hardened = requiresHardenedAuth(nodeEnv);

    const enabledParse = parseBooleanStrict(env.DEVELOPER_AUTH_ENABLED);

    if (!enabledParse.ok) {

        collector.add({
            key: DEVELOPER_SCHEMA.DEVELOPER_AUTH_ENABLED.key,
            reason: "Invalid boolean",
            expectedType: "true|false",
            received: env.DEVELOPER_AUTH_ENABLED,
            suggestedFix: DEVELOPER_SCHEMA.DEVELOPER_AUTH_ENABLED.suggestedFix
        });

    }

    const explicitlyDisabled = env.DEVELOPER_AUTH_ENABLED === "false";

    const secret = env.DEVELOPER_AUTH_SECRET;

    const username = env.DEVELOPER_AUTH_USERNAME;

    const password = env.DEVELOPER_AUTH_PASSWORD;

    if (hardened) {

        if (explicitlyDisabled) {

            collector.add({
                key: DEVELOPER_SCHEMA.DEVELOPER_AUTH_ENABLED.key,
                reason: "Developer authentication cannot be disabled in this profile",
                expectedType: "true",
                received: env.DEVELOPER_AUTH_ENABLED,
                suggestedFix: "Set DEVELOPER_AUTH_ENABLED=true for staging/production."
            });

        }

        if (isMissing(secret)) {

            collector.add({
                key: DEVELOPER_SCHEMA.DEVELOPER_AUTH_SECRET.key,
                reason: "Missing developer secret",
                expectedType: "secret",
                received: secret,
                suggestedFix: DEVELOPER_SCHEMA.DEVELOPER_AUTH_SECRET.suggestedFix
            });

        } else if (String(secret).trim().length
            < DEVELOPER_SCHEMA.DEVELOPER_AUTH_SECRET.minLength) {

            collector.add({
                key: DEVELOPER_SCHEMA.DEVELOPER_AUTH_SECRET.key,
                reason: "Developer secret too short",
                expectedType: `secret(minLength=${DEVELOPER_SCHEMA.DEVELOPER_AUTH_SECRET.minLength})`,
                received: secret,
                suggestedFix: DEVELOPER_SCHEMA.DEVELOPER_AUTH_SECRET.suggestedFix
            });

        } else if (isInsecureSecretDefault(secret)) {

            collector.add({
                key: DEVELOPER_SCHEMA.DEVELOPER_AUTH_SECRET.key,
                reason: "Insecure default developer secret is not allowed",
                expectedType: "non-default secret",
                received: secret,
                suggestedFix: "Replace the example DEVELOPER_AUTH_SECRET with a unique value."
            });

        }

        if (isMissing(username)) {

            collector.add({
                key: DEVELOPER_SCHEMA.DEVELOPER_AUTH_USERNAME.key,
                reason: "Missing developer username",
                expectedType: "string",
                received: username,
                suggestedFix: DEVELOPER_SCHEMA.DEVELOPER_AUTH_USERNAME.suggestedFix
            });

        }

        if (isMissing(password)) {

            collector.add({
                key: DEVELOPER_SCHEMA.DEVELOPER_AUTH_PASSWORD.key,
                reason: "Missing developer password",
                expectedType: "secret",
                received: password,
                suggestedFix: DEVELOPER_SCHEMA.DEVELOPER_AUTH_PASSWORD.suggestedFix
            });

        } else if (String(password).length
            < DEVELOPER_SCHEMA.DEVELOPER_AUTH_PASSWORD.minLength) {

            collector.add({
                key: DEVELOPER_SCHEMA.DEVELOPER_AUTH_PASSWORD.key,
                reason: "Developer password too short",
                expectedType: `secret(minLength=${DEVELOPER_SCHEMA.DEVELOPER_AUTH_PASSWORD.minLength})`,
                received: password,
                suggestedFix: DEVELOPER_SCHEMA.DEVELOPER_AUTH_PASSWORD.suggestedFix
            });

        } else if (isInsecureSecretDefault(password)) {

            collector.add({
                key: DEVELOPER_SCHEMA.DEVELOPER_AUTH_PASSWORD.key,
                reason: "Insecure default developer password is not allowed",
                expectedType: "non-default secret",
                received: password,
                suggestedFix: "Replace the example DEVELOPER_AUTH_PASSWORD with a strong password."
            });

        }

    } else if (env.DEVELOPER_AUTH_ENABLED === "true") {

        // Development with auth explicitly enabled still needs credentials.
        if (isMissing(secret) || isMissing(username) || isMissing(password)) {

            collector.add({
                key: "DEVELOPER_AUTH_*",
                reason: "Developer auth enabled but credentials are incomplete",
                expectedType: "secret+username+password",
                received: "<incomplete>",
                suggestedFix: "Provide DEVELOPER_AUTH_SECRET, USERNAME, and PASSWORD."
            });

        }

    }

    for (const schema of [
        DEVELOPER_SCHEMA.DEVELOPER_AUTH_ACCESS_TTL_SECONDS,
        DEVELOPER_SCHEMA.DEVELOPER_AUTH_REFRESH_TTL_SECONDS
    ]) {

        const raw = env[schema.key];

        if (isMissing(raw)) {

            continue;

        }

        const parsed = parseIntegerStrict(raw);

        if (!parsed.ok || parsed.value < schema.min) {

            collector.add({
                key: schema.key,
                reason: "Invalid auth TTL",
                expectedType: `integer>=${schema.min}`,
                received: raw,
                suggestedFix: schema.suggestedFix
            });

        }

    }

    if (context.tonDeployMode === "live") {

        if (isMissing(env.TON_DEPLOYER_MNEMONIC)) {

            collector.add({
                key: "TON_DEPLOYER_MNEMONIC",
                reason: "Missing TON deployer mnemonic for live deploy mode",
                expectedType: "secret",
                received: env.TON_DEPLOYER_MNEMONIC,
                suggestedFix: "Set TON_DEPLOYER_MNEMONIC when TON_DEPLOY_MODE=live."
            });

        }

    }

}
