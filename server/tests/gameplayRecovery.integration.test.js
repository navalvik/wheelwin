import { GameCatalog } from "../catalog/GameCatalog.js";
import { createStandardConfigurationPlayers } from "./helpers/configurationPlayers.js";
import { INPUT_RULES } from "../catalog/InputRules.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GameClockEngine } from "../engines/GameClockEngine.js";
import { ConfigurationEngine } from "../engines/ConfigurationEngine.js";
import { GameStateEngine } from "../engines/GameStateEngine.js";
import { PhysicsEngine } from "../engines/PhysicsEngine.js";
import { WinnerEngine } from "../engines/WinnerEngine.js";
import { PaymentEngine } from "../engines/PaymentEngine.js";
import { RecoveryEngine } from "../engines/RecoveryEngine.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import { InputAuthority } from "../input/InputAuthority.js";
import { PLAYER_STATE } from "../models/PlayerState.js";
import { PlayerManager } from "../managers/PlayerManager.js";
import { LoggerService } from "../services/LoggerService.js";
import { RandomService } from "../services/RandomService.js";
import { TelegramWalletAdapter } from "../services/telegram/TelegramWalletAdapter.js";
import { SimulationLoop } from "../simulation/SimulationLoop.js";
import { WinnerActivation } from "../gameplay/WinnerActivation.js";
import { ResultActivation } from "../gameplay/ResultActivation.js";
import { GameplayPhaseLifecycle } from "../gameplay/GameplayPhaseLifecycle.js";
import { PaymentActivation } from "../gameplay/PaymentActivation.js";
import { RecoverySnapshotCache } from "../gameplay/RecoverySnapshotCache.js";
import { GameplayContextResolver } from "../socket/GameplayContextResolver.js";
import { RoomLobbyBridge } from "../socket/RoomLobbyBridge.js";
import { RoomManager } from "../managers/RoomManager.js";
import { SetupSessionLifecycle } from "../gameplay/SetupSessionLifecycle.js";
import {
    buildClientRecoveryPayload,
    RECOVERY_SOCKET_MESSAGE_TYPES
} from "../socket/gameplayRecoveryProtocol.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

