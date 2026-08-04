/**
 * R7.5A — Authoritative Socket Commit Protocol regression tests.
 */
import { EventBus } from "../events/EventBus.js";
import { CONNECTION_STATE } from "../models/ConnectionState.js";
import { PlayerManager } from "../managers/PlayerManager.js";
import { RoomManager } from "../managers/RoomManager.js";
import { LoggerService } from "../services/LoggerService.js";
import { GameplayContextResolver } from "../socket/GameplayContextResolver.js";
import { RoomLobbyBridge } from "../socket/RoomLobbyBridge.js";
import { SetupSessionLifecycle } from "../gameplay/SetupSessionLifecycle.js";

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
        playerManager,
        roomManager,
        roomLobbyBridge,
        setupSessionLifecycle,
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

function seatPlayer(stack, { socketId, nickname = "P" }) {

    const room = stack.roomManager.createRoom();

    const player = stack.playerManager.createPlayer({ nickname });

    const playerId = player.identity.playerId;

    stack.roomManager.addPlayer(room.roomId, playerId);

    stack.playerManager.updateRuntime(playerId, { roomId: room.roomId });

    stack.roomLobbyBridge._registerSocketPlayer(socketId, playerId);

    stack.roomLobbyBridge._attachSocketToRoom(socketId, room.roomId);

    stack.playerManager.setConnectionState(playerId, CONNECTION_STATE.CONNECTED);

    return { roomId: room.roomId, playerId };

}

// Test A — disconnect → recover → submitSecretMatrix accepted (never context null).
{

    const stack = buildStack();

    try {

        const { roomId, playerId } = seatPlayer(stack, { socketId: "sock-a" });

        // Keep room at 3 seats so a single submit stays in the Map (not auto-accepted).
        for (const nick of ["P2", "P3"]) {

            const extra = stack.playerManager.createPlayer({ nickname: nick });

            stack.roomManager.addPlayer(roomId, extra.identity.playerId);

            stack.playerManager.updateRuntime(extra.identity.playerId, {
                roomId
            });

        }

        stack.roomLobbyBridge._handleSocketDisconnected("sock-a");

        assert(
            stack.roomLobbyBridge._playerToSocket.get(playerId) === "sock-a",
            "soft disconnect must keep authoritative ownership"
        );

        assert(
            stack.roomLobbyBridge._getSocketContext("sock-a")?.playerId === playerId,
            "authoritative socket context must remain resolvable after soft disconnect"
        );

        const reclaimed = stack.roomLobbyBridge.reconnectGameplaySession(
            "sock-b",
            { playerId, roomId }
        );

        assert(reclaimed.ok, "reclaim must succeed");

        assert(
            stack.roomLobbyBridge._playerToSocket.get(playerId) === "sock-b",
            "new socket must be authoritative after commit"
        );

        assert(
            stack.roomLobbyBridge._getSocketContext("sock-b")?.playerId === playerId,
            "getSocketContext must resolve for committed socket"
        );

        const cells = ["A", "B", "C", "1", "2", "3", "X", "Y", "Z"];

        stack.roomLobbyBridge._handleSubmitSecretMatrix("sock-b", cells);

        const submissions = stack.roomLobbyBridge._secretMatrixByRoom.get(roomId);

        assert(
            submissions?.get(playerId)?.join("") === "ABC123XYZ",
            "submitSecretMatrix after reclaim must be accepted into Map"
        );

        console.log("  Test A (disconnect → recover → submit) passed");

    } finally {

        stack.shutdown();

    }

}

// Test B — invalid recovery keeps old socket authoritative.
{

    const stack = buildStack();

    try {

        const { roomId, playerId } = seatPlayer(stack, { socketId: "sock-old" });

        const failed = stack.roomLobbyBridge.reconnectGameplaySession(
            "sock-attacker",
            { playerId: "player_does_not_exist", roomId }
        );

        assert(!failed.ok, "invalid reclaim must fail");

        assert(
            stack.roomLobbyBridge._playerToSocket.get(playerId) === "sock-old",
            "old socket must remain authoritative after failed reclaim"
        );

        console.log("  Test B (invalid recovery keeps owner) passed");

    } finally {

        stack.shutdown();

    }

}

