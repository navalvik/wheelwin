export function loadSocketConfig(serverConfig) {

    return {
        cors: {
            origin: serverConfig.clientOrigin,
            methods: ["GET", "POST"]
        },
        transports: ["websocket", "polling"],
        connectionStateRecovery: {
            maxDisconnectionDuration: 2 * 60 * 1000,
            skipMiddlewares: true
        }
    };

}
