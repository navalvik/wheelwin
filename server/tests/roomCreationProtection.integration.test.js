/**
 * R1.2C — DOS-1 Room creation protection.
 *
 * Verifies concurrent room limits reject abusive creation without allocating
 * rooms, setup sessions, or timers.
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

function buildProtectionHarness({
    maxConcurrentRooms = 2,
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

    const roomLobbyBridge = new RoomLobbyBridge({
        logger,
        eventBus,
        roomManager,
        playerManager,
        setupSessionLifecycle
    });

    roomLobbyBridge.initialize();

    const deliveries = [];

    eventBus.subscribe(EVENT_TYPES.LOBBY_SOCKET_DELIVERY, (envelope) => {

        deliveries.push(envelope.payload);

    });

    function requestCreateRoom(socketId) {

        eventBus.emit({
            source: EVENT_SOURCES.SOCKET_GATEWAY,
            type: EVENT_TYPES.LOBBY_CREATE_ROOM_REQUEST,
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

    return {
        roomManager,
        playerManager,
        setupSessionLifecycle,
        roomLobbyBridge,
        requestCreateRoom,
        deliveryFor,
        lastDeliveryFor,
        countSetupSessions,
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

function assertNoAllocation(harness, {
    rooms,
    setupSessions,
    players
}) {

    assert(
        harness.roomManager.getActiveRoomCount() === rooms,
        `expected ${rooms} rooms, found ${harness.roomManager.getActiveRoomCount()}`
    );

    assert(
        harness.countSetupSessions() === setupSessions,
        `expected ${setupSessions} setup sessions, found ${harness.countSetupSessions()}`
    );

    assert(
        harness.playerManager.getDebugSnapshot().players.length === players,
        `expected ${players} players, found ${harness.playerManager.getDebugSnapshot().players.length}`
    );

}

// ---------------------------------------------------------------------------
// Scenario 1 — legitimate room creation still works.
// ---------------------------------------------------------------------------

{

    const harness = buildProtectionHarness();

    try {

        harness.requestCreateRoom("socket-normal");

        const delivery = harness.deliveryFor(
            "socket-normal",
            LOBBY_SERVER_EVENTS.ROOM_CREATED
        );

        assert(
            delivery?.event === LOBBY_SERVER_EVENTS.ROOM_CREATED,
            "legitimate create must return ROOM_CREATED"
        );

        assertNoAllocation(harness, {
            rooms: 1,
            setupSessions: 1,
            players: 1
        });

        console.log("  scenario 1 (legitimate room creation) passed");

    } finally {

        harness.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Scenario 2 — rapid repeated CREATE_ROOM on the same socket is rejected.
// ---------------------------------------------------------------------------

{

    const harness = buildProtectionHarness();

    try {

        harness.requestCreateRoom("socket-repeat");

        harness.requestCreateRoom("socket-repeat");

        const delivery = harness.lastDeliveryFor("socket-repeat");

        assert(
            delivery?.event === LOBBY_SERVER_EVENTS.ROOM_ERROR,
            "second create on same socket must return ROOM_ERROR"
        );

        assert(
            delivery?.payload?.code === LOBBY_ERROR_CODES.PLAYER_ALREADY_CONNECTED,
            "same socket must be rejected as already connected"
        );

        assertNoAllocation(harness, {
            rooms: 1,
            setupSessions: 1,
            players: 1
        });

        console.log("  scenario 2 (rapid repeated create on same socket) passed");

    } finally {

        harness.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Scenario 3 — parallel creation stops at the concurrent room limit.
// ---------------------------------------------------------------------------

{

    const harness = buildProtectionHarness({ maxConcurrentRooms: 2 });

    try {

        harness.requestCreateRoom("socket-a");

        harness.requestCreateRoom("socket-b");

        const roomsBeforeReject = harness.roomManager.getActiveRoomCount();

        const setupBeforeReject = harness.countSetupSessions();

        const playersBeforeReject = harness.playerManager
            .getDebugSnapshot().players.length;

        harness.requestCreateRoom("socket-c");

        const delivery = harness.lastDeliveryFor("socket-c");

        assert(
            delivery?.event === LOBBY_SERVER_EVENTS.ROOM_ERROR,
            "over-limit create must return ROOM_ERROR"
        );

        assert(
            delivery?.payload?.code === LOBBY_ERROR_CODES.ROOM_CREATION_LIMIT,
            "over-limit create must return ROOM_CREATION_LIMIT"
        );

        assert(
            harness.roomManager.getActiveRoomCount() === roomsBeforeReject,
            "rejected create must not add rooms"
        );

        assert(
            harness.countSetupSessions() === setupBeforeReject,
            "rejected create must not add setup sessions"
        );

        assert(
            harness.playerManager.getDebugSnapshot().players.length === playersBeforeReject,
            "rejected create must not add players"
        );

        assert(
            !harness.roomLobbyBridge._socketToPlayer.has("socket-c"),
            "rejected create must not bind the socket"
        );

        console.log("  scenario 3 (parallel room creation limit) passed");

    } finally {

        harness.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Scenario 4 — room creation succeeds again after explicit cleanup.
// ---------------------------------------------------------------------------

{

    const harness = buildProtectionHarness({ maxConcurrentRooms: 1 });

    try {

        harness.requestCreateRoom("socket-first");

        const firstDelivery = harness.deliveryFor(
            "socket-first",
            LOBBY_SERVER_EVENTS.ROOM_CREATED
        );

        const firstRoomId = firstDelivery?.payload?.roomId;

        assert(firstRoomId, "first room must be created");

        harness.requestCreateRoom("socket-blocked");

        assert(
            harness.lastDeliveryFor("socket-blocked")?.payload?.code
                === LOBBY_ERROR_CODES.ROOM_CREATION_LIMIT,
            "second create must be blocked at capacity"
        );

        harness.roomManager.destroyRoom(firstRoomId);

        harness.requestCreateRoom("socket-after-cleanup");

        assert(
            harness.deliveryFor(
                "socket-after-cleanup",
                LOBBY_SERVER_EVENTS.ROOM_CREATED
            ),
            "create after cleanup must succeed"
        );

        assertNoAllocation(harness, {
            rooms: 1,
            setupSessions: 1,
            players: 2
        });

        console.log("  scenario 4 (create after cleanup) passed");

    } finally {

        harness.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Scenario 5 — room creation succeeds again after setup timeout cleanup.
// ---------------------------------------------------------------------------

{

    const harness = buildProtectionHarness({
        maxConcurrentRooms: 1,
        setupDurationMs: 50
    });

    try {

        harness.requestCreateRoom("socket-expire");

        assert(
            harness.roomManager.getActiveRoomCount() === 1,
            "setup room must be created before expiry"
        );

        await wait(120);

        assert(
            harness.roomManager.getActiveRoomCount() === 0,
            "setup expiry must release the room"
        );

        harness.requestCreateRoom("socket-after-timeout");

        assert(
            harness.deliveryFor(
                "socket-after-timeout",
                LOBBY_SERVER_EVENTS.ROOM_CREATED
            ),
            "create after setup timeout must succeed"
        );

        console.log("  scenario 5 (create after setup timeout) passed");

    } finally {

        harness.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Scenario 6 — direct RoomManager guard also rejects over-limit allocation.
// ---------------------------------------------------------------------------

{

    const harness = buildProtectionHarness({ maxConcurrentRooms: 1 });

    try {

        const first = harness.roomManager.createRoom();

        assert(first, "first direct create must succeed");

        const second = harness.roomManager.createRoom();

        assert(!second, "second direct create must fail at capacity");

        assertNoAllocation(harness, {
            rooms: 1,
            setupSessions: 1,
            players: 0
        });

        console.log("  scenario 6 (RoomManager capacity guard) passed");

    } finally {

        harness.shutdown();

    }

}

console.log("roomCreationProtection.integration.test.js: all assertions passed");
