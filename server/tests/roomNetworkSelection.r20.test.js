/**
 * R20 — Room network is pinned by the server deployment at CREATE_ROOM.
 *
 * Security invariants:
 * 1. CREATE_ROOM remains strictly authenticated by the trusted Telegram
 *    identity resolver (never client payloads).
 * 2. Each deployment creates rooms on its configured TON_NETWORK.
 * 3. Client selection requests cannot switch the room to another network.
 * 4. Unauthenticated room creation remains rejected before allocation.
 * 5. Network state is released by the existing room destruction cleanup.
 */
import { EventBus } from "../events/EventBus.js";
import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { SetupSessionLifecycle } from "../gameplay/SetupSessionLifecycle.js";
import { PlayerManager } from "../managers/PlayerManager.js";
import { RoomManager } from "../managers/RoomManager.js";
import { LoggerService } from "../services/LoggerService.js";
import {
    LOBBY_ERROR_CODES,
    LOBBY_SERVER_EVENTS
} from "../socket/lobbyProtocol.js";
import { RoomLobbyBridge } from "../socket/RoomLobbyBridge.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

function assertEqual(actual, expected, message) {

    assert(actual === expected, message);

}

function wait(ms) {

    return new Promise((resolve) => setTimeout(resolve, ms));

}

/**
 * Harness with a simulated trusted socket-identity registry (mirrors
 * roomCreationTelegramAuthorization.r179t6c.test.js). The bridge only ever
 * sees the resolver function — never client payloads.
 */
function buildHarness({ setupDurationMs = 80, network = "testnet" } = {}) {

    const previousTonNetwork = process.env.TON_NETWORK;
    process.env.TON_NETWORK = network;

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
        roomConfig: {
            maxPlayers: 3,
            maxConcurrentRooms: 64,
            setupDurationMs
        }
    });

    const playerManager = new PlayerManager({ logger, eventBus });

    const setupSessionLifecycle = new SetupSessionLifecycle({
        logger,
        eventBus,
        roomManager,
        roomConfig: { setupDurationMs }
    });

    roomManager.initialize();

    playerManager.initialize();

    setupSessionLifecycle.initialize();

    roomManager.attachSetupSessionLifecycle(setupSessionLifecycle);

    // Simulated authenticated socket context: socketId → telegramUserId|null.
    const telegramIdentityBySocket = new Map();

    const telegramIdentityResolver = (socketId) => {

        return telegramIdentityBySocket.get(socketId) ?? null;

    };

    const roomLobbyBridge = new RoomLobbyBridge({
        logger,
        eventBus,
        roomManager,
        playerManager,
        setupSessionLifecycle,
        telegramIdentityResolver
    });

    roomLobbyBridge.initialize();

    const deliveries = [];

    eventBus.subscribe(EVENT_TYPES.LOBBY_SOCKET_DELIVERY, (envelope) => {

        deliveries.push(envelope.payload);

    });

    function authenticateSocket(socketId, telegramUserId) {

        telegramIdentityBySocket.set(socketId, telegramUserId ?? null);

    }

    function requestCreateRoom(socketId, forgedPayload = null) {

        eventBus.emit({
            source: EVENT_SOURCES.SOCKET_GATEWAY,
            type: EVENT_TYPES.LOBBY_CREATE_ROOM_REQUEST,
            payload: {
                socketId,
                ...(forgedPayload ?? {})
            }
        });

    }

    function requestJoinRoom(socketId, roomId) {

        eventBus.emit({
            source: EVENT_SOURCES.SOCKET_GATEWAY,
            type: EVENT_TYPES.LOBBY_JOIN_ROOM_REQUEST,
            payload: { socketId, roomId }
        });

    }

    function requestLeaveRoom(socketId) {

        eventBus.emit({
            source: EVENT_SOURCES.SOCKET_GATEWAY,
            type: EVENT_TYPES.LOBBY_LEAVE_ROOM_REQUEST,
            payload: { socketId }
        });

    }

    function requestSelectRoomNetwork(socketId, network, forgedPayload = null) {

        // Mirrors SocketGateway's real envelope shape: socketId + network only.
        // forgedPayload simulates smuggled client fields (roomId / playerId /
        // telegramUserId / ownerPlayerId); the bridge must ignore them all.
        eventBus.emit({
            source: EVENT_SOURCES.SOCKET_GATEWAY,
            type: EVENT_TYPES.LOBBY_SELECT_ROOM_NETWORK_REQUEST,
            payload: {
                socketId,
                network,
                ...(forgedPayload ?? {})
            }
        });

    }

    function lastSocketDeliveryFor(socketId, eventName = null) {

        for (let index = deliveries.length - 1; index >= 0; index -= 1) {

            const delivery = deliveries[index];

            if (delivery.target !== "socket" || delivery.socketId !== socketId) {

                continue;

            }

            if (!eventName || delivery.event === eventName) {

                return delivery;

            }

        }

        return null;

    }

    function lastRoomDeliveryFor(roomId, eventName = null) {

        for (let index = deliveries.length - 1; index >= 0; index -= 1) {

            const delivery = deliveries[index];

            if (delivery.target !== "room" || delivery.roomId !== roomId) {

                continue;

            }

            if (!eventName || delivery.event === eventName) {

                return delivery;

            }

        }

        return null;

    }

    function countRoomDeliveries(roomId, eventName) {

        let count = 0;

        for (const delivery of deliveries) {

            if (
                delivery.target === "room"
                && delivery.roomId === roomId
                && delivery.event === eventName
            ) {

                count += 1;

            }

        }

        return count;

    }

    function latestRoomState(roomId) {

        const delivery = lastRoomDeliveryFor(
            roomId,
            LOBBY_SERVER_EVENTS.ROOM_STATE
        );

        return delivery?.payload ?? null;

    }

    function lastSocketError(socketId) {

        const delivery = lastSocketDeliveryFor(
            socketId,
            LOBBY_SERVER_EVENTS.ROOM_ERROR
        );

        return delivery?.payload ?? null;

    }

    function shutdown() {

        roomLobbyBridge.shutdown();

        setupSessionLifecycle.shutdown();

        roomManager.shutdown();

        playerManager.shutdown();

        eventBus.shutdown();

        logger.shutdown();

        if (previousTonNetwork === undefined) {
            delete process.env.TON_NETWORK;
        } else {
            process.env.TON_NETWORK = previousTonNetwork;
        }

    }

    return {
        logger,
        roomManager,
        playerManager,
        setupSessionLifecycle,
        roomLobbyBridge,
        authenticateSocket,
        requestCreateRoom,
        requestJoinRoom,
        requestLeaveRoom,
        requestSelectRoomNetwork,
        lastSocketDeliveryFor,
        lastRoomDeliveryFor,
        countRoomDeliveries,
        latestRoomState,
        lastSocketError,
        shutdown
    };

}

