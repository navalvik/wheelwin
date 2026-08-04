/**
 * R7.7A — Authoritative Secret Matrix submission status tests.
 */
import { EventBus } from "../events/EventBus.js";
import { CONNECTION_STATE } from "../models/ConnectionState.js";
import { PlayerManager } from "../managers/PlayerManager.js";
import { RoomManager } from "../managers/RoomManager.js";
import { LoggerService } from "../services/LoggerService.js";
import { GameplayContextResolver } from "../socket/GameplayContextResolver.js";
import { RoomLobbyBridge } from "../socket/RoomLobbyBridge.js";
import { SetupSessionLifecycle } from "../gameplay/SetupSessionLifecycle.js";
import { SECRET_MATRIX_STATUS } from "../models/SecretMatrixStatus.js";
import { LOBBY_SERVER_EVENTS } from "../socket/lobbyProtocol.js";
import { EVENT_TYPES } from "../events/EventTypes.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

function buildStack() {

    const logger = new LoggerService({ logLevel: "error" });

    logger.initialize();

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const playerManager = new PlayerManager({ logger, eventBus });

    playerManager.initialize();

    const roomManager = new RoomManager({
        logger,
        eventBus,
        roomConfig: { maxPlayers: 3 }
    });

    roomManager.initialize();

    const gameplayContextResolver = new GameplayContextResolver({
        logger,
        playerManager,
        roomManager
    });

    const setupSessionLifecycle = new SetupSessionLifecycle({
        logger,
        eventBus,
        roomManager,
        roomConfig: { setupDurationMs: 10 * 60 * 1000 }
    });

    setupSessionLifecycle.initialize();

    roomManager.attachSetupSessionLifecycle(setupSessionLifecycle);

    const roomLobbyBridge = new RoomLobbyBridge({
        logger,
        eventBus,
        roomManager,
        playerManager,
        gameplayContextResolver,
        setupSessionLifecycle
    });

    roomLobbyBridge.initialize();

    return {
        eventBus,
        playerManager,
        roomManager,
        roomLobbyBridge,
        shutdown() {

            roomLobbyBridge.shutdown();

            setupSessionLifecycle.shutdown();

            roomManager.shutdown();

            playerManager.shutdown();

            eventBus.shutdown();

            logger.shutdown();

        }
    };

}

function fillRoom(stack) {

    const room = stack.roomManager.createRoom();

    const seats = [];

    for (let index = 0; index < 3; index += 1) {

        const player = stack.playerManager.createPlayer({
            nickname: `P${index}`
        });

        const playerId = player.identity.playerId;

        const socketId = `sock-${index}`;

        stack.roomManager.addPlayer(room.roomId, playerId);

        stack.playerManager.updateRuntime(playerId, { roomId: room.roomId });

        stack.roomLobbyBridge._registerSocketPlayer(socketId, playerId);

        stack.roomLobbyBridge._attachSocketToRoom(socketId, room.roomId);

        stack.playerManager.setConnectionState(
            playerId,
            CONNECTION_STATE.CONNECTED
        );

        seats.push({ playerId, socketId });

    }

    return { roomId: room.roomId, seats };

}

const CELLS_A = ["A", "B", "C", "1", "2", "3", "X", "Y", "Z"];

const CELLS_B = ["Q", "W", "E", "R", "T", "Y", "U", "I", "O"];

function collectStatus(eventBus, limit = 20) {

    const events = [];

    const handler = (envelope) => {

        if (envelope?.payload?.event === LOBBY_SERVER_EVENTS.SECRET_MATRIX_STATUS
            || envelope?.type === EVENT_TYPES.LOBBY_SOCKET_DELIVERY) {

            if (envelope.payload?.event === LOBBY_SERVER_EVENTS.SECRET_MATRIX_STATUS) {

                events.push(envelope.payload.payload);

            }

        }

    };

    eventBus.subscribe(EVENT_TYPES.LOBBY_SOCKET_DELIVERY, handler);

    return {
        events,
        stop() {

            eventBus.unsubscribe(EVENT_TYPES.LOBBY_SOCKET_DELIVERY, handler);

        }
    };

}

// Test A — disconnect race: unauthorized submit → reclaim → can continue.
{

    const stack = buildStack();

    const collector = collectStatus(stack.eventBus);

    try {

        const { roomId, seats } = fillRoom(stack);

        const host = seats[0];

        stack.roomLobbyBridge._handleSocketDisconnected(host.socketId);

        stack.roomLobbyBridge._markPendingSocket(
            "sock-pending",
            host.playerId,
            roomId
        );

        stack.roomLobbyBridge._handleSubmitSecretMatrix(
            "sock-pending",
            CELLS_A
        );

        assert(
            !stack.roomLobbyBridge._secretMatrixByRoom.get(roomId)
                ?.has(host.playerId),
            "unauthorized submit must not mutate Map"
        );

        const unauthorized = collector.events.find(
            (entry) => entry?.reason === "SOCKET_NOT_AUTHORIZED"
        );

        assert(
            unauthorized?.status === SECRET_MATRIX_STATUS.NOT_SUBMITTED,
            "unauthorized submit must emit NOT_SUBMITTED status"
        );

        const reclaimed = stack.roomLobbyBridge.reconnectGameplaySession(
            "sock-reclaimed",
            { playerId: host.playerId, roomId }
        );

        assert(reclaimed.ok, "reclaim must succeed");

        stack.roomLobbyBridge._handleSubmitSecretMatrix(
            "sock-reclaimed",
            CELLS_A
        );

        assert(
            stack.roomLobbyBridge.getSecretMatrixStatus(
                roomId,
                host.playerId
            ).status === SECRET_MATRIX_STATUS.SUBMITTED,
            "after reclaim, submit must reach SUBMITTED"
        );

        console.log("  Test A (disconnect race / no frozen UI) passed");

    } finally {

        collector.stop();

        stack.shutdown();

    }

}

