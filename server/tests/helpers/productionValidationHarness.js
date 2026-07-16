/**
 * C4.12 — Production Validation Suite shared harness.
 *
 * Builds the complete authoritative stack exactly as production wires it
 * (gameplay core + speed + offline continuation + winner + payment + audit +
 * recovery + lifecycle + broadcaster + lobby + socket gateway) and exposes small
 * primitives so each production scenario can be written as an independent test.
 *
 * This harness changes no gameplay behavior — it only drives the real pipeline
 * through lobby events and observes runtime counters. Group F (cleanup to
 * Baseline) is enforced via `assertClean(baseline, label)`.
 */
import http from "http";

import { EventBus } from "../../events/EventBus.js";
import { EVENT_TYPES } from "../../events/EventTypes.js";
import { EVENT_SOURCES } from "../../events/EventSources.js";
import { GAME_STATES } from "../../engines/gameState/GameStates.js";
import { CONNECTION_STATE } from "../../models/ConnectionState.js";
import { GameManager } from "../../managers/GameManager.js";
import { PlayerManager } from "../../managers/PlayerManager.js";
import { RoomManager } from "../../managers/RoomManager.js";
import { LoggerService } from "../../services/LoggerService.js";
import { GameplayContextResolver } from "../../socket/GameplayContextResolver.js";
import { RoomLobbyBridge } from "../../socket/RoomLobbyBridge.js";
import { SocketGateway } from "../../socket/SocketGateway.js";
import { GameClockBroadcaster } from "../../gameplay/GameClockBroadcaster.js";
import { RecoveryEngine } from "../../engines/RecoveryEngine.js";
import { AuditEngine } from "../../engines/AuditEngine.js";
import { AuditActivation } from "../../gameplay/AuditActivation.js";
import {
    shutdownGameplayBootstrap,
    wireGameplayBootstrap
} from "./gameplayBootstrapHarness.js";

export function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

export function wait(ms) {

    return new Promise((resolve) => setTimeout(resolve, ms));

}

export async function poll(predicate, { timeoutMs = 5000, intervalMs = 5 } = {}) {

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {

        if (predicate()) {

            return true;

        }

        await wait(intervalMs);

    }

    return false;

}

function totalSubscribers(eventBus) {

    return eventBus
        .getDebugSnapshot()
        .registeredEvents
        .reduce((sum, entry) => sum + entry.subscriberCount, 0);

}

function countSocketGatewayGameplayListeners(gateway) {

    let count = 0;

    for (const key in gateway) {

        if (key.endsWith("Handler") && gateway[key]) {

            count += 1;

        }

    }

    return count;

}

function normalizePlayerId(entry) {

    if (typeof entry === "string") {

        return entry;

    }

    return entry?.playerId ?? entry?.id ?? null;

}