// ---------------------------------------------------------------------------
// Test 1 — Testnet deployment pins room network at creation.

{
    const harness = buildHarness({ network: "testnet" });
    try {
        harness.authenticateSocket("creator-testnet", 2001);
        harness.requestCreateRoom("creator-testnet");

        const created = harness.lastSocketDeliveryFor(
            "creator-testnet", LOBBY_SERVER_EVENTS.ROOM_CREATED
        );
        assert(created?.event === LOBBY_SERVER_EVENTS.ROOM_CREATED,
            "authenticated create must deliver ROOM_CREATED");
        const roomId = created.payload.roomId;
        assertEqual(created.payload.network, "testnet",
            "Testnet runtime must assign Testnet in the create response");
        assertEqual(harness.latestRoomState(roomId)?.network, "testnet",
            "Testnet room state must be bound at creation");
        assertEqual(harness.roomLobbyBridge._roomNetworkByRoom.get(roomId), "testnet");

        harness.requestSelectRoomNetwork("creator-testnet", "mainnet");
        assertEqual(harness.lastSocketError("creator-testnet")?.code,
            LOBBY_ERROR_CODES.ROOM_NETWORK_ALREADY_SELECTED,
            "client cannot switch a Testnet deployment room to Mainnet");
        assertEqual(harness.latestRoomState(roomId)?.network, "testnet",
            "rejected selection must not change Testnet room state");
        console.log("  test 1 (Testnet network pinned at room creation) passed");
    } finally {
        harness.shutdown();
    }
}

// Test 2 — Mainnet deployment pins room network at creation.

