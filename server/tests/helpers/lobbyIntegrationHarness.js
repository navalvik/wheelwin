import http from "http";

import { EventBus } from "../../events/EventBus.js";
import { GameManager } from "../../managers/GameManager.js";
import { PlayerManager } from "../../managers/PlayerManager.js";
import { RoomManager } from "../../managers/RoomManager.js";
import { PaymentSessionManager } from "../../gameplay/PaymentSessionManager.js";
import { GameContractManager } from "../../gameplay/GameContractManager.js";
import { GameStartAuthorization } from "../../gameplay/GameStartAuthorization.js";
import { GameContractDeployAdapter } from "../../payment/GameContractDeployAdapter.js";
import {
    BlockchainMonitor,
    EntryPaymentAuditLedger
} from "../../payment/BlockchainMonitor.js";
import { MockTonTransport } from "../../payment/ton/MockTonTransport.js";
import { LoggerService } from "../../services/LoggerService.js";
import { SessionWalletStore } from "../../session/SessionWalletStore.js";
import { GameplayContextResolver } from "../../socket/GameplayContextResolver.js";
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

    const sessionWalletStore = new SessionWalletStore();

    const tonTransport = new MockTonTransport();

    const entryPaymentAuditLedger = new EntryPaymentAuditLedger();

    const blockchainMonitor = new BlockchainMonitor({
        logger,
        eventBus,
        transport: tonTransport,
        auditLedger: entryPaymentAuditLedger,
        pollIntervalMs: 60_000
    });

    blockchainMonitor.initialize();

    const paymentSessionManager = new PaymentSessionManager({
        logger,
        eventBus,
        playerManager,
        roomManager,
        roomConfig: { paymentSessionDurationMs: 60_000 },
        gameplayContextResolver,
        sessionWalletStore,
        blockchainMonitor,
        devMode: false
    });

    paymentSessionManager.initialize();

    const gameContractManager = new GameContractManager({
        logger,
        eventBus,
        playerManager,
        roomManager,
        sessionWalletStore,
        configurationEngine: bootstrapEngines.configurationEngine,
        deployAdapter: new GameContractDeployAdapter({ deployDelayMs: 0 }),
        creatingDelayMs: 0,
        devMode: false
    });

    gameContractManager.initialize();

    const gameStartAuthorization = new GameStartAuthorization({
        logger,
        eventBus,
        roomManager,
        playerManager,
        gameManager,
        paymentSessionManager,
        gameContractManager,
        configurationEngine: bootstrapEngines.configurationEngine,
        physicsEngine: bootstrapEngines.physicsEngine,
        gameClockEngine: bootstrapEngines.gameClockEngine,
        gameplayContextResolver,
        auditLedger: entryPaymentAuditLedger,
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
        paymentSessionManager,
        gameContractManager,
        gameStartAuthorization,
        sessionWalletStore,
        isDevelopment: true,
        entryPaymentDelays: {
            playerPaymentDelayMs: 40,
            smartContractDelayMs: 40,
            completionDelayMs: 80
        }
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
        paymentSessionManager,
        gameContractManager,
        gameStartAuthorization,
        blockchainMonitor,
        tonTransport,
        entryPaymentAuditLedger,
        sessionWalletStore,
        bootstrapEngines,
        socketGateway,
        roomLobbyBridge,
        async shutdown() {

            roomLobbyBridge.shutdown();

            paymentSessionManager.shutdown();

            blockchainMonitor.shutdown();

            gameContractManager.shutdown();

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
