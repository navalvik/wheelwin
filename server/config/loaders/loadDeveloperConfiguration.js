/**
 * R7.0C — Developer authentication configuration loader.
 */

import { loadDeveloperAuthConfig } from "../../console/auth/developerAuthConfig.js";

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {object} productionConfig
 */
export function loadDeveloperConfiguration(env, productionConfig) {

    const auth = loadDeveloperAuthConfig(env, productionConfig);

    return Object.freeze({
        enabled: auth.enabled,
        configured: auth.configured,
        secret: auth.secret,
        username: auth.username,
        passwordHash: auth.passwordHash,
        defaultRole: auth.defaultRole,
        accessTokenTtlSeconds: auth.accessTokenTtlSeconds,
        refreshTokenTtlSeconds: auth.refreshTokenTtlSeconds,
        environment: auth.environment,
        nodeEnv: auth.nodeEnv
    });

}
