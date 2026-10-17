import http from "http";

import { EventBus } from "../../events/EventBus.js";
import { GameManager } from "../../managers/GameManager.js";
import { PlayerManager } from "../../managers/PlayerManager.js";
import { RoomManager } from "../../managers/RoomManager.js";
import { GameStartAuthorization } from "../../gameplay/GameStartAuthorization.js";
import { LoggerService } from "../../services/LoggerService.js";
import { GameplayContextResolver } from "../../socket/GameplayContextResolver.js";
import { RoomLobbyBridge } from "../../socket/RoomLobbyBridge.js";
import { SocketGateway } from "../../socket/SocketGateway.js";
import {
    shutdownGameplayBootstrap,
    wireGameplayBootstrap
} from "./gameplayBootstrapHarness.js";

export async function createLobbyIntegrationHarness({ paymentGate = undefined } = {}) {

    const logger = new LoggerService({ logLevel: "error" });

    logger.initialize();

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const roomManager = new RoomManager({
        logger,
        eventBus,
        roomConfig: { maxPlayers: 3 }
    });

    const playerManager = new PlayerManager({ logger, eventBus });

    const gameManager = new GameManager({ logger, eventBus });

    roomManager.initialize();

    playerManager.initialize();

    gameManager.initialize();

    const gameplayContextResolver = new GameplayContextResolver({
        logger,
        playerManager,
        roomManager
    });

    gameManager.linkGameplayContextResolver(gameplayContextResolver);

    const bootstrapEngines = wireGameplayBootstrap({
        gameManager,
        roomManager,
        playerManager,
        logger,
        eventBus,
        gameplayContextResolver
    });

    // Dev harness identity: every socket is authenticated server-side with a
    // deterministic numeric Telegram-user marker (never client-supplied).
    const telegramIdentityBySocket = new Map();

    const telegramIdentityResolver = (socketId) => {

        if (!telegramIdentityBySocket.has(socketId)) {

            telegramIdentityBySocket.set(
                socketId,
                900000 + telegramIdentityBySocket.size
            );

        }

        return telegramIdentityBySocket.get(socketId);

    };

    const gameStartAuthorization = new GameStartAuthorization({
        logger,
        eventBus,
        roomManager,
        playerManager,
        gameManager,
        configurationEngine: bootstrapEngines.configurationEngine,
        physicsEngine: bootstrapEngines.physicsEngine,
        gameClockEngine: bootstrapEngines.gameClockEngine,
        gameplayContextResolver,
        paymentGate,
        roomConfig: { maxPlayers: 3 },
        devMode: false
    });

    gameStartAuthorization.initialize();

    const httpServer = http.createServer();

    const socketGateway = new SocketGateway({
        logger,
        socketConfig: {
            cors: {
                origin: "*"
            }
        },
        eventBus,
        gameplayContextResolver,
        devMode: true
    });

    socketGateway.initialize(httpServer);

    socketGateway.connectEventBus(eventBus);

    const roomLobbyBridge = new RoomLobbyBridge({
        logger,
        eventBus,
        roomManager,
        playerManager,
        gameplayContextResolver,
        setupSessionLifecycle: bootstrapEngines.setupSessionLifecycle,
        gameStartAuthorization,
        telegramIdentityResolver,
        isDevelopment: true
    });

    roomLobbyBridge.initialize();

    await new Promise((resolve) => {

        httpServer.listen(0, "127.0.0.1", resolve);

    });

    const { port } = httpServer.address();

    return {
        port,
        logger,
        eventBus,
        roomManager,
        playerManager,
        gameManager,
        gameplayContextResolver,
        gameStartAuthorization,
        bootstrapEngines,
        socketGateway,
        roomLobbyBridge,
        async shutdown() {

            roomLobbyBridge.shutdown();

            gameStartAuthorization.shutdown();

            shutdownGameplayBootstrap(bootstrapEngines);

            await socketGateway.shutdown();

            eventBus.shutdown();

            roomManager.shutdown();

            playerManager.shutdown();

            gameManager.shutdown();

            await new Promise((resolve, reject) => {

                if (!httpServer.listening) {

                    resolve();

                    return;

                }

                httpServer.close((error) => {

                    if (error) {

                        reject(error);

                        return;

                    }

                    resolve();

                });

            });

            logger.shutdown();

        }
    };

}