function buildRecoveryStack() {

    const logger = new LoggerService({ logLevel: "error" });

    logger.initialize();

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const catalog = new GameCatalog({ logger });

    catalog.initialize();

    const randomService = new RandomService({ logger });

    randomService.initialize();

    randomService.setSeed(9876);

    const playerManager = new PlayerManager({ logger, eventBus });

    playerManager.initialize();

    const roomManager = new RoomManager({
        logger,
        eventBus,
        roomConfig: { maxPlayers: 3 }
    });

    roomManager.initialize();

    const setupSessionLifecycle = new SetupSessionLifecycle({
        logger,
        eventBus,
        roomManager,
        roomConfig: { setupDurationMs: 10 * 60 * 1000 }
    });

    setupSessionLifecycle.initialize();

    roomManager.attachSetupSessionLifecycle(setupSessionLifecycle);

    const configurationEngine = new ConfigurationEngine({
        logger,
        eventBus,
        gameCatalog: catalog,
        randomService
    });

    configurationEngine.initialize();

    const gameClockEngine = new GameClockEngine({
        logger,
        eventBus,
        gameCatalog: catalog
    });

    gameClockEngine.initialize();

    const physicsEngine = new PhysicsEngine({
        logger,
        eventBus,
        gameClock: gameClockEngine
    });

    physicsEngine.initialize();

    const gameStateEngine = new GameStateEngine({ logger, eventBus });

    gameStateEngine.initialize();

    const winnerEngine = new WinnerEngine({
        logger,
        eventBus,
        physicsEngine,
        configurationEngine,
        gameCatalog: catalog
    });

    winnerEngine.initialize();

    const inputAuthority = new InputAuthority({
        logger,
        eventBus,
        gameCatalog: {
            getInputRules: () => ({ ...INPUT_RULES, pressCooldownMs: 0 }),
            getColors: () => catalog.getColors(),
            getIcons: () => catalog.getIcons(),
            getStakes: () => catalog.getStakes(),
            getTimers: () => catalog.getTimers(),
            getWheelRules: () => catalog.getWheelRules()
        },
        playerManager,
        physicsEngine,
        gameStateEngine,
        devMode: false
    });

    inputAuthority.initialize();

    const paymentEngine = new PaymentEngine({
        logger,
        eventBus,
        winnerEngine,
        configurationEngine,
        gameCatalog: catalog,
        telegramWalletAdapter: new TelegramWalletAdapter({ logger })
    });

    paymentEngine.initialize();

    const recoveryEngine = new RecoveryEngine({
        logger,
        eventBus,
        gameCatalog: catalog,
        configurationEngine,
        gameStateEngine,
        gameClock: gameClockEngine,
        physicsEngine,
        inputAuthority,
        winnerEngine,
        paymentEngine
    });

    recoveryEngine.initialize();

    const recoverySnapshotCache = new RecoverySnapshotCache({
        logger,
        eventBus,
        recoveryEngine,
        paymentEngine,
        devMode: false
    });

    recoverySnapshotCache.initialize();

    const gameplayContextResolver = new GameplayContextResolver({
        logger,
        playerManager,
        roomManager
    });

    const roomLobbyBridge = new RoomLobbyBridge({
        logger,
        eventBus,
        roomManager,
        playerManager,
        gameplayContextResolver,
        setupSessionLifecycle
    });

    roomLobbyBridge.initialize();

    const simulationLoop = new SimulationLoop({
        logger,
        eventBus,
        physicsEngine,
        inputAuthority,
        devMode: false
    });

    simulationLoop.initialize();

    const winnerActivation = new WinnerActivation({
        logger,
        eventBus,
        physicsEngine,
        winnerEngine,
        gameStateEngine,
        devMode: false
    });

    winnerActivation.initialize();

    const gameplayPhaseLifecycle = new GameplayPhaseLifecycle({
        logger,
        eventBus,
        gameStateEngine,
        gameClockEngine,
        winnerEngine,
        devMode: false
    });

    gameplayPhaseLifecycle.initialize();

    const resultActivation = new ResultActivation({
        logger,
        eventBus,
        gameClockEngine,
        winnerEngine,
        devMode: false
    });

    resultActivation.initialize();

    const paymentActivation = new PaymentActivation({
        logger,
        eventBus,
        paymentEngine,
        devMode: false
    });

    paymentActivation.initialize();

    // Re-bind recovery with ResultActivation for openPage6 tracking.
    recoveryEngine._resultActivation = resultActivation;

    return {
        logger,
        eventBus,
        catalog,
        playerManager,
        roomManager,
        configurationEngine,
        gameClockEngine,
        physicsEngine,
        gameStateEngine,
        winnerEngine,
        inputAuthority,
        paymentEngine,
        recoveryEngine,
        recoverySnapshotCache,
        gameplayContextResolver,
        roomLobbyBridge,
        simulationLoop,
        winnerActivation,
        resultActivation,
        gameplayPhaseLifecycle,
        paymentActivation,
        shutdown() {

            paymentActivation.shutdown();

            resultActivation.shutdown();

            gameplayPhaseLifecycle.shutdown();

            winnerActivation.shutdown();

            simulationLoop.shutdown();

            roomLobbyBridge.shutdown();

            setupSessionLifecycle.shutdown();

            recoverySnapshotCache.shutdown();

            recoveryEngine.shutdown();

            paymentEngine.shutdown();

            inputAuthority.shutdown();

            winnerEngine.shutdown();

            gameStateEngine.shutdown();

            gameClockEngine.shutdown();

            physicsEngine.shutdown();

            configurationEngine.shutdown();

            roomManager.shutdown();

            playerManager.shutdown();

            randomService.shutdown();

            eventBus.shutdown();

            logger.shutdown();

        }
    };

}

