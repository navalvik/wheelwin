/**
 * R24.1 — Owner room-network selection lifecycle gate.
 *
 * Focused regression for the Owner TESTNET/MAINNET selection lifecycle
 * introduced by R20-R24 and enforced server-side by RoomLobbyBridge:
 *
 * 1. After CREATE_ROOM the authoritative roomState carries network=null and
 *    the ownerPlayerId projection, so the creator's selector renders from
 *    hydratable state (not from a single roomCreated event).
 * 2. Joiners never receive owner controls (ownerPlayerId differs) and can
 *    never select (server-side ownership enforcement).
 * 3. A committed selection broadcasts ROOM_NETWORK_SELECTED + roomState and
 *    is one-time (second attempt rejected, value unchanged).
 * 4. ROOM_FULL / game-created with network=null does NOT emit startGame
 *    (withheld); a TESTNET selection releases it (existing lifecycle).
 * 5. MAINNET keeps the existing handoff behavior: committed on a testnet
 *    runtime it stays parked (no wrong-network startGame), while on a
 *    mainnet runtime the normal Mainnet RoomLobby lifecycle continues.
 * 6. Room destruction releases the network lifecycle state.
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

// ===== HARNESS =====

function buildHarness({
    setupDurationMs = 60000,
    runtimeNetwork = null
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
        telegramIdentityResolver,
        // R24.1 — financial rails of this runtime (null = historical default).
        runtimeNetwork
    });

    roomLobbyBridge.initialize();

    const deliveries = [];

    eventBus.subscribe(EVENT_TYPES.LOBBY_SOCKET_DELIVERY, (envelope) => {

        deliveries.push(envelope.payload);

    });

    // ===== HARNESS HELPERS =====

    function authenticateSocket(socketId, telegramUserId) {

        telegramIdentityBySocket.set(socketId, telegramUserId ?? null);

    }

    function requestCreateRoom(socketId) {

        eventBus.emit({
            source: EVENT_SOURCES.SOCKET_GATEWAY,
            type: EVENT_TYPES.LOBBY_CREATE_ROOM_REQUEST,
            payload: { socketId }
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

    function requestSelectRoomNetwork(socketId, network) {

        // Mirrors SocketGateway's real envelope shape: socketId + network only.
        eventBus.emit({
            source: EVENT_SOURCES.SOCKET_GATEWAY,
            type: EVENT_TYPES.LOBBY_SELECT_ROOM_NETWORK_REQUEST,
            payload: { socketId, network }
        });

    }

    function requestGameCreated(roomId, gameId) {

        // Simulates the existing GameManager → GAME_CREATED room-full /
        // game-prep transition (the transition the R24.1 gate protects).
        eventBus.emit({
            source: EVENT_SOURCES.GAME_MANAGER,
            type: EVENT_TYPES.GAME_CREATED,
            payload: { roomId, gameId }
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

    function lastSocketErrorCode(socketId) {

        const delivery = lastSocketDeliveryFor(
            socketId,
            LOBBY_SERVER_EVENTS.ROOM_ERROR
        );

        return delivery?.payload?.code ?? null;

    }

    function countStartGameDeliveries(roomId) {

        // startGame is delivered per-socket (one per room member), so count
        // socket-targeted START_GAME deliveries addressed to this room.
        let count = 0;

        for (const delivery of deliveries) {

            if (
                delivery.target === "socket"
                && delivery.event === LOBBY_SERVER_EVENTS.START_GAME
                && delivery.payload?.roomId === roomId
            ) {

                count += 1;

            }

        }

        return count;

    }

    function createOwnedRoom(socketId, telegramUserId) {

        authenticateSocket(socketId, telegramUserId);

        requestCreateRoom(socketId);

        const delivery = lastSocketDeliveryFor(
            socketId,
            LOBBY_SERVER_EVENTS.ROOM_CREATED
        );

        return delivery?.payload ?? null;

    }

    return {
        eventBus,
        roomManager,
        playerManager,
        roomLobbyBridge,
        deliveries,
        authenticateSocket,
        requestCreateRoom,
        requestJoinRoom,
        requestLeaveRoom,
        requestSelectRoomNetwork,
        requestGameCreated,
        lastSocketDeliveryFor,
        lastRoomDeliveryFor,
        countRoomDeliveries,
        latestRoomState,
        lastSocketErrorCode,
        countStartGameDeliveries,
        createOwnedRoom
    };

}

// ===== TESTS =====

async function test1_ownerSelectorInputsAfterCreateWhileNetworkNull() {

    const harness = buildHarness();

    const created = harness.createOwnedRoom("sock-owner", "1001");

    await wait(20);

    assert(created, "Owner must receive roomCreated");
    assert(
        created.ownerPlayerId != null
        && created.ownerPlayerId === created.playerId,
        "roomCreated must carry the authoritative ownerPlayerId projection"
    );

    const roomState = harness.latestRoomState(created.roomId);

    assert(roomState, "roomState must be broadcast after CREATE_ROOM");
    assert(
        roomState.network === null,
        "roomState.network must be null before the Owner selects"
    );
    assert(
        roomState.ownerPlayerId === created.playerId,
        "roomState must carry ownerPlayerId so the selector survives hydration"
    );

    console.log("Test 1 — owner selector inputs after CREATE_ROOM (network null): passed");

}

async function test2_joinerNeverReceivesOwnerControls() {

    const harness = buildHarness();

    const created = harness.createOwnedRoom("sock-owner", "1001");

    await wait(20);

    harness.authenticateSocket("sock-joiner", "2002");

    harness.requestJoinRoom("sock-joiner", created.roomId);

    await wait(20);

    const joinerState = harness.latestRoomState(created.roomId);

    assert(
        joinerState.ownerPlayerId === created.playerId,
        "joiner's hydrated roomState must show the creator as ownerPlayerId"
    );
    assert(
        joinerState.network === null,
        "joiner's roomState network stays null until the Owner selects"
    );

    harness.requestSelectRoomNetwork("sock-joiner", "testnet");

    await wait(20);

    assert(
        harness.lastSocketErrorCode("sock-joiner")
            === LOBBY_ERROR_CODES.ROOM_NETWORK_SELECT_FORBIDDEN,
        "joiner selection must be rejected with ROOM_NETWORK_SELECT_FORBIDDEN"
    );
    assert(
        harness.countRoomDeliveries(
            created.roomId,
            LOBBY_SERVER_EVENTS.ROOM_NETWORK_SELECTED
        ) === 0,
        "joiner selection must not broadcast ROOM_NETWORK_SELECTED"
    );
    assert(
        harness.latestRoomState(created.roomId).network === null,
        "network must stay null after a rejected joiner selection"
    );

    // An unbound socket (no authoritative player binding) is rejected too.
    harness.requestSelectRoomNetwork("sock-ghost", "testnet");

    await wait(20);

    assert(
        harness.countRoomDeliveries(
            created.roomId,
            LOBBY_SERVER_EVENTS.ROOM_NETWORK_SELECTED
        ) === 0,
        "unbound socket must never trigger a network broadcast"
    );

    console.log("Test 2 — joiner never receives owner controls: passed");

}

// ===== TESTS PART 2 =====

async function test3_selectionCommitsDisappearsAndIsOneTime() {

    const harness = buildHarness();

    const created = harness.createOwnedRoom("sock-owner", "1001");

    await wait(20);

    // Malformed values are rejected WITHOUT burning the one-time selection.
    harness.requestSelectRoomNetwork("sock-owner", "fakenet");

    await wait(20);

    assert(
        harness.lastSocketErrorCode("sock-owner")
            === LOBBY_ERROR_CODES.ROOM_NETWORK_INVALID,
        "invalid network must be rejected with ROOM_NETWORK_INVALID"
    );
    assert(
        harness.latestRoomState(created.roomId).network === null,
        "invalid selection must not commit anything"
    );

    // Uppercase is normalized strictly by the server.
    harness.requestSelectRoomNetwork("sock-owner", "TESTNET");

    await wait(20);

    const selected = harness.lastRoomDeliveryFor(
        created.roomId,
        LOBBY_SERVER_EVENTS.ROOM_NETWORK_SELECTED
    );

    assert(selected, "Owner selection must broadcast ROOM_NETWORK_SELECTED");
    assert(
        selected.payload.roomId === created.roomId
        && selected.payload.network === "testnet",
        "broadcast payload must be exactly { roomId, network: 'testnet' }"
    );
    assert(
        harness.latestRoomState(created.roomId).network === "testnet",
        "roomState must expose the committed network (selector disappears)"
    );

    // One-time: a second attempt (same value) is rejected, value unchanged.
    harness.requestSelectRoomNetwork("sock-owner", "testnet");

    await wait(20);

    assert(
        harness.lastSocketErrorCode("sock-owner")
            === LOBBY_ERROR_CODES.ROOM_NETWORK_ALREADY_SELECTED,
        "second selection must be rejected with ROOM_NETWORK_ALREADY_SELECTED"
    );
    assert(
        harness.countRoomDeliveries(
            created.roomId,
            LOBBY_SERVER_EVENTS.ROOM_NETWORK_SELECTED
        ) === 1,
        "exactly one ROOM_NETWORK_SELECTED broadcast may ever be emitted"
    );
    assert(
        harness.latestRoomState(created.roomId).network === "testnet",
        "committed network must be immutable"
    );

    console.log("Test 3 — selection commits, disappears, one-time: passed");

}

// ===== TESTS PART 3 =====

async function test4_roomFullWithNullNetworkCannotStart_testnetReleases() {

    const harness = buildHarness();

    const created = harness.createOwnedRoom("sock-owner", "1001");

    await wait(20);

    harness.authenticateSocket("sock-joiner-2", "2002");
    harness.requestJoinRoom("sock-joiner-2", created.roomId);
    harness.authenticateSocket("sock-joiner-3", "3003");
    harness.requestJoinRoom("sock-joiner-3", created.roomId);

    await wait(20);

    // ROOM_FULL / game-prep reached with network still null.
    harness.requestGameCreated(created.roomId, "game-r241-e");

    await wait(20);

    assert(
        harness.countStartGameDeliveries(created.roomId) === 0,
        "ROOM_FULL with network=null must NOT emit startGame"
    );
    assert(
        harness.roomLobbyBridge._startGamePendingByRoom.get(created.roomId)
            === "game-r241-e",
        "startGame must be withheld (pending) while network is null"
    );

    // Owner commits TESTNET → the existing lifecycle continues.
    harness.requestSelectRoomNetwork("sock-owner", "testnet");

    await wait(20);

    assert(
        harness.countStartGameDeliveries(created.roomId) === 3,
        "TESTNET selection must release startGame (one per room member)"
    );
    assert(
        !harness.roomLobbyBridge._startGamePendingByRoom.has(created.roomId),
        "pending startGame entry must be released after TESTNET selection"
    );

    console.log("Test 4 — ROOM_FULL null-network gate + TESTNET release: passed");

}

// ===== TESTS PART 4 =====

async function test5_mainnetHandoffBehaviorPreserved() {

    // (a) Testnet runtime: MAINNET commits authoritatively and the room stays
    // parked — its continuation is the existing cross-runtime handoff, never
    // this runtime's payment flow. No extra room is created.
    const testnetHarness = buildHarness({ runtimeNetwork: "testnet" });

    const testnetRoom = testnetHarness.createOwnedRoom("sock-owner", "1001");

    await wait(20);

    testnetHarness.requestSelectRoomNetwork("sock-owner", "mainnet");

    await wait(20);

    assert(
        testnetHarness.latestRoomState(testnetRoom.roomId).network
            === "mainnet",
        "MAINNET selection must commit authoritatively on the testnet runtime"
    );
    assert(
        !testnetHarness.deliveries.some(
            (delivery) => delivery.event === "roomNetworkHandoffReady"
        ),
        "no handoff event exists in this slice; handoff machinery untouched"
    );

    testnetHarness.requestGameCreated(testnetRoom.roomId, "game-r241-g1");

    await wait(20);

    assert(
        testnetHarness.countStartGameDeliveries(testnetRoom.roomId) === 0,
        "MAINNET room on the testnet runtime must stay parked (no startGame)"
    );
    assert(
        !testnetHarness.roomLobbyBridge._startGamePendingByRoom.has(
            testnetRoom.roomId
        ),
        "mismatched network must not store a releasable pending startGame"
    );

    // (b) Mainnet runtime (e.g. the R23 bootstrap-created Mainnet room): the
    // normal Mainnet RoomLobby lifecycle continues after MAINNET selection.
    const mainnetHarness = buildHarness({ runtimeNetwork: "mainnet" });

    const mainnetRoom = mainnetHarness.createOwnedRoom("sock-owner", "5001");

    await wait(20);

    mainnetHarness.requestSelectRoomNetwork("sock-owner", "mainnet");

    await wait(20);

    mainnetHarness.requestGameCreated(mainnetRoom.roomId, "game-r241-g2");

    await wait(20);

    assert(
        mainnetHarness.countStartGameDeliveries(mainnetRoom.roomId) === 1,
        "MAINNET room on the mainnet runtime must continue the lifecycle"
    );

    // (c) Mainnet runtime + TESTNET selection → parked (wrong-network guard).
    const wrongHarness = buildHarness({ runtimeNetwork: "mainnet" });

    const wrongRoom = wrongHarness.createOwnedRoom("sock-owner", "6001");

    await wait(20);

    wrongHarness.requestSelectRoomNetwork("sock-owner", "testnet");

    await wait(20);

    wrongHarness.requestGameCreated(wrongRoom.roomId, "game-r241-g3");

    await wait(20);

    assert(
        wrongHarness.countStartGameDeliveries(wrongRoom.roomId) === 0,
        "TESTNET room on the mainnet runtime must never receive startGame"
    );

    console.log("Test 5 — MAINNET handoff behavior preserved: passed");

}

// ===== TESTS PART 5 =====

async function test6_destructionReleasesNetworkLifecycleState() {

    const harness = buildHarness();

    const created = harness.createOwnedRoom("sock-owner", "1001");

    await wait(20);

    harness.requestSelectRoomNetwork("sock-owner", "testnet");

    await wait(20);

    assert(
        harness.roomLobbyBridge._roomNetworkByRoom.has(created.roomId),
        "network state must exist while the room is alive"
    );

    // Owner leaves the single-player (unfilled pre-setup) room → the existing
    // empty-room destruction path must also release the network state.
    harness.requestLeaveRoom("sock-owner");

    await wait(20);

    assert(
        !harness.roomLobbyBridge._roomNetworkByRoom.has(created.roomId),
        "room destruction must release the room network state"
    );
    assert(
        !harness.roomLobbyBridge._startGamePendingByRoom.has(created.roomId),
        "room destruction must release any withheld startGame entry"
    );

    console.log("Test 6 — destruction releases network lifecycle state: passed");

}

// ===== TESTS PART 6 =====

async function test7_runtimeNetworkWiring() {

    // The bridge MUST receive the authoritative runtime rails from app.js
    // (TON_NETWORK). Without injection the default ("testnet") would park
    // MAINNET rooms forever on a mainnet deployment.
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const testsDir = dirname(fileURLToPath(import.meta.url));

    const appSource = readFileSync(join(testsDir, "..", "app.js"), "utf8");

    assert(
        appSource.includes("runtimeNetwork: this._tonConfig?.network ?? null"),
        "app.js must inject runtimeNetwork from the authoritative TON config"
    );

    console.log("Test 7 — runtimeNetwork wiring from app.js: passed");

}

async function main() {

    await test1_ownerSelectorInputsAfterCreateWhileNetworkNull();

    await test2_joinerNeverReceivesOwnerControls();

    await test3_selectionCommitsDisappearsAndIsOneTime();

    await test4_roomFullWithNullNetworkCannotStart_testnetReleases();

    await test5_mainnetHandoffBehaviorPreserved();

    await test6_destructionReleasesNetworkLifecycleState();

    await test7_runtimeNetworkWiring();

    console.log("all assertions passed");

}

main().catch((error) => {

    console.error("R24.1 network gate test FAILED:", error.message);

    process.exit(1);

});