{
    const harness = buildHarness({ network: "mainnet" });
    try {
        harness.authenticateSocket("creator-mainnet", 2101);
        harness.requestCreateRoom("creator-mainnet");

        const created = harness.lastSocketDeliveryFor(
            "creator-mainnet", LOBBY_SERVER_EVENTS.ROOM_CREATED
        );
        assert(created?.event === LOBBY_SERVER_EVENTS.ROOM_CREATED,
            "authenticated create must deliver ROOM_CREATED");
        const roomId = created.payload.roomId;
        assertEqual(created.payload.network, "mainnet",
            "Mainnet runtime must assign Mainnet in the create response");
        assertEqual(harness.latestRoomState(roomId)?.network, "mainnet",
            "Mainnet room state must be bound at creation");
        assertEqual(harness.roomLobbyBridge._roomNetworkByRoom.get(roomId), "mainnet");

        harness.requestSelectRoomNetwork("creator-mainnet", "testnet");
        assertEqual(harness.lastSocketError("creator-mainnet")?.code,
            LOBBY_ERROR_CODES.ROOM_NETWORK_ALREADY_SELECTED,
            "client cannot switch a Mainnet deployment room to Testnet");
        assertEqual(harness.latestRoomState(roomId)?.network, "mainnet",
            "rejected selection must not change Mainnet room state");
        console.log("  test 2 (Mainnet network pinned at room creation) passed");
    } finally {
        harness.shutdown();
    }
}

// Test 3 — joiners and malformed requests cannot alter deployment binding.

{
    const harness = buildHarness({ network: "testnet" });
    try {
        harness.authenticateSocket("creator", 2201);
        harness.requestCreateRoom("creator");
        const roomId = harness.lastSocketDeliveryFor(
            "creator", LOBBY_SERVER_EVENTS.ROOM_CREATED
        )?.payload?.roomId;

        harness.authenticateSocket("joiner", 2202);
        harness.requestJoinRoom("joiner", roomId);
        assertEqual(harness.lastSocketDeliveryFor(
            "joiner", LOBBY_SERVER_EVENTS.ROOM_JOINED
        )?.event, LOBBY_SERVER_EVENTS.ROOM_JOINED, "joiner must enter the room");
        harness.requestSelectRoomNetwork("joiner", "mainnet");
        assertEqual(harness.lastSocketError("joiner")?.code,
            LOBBY_ERROR_CODES.ROOM_NETWORK_SELECT_FORBIDDEN,
            "joiner cannot select or change the room network");

        harness.requestSelectRoomNetwork("creator", "livenet");
        assertEqual(harness.lastSocketError("creator")?.code,
            LOBBY_ERROR_CODES.ROOM_NETWORK_INVALID,
            "malformed network value must remain rejected");
        assertEqual(harness.latestRoomState(roomId)?.network, "testnet",
            "rejected requests must preserve the server-selected network");
        console.log("  test 3 (joiner and malformed requests cannot alter network) passed");
    } finally {
        harness.shutdown();
    }
}

// Test 4 — unauthenticated CREATE_ROOM stays rejected before allocation.

{
    const harness = buildHarness({ network: "testnet" });
    try {
        harness.requestCreateRoom("web-socket-r20", { telegramUserId: 999999 });
        assertEqual(harness.lastSocketError("web-socket-r20")?.code,
            LOBBY_ERROR_CODES.ROOM_CREATION_REQUIRES_TELEGRAM,
            "unauthenticated CREATE_ROOM must stay rejected");
        assertEqual(harness.roomManager.getActiveRoomCount(), 0,
            "no room may be allocated");
        assertEqual(harness.playerManager.getDebugSnapshot().players.length, 0,
            "no player may be allocated");
        console.log("  test 4 (unauthenticated create rejected) passed");
    } finally {
        harness.shutdown();
    }
}

// Test 5 — runtime network state is removed through existing room cleanup.

{
    const harness = buildHarness({ network: "mainnet" });
    try {
        harness.authenticateSocket("creator-cleanup", 2301);
        harness.requestCreateRoom("creator-cleanup");
        const roomId = harness.lastSocketDeliveryFor(
            "creator-cleanup", LOBBY_SERVER_EVENTS.ROOM_CREATED
        )?.payload?.roomId;
        assertEqual(harness.roomLobbyBridge._roomNetworkByRoom.get(roomId), "mainnet",
            "precondition: Mainnet network bound when room is created");

        harness.requestLeaveRoom("creator-cleanup");
        await wait(50);
        assertEqual(harness.roomManager.getRoom(roomId), null,
            "room must be destroyed by creator-leave path");
        assertEqual(harness.roomLobbyBridge._roomNetworkByRoom.has(roomId), false,
            "network binding must be removed with the room");
        console.log("  test 5 (network binding removed on room destroy) passed");
    } finally {
        harness.shutdown();
    }
}

console.log("roomNetworkSelection.r20.test.js: all assertions passed");