// Test B — unbound socket submit.
{

    const stack = buildStack();

    const collector = collectStatus(stack.eventBus);

    try {

        fillRoom(stack);

        stack.roomLobbyBridge._handleSubmitSecretMatrix(
            "sock-ghost",
            CELLS_A
        );

        assert(
            collector.events.some(
                (entry) => entry?.status === SECRET_MATRIX_STATUS.NOT_SUBMITTED
                    && entry?.reason === "SOCKET_NOT_AUTHORIZED"
            ),
            "unbound submit must emit NOT_SUBMITTED"
        );

        console.log("  Test B (submit without authority) passed");

    } finally {

        collector.stop();

        stack.shutdown();

    }

}

// Test C — successful submit.
{

    const stack = buildStack();

    try {

        const { roomId, seats } = fillRoom(stack);

        stack.roomLobbyBridge._handleSubmitSecretMatrix(
            seats[0].socketId,
            CELLS_A
        );

        const status = stack.roomLobbyBridge.getSecretMatrixStatus(
            roomId,
            seats[0].playerId
        );

        assert(
            status.status === SECRET_MATRIX_STATUS.SUBMITTED,
            "submit must become SUBMITTED"
        );

        assert(status.selfSubmitted === true, "selfSubmitted must be true");

        assert(status.submittedCount === 1, "submittedCount must be 1");

        console.log("  Test C (successful submit) passed");

    } finally {

        stack.shutdown();

    }

}

// Test D — duplicate submit overwrites and bumps revision.
{

    const stack = buildStack();

    try {

        const { roomId, seats } = fillRoom(stack);

        stack.roomLobbyBridge._handleSubmitSecretMatrix(
            seats[0].socketId,
            CELLS_A
        );

        const first = stack.roomLobbyBridge.getSecretMatrixStatus(
            roomId,
            seats[0].playerId
        );

        stack.roomLobbyBridge._handleSubmitSecretMatrix(
            seats[0].socketId,
            CELLS_A
        );

        const second = stack.roomLobbyBridge.getSecretMatrixStatus(
            roomId,
            seats[0].playerId
        );

        assert(
            second.status === SECRET_MATRIX_STATUS.SUBMITTED,
            "duplicate submit stays SUBMITTED"
        );

        assert(
            second.revision > first.revision,
            "duplicate submit must bump revision"
        );

        console.log("  Test D (duplicate submit) passed");

    } finally {

        stack.shutdown();

    }

}

// Test E — reconnect after submit restores SUBMITTED.
{

    const stack = buildStack();

    const collector = collectStatus(stack.eventBus);

    try {

        const { roomId, seats } = fillRoom(stack);

        stack.roomLobbyBridge._handleSubmitSecretMatrix(
            seats[0].socketId,
            CELLS_A
        );

        stack.roomLobbyBridge._handleSocketDisconnected(seats[0].socketId);

        const reclaimed = stack.roomLobbyBridge.reconnectGameplaySession(
            "sock-restore",
            { playerId: seats[0].playerId, roomId }
        );

        assert(reclaimed.ok, "reclaim must succeed");

        const restored = collector.events
            .filter((entry) => entry?.playerId === seats[0].playerId)
            .pop();

        assert(
            restored?.status === SECRET_MATRIX_STATUS.SUBMITTED,
            "reconnect must restore SUBMITTED"
        );

        assert(
            stack.roomLobbyBridge.getSecretMatrixStatus(
                roomId,
                seats[0].playerId
            ).status === SECRET_MATRIX_STATUS.SUBMITTED,
            "server status remains SUBMITTED after reclaim"
        );

        console.log("  Test E (reconnect after submit) passed");

    } finally {

        collector.stop();

        stack.shutdown();

    }

}

// Test F — match accepted.
{

    const stack = buildStack();

    try {

        const { roomId, seats } = fillRoom(stack);

        for (const seat of seats) {

            stack.roomLobbyBridge._handleSubmitSecretMatrix(
                seat.socketId,
                CELLS_A
            );

        }

        for (const seat of seats) {

            const status = stack.roomLobbyBridge.getSecretMatrixStatus(
                roomId,
                seat.playerId
            );

            assert(
                status.status === SECRET_MATRIX_STATUS.MATCH_ACCEPTED,
                "all players must see MATCH_ACCEPTED"
            );

        }

        console.log("  Test F (match accepted) passed");

    } finally {

        stack.shutdown();

    }

}

// Mismatch → MATCH_REJECTED then NOT_SUBMITTED.
{

    const stack = buildStack();

    try {

        const { roomId, seats } = fillRoom(stack);

        stack.roomLobbyBridge._handleSubmitSecretMatrix(
            seats[0].socketId,
            CELLS_A
        );

        stack.roomLobbyBridge._handleSubmitSecretMatrix(
            seats[1].socketId,
            CELLS_A
        );

        stack.roomLobbyBridge._handleSubmitSecretMatrix(
            seats[2].socketId,
            CELLS_B
        );

        const status = stack.roomLobbyBridge.getSecretMatrixStatus(
            roomId,
            seats[0].playerId
        );

        assert(
            status.status === SECRET_MATRIX_STATUS.NOT_SUBMITTED,
            "mismatch must clear back to NOT_SUBMITTED"
        );

        assert(
            !stack.roomLobbyBridge._secretMatrixByRoom.has(roomId),
            "mismatch must clear submission Map"
        );

        console.log("  mismatch → NOT_SUBMITTED passed");

    } finally {

        stack.shutdown();

    }

}

console.log("secretMatrix.status.test.js: all assertions passed");
