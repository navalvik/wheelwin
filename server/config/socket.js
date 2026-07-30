export function loadSocketConfig(serverConfig) {

    return {
        // Same cors object as Express (serverConfig.cors).
        cors: serverConfig.cors,
        transports: ["websocket", "polling"],
        connectionStateRecovery: {
            maxDisconnectionDuration: 2 * 60 * 1000,
            skipMiddlewares: true
        }
    };

}