function activateGame(stack, gameId, playerIds) {

    stack.configurationEngine.generateConfiguration(
        gameId,
        { roomId: "recovery-room", stake: 10 },
        createStandardConfigurationPlayers(playerIds)
    );

    stack.gameStateEngine.initializeGameState(gameId);

    for (const state of [
        GAME_STATES.READY,
        GAME_STATES.SELF_TEST,
        GAME_STATES.SPEED
    ]) {

        stack.gameStateEngine.transition(gameId, state, { reason: "test" });

    }

    stack.gameClockEngine.createClock(gameId);

    stack.gameClockEngine.startClock(gameId);

    stack.physicsEngine.createSimulation(gameId);

    stack.physicsEngine.startSimulation(gameId);

    for (const playerId of playerIds) {

        stack.inputAuthority.registerPlayer(gameId, playerId);

    }

}

// ---------------------------------------------------------------------------
// Scenario 1 — gameplay recovery snapshot matches authoritative server state.
// ---------------------------------------------------------------------------

{

    const stack = buildRecoveryStack();

    try {

        const gameId = "recovery-gameplay";

        const playerId = "recovery-player-1";

        const playerIds = [];

        for (let index = 0; index < 3; index += 1) {

            const created = stack.playerManager.createPlayer({
                nickname: `Recovery Racer ${index + 1}`
            });

            stack.playerManager.setPlayerState(
                created.identity.playerId,
                PLAYER_STATE.PLAYING
            );

            playerIds.push(created.identity.playerId);

        }

        const actualPlayerId = playerIds[0];

        activateGame(stack, gameId, playerIds);

        stack.gameplayContextResolver.activateRoomGame("recovery-room", gameId);

        stack.gameplayContextResolver.bindSocket("socket-recovery", {
            playerId: actualPlayerId,
            roomId: "recovery-room"
        });

        const snapshot = stack.recoveryEngine.recoverPlayer(gameId, actualPlayerId);

        const clientPayload = buildClientRecoveryPayload({
            snapshot,
            playerId: actualPlayerId,
            roomId: "recovery-room",
            paymentStatus: stack.paymentEngine.getPaymentStatus(gameId),
            payment: stack.paymentEngine.getPayment(gameId)
        });

        assert(
            clientPayload.gameState === GAME_STATES.SPEED,
            "recovered GameState must match server"
        );

        assert(
            Number.isFinite(clientPayload.wheelAngle),
            "recovered wheel angle must be present"
        );

        assert(
            clientPayload.gameId === gameId,
            "gameId must pass through"
        );

        assert(
            RECOVERY_SOCKET_MESSAGE_TYPES.SESSION_SNAPSHOT === "SESSION_SNAPSHOT",
            "recovery protocol message type must be defined"
        );

        console.log("  scenario 1 (gameplay snapshot authority) passed");

    } finally {

        stack.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Scenario 2 — finished game snapshot restores winner + payment for Page6.
// ---------------------------------------------------------------------------

{

    const stack = buildRecoveryStack();

    try {

        const gameId = "recovery-result";

        const playerIds = [];

        for (let index = 0; index < 3; index += 1) {

            const created = stack.playerManager.createPlayer({
                nickname: `Result Racer ${index + 1}`
            });

            stack.playerManager.setPlayerState(
                created.identity.playerId,
                PLAYER_STATE.PLAYING
            );

            playerIds.push(created.identity.playerId);

        }

        const playerId = playerIds[0];

        activateGame(stack, gameId, playerIds);

        for (let tick = 0; tick < 5; tick += 1) {

            stack.simulationLoop._onTick();

        }

        // Advance clock into BRAKE so ResultActivation can begin RESULT.
        stack.gameClockEngine.restorePhaseSchedule(gameId, {
            phase: GAME_STATES.BRAKE,
            phaseStartedAt: Date.now() - 1000,
            phaseEndsAt: Date.now() + 5000
        });

        stack.gameStateEngine.transition(gameId, GAME_STATES.BRAKE, {
            reason: "test"
        });

        // PHYSICS_STOPPED → WinnerActivation → ResultActivation → RESULT
        stack.physicsEngine.stopSimulation(gameId);

        assert(
            stack.gameStateEngine.getState(gameId) === GAME_STATES.RESULT,
            "game should reach RESULT"
        );

        assert(
            stack.winnerEngine.getResult(gameId),
            "winner must be stored before RESULT recovery"
        );

        const cached = stack.recoverySnapshotCache.get(gameId);

        assert(cached?.snapshot, "RESULT snapshot should be cached");

        const clientPayload = buildClientRecoveryPayload({
            snapshot: cached.snapshot,
            playerId,
            roomId: "recovery-room",
            paymentStatus: cached.paymentStatus,
            payment: cached.payment
        });

        assert(clientPayload.gameResult, "Page6 recovery must include winner");

        assert(
            clientPayload.gameState === GAME_STATES.RESULT,
            "finished game must restore RESULT state"
        );

        const winnerBefore = clientPayload.gameResult.winner.id;

        const completedPayment = stack.paymentEngine.getPayment(gameId);

        assert(
            completedPayment?.winnerId === winnerBefore,
            "winner must remain immutable after settlement"
        );

        console.log("  scenario 2 (Page6 winner + payment recovery) passed");

    } finally {

        stack.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Scenario 3 — soft disconnect preserves player for gameplay reconnect.
// ---------------------------------------------------------------------------

{

    const stack = buildRecoveryStack();

    try {

        const room = stack.roomManager.createRoom();

        const player = stack.playerManager.createPlayer({ nickname: "Lobby" });

        const playerId = player.identity.playerId;

        stack.roomManager.addPlayer(room.roomId, playerId);

        stack.playerManager.updateRuntime(playerId, { roomId: room.roomId });

        stack.roomLobbyBridge._registerSocketPlayer("socket-a", playerId);

        stack.roomLobbyBridge._attachSocketToRoom("socket-a", room.roomId);

        stack.roomLobbyBridge._startedRooms.add(room.roomId);

        stack.gameplayContextResolver.activateRoomGame(room.roomId, "game-recovery");

        stack.roomLobbyBridge._handleSocketDisconnected("socket-a");

        assert(
            stack.playerManager.hasPlayer(playerId),
            "soft disconnect must preserve player during gameplay"
        );

        assert(
            stack.roomLobbyBridge.transferRecoveryOwnership("socket-a", "socket-b"),
            "recovery ownership must transfer for a new socket"
        );

        const reconnected = stack.roomLobbyBridge.reconnectGameplaySession(
            "socket-b"
        );

        assert(reconnected.ok, "gameplay reconnect should succeed");

        assert(
            reconnected.gameId === "game-recovery",
            "reconnect must restore active gameId"
        );

        console.log("  scenario 3 (soft disconnect reconnect) passed");

    } finally {

        stack.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Scenario 4 — RC-1: recovery identity is server-owned; forged sockets fail.
// ---------------------------------------------------------------------------

{

    const stack = buildRecoveryStack();

    try {

        const room = stack.roomManager.createRoom();

        const player = stack.playerManager.createPlayer({ nickname: "Victim" });

        const playerId = player.identity.playerId;

        stack.roomManager.addPlayer(room.roomId, playerId);

        stack.playerManager.updateRuntime(playerId, { roomId: room.roomId });

        stack.roomLobbyBridge._registerSocketPlayer("victim-socket", playerId);

        stack.roomLobbyBridge._attachSocketToRoom("victim-socket", room.roomId);

        stack.roomLobbyBridge._startedRooms.add(room.roomId);

        stack.roomLobbyBridge._handleSocketDisconnected("victim-socket");

        const forged = stack.roomLobbyBridge.reconnectGameplaySession(
            "attacker-socket"
        );

        assert(
            !forged.ok,
            "an unbound socket must not recover another player's session"
        );

        const legitimate = stack.roomLobbyBridge.reconnectGameplaySession(
            "victim-socket"
        );

        assert(
            legitimate.ok,
            "the legitimate disconnected socket must still recover"
        );

        console.log("  scenario 4 (RC-1 forged recovery rejected) passed");

    } finally {

        stack.shutdown();

    }

}

console.log("gameplayRecovery.integration.test.js: all assertions passed");
