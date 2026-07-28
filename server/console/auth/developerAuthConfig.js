/**
 * R6.1 / R6.2 — Developer authentication configuration (env-only secrets).
 */

import { createHash, timingSafeEqual } from "node:crypto";

import {
    isScryptPasswordHash,
    verifyAdminPassword
} from "./adminPasswordHash.js";
import { DEVELOPER_ROLES } from "./developerRoles.js";
import {
    APP_ENVIRONMENT,
    resolveAppEnvironment
} from "../environment/AppEnvironment.js";

function hashPasswordLegacy(password, secret) {

    return createHash("sha256")
        .update(`${secret}:${password}`)
        .digest();

}

function loadCredentialPair(env, {
    usernameKey,
    usernameFallbackKey,
    hashKey,
    hashFallbackKey,
    plainKey,
    plainFallbackKey,
    secret
}) {

    const username = String(
        env[usernameKey]
        || (usernameFallbackKey ? env[usernameFallbackKey] : "")
        || ""
    ).trim();

    const passwordHashScrypt = String(
        env[hashKey]
        || (hashFallbackKey ? env[hashFallbackKey] : "")
        || ""
    ).trim();

    const plainPassword = String(
        env[plainKey]
        || (plainFallbackKey ? env[plainFallbackKey] : "")
        || ""
    );

    return Object.freeze({
        username: username || null,
        passwordHashScrypt: passwordHashScrypt || null,
        passwordHashLegacy: !passwordHashScrypt && plainPassword && secret
            ? hashPasswordLegacy(plainPassword, secret)
            : null,
        usesPlainPasswordFallback: !passwordHashScrypt && Boolean(plainPassword),
        configured: Boolean(username && (passwordHashScrypt || plainPassword))
    });

}

function verifyCredentialPassword(password, credential, secret) {

    if (!credential?.configured) {

        return false;

    }

    if (credential.passwordHashScrypt) {

        if (isScryptPasswordHash(credential.passwordHashScrypt)) {

            return verifyAdminPassword(password, credential.passwordHashScrypt);

        }

        return false;

    }

    if (credential.passwordHashLegacy) {

        return passwordsMatch(password, credential.passwordHashLegacy, secret);

    }

    return false;

}

export function loadDeveloperAuthConfig(env = process.env, productionConfig = null) {

    const nodeEnv = productionConfig?.nodeEnv
        || env.NODE_ENV
        || "development";

    const secret = String(env.DEVELOPER_AUTH_SECRET || "").trim();

    const administrator = loadCredentialPair(env, {
        usernameKey: "ADMIN_USERNAME",
        usernameFallbackKey: "DEVELOPER_AUTH_USERNAME",
        hashKey: "ADMIN_PASSWORD_HASH",
        hashFallbackKey: "DEVELOPER_AUTH_PASSWORD_HASH",
        plainKey: "DEVELOPER_AUTH_PASSWORD",
        plainFallbackKey: "ADMIN_PASSWORD",
        secret
    });

    const viewer = loadCredentialPair(env, {
        usernameKey: "VIEWER_USERNAME",
        usernameFallbackKey: null,
        hashKey: "VIEWER_PASSWORD_HASH",
        hashFallbackKey: null,
        plainKey: "VIEWER_PASSWORD",
        plainFallbackKey: null,
        secret
    });

    const explicitlyDisabled = env.DEVELOPER_AUTH_ENABLED === "false";

    const configured = Boolean(secret && administrator.configured);

    const enabled = explicitlyDisabled
        ? false
        : (configured || env.DEVELOPER_AUTH_ENABLED === "true");

    // R6.2A — Unauthenticated console access only when auth is explicitly
    // disabled. Missing DEVELOPER_AUTH_SECRET must not unlock /debug.
    const openAccess = explicitlyDisabled === true;

    const accessTokenTtlSeconds = Number.parseInt(
        env.DEVELOPER_AUTH_ACCESS_TTL_SECONDS
        || env.ADMIN_SESSION_TIMEOUT_SECONDS
        || "900",
        10
    );

    const refreshTokenTtlSeconds = Number.parseInt(
        env.DEVELOPER_AUTH_REFRESH_TTL_SECONDS
        || env.ADMIN_SESSION_REFRESH_TTL_SECONDS
        || "28800",
        10
    );

    const appEnvironment = resolveAppEnvironment(env);

    return Object.freeze({
        enabled,
        configured,
        openAccess,
        secret,
        username: administrator.username,
        passwordHashScrypt: administrator.passwordHashScrypt,
        passwordHashLegacy: administrator.passwordHashLegacy,
        usesPlainPasswordFallback: administrator.usesPlainPasswordFallback,
        administrator,
        viewer,
        defaultRole: DEVELOPER_ROLES.ADMINISTRATOR,
        accessTokenTtlSeconds: Number.isFinite(accessTokenTtlSeconds)
            && accessTokenTtlSeconds > 0
            ? accessTokenTtlSeconds
            : 900,
        refreshTokenTtlSeconds: Number.isFinite(refreshTokenTtlSeconds)
            && refreshTokenTtlSeconds > 0
            ? refreshTokenTtlSeconds
            : 28800,
        appEnvironment,
        nodeEnv,
        nodeEnvironmentLabel: nodeEnv
    });

}

export function passwordsMatch(password, passwordHash, secret) {

    if (!passwordHash || !secret) {

        return false;

    }

    const left = hashPasswordLegacy(password, secret);

    if (left.length !== passwordHash.length) {

        return false;

    }

    return timingSafeEqual(left, passwordHash);

}

/**
 * Resolve login identity and role from credentials.
 */
export function resolveLoginIdentity(username, password, config) {

    const normalizedUser = String(username || "").trim();

    if (!normalizedUser || !config) {

        return null;

    }

    if (normalizedUser === config.administrator?.username
        && verifyCredentialPassword(password, config.administrator, config.secret)) {

        return {
            username: normalizedUser,
            role: DEVELOPER_ROLES.ADMINISTRATOR
        };

    }

    if (config.viewer?.configured
        && normalizedUser === config.viewer.username
        && verifyCredentialPassword(password, config.viewer, config.secret)) {

        return {
            username: normalizedUser,
            role: DEVELOPER_ROLES.VIEWER
        };

    }

    return null;

}

/**
 * Verify administrator password against configured hash material.
 */
export function verifyAdministratorPassword(password, config) {

    return verifyCredentialPassword(password, config?.administrator, config?.secret);

}

export function getAppEnvironmentLabel(appEnvironment) {

    if (appEnvironment === APP_ENVIRONMENT.MAINNET) {

        return "MAINNET";

    }

    if (appEnvironment === APP_ENVIRONMENT.TESTNET) {

        return "TESTNET";

    }

    return "DEVELOPMENT";

}
