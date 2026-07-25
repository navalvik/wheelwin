/**
 * R6.1 — Developer authentication configuration (env-only secrets).
 */

import { createHash, timingSafeEqual } from "node:crypto";

import { DEVELOPER_ROLES } from "./developerRoles.js";

function resolveEnvironmentLabel(nodeEnv) {

    if (nodeEnv === "production") {

        return "Production";

    }

    if (nodeEnv === "staging") {

        return "Staging";

    }

    return "Development";

}

function hashPassword(password, secret) {

    return createHash("sha256")
        .update(`${secret}:${password}`)
        .digest();

}

export function loadDeveloperAuthConfig(env = process.env, productionConfig = null) {

    const nodeEnv = productionConfig?.nodeEnv
        || env.NODE_ENV
        || "development";

    const secret = String(env.DEVELOPER_AUTH_SECRET || "").trim();

    const username = String(env.DEVELOPER_AUTH_USERNAME || "").trim();

    const password = String(env.DEVELOPER_AUTH_PASSWORD || "");

    const explicitlyDisabled = env.DEVELOPER_AUTH_ENABLED === "false";

    const configured = Boolean(secret && username && password);

    // Secure by default when credentials exist. Explicit false disables the gate.
    const enabled = explicitlyDisabled
        ? false
        : (configured || env.DEVELOPER_AUTH_ENABLED === "true");

    const accessTokenTtlSeconds = Number.parseInt(
        env.DEVELOPER_AUTH_ACCESS_TTL_SECONDS || "900",
        10
    );

    const refreshTokenTtlSeconds = Number.parseInt(
        env.DEVELOPER_AUTH_REFRESH_TTL_SECONDS || "28800",
        10
    );

    return Object.freeze({
        enabled,
        configured,
        secret,
        username,
        passwordHash: configured ? hashPassword(password, secret) : null,
        defaultRole: DEVELOPER_ROLES.DEVELOPER,
        accessTokenTtlSeconds: Number.isFinite(accessTokenTtlSeconds)
            && accessTokenTtlSeconds > 0
            ? accessTokenTtlSeconds
            : 900,
        refreshTokenTtlSeconds: Number.isFinite(refreshTokenTtlSeconds)
            && refreshTokenTtlSeconds > 0
            ? refreshTokenTtlSeconds
            : 28800,
        environment: resolveEnvironmentLabel(nodeEnv),
        nodeEnv
    });

}

export function passwordsMatch(password, passwordHash, secret) {

    if (!passwordHash || !secret) {

        return false;

    }

    const left = hashPassword(password, secret);

    if (left.length !== passwordHash.length) {

        return false;

    }

    return timingSafeEqual(left, passwordHash);

}
