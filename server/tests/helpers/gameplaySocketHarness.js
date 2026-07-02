import http from "http";

import { EventBus } from "../../events/EventBus.js";
import { GameManager } from "../../managers/GameManager.js";
import { PlayerManager } from "../../managers/PlayerManager.js";
import { RoomManager } from "../../managers/RoomManager.js";
import { LoggerService } from "../../services/LoggerService.js";
import { GameplayContextResolver } from "../../socket/GameplayContextResolver.js";
import { RoomLobbyBridge } from "../../socket/RoomLobbyBridge.js";
import { SocketGateway } from "../../socket/SocketGateway.js";
import {
    shutdownGameplayBootstrap,
    wireGameplayBootstrap
} from "./gameplayBootstrapHarness.js";

export async function createGameplaySocketHarness() {

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

    const bootstrapEngines = wireGameplayBootstrap({
        gameManager,
        roomManager,
        playerManager,
        logger,
        eventBus,
        gameplayContextResolver
    });

    const httpServer = http.createServer();

    const socketGateway = new SocketGateway({
        logger,
        socketConfig: {
            cors: {
                origin: "*"
            }
        },
        eventBus,
        inputAuthority: bootstrapEngines.inputAuthority,
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
        gameplayContextResolver
    });

    roomLobbyBridge.initialize();

    await new Promise((resolve) => {

        httpServer.listen(0, "127.0.0.1", resolve);

    });

    const { port } = httpServer.address();

    const forwardedCalls = [];

    const originalPress = bootstrapEngines.inputAuthority
        .handleButtonPress.bind(bootstrapEngines.inputAuthority);

    const originalRelease = bootstrapEngines.inputAuthority
        .handleButtonRelease.bind(bootstrapEngines.inputAuthority);

    bootstrapEngines.inputAuthority.handleButtonPress = (gameId, playerId) => {

        forwardedCalls.push({
            method: "press",
            gameId,
            playerId
        });

        return originalPress(gameId, playerId);

    };

    bootstrapEngines.inputAuthority.handleButtonRelease = (gameId, playerId) => {

        forwardedCalls.push({
            method: "release",
            gameId,
            playerId
        });

        return originalRelease(gameId, playerId);

    };

    return {
        port,
        logger,
        eventBus,
        roomManager,
        playerManager,
        gameManager,
        bootstrapEngines,
        inputAuthority: bootstrapEngines.inputAuthority,
        gameplayContextResolver,
        socketGateway,
        roomLobbyBridge,
        forwardedCalls,
        resetForwardedCalls() {

            forwardedCalls.length = 0;

        },
        async shutdown() {

            roomLobbyBridge.shutdown();

            await socketGateway.shutdown();

            shutdownGameplayBootstrap(bootstrapEngines);

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
