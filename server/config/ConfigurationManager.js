/**
 * R7.0C — Single source of truth for production configuration loading.
 *
 * Process env → loaders → validation → immutable RuntimeConfiguration.
 * Fail-fast: never returns a partial config for RUNNING.
 */

import { createRequire } from "node:module";

import { ConfigurationIssueCollector, ConfigurationError } from "./ConfigurationError.js";
import { RuntimeConfiguration, CONFIGURATION_CATEGORIES } from "./RuntimeConfiguration.js";
import { loadEnvironment } from "./loaders/loadEnvironment.js";
import { loadOwnerConfiguration } from "./loaders/loadOwnerConfiguration.js";
import { loadDeveloperConfiguration } from "./loaders/loadDeveloperConfiguration.js";
import { validateEnvironment } from "./validators/validateEnvironment.js";
import { validateSecrets } from "./validators/validateSecrets.js";
import { validateConfiguration } from "./validators/validateConfiguration.js";
import { DEFAULT_OWNER_CONFIG_PATH } from "./OwnerConfiguration.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json");

export class ConfigurationManager {

    static _runtime = null;

    /**
     * Load, validate, and freeze runtime configuration.
     *
     * @param {{
     *   env?: NodeJS.ProcessEnv,
     *   ownerConfigPath?: string,
     *   resetForTests?: boolean,
     *   version?: string
     * }} [options]
     * @returns {RuntimeConfiguration}
     */
    static load({
        env = process.env,
        ownerConfigPath = DEFAULT_OWNER_CONFIG_PATH,
        resetForTests = false,
        version = packageJson.version
    } = {}) {

        if (ConfigurationManager._runtime && !resetForTests) {

            throw new ConfigurationError({
                errors: [{
                    key: "RuntimeConfiguration",
                    reason: "Configuration already loaded and immutable",
                    expectedType: "single-load",
                    received: "<already-loaded>",
                    suggestedFix: "Restart the process to reload configuration."
                }]
            });

        }

        if (resetForTests) {

            ConfigurationManager._runtime = null;

        }

        const collector = new ConfigurationIssueCollector();

        validateEnvironment(collector, env);

        const nodeEnv = env.NODE_ENV || "development";

        const tonDeployMode = String(env.TON_DEPLOY_MODE || "stub")
            .trim()
            .toLowerCase() === "live"
            ? "live"
            : "stub";

        validateSecrets(collector, env, {
            nodeEnv,
            tonDeployMode,
            developer: { enabled: false, configured: false }
        });

        collector.throwIfAny();

        const environment = loadEnvironment(env);

        const owner = loadOwnerConfiguration({
            configPath: ownerConfigPath,
            resetForTests
        });

        const developer = loadDeveloperConfiguration(
            env,
            environment.production
        );

        validateSecrets(collector, env, {
            nodeEnv: environment.server.nodeEnv,
            tonDeployMode: environment.ton.deployMode,
            developer
        });

        validateConfiguration(collector, {
            server: environment.server,
            production: environment.production,
            rooms: environment.rooms,
            ton: environment.ton,
            owner,
            developer,
            profile: environment.profile
        });

        collector.throwIfAny();

        const runtime = new RuntimeConfiguration({
            profile: environment.profile,
            server: environment.server,
            production: environment.production,
            rooms: environment.rooms,
            ton: environment.ton,
            socket: environment.socket,
            eventBus: environment.eventBus,
            gameplayPhases: environment.gameplayPhases,
            owner,
            developer,
            validatedCategories: CONFIGURATION_CATEGORIES,
            version
        });

        ConfigurationManager._runtime = runtime;

        return runtime;

    }

    static getRuntime() {

        if (!ConfigurationManager._runtime) {

            throw new ConfigurationError({
                errors: [{
                    key: "RuntimeConfiguration",
                    reason: "Configuration has not been loaded",
                    expectedType: "loaded RuntimeConfiguration",
                    received: "<missing>",
                    suggestedFix: "Call ConfigurationManager.load() during startup."
                }]
            });

        }

        return ConfigurationManager._runtime;

    }

    static isLoaded() {

        return ConfigurationManager._runtime !== null;

    }

    /**
     * Test-only reset.
     */
    static resetForTests() {

        ConfigurationManager._runtime = null;

    }

    /**
     * Startup logging — never prints secrets.
     *
     * @param {{ info: Function }} logger
     * @param {RuntimeConfiguration} [runtime]
     */
    static logStartupSummary(logger, runtime = ConfigurationManager._runtime) {

        if (!logger || !runtime) {

            return;

        }

        const safe = runtime.toSafeSummary();

        logger.info(
            `Configuration profile=${safe.profile} | env=${safe.environment} | version=${safe.version}`
        );

        logger.info(
            `Validated categories: ${safe.categories.join(", ")}`
        );

        logger.info(
            "Enabled modules | "
                + `metrics=${safe.features.metricsEnabled} `
                + `developerAuth=${safe.features.developerAuthEnabled} `
                + `tonDeploy=${safe.features.tonDeployMode} `
                + `eventBusLogging=${safe.features.eventBusLogging}`
        );

    }

}

export { ConfigurationError, RuntimeConfiguration };
