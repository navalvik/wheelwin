export const LOG_LEVELS = Object.freeze({
    ERROR: "error",
    WARN: "warn",
    INFO: "info",
    DEBUG: "debug"
});

export function isDevelopment(nodeEnv) {

    return nodeEnv === "development";

}

export function isProduction(nodeEnv) {

    return nodeEnv === "production";

}

export function loadProductionConfig(env = process.env, serverConfig = null) {

    const nodeEnv = serverConfig?.nodeEnv || env.NODE_ENV || "development";

    const development = isDevelopment(nodeEnv);

    const defaultLogLevel = development ? LOG_LEVELS.INFO : LOG_LEVELS.WARN;

    const requestedLevel = env.LOG_LEVEL || defaultLogLevel;

    const logLevel = Object.values(LOG_LEVELS).includes(requestedLevel)
        ? requestedLevel
        : defaultLogLevel;

    return {
        nodeEnv,
        isDevelopment: development,
        isProduction: isProduction(nodeEnv),
        logLevel,
        metricsEnabled: development || env.METRICS_ENABLED === "true",
        runStartupDemonstrations: development
            && env.STARTUP_DEMONSTRATIONS !== "false",
        // Per-tick SimulationLoop tracing is an explicit opt-in debug flag, not a
        // general development log. The loop ticks continuously (even with no
        // active game), so logging every tick floods stdout and can stall the
        // event loop when the output consumer drains slowly — which starves the
        // Socket.IO lobby pipeline. Off by default; enable only when debugging.
        debugSimulationLoop: env.DEBUG_SIMULATION_LOOP === "true"
    };

}
