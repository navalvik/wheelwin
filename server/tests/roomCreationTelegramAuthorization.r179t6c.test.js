/**
 * R17.9T.6-C — Telegram-only CREATE_ROOM authorization.
 *
 * Security invariants:
 * 1. CREATE_ROOM requires an authenticated Telegram identity resolved from the
 *    trusted server-side socket context (never from client payloads).
 * 2. One active created room per Telegram user; multiple sockets/devices are
 *    allowed and JOIN_ROOM is never limited by the creator quota.
 * 3. Rejected CREATE_ROOM allocates zero rooms / players / setup sessions /
 *    recovery credentials.
 * 4. Quota is released whenever the created room is destroyed (setup expiry,
 *    explicit destruction, creator leave).
 * 5. Global 64-room capacity remains authoritative.
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
 * Harness with a simulated trusted socket-identity registry that mirrors
 * socket.data.telegramUserId as established by SocketGateway authentication.
 * The bridge only ever sees the resolver function — never client payloads.
 */
function buildHarness({
    maxConcurrentRooms = 64,
    setupDurationMs = 80
} = {}) {

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
            maxConcurrentRooms,
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
    // This stands in for socket.data.telegramUserId set by SocketGateway.
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

    function requestCreateRoom(socketId, maliciousPayload = null) {

        // The envelope payload mirrors SocketGateway's real shape (socketId
        // only). maliciousPayload simulates a forged client field; the bridge
        // must ignore it entirely.
        eventBus.emit({
            source: EVENT_SOURCES.SOCKET_GATEWAY,
            type: EVENT_TYPES.LOBBY_CREATE_ROOM_REQUEST,
            payload: {
                socketId,
                ...(maliciousPayload ?? {})
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

    function deliveryFor(socketId, eventName = null) {

        for (let index = deliveries.length - 1; index >= 0; index -= 1) {

            const delivery = deliveries[index];

            if (delivery.socketId !== socketId) {

                continue;

            }

            if (!eventName || delivery.event === eventName) {

                return delivery;

            }

        }

        return null;

    }

    function lastDeliveryFor(socketId) {

        return deliveryFor(socketId);

    }

    function countSetupSessions() {

        let active = 0;

        for (const room of roomManager.getRooms()) {

            if (setupSessionLifecycle.isActive(room.roomId)) {

                active += 1;

            }

        }

        return active;

    }

    function countRecoveryCredentials() {

        return roomLobbyBridge._recoveryCredentials.size ?? 0;

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
        deliveryFor,
        lastDeliveryFor,
        countSetupSessions,
        countRecoveryCredentials,
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

// ---------------------------------------------------------------------------
// Test 1 — Web (unauthenticated) CREATE_ROOM is rejected with zero allocation.
// ---------------------------------------------------------------------------

{

    const harness = buildHarness();

    try {

        harness.requestCreateRoom("web-socket", {
            telegramUserId: 999999
        });

        const delivery = harness.lastDeliveryFor("web-socket");

        assert(
            delivery?.event === LOBBY_SERVER_EVENTS.ROOM_ERROR,
            "unauthenticated create must return ROOM_ERROR"
        );

        assert(
            delivery?.payload?.code
                === LOBBY_ERROR_CODES.ROOM_CREATION_REQUIRES_TELEGRAM,
            "unauthenticated create must return ROOM_CREATION_REQUIRES_TELEGRAM"
        );

        assert(
            harness.roomManager.getActiveRoomCount() === 0,
            "no rooms may be allocated"
        );

        assert(
            harness.countSetupSessions() === 0,
            "no setup sessions may be allocated"
        );

        assert(
            harness.playerManager.getDebugSnapshot().players.length === 0,
            "no players may be allocated"
        );

        assert(
            harness.countRecoveryCredentials() === 0,
            "no recovery credentials may be created"
        );

        console.log("  test 1 (web CREATE_ROOM rejected, zero allocation) passed");

    } finally {

        harness.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Test 2 — authenticated Telegram CREATE_ROOM succeeds normally.
// ---------------------------------------------------------------------------

{

    const harness = buildHarness();

    try {

        harness.authenticateSocket("tg-socket-a", 1001);

        harness.requestCreateRoom("tg-socket-a");

        const delivery = harness.deliveryFor(
            "tg-socket-a",
            LOBBY_SERVER_EVENTS.ROOM_CREATED
        );

        assert(
            delivery?.event === LOBBY_SERVER_EVENTS.ROOM_CREATED,
            "authenticated Telegram create must succeed"
        );

        assert(harness.roomManager.getActiveRoomCount() === 1, "one room");
        assert(harness.countSetupSessions() === 1, "one setup session");
        assert(
            harness.playerManager.getDebugSnapshot().players.length === 1,
            "one player"
        );

        console.log("  test 2 (telegram CREATE_ROOM succeeds) passed");

    } finally {

        harness.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Test 3 — same Telegram user on a second socket is limited to one room.
// ---------------------------------------------------------------------------

{

    const harness = buildHarness();

    try {

        harness.authenticateSocket("tg-device-1", 2002);
        harness.authenticateSocket("tg-device-2", 2002);

        harness.requestCreateRoom("tg-device-1");

        assert(
            harness.deliveryFor("tg-device-1", LOBBY_SERVER_EVENTS.ROOM_CREATED),
            "first device creates the room"
        );

        harness.requestCreateRoom("tg-device-2");

        const reject = harness.lastDeliveryFor("tg-device-2");

        assert(
            reject?.event === LOBBY_SERVER_EVENTS.ROOM_ERROR,
            "second device must receive ROOM_ERROR"
        );

        assert(
            reject?.payload?.code === LOBBY_ERROR_CODES.ROOM_CREATION_USER_LIMIT,
            "second device must receive ROOM_CREATION_USER_LIMIT"
        );

        assert(harness.roomManager.getActiveRoomCount() === 1, "exactly one room");
        assert(harness.countSetupSessions() === 1, "exactly one setup session");
        assert(
            harness.playerManager.getDebugSnapshot().players.length === 1,
            "exactly one player"
        );

        console.log("  test 3 (one active room per Telegram user) passed");

    } finally {

        harness.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Test 4 — same Telegram user can still JOIN another room from second socket.
// ---------------------------------------------------------------------------

{

    const harness = buildHarness();

    try {

        harness.authenticateSocket("tg-owner", 3003);
        harness.authenticateSocket("tg-second", 3003);
        harness.authenticateSocket("tg-other", 4004);

        harness.requestCreateRoom("tg-other");

        const otherDelivery = harness.deliveryFor(
            "tg-other",
            LOBBY_SERVER_EVENTS.ROOM_CREATED
        );

        const otherRoomId = otherDelivery?.payload?.roomId;

        assert(otherRoomId, "other user's room must exist");

        harness.requestJoinRoom("tg-second", otherRoomId);

        assert(
            harness.deliveryFor("tg-second", LOBBY_SERVER_EVENTS.ROOM_JOINED),
            "same Telegram user must be able to join another room"
        );

        console.log("  test 4 (JOIN_ROOM unaffected by creator quota) passed");

    } finally {

        harness.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Test 5 — setup expiry releases the Telegram creation quota.
// ---------------------------------------------------------------------------

{

    const harness = buildHarness({ maxConcurrentRooms: 1, setupDurationMs: 50 });

    try {

        harness.authenticateSocket("tg-expiry", 5005);

        harness.requestCreateRoom("tg-expiry");

        assert(harness.roomManager.getActiveRoomCount() === 1, "room exists");

        await wait(120);

        assert(
            harness.roomManager.getActiveRoomCount() === 0,
            "setup expiry must destroy the room"
        );

        harness.requestCreateRoom("tg-expiry");

        assert(
            harness.deliveryFor("tg-expiry", LOBBY_SERVER_EVENTS.ROOM_CREATED),
            "same user must create again after expiry"
        );

        console.log("  test 5 (setup expiry releases quota) passed");

    } finally {

        harness.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Test 6 — explicit room destruction (creator LEAVE_ROOM) releases the quota.
// ---------------------------------------------------------------------------

{

    const harness = buildHarness({ maxConcurrentRooms: 1 });

    try {

        harness.authenticateSocket("tg-destroy", 6006);

        harness.requestCreateRoom("tg-destroy");

        const created = harness.deliveryFor(
            "tg-destroy",
            LOBBY_SERVER_EVENTS.ROOM_CREATED
        );

        assert(created?.payload?.roomId, "room must be created");

        harness.requestLeaveRoom("tg-destroy");

        await wait(10);

        assert(
            harness.roomManager.getActiveRoomCount() === 0,
            "creator leave must destroy the room"
        );

        harness.requestCreateRoom("tg-destroy");

        assert(
            harness.deliveryFor("tg-destroy", LOBBY_SERVER_EVENTS.ROOM_CREATED),
            "same user must create again after explicit destruction"
        );

        console.log("  test 6 (explicit destroy releases quota) passed");

    } finally {

        harness.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Test 7 — global concurrent-room cap still applies to authenticated users.
// ---------------------------------------------------------------------------

{

    const harness = buildHarness({ maxConcurrentRooms: 2 });

    try {

        harness.authenticateSocket("cap-a", 7001);
        harness.authenticateSocket("cap-b", 7002);
        harness.authenticateSocket("cap-c", 7003);

        harness.requestCreateRoom("cap-a");
        harness.requestCreateRoom("cap-b");

        assert(harness.roomManager.getActiveRoomCount() === 2, "two rooms");

        harness.requestCreateRoom("cap-c");

        assert(
            harness.lastDeliveryFor("cap-c")?.payload?.code
                === LOBBY_ERROR_CODES.ROOM_CREATION_LIMIT,
            "global capacity limit must remain ROOM_CREATION_LIMIT"
        );

        assert(harness.roomManager.getActiveRoomCount() === 2, "still two rooms");

        console.log("  test 7 (global 64-room cap unchanged) passed");

    } finally {

        harness.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Test 8 — recovery/reconnect does not consume or create Telegram quota.
// ---------------------------------------------------------------------------

{

    const harness = buildHarness();

    try {

        harness.authenticateSocket("tg-recovery", 8008);

        harness.requestCreateRoom("tg-recovery");

        const created = harness.deliveryFor(
            "tg-recovery",
            LOBBY_SERVER_EVENTS.ROOM_CREATED
        );

        const roomId = created?.payload?.roomId;
        const playerId = created?.payload?.playerId;

        assert(roomId && playerId, "room + player must exist");

        const quotaBefore = harness.roomLobbyBridge._activeRoomsByTelegramUser.size;

        assert(quotaBefore === 1, "quota occupied by the created room");

        // A failed reconnect attempt must not mutate the quota map.
        harness.roomLobbyBridge.reconnectSession("tg-recovery-new", {
            playerId,
            roomId
        });

        assert(
            harness.roomLobbyBridge._activeRoomsByTelegramUser.size
                === quotaBefore,
            "reconnect attempt must not change quota occupancy"
        );

        console.log("  test 8 (recovery does not touch quota) passed");

    } finally {

        harness.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Test 9 — client-supplied telegramUserId never authenticates CREATE_ROOM.
// ---------------------------------------------------------------------------

{

    const harness = buildHarness();

    try {

        // Socket has NO authenticated identity; payload tries to inject one.
        harness.requestCreateRoom("forged-socket", {
            telegramUserId: 424242,
            initDataUnsafe: { user: { id: 424242 } }
        });

        const delivery = harness.lastDeliveryFor("forged-socket");

        assert(
            delivery?.payload?.code
                === LOBBY_ERROR_CODES.ROOM_CREATION_REQUIRES_TELEGRAM,
            "injected identity must not authenticate the request"
        );

        assert(
            harness.roomManager.getActiveRoomCount() === 0,
            "no rooms allocated for forged identity"
        );

        // Also verify the resolver is the ONLY identity source: even when the
        // resolver returns null for an otherwise-valid-looking socket id.
        harness.authenticateSocket("null-identity", null);

        harness.requestCreateRoom("null-identity", { telegramUserId: 777 });

        assert(
            harness.lastDeliveryFor("null-identity")?.payload?.code
                === LOBBY_ERROR_CODES.ROOM_CREATION_REQUIRES_TELEGRAM,
            "resolver-null socket stays unauthenticated regardless of payload"
        );

        console.log("  test 9 (no client-supplied identity) passed");

    } finally {

        harness.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Test 10 — flood regression: many unauthenticated sockets create zero rooms;
//           one Telegram identity across many sockets creates exactly one.
// ---------------------------------------------------------------------------

{

    const harness = buildHarness();

    try {

        const floodSockets = [];

        for (let index = 0; index < 25; index += 1) {

            const socketId = `flood-${index}`;

            floodSockets.push(socketId);

            harness.requestCreateRoom(socketId, { telegramUserId: index });

        }

        assert(
            harness.roomManager.getActiveRoomCount() === 0,
            "flood of unauthenticated CREATE_ROOM must create 0 rooms"
        );

        assert(
            harness.playerManager.getDebugSnapshot().players.length === 0,
            "flood must allocate 0 players"
        );

        assert(
            harness.countSetupSessions() === 0,
            "flood must allocate 0 setup sessions"
        );

        // One Telegram identity, many authenticated sockets → exactly 1 room.
        for (let index = 0; index < 10; index += 1) {

            const socketId = `multi-${index}`;

            harness.authenticateSocket(socketId, 9090);

            harness.requestCreateRoom(socketId);

        }

        assert(
            harness.roomManager.getActiveRoomCount() === 1,
            "one Telegram identity must hold exactly one active room"
        );

        let userLimitRejections = 0;

        for (let index = 0; index < 10; index += 1) {

            if (harness.deliveryFor(`multi-${index}`)?.payload?.code
                === LOBBY_ERROR_CODES.ROOM_CREATION_USER_LIMIT) {

                userLimitRejections += 1;

            }

        }

        assert(
            userLimitRejections === 9,
            "9 of 10 same-user creates must be rejected with USER_LIMIT"
        );

        console.log("  test 10 (flood + multi-device regression) passed");

    } finally {

        harness.shutdown();

    }

}

console.log(
    "roomCreationTelegramAuthorization.r179t6c.test.js: all assertions passed"
);