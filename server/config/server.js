export function loadServerConfig(env = process.env) {

    const port = Number(env.PORT);

    if (!Number.isFinite(port) || port <= 0) {

        throw new Error("Invalid PORT environment variable");

    }

    const host = env.HOST;

    if (!host) {

        throw new Error("HOST environment variable is required");

    }

    const clientOrigin = env.CLIENT_ORIGIN;

    if (!clientOrigin) {

        throw new Error("CLIENT_ORIGIN environment variable is required");

    }

    return {
        port,
        host,
        clientOrigin,
        nodeEnv: env.NODE_ENV || "development"
    };

}
