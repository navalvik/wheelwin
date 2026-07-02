export function loadEventBusConfig(env = process.env, serverConfig = null) {

    const nodeEnv = serverConfig?.nodeEnv || env.NODE_ENV || "development";

    const isDevelopment = nodeEnv === "development";

    const loggingFlag = env.EVENT_BUS_LOGGING;

    const logEvents = loggingFlag === undefined
        ? isDevelopment
        : loggingFlag === "true";

    return {
        logEvents,
        showDebugPanel: isDevelopment
    };

}
