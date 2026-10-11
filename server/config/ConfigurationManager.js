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
import { loadDeveloperConfiguration } from "./loaders/loadDeveloperConfiguration.js";
import { validateEnvironment } from "./validators/validateEnvironment.js";
import { validateSecrets } from "./validators/validateSecrets.js";
import { validateConfiguration } from "./validators/validateConfiguration.js";
import { applyEnvironmentStateToEnv } from "../console/environment/environmentStateStore.js";

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

        const effectiveEnv = applyEnvironmentStateToEnv(env);

        validateEnvironment(collector, effectiveEnv);

        const nodeEnv = effectiveEnv.NODE_ENV || "development";

        const environment = loadEnvironment(effectiveEnv);

        const developer = loadDeveloperConfiguration(
            effectiveEnv,
            environment.production
        );

        validateSecrets(collector, effectiveEnv, {
            nodeEnv: environment.server.nodeEnv,
            developer
        });

        validateConfiguration(collector, {
            server: environment.server,
            production: environment.production,
            rooms: environment.rooms,
            developer,
            profile: environment.profile
        });

        collector.throwIfAny();

        const runtime = new RuntimeConfiguration({
            profile: environment.profile,
            server: environment.server,
            production: environment.production,
            rooms: environment.rooms,
            socket: environment.socket,
            eventBus: environment.eventBus,
            gameplayPhases: environment.gameplayPhases,
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
                + ``
                + `eventBusLogging=${safe.features.eventBusLogging}`
        );

    }

}

export { ConfigurationError, RuntimeConfiguration };