export async function buildProductionStack() {

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

    // C5.6C — Soft-disconnect protection must be armed BEFORE GameManager
    // bootstraps. Wire engines without COMPLETED subscription, initialize Bridge
    // (COMPLETED first), then configure GameManager bootstrap (COMPLETED second).
    const harness = wireGameplayBootstrap({
        gameManager,
        roomManager,
        playerManager,
        logger,
        eventBus,
        gameplayContextResolver,
        devMode: false,
        enableLifecycle: true,
        deferGameBootstrap: true
    });

    const roomLobbyBridge = new RoomLobbyBridge({
        logger,
        eventBus,
        roomManager,
        playerManager,
        gameplayContextResolver,
        setupSessionLifecycle: harness.setupSessionLifecycle
    });

    roomLobbyBridge.initialize();

    gameManager.configureGameplayBootstrap({
        roomManager,
        playerManager,
        configurationEngine: harness.configurationEngine,
        gameStateEngine: harness.gameStateEngine,
        inputAuthority: harness.inputAuthority,
        physicsEngine: harness.physicsEngine,
        gameClockEngine: harness.gameClockEngine,
        gameCatalog: harness.catalog,
        gameplayContextResolver,
        devMode: false
    });

    const recoveryEngine = new RecoveryEngine({
        logger,
        eventBus,
        gameCatalog: harness.catalog,
        configurationEngine: harness.configurationEngine,
        gameStateEngine: harness.gameStateEngine,
        gameClock: harness.gameClockEngine,
        physicsEngine: harness.physicsEngine,
        inputAuthority: harness.inputAuthority,
        winnerEngine: harness.winnerEngine,
        paymentEngine: harness.paymentEngine
    });

    recoveryEngine.initialize();

    const auditEngine = new AuditEngine({
        logger,
        eventBus,
        gameCatalog: harness.catalog,
        configurationEngine: harness.configurationEngine,
        gameStateEngine: harness.gameStateEngine,
        gameClock: harness.gameClockEngine,
        physicsEngine: harness.physicsEngine,
        inputAuthority: harness.inputAuthority,
        winnerEngine: harness.winnerEngine,
        paymentEngine: harness.paymentEngine,
        recoveryEngine
    });

    auditEngine.initialize();

    const auditActivation = new AuditActivation({
        logger,
        eventBus,
        auditEngine,
        devMode: false
    });

    auditActivation.initialize();

    harness.gameplayLifecycle.configureAudit({ auditEngine, auditActivation });

    const gameClockBroadcaster = new GameClockBroadcaster({
        logger,
        eventBus,
        gameClockEngine: harness.gameClockEngine,
        intervalMs: 50,
        devMode: false
    });

    gameClockBroadcaster.initialize();

    const httpServer = http.createServer();

    const socketGateway = new SocketGateway({
        logger,
        socketConfig: { cors: { origin: "*" } },
        eventBus,
        inputAuthority: harness.inputAuthority,
        gameplayContextResolver,
        devMode: false
    });

    socketGateway.initialize(httpServer);

    socketGateway.connectEventBus(eventBus);

    await new Promise((resolve) => {

        httpServer.listen(0, "127.0.0.1", resolve);

    });

    // ---------------------------------------------------------------
    // Observers (subscribed BEFORE baseline so listener count is stable).
    // ---------------------------------------------------------------

    const current = { gameId: null, roomId: null, roster: [], cleanupCompleted: false };

    const observed = {
        winners: new Map(),
        paymentsCompleted: new Set(),
        auditsReady: new Set(),
        cleanups: new Set()
    };

    eventBus.subscribe(EVENT_TYPES.GAME_CREATED, (envelope) => {

        current.gameId = envelope.payload?.gameId;

        current.roster = (envelope.payload?.players ?? [])
            .map(normalizePlayerId)
            .filter(Boolean);

    });

    eventBus.subscribe(EVENT_TYPES.GAME_INITIALIZED, (envelope) => {

        current.roomId = envelope.payload?.roomId ?? null;

    });

    eventBus.subscribe(EVENT_TYPES.WINNER_DETERMINED, (envelope) => {

        observed.winners.set(envelope.payload?.gameId, envelope.payload);

    });

    eventBus.subscribe(EVENT_TYPES.PAYMENT_COMPLETED, (envelope) => {

        observed.paymentsCompleted.add(envelope.payload?.gameId);

    });

    eventBus.subscribe(EVENT_TYPES.AUDIT_READY, (envelope) => {

        observed.auditsReady.add(envelope.payload?.gameId);

    });

    eventBus.subscribe(EVENT_TYPES.CLEANUP_COMPLETED, (envelope) => {

        observed.cleanups.add(envelope.payload?.gameId);

        current.cleanupCompleted = true;

    });

    // ---------------------------------------------------------------
    // Runtime counter snapshot (every counter the C4.12 spec lists).
    // ---------------------------------------------------------------

    function snapshot() {

        return {
            "SimulationLoop": harness.simulationLoop.getActiveGameCount(),
            "PhysicsEngine": harness.physicsEngine.getActiveSimulationCount(),
            "GameClockEngine": harness.gameClockEngine.getActiveClockCount(),
            "GameClockBroadcaster": gameClockBroadcaster.getActiveBroadcastCount(),
            "SpeedActivation": harness.speedActivation.getActiveGameCount(),
            "OfflineInputContinuation":
                harness.offlineInputContinuation.getActiveContinuations().length,
            "WinnerEngine": harness.winnerEngine._results.size,
            "RecoveryEngine": recoveryEngine._snapshots.size,
            "PaymentEngine": harness.paymentEngine.getActivePaymentCount(),
            "AuditEngine": auditEngine.getActiveAuditCount(),
            "GameManager": gameManager.getGames().length,
            "RoomManager": roomManager.getRooms().length,
            "ContextResolver.roomGames": gameplayContextResolver._roomGames.size,
            "ContextResolver.socketBindings":
                gameplayContextResolver._socketBindings.size,
            "ConfigurationEngine":
                harness.configurationEngine.listConfigurationIds().length,
            "InputAuthority": harness.inputAuthority._registries.size,
            "GameStateEngine": harness.gameStateEngine._states.size,
            "PlayerRuntimeRegistry": playerManager._runtimes.size,
            "SocketGateway.sockets": socketGateway.getConnectedSocketCount(),
            "SocketGateway.gameplayListeners":
                countSocketGatewayGameplayListeners(socketGateway),
            "EventBus.listeners": totalSubscribers(eventBus),
            "PendingTeardowns": harness.gameplayLifecycle.getPendingTeardownCount()
        };

    }

    const COUNTER_KEYS = Object.keys(snapshot());

    function diff(baseline, other) {

        const mismatches = [];

        for (const key of COUNTER_KEYS) {

            if (baseline[key] !== other[key]) {

                mismatches.push(
                    `${key} (baseline ${baseline[key]} != ${other[key]})`
                );

            }

        }

        return mismatches;

    }

    function assertClean(baseline, label) {

        const mismatches = diff(baseline, snapshot());

        assert(
            mismatches.length === 0,
            `${label}: server not clean after Cleanup -> ${mismatches.join(", ")}`
        );

    }

    // ---------------------------------------------------------------
    // Player interaction primitives.
    // ---------------------------------------------------------------

    function socketForPlayer(playerId) {

        return roomLobbyBridge._playerToSocket.get(playerId) ?? null;

    }

    function isOnline(playerId) {

        return playerManager.getRuntime(playerId)?.connectionState
            === CONNECTION_STATE.CONNECTED;

    }

    const disconnectedSockets = new Map();

    // Soft disconnect through the real lobby path (started room): sets the player
    // DISCONNECTED and emits PLAYER_DISCONNECTED, exactly as a dropped socket.
    function disconnect(playerId) {

        const socketId = socketForPlayer(playerId);

        assert(socketId, `disconnect: no socket bound for ${playerId}`);

        roomLobbyBridge._handleSocketDisconnected(socketId);

        disconnectedSockets.set(playerId, socketId);

        return socketId;

    }

    // Real gameplay reconnect: identity is resolved server-side from stashed
    // socket ownership. A new socket id (page refresh) transfers that stash.
    function reconnect(playerId, roomId, socketId) {

        const previousSocketId = disconnectedSockets.get(playerId)
            ?? socketForPlayer(playerId);

        const targetSocketId = socketId
            ?? previousSocketId
            ?? `reconnect-${playerId}-${Date.now()}`;

        if (socketId && previousSocketId && socketId !== previousSocketId) {

            const transferred = roomLobbyBridge.transferRecoveryOwnership(
                previousSocketId,
                socketId
            );

            assert(
                transferred,
                `reconnect: no recovery ownership to transfer for ${playerId}`
            );

        }

        return roomLobbyBridge.reconnectGameplaySession(targetSocketId);

    }

    function finishPlayer(gameId, playerId) {

        for (let guard = 0; guard < 24; guard += 1) {

            const state = harness.inputAuthority.getPlayerInputState(
                gameId,
                playerId
            );

            if (!state || state.locked) {

                return;

            }

            if (state.buttonPressed) {

                harness.inputAuthority.handleButtonRelease(gameId, playerId);

            } else {

                harness.inputAuthority.handleButtonPress(gameId, playerId);

                harness.inputAuthority.handleButtonRelease(gameId, playerId);

            }

        }

    }

    // Finish input for every roster player that is currently online. Offline
    // players are finished authoritatively by OfflineInputContinuation.
    function exhaustOnline(gameId, roster) {

        for (const playerId of roster) {

            if (isOnline(playerId)) {

                finishPlayer(gameId, playerId);

            }

        }

    }

    // Return every client to Page1 (deliberate leave), releasing the recovery
    // window survivors (room, room->game mapping, players, sockets).
    function returnToPage1(roomId) {

        const room = roomManager.getRoom(roomId);

        if (!room) {

            return;

        }

        let leaveSocket = null;

        for (const playerId of room.players) {

            const socketId = socketForPlayer(playerId);

            if (socketId) {

                leaveSocket = socketId;

                break;

            }

        }

        if (!leaveSocket && room.players.length > 0) {

            // Every participant is offline: a client comes back to Page1 first.
            const returning = room.players[0];

            reconnect(returning, roomId, `return-${roomId}`);

            leaveSocket = socketForPlayer(returning);

        }

        if (leaveSocket) {

            eventBus.emit({
                source: EVENT_SOURCES.SOCKET_GATEWAY,
                type: EVENT_TYPES.LOBBY_LEAVE_ROOM_REQUEST,
                payload: { socketId: leaveSocket }
            });

        }

    }

    // ---------------------------------------------------------------
    // Full-lifecycle game runner with per-phase hooks.
    //
    //   hooks: { READY, COUNTDOWN, SELF_TEST, SPEED, BRAKE, RESULT }
    //     each fires exactly once, synchronously, when that phase is entered.
    //   onSpeed(ctx): async override run after SPEED is reached (and after the
    //     synchronous SPEED hook). If omitted, online players are auto-finished.
    // ---------------------------------------------------------------

    async function runGame({ index, hooks = {}, onSpeed = null } = {}) {

        current.gameId = null;

        current.roomId = null;

        current.roster = [];

        current.cleanupCompleted = false;

        const sockets = [
            `c4.12-g${index}-s1`,
            `c4.12-g${index}-s2`,
            `c4.12-g${index}-s3`
        ];

        const firedPhases = new Set();

        const buildContext = (gameId, roomId) => ({
            gameId,
            roomId,
            roster: current.roster,
            sockets,
            disconnect,
            reconnect: (playerId, socketId) => reconnect(playerId, roomId, socketId),
            finishPlayer: (playerId) => finishPlayer(gameId, playerId),
            exhaustOnline: () => exhaustOnline(gameId, current.roster),
            isOnline,
            components
        });

        const phaseListener = (envelope) => {

            const gameId = envelope.payload?.gameId;

            const phase = envelope.payload?.currentState ?? envelope.payload?.state;

            if (!gameId || gameId !== current.gameId) {

                return;

            }

            if (firedPhases.has(phase) || typeof hooks[phase] !== "function") {

                return;

            }

            firedPhases.add(phase);

            hooks[phase](buildContext(gameId, current.roomId));

        };

        eventBus.subscribe(EVENT_TYPES.GAME_STATE_CHANGED, phaseListener);

        try {

            eventBus.emit({
                source: EVENT_SOURCES.SOCKET_GATEWAY,
                type: EVENT_TYPES.LOBBY_CREATE_ROOM_REQUEST,
                payload: { socketId: sockets[0] }
            });

            const room = roomManager.getRooms().find(
                (entry) => entry.players.length < entry.maxPlayers
            ) ?? roomManager.getRooms()[roomManager.getRooms().length - 1];

            assert(room, `game #${index}: room should be created`);

            const roomId = room.roomId;

            for (let i = 1; i < sockets.length; i += 1) {

                eventBus.emit({
                    source: EVENT_SOURCES.SOCKET_GATEWAY,
                    type: EVENT_TYPES.LOBBY_JOIN_ROOM_REQUEST,
                    payload: { socketId: sockets[i], roomId }
                });

            }

            const bootstrapped = await poll(() => Boolean(current.gameId));

            assert(bootstrapped, `game #${index}: ROOM_FULL should bootstrap a game`);

            const gameId = current.gameId;

            assert(current.roster.length === 3, `game #${index}: roster should be 3`);

            const reachedSpeed = await poll(
                () => harness.gameStateEngine.getState(gameId) === GAME_STATES.SPEED
            );

            assert(reachedSpeed, `game #${index}: should reach SPEED`);

            if (typeof onSpeed === "function") {

                await onSpeed(buildContext(gameId, roomId));

            } else {

                exhaustOnline(gameId, current.roster);

            }

            const tornDown = await poll(
                () => current.cleanupCompleted && !gameManager.hasGame(gameId)
            );

            assert(tornDown, `game #${index}: should complete audit + tear down`);

            returnToPage1(roomId);

            await wait(20);

            return { gameId, roomId, roster: [...current.roster], sockets };

        } finally {

            eventBus.unsubscribe(EVENT_TYPES.GAME_STATE_CHANGED, phaseListener);

        }

    }

    const components = {
        logger,
        eventBus,
        roomManager,
        playerManager,
        gameManager,
        gameplayContextResolver,
        recoveryEngine,
        auditEngine,
        gameClockBroadcaster,
        roomLobbyBridge,
        socketGateway,
        ...harness
    };

    async function shutdown() {

        await socketGateway.shutdown();

        roomLobbyBridge.shutdown();

        gameClockBroadcaster.shutdown();

        auditActivation.shutdown();

        auditEngine.shutdown();

        recoveryEngine.shutdown();

        shutdownGameplayBootstrap(harness);

        gameManager.shutdown();

        playerManager.shutdown();

        roomManager.shutdown();

        eventBus.shutdown();

        logger.shutdown();

        await new Promise((resolve) => {

            if (!httpServer.listening) {

                resolve();

                return;

            }

            httpServer.close(() => resolve());

        });

    }

    return {
        components,
        observed,
        snapshot,
        COUNTER_KEYS,
        diff,
        assertClean,
        runGame,
        disconnect,
        reconnect,
        finishPlayer,
        exhaustOnline,
        returnToPage1,
        isOnline,
        socketForPlayer,
        shutdown
    };

}