// Test C — only authoritative socket mutates; pending/new pre-commit rejected.
{

    const stack = buildStack();

    try {

        const { roomId, playerId } = seatPlayer(stack, {
            socketId: "sock-auth",
            nickname: "Auth"
        });

        for (const nick of ["P2", "P3"]) {

            const extra = stack.playerManager.createPlayer({ nickname: nick });

            stack.roomManager.addPlayer(roomId, extra.identity.playerId);

            stack.playerManager.updateRuntime(extra.identity.playerId, {
                roomId
            });

        }

        stack.roomLobbyBridge._markPendingSocket("sock-pending", playerId, roomId);

        const cells = ["A", "B", "C", "1", "2", "3", "X", "Y", "Z"];

        stack.roomLobbyBridge._handleSubmitSecretMatrix("sock-pending", cells);

        assert(
            !stack.roomLobbyBridge._secretMatrixByRoom.get(roomId)?.has(playerId),
            "pending socket must not mutate Secret Matrix"
        );

        stack.roomLobbyBridge._handleSubmitSecretMatrix("sock-auth", cells);

        assert(
            stack.roomLobbyBridge._secretMatrixByRoom.get(roomId)?.has(playerId),
            "authoritative socket must mutate Secret Matrix"
        );

        console.log("  Test C (only authoritative executes) passed");

    } finally {

        stack.shutdown();

    }

}

// Test D — obsolete socket packet rejected after commit.
{

    const stack = buildStack();

    try {

        const { roomId, playerId } = seatPlayer(stack, { socketId: "sock-old" });

        const committed = stack.roomLobbyBridge._commitSocketAuthority({
            playerId,
            roomId,
            oldSocketId: "sock-old",
            newSocketId: "sock-new"
        });

        assert(committed.ok, "commit must succeed");

        assert(
            stack.roomLobbyBridge._obsoleteSockets.has("sock-old"),
            "old socket must be marked obsolete"
        );

        const cells = ["Q", "W", "E", "R", "T", "Y", "U", "I", "O"];

        stack.roomLobbyBridge._handleSubmitSecretMatrix("sock-old", cells);

        assert(
            !stack.roomLobbyBridge._secretMatrixByRoom.get(roomId)?.has(playerId),
            "obsolete socket must not store Secret Matrix"
        );

        console.log("  Test D (obsolete packet rejected) passed");

    } finally {

        stack.shutdown();

    }

}

// Test E — reclaim during setup-protected room (Page4-equivalent ownership) preserves seat.
{

    const stack = buildStack();

    try {

        const { roomId, playerId } = seatPlayer(stack, { socketId: "sock-p4" });

        assert(
            stack.setupSessionLifecycle.isRecoverable(roomId),
            "setup must protect seat"
        );

        stack.roomLobbyBridge._handleSocketDisconnected("sock-p4");

        assert(
            stack.roomManager.getRoom(roomId)?.players.includes(playerId),
            "payment-stage soft disconnect must keep seat"
        );

        const reclaimed = stack.roomLobbyBridge.reconnectGameplaySession(
            "sock-p4b",
            { playerId, roomId }
        );

        assert(reclaimed.ok, "page4 reclaim must succeed");

        assert(
            stack.roomLobbyBridge._playerToSocket.get(playerId) === "sock-p4b",
            "exactly one owner after page4 reclaim"
        );

        console.log("  Test E (reconnect during prep/payment ownership) passed");

    } finally {

        stack.shutdown();

    }

}

// Test F — reclaim after soft disconnect with started room (gameplay-style protection).
{

    const stack = buildStack();

    try {

        const { roomId, playerId } = seatPlayer(stack, { socketId: "sock-g1" });

        stack.roomLobbyBridge._startedRooms.add(roomId);

        stack.roomLobbyBridge._handleSocketDisconnected("sock-g1");

        assert(
            stack.roomLobbyBridge._playerToSocket.get(playerId) === "sock-g1",
            "gameplay soft disconnect must keep owner"
        );

        const reclaimed = stack.roomLobbyBridge.reconnectGameplaySession(
            "sock-g2",
            { playerId, roomId }
        );

        assert(reclaimed.ok, "gameplay reclaim must succeed");

        assert(
            stack.roomLobbyBridge._playerToSocket.get(playerId) === "sock-g2",
            "gameplay reclaim must leave exactly one owner"
        );

        console.log("  Test F (reconnect during gameplay protection) passed");

    } finally {

        stack.shutdown();

    }

}

console.log("socketAuthority.commit.test.js: all assertions passed");
