/**
 * R7.0C — Load process environment into typed module configs (existing loaders).
 */

import { loadServerConfig } from "../server.js";
import { loadProductionConfig } from "../production.js";
import { loadRoomConfig } from "../rooms.js";
import { loadTonConfig } from "../ton.js";
import { loadSocketConfig } from "../socket.js";
import { loadEventBusConfig } from "../events.js";
import { loadGameplayPhaseConfig } from "../gameplayPhases.js";
import { ConfigurationError } from "../ConfigurationError.js";

function wrapLoaderError(key, error, suggestedFix) {

    return new ConfigurationError({
        errors: [{
            key,
            reason: error?.message || "Environment loader failed",
            expectedType: "valid configuration",
            received: "<loader-error>",
            suggestedFix
        }]
    });

}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {{
 *   server: object,
 *   production: object,
 *   rooms: object,
 *   ton: object,
 *   socket: object,
 *   eventBus: object,
 *   gameplayPhases: object,
 *   profile: string
 * }}
 */
export function loadEnvironment(env = process.env) {

    let server;

    try {

        server = loadServerConfig(env);

    } catch (error) {

        throw wrapLoaderError(
            "PORT|HOST|CLIENT_ORIGIN",
            error,
            "Fix PORT, HOST, and CLIENT_ORIGIN in the environment."
        );

    }

    // Reject invalid NODE_ENV values early (schema allows only three).
    const nodeEnvRaw = env.NODE_ENV;

    if (nodeEnvRaw !== undefined && nodeEnvRaw !== "") {

        const allowed = new Set(["development", "staging", "production"]);

        if (!allowed.has(String(nodeEnvRaw))) {

            throw new ConfigurationError({
                errors: [{
                    key: "NODE_ENV",
                    reason: "Invalid environment profile",
                    expectedType: "development|staging|production",
                    received: nodeEnvRaw,
                    suggestedFix: "Set NODE_ENV to development, staging, or production."
                }]
            });

        }

    }

    let production;

    try {

        production = loadProductionConfig(env, server);

    } catch (error) {

        throw wrapLoaderError(
            "GRACEFUL_SHUTDOWN_TIMEOUT_MS",
            error,
            "Set GRACEFUL_SHUTDOWN_TIMEOUT_MS to a positive integer."
        );

    }

    let rooms;

    try {

        rooms = loadRoomConfig(env);

    } catch (error) {

        throw wrapLoaderError(
            "ROOM_MAX_PLAYERS",
            error,
            "Set ROOM_MAX_PLAYERS and related room timing variables correctly."
        );

    }

    let ton;

    try {

        ton = loadTonConfig(env);

    } catch (error) {

        throw wrapLoaderError(
            String(error?.message || "").includes("GAME_ESCROW_MODE")
                ? "GAME_ESCROW_MODE"
                : "TON_NETWORK",
            error,
            "Set TON_NETWORK and optional TON_* / GAME_ESCROW_MODE correctly (v4|game)."
        );

    }

    const socket = loadSocketConfig(server);

    const eventBus = loadEventBusConfig(env, server);

    const gameplayPhases = loadGameplayPhaseConfig(env);

    const profile = production.isProduction
        ? "production"
        : server.nodeEnv === "staging"
            ? "staging"
            : "development";

    return {
        server,
        production,
        rooms,
        ton,
        socket,
        eventBus,
        gameplayPhases,
        profile
    };

}
