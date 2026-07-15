import http from "http";

import { EventBus } from "../../events/EventBus.js";
import { GameManager } from "../../managers/GameManager.js";
import { PlayerManager } from "../../managers/PlayerManager.js";
import { RoomManager } from "../../managers/RoomManager.js";
import { LoggerService } from "../../services/LoggerService.js";
import { RoomLobbyBridge } from "../../socket/RoomLobbyBridge.js";
import { SocketGateway } from "../../socket/SocketGateway.js";
import {
    shutdownGameplayBootstrap,
    wireGameplayBootstrap
} from "./gameplayBootstrapHarness.js";

export async function createLobbyIntegrationHarness() {

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

    const bootstrapEngines = wireGameplayBootstrap({
        gameManager,
        roomManager,
        playerManager,
        logger,
        eventBus
    });

    const httpServer = http.createServer();

    const socketGateway = new SocketGateway({
        logger,
        socketConfig: {
            cors: {
                origin: "*"
            }
        },
        eventBus
    });

    socketGateway.initialize(httpServer);

    socketGateway.connectEventBus(eventBus);

    const roomLobbyBridge = new RoomLobbyBridge({
        logger,
        eventBus,
        roomManager,
        playerManager,
        setupSessionLifecycle: bootstrapEngines.setupSessionLifecycle
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
        bootstrapEngines,
        socketGateway,
        roomLobbyBridge,
        async shutdown() {

            roomLobbyBridge.shutdown();

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
