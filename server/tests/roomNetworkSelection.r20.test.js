/**
 * R20 — Owner-only one-time room network selection (post-CREATE_ROOM).
 *
 * Security invariants:
 * 1. CREATE_ROOM remains strictly authenticated by the trusted Telegram
 *    identity resolver (never client payloads).
 * 2. The requesting socket's room is derived from the server-side
 *    socket→player binding; the selection payload never carries a roomId.
 * 3. Only the player recorded in _roomCreators may select; joiners and
 *    sockets without an authoritative binding are rejected.
 * 4. The requested network is normalized strictly to testnet | mainnet;
 *    every malformed value is rejected.
 * 5. The selection is one-time: a second attempt (even the same value) is
 *    rejected and the committed value is unchanged.
 * 6. ROOM_NETWORK_SELECTED is a room-wide authoritative broadcast with safe
 *    lobby payload only: { roomId, network }.
 * 7. Network state is released by the existing room destruction cleanup.
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

function wait(ms) {

    return new Promise((resolve) => setTimeout(resolve, ms));

}

/**
 * Harness with a simulated trusted socket-identity registry (mirrors
 * roomCreationTelegramAuthorization.r179t6c.test.js). The bridge only ever
 * sees the resolver function — never client payloads.
 */
function buildHarness({ setupDurationMs = 80 } = {}) {

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
// Test 1 — authenticated creator creates a room; network starts pending.
// ---------------------------------------------------------------------------

{
    const harness = buildHarness();

    try {

        harness.authenticateSocket("creator-a", 2001);

        harness.requestCreateRoom("creator-a");

        const created = harness.lastSocketDeliveryFor(
            "creator-a",
            LOBBY_SERVER_EVENTS.ROOM_CREATED
        );

        assert(
            created?.event === LOBBY_SERVER_EVENTS.ROOM_CREATED,
            "authenticated create must deliver ROOM_CREATED to the creator socket"
        );

        const roomId = created?.payload?.roomId ?? null;

        assert(Boolean(roomId), "ROOM_CREATED must carry the roomId");

        const roomState = harness.latestRoomState(roomId);

        assert(roomState !== null, "room state must be broadcast after create");

        assert(
            Object.prototype.hasOwnProperty.call(roomState, "network"),
            "room state must expose the network field"
        );

        assert(
            roomState.network === null,
            "network must be null while selection is pending"
        );

        console.log("  test 1 (authenticated create, network pending) passed");

    } finally {

        harness.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Test 2 — creator selects TESTNET; authoritative broadcast + room state.
// ---------------------------------------------------------------------------

{
    const harness = buildHarness();

    try {

        harness.authenticateSocket("creator-t", 2101);

        harness.requestCreateRoom("creator-t");

        const roomId = harness.lastSocketDeliveryFor(
            "creator-t",
            LOBBY_SERVER_EVENTS.ROOM_CREATED
        )?.payload?.roomId;

        // Smuggled ownership fields must be ignored end-to-end.
        harness.requestSelectRoomNetwork("creator-t", "TESTNET", {
            roomId: "FORGED-ROOM",
            playerId: "forged-player",
            telegramUserId: 1,
            ownerPlayerId: "forged-owner"
        });

        const broadcast = harness.lastRoomDeliveryFor(
            roomId,
            LOBBY_SERVER_EVENTS.ROOM_NETWORK_SELECTED
        );

        assert(
            broadcast?.event === LOBBY_SERVER_EVENTS.ROOM_NETWORK_SELECTED,
            "selection must broadcast ROOM_NETWORK_SELECTED to the room"
        );

        assert(
            broadcast.target === "room" && broadcast.roomId === roomId,
            "broadcast must be room-targeted (all sockets in the room)"
        );

        const payloadKeys = Object.keys(broadcast?.payload ?? {}).sort();

        assert(
            payloadKeys.length === 2
            && payloadKeys[0] === "network"
            && payloadKeys[1] === "roomId",
            "broadcast payload must contain only roomId and network"
        );

        assert(
            broadcast.payload.network === "testnet",
            "uppercase input must normalize to testnet"
        );

        assert(
            broadcast.payload.roomId === roomId,
            "broadcast roomId must match the authoritative room"
        );

        assert(
            harness.latestRoomState(roomId)?.network === "testnet",
            "room state must expose the selected network"
        );

        assert(
            harness.roomLobbyBridge._roomNetworkByRoom.get(roomId)
                === "testnet",
            "bridge map must hold the committed network"
        );

        console.log("  test 2 (creator selects TESTNET) passed");

    } finally {

        harness.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Test 3 — creator selects MAINNET; no extra room, no handoff side effects.
// ---------------------------------------------------------------------------

{
    const harness = buildHarness();

    try {

        harness.authenticateSocket("creator-m", 2201);

        harness.requestCreateRoom("creator-m");

        const roomId = harness.lastSocketDeliveryFor(
            "creator-m",
            LOBBY_SERVER_EVENTS.ROOM_CREATED
        )?.payload?.roomId;

        harness.requestSelectRoomNetwork("creator-m", "  Mainnet ");

        const broadcast = harness.lastRoomDeliveryFor(
            roomId,
            LOBBY_SERVER_EVENTS.ROOM_NETWORK_SELECTED
        );

        assert(
            broadcast?.payload?.network === "mainnet",
            "whitespace/mixed-case input must normalize to mainnet"
        );

        assert(
            harness.latestRoomState(roomId)?.network === "mainnet",
            "room state must expose mainnet"
        );

        assert(
            harness.roomManager.getActiveRoomCount() === 1,
            "MAINNET selection must not create any additional room"
        );

        assert(
            harness.roomLobbyBridge._roomNetworkHandoffStore === undefined,
            "RoomNetworkHandoffStore must remain unwired in this pass"
        );

        console.log("  test 3 (creator selects MAINNET, no handoff) passed");

    } finally {

        harness.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Test 4 — a joiner cannot select a network (Owner-only).
// ---------------------------------------------------------------------------

{
    const harness = buildHarness();

    try {

        harness.authenticateSocket("creator-j", 2301);

        harness.requestCreateRoom("creator-j");

        const roomId = harness.lastSocketDeliveryFor(
            "creator-j",
            LOBBY_SERVER_EVENTS.ROOM_CREATED
        )?.payload?.roomId;

        harness.authenticateSocket("joiner-j", 2302);

        harness.requestJoinRoom("joiner-j", roomId);

        assert(
            harness.lastSocketDeliveryFor(
                "joiner-j",
                LOBBY_SERVER_EVENTS.ROOM_JOINED
            )?.event === LOBBY_SERVER_EVENTS.ROOM_JOINED,
            "joiner must be in the room"
        );

        harness.requestSelectRoomNetwork("joiner-j", "testnet");

        assert(
            harness.lastSocketError("joiner-j")?.code
                === LOBBY_ERROR_CODES.ROOM_NETWORK_SELECT_FORBIDDEN,
            "joiner selection must be rejected as forbidden"
        );

        assert(
            harness.countRoomDeliveries(
                roomId,
                LOBBY_SERVER_EVENTS.ROOM_NETWORK_SELECTED
            ) === 0,
            "no network broadcast may be emitted for a rejected selection"
        );

        assert(
            harness.latestRoomState(roomId)?.network === null,
            "network must remain pending after a rejected selection"
        );

        console.log("  test 4 (joiner cannot select) passed");

    } finally {

        harness.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Test 5 — a client cannot select a network for another room; unbound
//          sockets are rejected outright.
// ---------------------------------------------------------------------------

{
    const harness = buildHarness();

    try {

        harness.authenticateSocket("creator-x", 2401);

        harness.requestCreateRoom("creator-x");

        const roomX = harness.lastSocketDeliveryFor(
            "creator-x",
            LOBBY_SERVER_EVENTS.ROOM_CREATED
        )?.payload?.roomId;

        harness.authenticateSocket("creator-y", 2402);

        harness.requestCreateRoom("creator-y");

        const roomY = harness.lastSocketDeliveryFor(
            "creator-y",
            LOBBY_SERVER_EVENTS.ROOM_CREATED
        )?.payload?.roomId;

        harness.requestSelectRoomNetwork("creator-x", "mainnet");

        assert(
            harness.roomLobbyBridge._roomNetworkByRoom.get(roomX)
                === "mainnet",
            "creator-x must commit only his own room"
        );

        assert(
            harness.roomLobbyBridge._roomNetworkByRoom.has(roomY) === false,
            "no selection may leak into the other room"
        );

        assert(
            harness.latestRoomState(roomY)?.network === null,
            "other room must stay network-pending"
        );

        // A socket with no authoritative player binding is rejected outright.
        harness.requestSelectRoomNetwork("ghost-socket", "testnet");

        assert(
            harness.lastSocketDeliveryFor(
                "ghost-socket",
                LOBBY_SERVER_EVENTS.ROOM_ERROR
            )?.event === LOBBY_SERVER_EVENTS.ROOM_ERROR,
            "unbound socket must be rejected"
        );

        assert(
            harness.roomLobbyBridge._roomNetworkByRoom.get(roomX)
                === "mainnet",
            "unbound request must not change committed state"
        );

        // The other owner can still select his own room independently.
        harness.requestSelectRoomNetwork("creator-y", "testnet");

        assert(
            harness.roomLobbyBridge._roomNetworkByRoom.get(roomY)
                === "testnet",
            "other owner selection must work independently"
        );

        console.log("  test 5 (no cross-room selection) passed");

    } finally {

        harness.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Test 6 — malformed network values are rejected; rejections must not burn
//          the one-time selection.
// ---------------------------------------------------------------------------

{
    const harness = buildHarness();

    try {

        harness.authenticateSocket("creator-bad", 2501);

        harness.requestCreateRoom("creator-bad");

        const roomId = harness.lastSocketDeliveryFor(
            "creator-bad",
            LOBBY_SERVER_EVENTS.ROOM_CREATED
        )?.payload?.roomId;

        const malformedValues = [
            null,
            undefined,
            "",
            "    ",
            "livenet",
            "testnet2",
            "TEST",
            "Test Net",
            123,
            true,
            { network: "testnet" },
            ["testnet"]
        ];

        for (const value of malformedValues) {

            harness.requestSelectRoomNetwork("creator-bad", value);

            assert(
                harness.lastSocketError("creator-bad")?.code
                    === LOBBY_ERROR_CODES.ROOM_NETWORK_INVALID,
                `malformed network value must be rejected: ${String(value)}`
            );

        }

        assert(
            harness.latestRoomState(roomId)?.network === null,
            "no malformed attempt may commit a network"
        );

        harness.requestSelectRoomNetwork("creator-bad", "testnet");

        assert(
            harness.roomLobbyBridge._roomNetworkByRoom.get(roomId)
                === "testnet",
            "rejections must not burn the one-time selection"
        );

        console.log("  test 6 (malformed values rejected) passed");

    } finally {

        harness.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Test 7 — unauthenticated CREATE_ROOM stays rejected (zero allocation).
// ---------------------------------------------------------------------------

{
    const harness = buildHarness();

    try {

        harness.requestCreateRoom("web-socket-r20", {
            telegramUserId: 999999
        });

        assert(
            harness.lastSocketError("web-socket-r20")?.code
                === LOBBY_ERROR_CODES.ROOM_CREATION_REQUIRES_TELEGRAM,
            "unauthenticated CREATE_ROOM must stay rejected"
        );

        assert(
            harness.roomManager.getActiveRoomCount() === 0,
            "no rooms may be allocated"
        );

        assert(
            harness.playerManager.getDebugSnapshot().players.length === 0,
            "no players may be allocated"
        );

        console.log("  test 7 (unauthenticated create rejected) passed");

    } finally {

        harness.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Test 8 — the creator cannot change the network after the first selection
//          (switching AND re-selecting the same value are both rejected).
// ---------------------------------------------------------------------------

{
    const harness = buildHarness();

    try {

        harness.authenticateSocket("creator-lock", 2601);

        harness.requestCreateRoom("creator-lock");

        const roomId = harness.lastSocketDeliveryFor(
            "creator-lock",
            LOBBY_SERVER_EVENTS.ROOM_CREATED
        )?.payload?.roomId;

        harness.requestSelectRoomNetwork("creator-lock", "testnet");

        assert(
            harness.lastRoomDeliveryFor(
                roomId,
                LOBBY_SERVER_EVENTS.ROOM_NETWORK_SELECTED
            )?.payload?.network === "testnet",
            "first selection must commit testnet"
        );

        harness.requestSelectRoomNetwork("creator-lock", "mainnet");

        assert(
            harness.lastSocketError("creator-lock")?.code
                === LOBBY_ERROR_CODES.ROOM_NETWORK_ALREADY_SELECTED,
            "second selection (switch) must be rejected"
        );

        harness.requestSelectRoomNetwork("creator-lock", "testnet");

        assert(
            harness.lastSocketError("creator-lock")?.code
                === LOBBY_ERROR_CODES.ROOM_NETWORK_ALREADY_SELECTED,
            "re-selecting the same value must also be rejected"
        );

        assert(
            harness.countRoomDeliveries(
                roomId,
                LOBBY_SERVER_EVENTS.ROOM_NETWORK_SELECTED
            ) === 1,
            "exactly one authoritative broadcast must ever be emitted"
        );

        assert(
            harness.latestRoomState(roomId)?.network === "testnet",
            "committed network must remain testnet"
        );

        console.log("  test 8 (selection immutable) passed");

    } finally {

        harness.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Test 9 — network state is removed when the room is destroyed through the
//          existing creator-leave destruction path.
// ---------------------------------------------------------------------------

{
    const harness = buildHarness();

    try {

        harness.authenticateSocket("creator-d", 2701);

        harness.requestCreateRoom("creator-d");

        const roomId = harness.lastSocketDeliveryFor(
            "creator-d",
            LOBBY_SERVER_EVENTS.ROOM_CREATED
        )?.payload?.roomId;

        harness.requestSelectRoomNetwork("creator-d", "mainnet");

        assert(
            harness.roomLobbyBridge._roomNetworkByRoom.get(roomId)
                === "mainnet",
            "precondition: network committed before destroy"
        );

        harness.requestLeaveRoom("creator-d");

        // _closeRoom is async; give the existing destruction path a moment.
        await wait(50);

        assert(
            !harness.roomManager.getRoom(roomId),
            "room must be destroyed by the existing creator-leave path"
        );

        assert(
            !harness.roomLobbyBridge._roomNetworkByRoom.has(roomId),
            "network selection state must be removed with the room"
        );

        console.log("  test 9 (network state removed on destroy) passed");

    } finally {

        harness.shutdown();

    }

}

console.log(
    "roomNetworkSelection.r20.test.js: all assertions passed"
);