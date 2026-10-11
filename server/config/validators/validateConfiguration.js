/**
 * R7.0C — Cross-cutting configuration validation after loaders succeed.
 */

/**
 * @param {import("../ConfigurationError.js").ConfigurationIssueCollector} collector
 * @param {{
 *   server: object,
 *   production: object,
 *   rooms: object,
 *   developer: object,
 *   profile: string
 * }} loaded
 */
export function validateConfiguration(collector, loaded) {

    const { server, production, rooms, developer, profile } = loaded;

    if (!Number.isInteger(server.port)
        || server.port < 1
        || server.port > 65535) {

        collector.add({
            key: "PORT",
            reason: "Port out of valid range after load",
            expectedType: "integer(1-65535)",
            received: server.port,
            suggestedFix: "Set PORT between 1 and 65535."
        });

    }

    if (!Number.isInteger(rooms.maxPlayers) || rooms.maxPlayers <= 0) {

        collector.add({
            key: "ROOM_MAX_PLAYERS",
            reason: "ROOM_MAX_PLAYERS must be a positive integer",
            expectedType: "integer>0",
            received: rooms.maxPlayers,
            suggestedFix: "Set ROOM_MAX_PLAYERS to a positive integer."
        });

    }

    if (profile === "production" || profile === "staging") {

        if (production.runStartupDemonstrations === true) {

            collector.add({
                key: "STARTUP_DEMONSTRATIONS",
                reason: "Startup demonstrations are forbidden in this profile",
                expectedType: "false",
                received: true,
                suggestedFix: "Unset STARTUP_DEMONSTRATIONS for staging/production."
            });

        }

        if (production.debugSimulationLoop === true) {

            collector.add({
                key: "DEBUG_SIMULATION_LOOP",
                reason: "Debug simulation loop is forbidden in this profile",
                expectedType: "false",
                received: true,
                suggestedFix: "Unset DEBUG_SIMULATION_LOOP for staging/production."
            });

        }

        if (developer.enabled !== true || developer.configured !== true) {

            collector.add({
                key: "DEVELOPER_AUTH_ENABLED",
                reason: "Developer Console authentication must be enabled and configured",
                expectedType: "enabled+configured",
                received: `enabled=${developer.enabled};configured=${developer.configured}`,
                suggestedFix: "Configure DEVELOPER_AUTH_* and enable authentication."
            });

        }

    }

    if (!Number.isFinite(production.gracefulShutdownTimeoutMs)
        || production.gracefulShutdownTimeoutMs <= 0) {

        collector.add({
            key: "GRACEFUL_SHUTDOWN_TIMEOUT_MS",
            reason: "Invalid graceful shutdown timeout",
            expectedType: "integer>0",
            received: production.gracefulShutdownTimeoutMs,
            suggestedFix: "Set GRACEFUL_SHUTDOWN_TIMEOUT_MS to a positive integer."
        });

    }

}
