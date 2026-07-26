export function loadServerConfig(env = process.env) {

    const port = Number(env.PORT);

    if (!Number.isFinite(port) || port <= 0) {

        throw new Error("Invalid PORT environment variable");

    }

    const host = env.HOST;

    if (!host) {

        throw new Error("HOST environment variable is required");

    }

    const clientOriginRaw = env.CLIENT_ORIGIN;

    if (!clientOriginRaw) {

        throw new Error("CLIENT_ORIGIN environment variable is required");

    }

    // Comma-separated origins for localhost + LAN Vite clients.
    const clientOrigins = String(clientOriginRaw)
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);

    if (clientOrigins.length === 0) {

        throw new Error("CLIENT_ORIGIN environment variable is required");

    }

    // Single string when one origin (backward compatible); array for many.
    const clientOrigin = clientOrigins.length === 1
        ? clientOrigins[0]
        : Object.freeze([...clientOrigins]);

    return {
        port,
        host,
        clientOrigin,
        nodeEnv: env.NODE_ENV || "development"
    };

}
