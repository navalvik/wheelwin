export function loadSocketConfig(serverConfig) {

    return {
        cors: {
            origin: serverConfig.clientOrigin,
            methods: ["GET", "POST"]
        },
        transports: ["websocket", "polling"]
    };

}
