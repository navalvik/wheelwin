/**
 * R7.0C — Secret presence / strength validation (never logs secret values).
 */

import { DEVELOPER_SCHEMA } from "../schemas/developerSchema.js";
import { isMissing, parseBooleanStrict, parseIntegerStrict } from "../parseHelpers.js";
import { isInsecureSecretDefault } from "../secrets.js";
import { isRoomWalletPaymentIntakeEnabled } from "../../payment/roomWallet/roomWalletConfig.js";
import { loadRoomWalletRuntimeConfig } from "../../payment/roomWallet/RoomWalletRuntimeResolver.js";

function requiresHardenedAuth(nodeEnv) {

    return nodeEnv === "production" || nodeEnv === "staging";

}

function resolveAdminUsername(env) {

    return env.ADMIN_USERNAME || env.DEVELOPER_AUTH_USERNAME;

}

function resolveAdminPasswordHash(env) {

    return env.ADMIN_PASSWORD_HASH || env.DEVELOPER_AUTH_PASSWORD_HASH;

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

    const username = resolveAdminUsername(env);

    const passwordHash = resolveAdminPasswordHash(env);

    const plainPassword = env.DEVELOPER_AUTH_PASSWORD || env.ADMIN_PASSWORD;

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
                key: DEVELOPER_SCHEMA.ADMIN_USERNAME.key,
                reason: "Missing administrator username",
                expectedType: "string",
                received: username,
                suggestedFix: DEVELOPER_SCHEMA.ADMIN_USERNAME.suggestedFix
            });

        }

        if (isMissing(passwordHash)) {

            collector.add({
                key: DEVELOPER_SCHEMA.ADMIN_PASSWORD_HASH.key,
                reason: "Missing administrator password hash",
                expectedType: "scrypt hash",
                received: passwordHash,
                suggestedFix: DEVELOPER_SCHEMA.ADMIN_PASSWORD_HASH.suggestedFix
            });

        }

        if (!isMissing(plainPassword)) {

            collector.add({
                key: DEVELOPER_SCHEMA.DEVELOPER_AUTH_PASSWORD.key,
                reason: "Plain-text administrator password is not allowed in this profile",
                expectedType: "ADMIN_PASSWORD_HASH",
                received: "<plain-password>",
                suggestedFix: "Remove DEVELOPER_AUTH_PASSWORD and set ADMIN_PASSWORD_HASH."
            });

        }

    } else if (env.DEVELOPER_AUTH_ENABLED === "true") {

        // Development with auth explicitly enabled still needs credentials.
        if (isMissing(secret) || isMissing(username) || (isMissing(passwordHash) && isMissing(plainPassword))) {

            collector.add({
                key: "ADMIN_*",
                reason: "Developer auth enabled but credentials are incomplete",
                expectedType: "secret+username+password-hash-or-dev-password",
                received: "<incomplete>",
                suggestedFix: "Provide DEVELOPER_AUTH_SECRET, ADMIN_USERNAME, and ADMIN_PASSWORD_HASH (or DEVELOPER_AUTH_PASSWORD for local dev)."
            });

        }

    }

    for (const schema of [
        DEVELOPER_SCHEMA.DEVELOPER_AUTH_ACCESS_TTL_SECONDS,
        DEVELOPER_SCHEMA.ADMIN_SESSION_TIMEOUT_SECONDS,
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

    const roomWalletsRaw = env.ROOM_WALLETS_JSON;
    const roomWalletIntakeEnabled = isRoomWalletPaymentIntakeEnabled(env);

    if (roomWalletIntakeEnabled && isMissing(roomWalletsRaw)) {

        collector.add({
            key: "ROOM_WALLETS_JSON",
            reason: "Room Wallet intake requires ROOM_WALLETS_JSON",
            expectedType: "secret",
            received: roomWalletsRaw,
            suggestedFix:
                "Set ROOM_WALLETS_JSON to a valid 64-entry catalog when "
                + "ROOM_WALLET_PAYMENT_INTAKE_MODE=ROOM_WALLET, or leave intake unset."
        });

    } else if (!isMissing(roomWalletsRaw)) {

        try {

            loadRoomWalletRuntimeConfig(env);

        } catch (error) {

            collector.add({
                key: "ROOM_WALLETS_JSON",
                reason: error?.message || "Invalid Room Wallet runtime configuration",
                expectedType: "secret",
                received: roomWalletsRaw,
                suggestedFix:
                    "Provide a parseable ROOM_WALLETS_JSON array whose keys derive "
                    + "the configured addresses. Never log or commit this value."
            });

        }

    }

}