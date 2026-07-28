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
        openAccess: auth.openAccess === true,
        secret: auth.secret,
        username: auth.username,
        passwordHashScrypt: auth.passwordHashScrypt,
        passwordHashLegacy: auth.passwordHashLegacy,
        usesPlainPasswordFallback: auth.usesPlainPasswordFallback,
        administrator: auth.administrator,
        viewer: auth.viewer,
        defaultRole: auth.defaultRole,
        accessTokenTtlSeconds: auth.accessTokenTtlSeconds,
        refreshTokenTtlSeconds: auth.refreshTokenTtlSeconds,
        appEnvironment: auth.appEnvironment,
        nodeEnv: auth.nodeEnv,
        nodeEnvironmentLabel: auth.nodeEnvironmentLabel
    });

}
