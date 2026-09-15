/**
 * R22 — server-side creation and Owner-only delivery of the cross-runtime
 * MAINNET room handoff (built on the R21 store and the R20 selection flow).
 *
 * Security invariants:
 * 1. MAINNET selection arms the handoff BEFORE the authoritative commit
 *    (atomicity): if handoffStore.create() fails, MAINNET is NOT committed,
 *    no ROOM_NETWORK_SELECTED broadcast is emitted, no handoffId is exposed,
 *    and the existing controlled error path is used (the one-time selection
 *    is not consumed, so the Owner may retry).
 * 2. handoffStore.create() receives ONLY server-authoritative identity:
 *    roomId from the authoritative room context, ownerPlayerId from the
 *    existing _roomCreators mapping, ownerTelegramUserId from the trusted
 *    Telegram identity resolver pinned at CREATE_ROOM. Forged client fields
 *    (roomId / playerId / ownerPlayerId / telegramUserId) are ignored.
 * 3. ROOM_NETWORK_SELECTED stays a room-wide broadcast with safe lobby data
 *    only — it must NEVER carry the opaque handoffId.
 * 4. ROOM_NETWORK_HANDOFF_READY is delivered ONLY to the verified Owner's
 *    authenticated socket, never to joiners, spectators or the room, with a
 *    payload of exactly { roomId, handoffId, targetNetwork, expiresAt }.
 * 5. TESTNET selection never creates handoff material and never emits the
 *    handoff-ready event.
 * 6. R20 rules are preserved: Owner-only, one-time, strict normalization.
 * 7. Room destruction releases an outstanding handoff through the shared
 *    store's release() (no new cleanup subsystem).
 */
import { EventBus } from "../events/EventBus.js";
import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { SetupSessionLifecycle } from "../gameplay/SetupSessionLifecycle.js";
import { PlayerManager } from "../managers/PlayerManager.js";
import { RoomManager } from "../managers/RoomManager.js";
import { LoggerService } from "../services/LoggerService.js";
import { RoomNetworkHandoffStore } from "../network/RoomNetworkHandoffStore.js";
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
 * Spy wrapper around the REAL R21 RoomNetworkHandoffStore. Store semantics
 * are untouched; the spy only records calls and can force create() to fail.
 */
class SpyHandoffStore extends RoomNetworkHandoffStore {

    constructor(options = {}) {

        super(options);

        this.createCalls = [];

        this.releaseCalls = [];

        this.failCreate = false;

    }

    create(input) {

        if (this.failCreate) {

            throw new Error("forced handoff store failure (test)");

        }

        this.createCalls.push({ ...input });

        return super.create(input);

    }

    release(handoffId) {

        this.releaseCalls.push(handoffId);

        return super.release(handoffId);

    }

}

/**
 * Harness mirroring roomNetworkSelection.r20.test.js: a simulated trusted
 * socket-identity registry. The bridge only ever sees the resolver function
 * — never client payloads. The SAME shared spy store instance is injected
 * (no second store).
 */
function buildHarness({ withHandoffStore = true } = {}) {

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
            setupDurationMs: 80
        }
    });

    const playerManager = new PlayerManager({ logger, eventBus });

    const setupSessionLifecycle = new SetupSessionLifecycle({
        logger,
        eventBus,
        roomManager,
        roomConfig: { setupDurationMs: 80 }
    });

    roomManager.initialize();

    playerManager.initialize();

    setupSessionLifecycle.initialize();

    roomManager.attachSetupSessionLifecycle(setupSessionLifecycle);

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

    const handoffStore = withHandoffStore ? new SpyHandoffStore() : null;

    if (handoffStore) {

        // R22 — app-level wiring: the bridge reuses the SINGLE shared store.
        roomLobbyBridge.configureRoomNetworkHandoffStore(handoffStore);

    }

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
        // forgedPayload simulates smuggled client fields; the bridge must
        // never treat them as ownership or identity proof.
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

    function countHandoffReadyDeliveries() {

        let count = 0;

        for (const delivery of deliveries) {

            if (delivery.event === LOBBY_SERVER_EVENTS.ROOM_NETWORK_HANDOFF_READY) {

                count += 1;

            }

        }

        return count;

    }

    function lastSocketError(socketId) {

        const delivery = lastSocketDeliveryFor(
            socketId,
            LOBBY_SERVER_EVENTS.ROOM_ERROR
        );

        return delivery?.payload ?? null;

    }

    function createAuthenticatedRoom(socketId, telegramUserId) {

        authenticateSocket(socketId, telegramUserId);

        requestCreateRoom(socketId);

        const created = lastSocketDeliveryFor(
            socketId,
            LOBBY_SERVER_EVENTS.ROOM_CREATED
        );

        const roomId = created?.payload?.roomId ?? null;

        assert(Boolean(roomId), "ROOM_CREATED must carry the roomId");

        const ownerPlayerId = created?.payload?.playerId ?? null;

        assert(
            Boolean(ownerPlayerId),
            "ROOM_CREATED must carry the authoritative playerId"
        );

        assert(
            roomLobbyBridge._roomCreators.get(roomId) === ownerPlayerId,
            "authoritative creator mapping must match the creator player"
        );

        return { roomId, ownerPlayerId };

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
        roomLobbyBridge,
        handoffStore,
        requestJoinRoom,
        requestLeaveRoom,
        requestSelectRoomNetwork,
        lastSocketDeliveryFor,
        lastRoomDeliveryFor,
        countHandoffReadyDeliveries,
        lastSocketError,
        createAuthenticatedRoom,
        shutdown
    };

}

// ---------------------------------------------------------------------------
// Test 1 — Owner selects MAINNET: handoff created exactly once from
//          authoritative identity; handoff-ready delivered to Owner only.
// ---------------------------------------------------------------------------

{

    const harness = buildHarness();

    try {

        const { roomId, ownerPlayerId }
            = harness.createAuthenticatedRoom("creator-a", 2001);

        harness.requestJoinRoom("joiner-a", roomId);

        harness.requestSelectRoomNetwork("creator-a", "mainnet");

        assert(
            harness.handoffStore.createCalls.length === 1,
            "handoffStore.create() must be called exactly once"
        );

        const createArgs = harness.handoffStore.createCalls[0];

        assert(
            createArgs.roomId === roomId,
            "create() must receive the authoritative roomId"
        );

        assert(
            createArgs.ownerPlayerId === ownerPlayerId,
            "create() must receive the authoritative ownerPlayerId"
        );

        assert(
            String(createArgs.ownerTelegramUserId) === "2001",
            "create() must receive the trusted Telegram owner identity"
        );

        const selected = harness.lastRoomDeliveryFor(
            roomId,
            LOBBY_SERVER_EVENTS.ROOM_NETWORK_SELECTED
        );

        assert(
            selected?.payload?.network === "mainnet",
            "ROOM_NETWORK_SELECTED must indicate mainnet"
        );

        assert(
            !Object.prototype.hasOwnProperty.call(
                selected.payload,
                "handoffId"
            ),
            "ROOM_NETWORK_SELECTED must NEVER carry the handoffId"
        );

        assert(
            harness.countHandoffReadyDeliveries() === 1,
            "exactly one ROOM_NETWORK_HANDOFF_READY delivery must exist"
        );

        const handoffReady = harness.lastSocketDeliveryFor(
            "creator-a",
            LOBBY_SERVER_EVENTS.ROOM_NETWORK_HANDOFF_READY
        );

        assert(
            handoffReady?.target === "socket"
                && handoffReady.socketId === "creator-a",
            "handoff-ready must be a socket-targeted delivery to the Owner"
        );

        const payload = handoffReady?.payload ?? null;

        assert(
            payload
                && payload.roomId === roomId
                && typeof payload.handoffId === "string"
                && payload.handoffId.length > 0
                && payload.targetNetwork === "mainnet"
                && typeof payload.expiresAt === "number",
            "handoff-ready payload must carry the opaque continuation"
        );

        assert(
            JSON.stringify(Object.keys(payload).sort())
                === JSON.stringify(
                    ["expiresAt", "handoffId", "roomId", "targetNetwork"]
                ),
            "handoff-ready payload must contain exactly the allowed fields"
        );

        assert(
            harness.lastSocketDeliveryFor(
                "joiner-a",
                LOBBY_SERVER_EVENTS.ROOM_NETWORK_HANDOFF_READY
            ) === null,
            "joiner must never receive ROOM_NETWORK_HANDOFF_READY"
        );

        assert(
            harness.lastRoomDeliveryFor(
                roomId,
                LOBBY_SERVER_EVENTS.ROOM_NETWORK_HANDOFF_READY
            ) === null,
            "handoff-ready must never be delivered room-wide"
        );

        assert(
            harness.handoffStore.releaseCalls.length === 0,
            "no release must happen while the room is alive"
        );

        console.log("  test 1 (mainnet owner handoff armed) passed");

    } finally {

        harness.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Test 2 — Non-owner selects MAINNET: rejected per R20; no handoff created
//          and no handoff event emitted.
// ---------------------------------------------------------------------------

{

    const harness = buildHarness();

    try {

        const { roomId } = harness.createAuthenticatedRoom("creator-b", 2101);

        harness.requestJoinRoom("joiner-b", roomId);

        harness.requestSelectRoomNetwork("joiner-b", "mainnet");

        assert(
            harness.lastSocketError("joiner-b")?.code
                === LOBBY_ERROR_CODES.ROOM_NETWORK_SELECT_FORBIDDEN,
            "non-owner mainnet selection must be rejected"
        );

        assert(
            harness.handoffStore.createCalls.length === 0,
            "non-owner attempt must not create any handoff"
        );

        assert(
            harness.countHandoffReadyDeliveries() === 0,
            "non-owner attempt must not emit the handoff-ready event"
        );

        assert(
            harness.lastRoomDeliveryFor(
                roomId,
                LOBBY_SERVER_EVENTS.ROOM_NETWORK_SELECTED
            ) === null,
            "non-owner attempt must not broadcast a selection"
        );

        // The room network is still pending; the Owner can now select.
        harness.requestSelectRoomNetwork("creator-b", "mainnet");

        assert(
            harness.handoffStore.createCalls.length === 1,
            "Owner selection after the rejected attempt must arm the handoff"
        );

        console.log("  test 2 (non-owner mainnet rejected) passed");

    } finally {

        harness.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Test 3 — Owner selects TESTNET: R20 behavior preserved; no handoff
//          material created and no handoff-ready event.
// ---------------------------------------------------------------------------

{

    const harness = buildHarness();

    try {

        const { roomId } = harness.createAuthenticatedRoom("creator-c", 2201);

        harness.requestSelectRoomNetwork("creator-c", "testnet");

        assert(
            harness.lastRoomDeliveryFor(
                roomId,
                LOBBY_SERVER_EVENTS.ROOM_NETWORK_SELECTED
            )?.payload?.network === "testnet",
            "testnet selection must be committed as before"
        );

        assert(
            harness.handoffStore.createCalls.length === 0,
            "testnet selection must not create any handoff"
        );

        assert(
            harness.countHandoffReadyDeliveries() === 0,
            "testnet selection must not emit the handoff-ready event"
        );

        assert(
            harness.handoffStore.releaseCalls.length === 0,
            "testnet selection must not release any handoff"
        );

        console.log("  test 3 (testnet creates no handoff) passed");

    } finally {

        harness.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Test 4 — Forged client identity fields cannot control the handoff:
//          smuggled roomId / ownerPlayerId / telegramUserId are ignored and
//          the trusted identity rules remain enforced.
// ---------------------------------------------------------------------------

{

    const harness = buildHarness();

    try {

        const { roomId, ownerPlayerId }
            = harness.createAuthenticatedRoom("creator-d", 2301);

        // The real SocketGateway envelope never carries these fields; forging
        // them simulates a tampered payload. The bridge must ignore them all.
        harness.requestSelectRoomNetwork("creator-d", "mainnet", {
            roomId: "forged-room-id",
            playerId: "forged-player",
            ownerPlayerId: "forged-owner",
            telegramUserId: 999999
        });

        assert(
            harness.handoffStore.createCalls.length === 1,
            "forged fields must not prevent the legit Owner selection"
        );

        const createArgs = harness.handoffStore.createCalls[0];

        assert(
            createArgs.roomId === roomId
                && createArgs.ownerPlayerId === ownerPlayerId
                && String(createArgs.ownerTelegramUserId) === "2301",
            "create() must use only server-authoritative identity values"
        );

        // The handoff must be delivered to the REAL Owner socket (bound via
        // the authoritative socket→player mapping), never derived from the
        // forged payload.
        assert(
            harness.lastSocketDeliveryFor(
                "creator-d",
                LOBBY_SERVER_EVENTS.ROOM_NETWORK_HANDOFF_READY
            ) !== null,
            "handoff-ready must reach the real Owner socket"
        );

        console.log("  test 4 (forged identity ignored) passed");

    } finally {

        harness.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Test 5 — Handoff creation failure: MAINNET is not committed, no success
//          broadcast, no handoff event, controlled error only; the one-time
//          selection is not consumed so the Owner may retry.
// ---------------------------------------------------------------------------

{

    const harness = buildHarness();

    try {

        const { roomId } = harness.createAuthenticatedRoom("creator-e", 2401);

        harness.handoffStore.failCreate = true;

        harness.requestSelectRoomNetwork("creator-e", "mainnet");

        assert(
            harness.lastSocketError("creator-e")?.code
                === LOBBY_ERROR_CODES.UNKNOWN_ERROR,
            "handoff failure must surface the controlled UNKNOWN_ERROR path"
        );

        assert(
            !harness.roomLobbyBridge._roomNetworkByRoom.has(roomId),
            "failed handoff creation must NOT commit the mainnet selection"
        );

        assert(
            harness.lastRoomDeliveryFor(
                roomId,
                LOBBY_SERVER_EVENTS.ROOM_NETWORK_SELECTED
            ) === null,
            "failed handoff creation must not broadcast success"
        );

        assert(
            harness.countHandoffReadyDeliveries() === 0,
            "failed handoff creation must not emit the handoff-ready event"
        );

        assert(
            harness.handoffStore.createCalls.length === 0,
            "failed create() must not leave a recorded successful call"
        );

        // Retry (the same owner, store now healthy) must succeed — proving
        // the one-time selection was not consumed by the failed attempt.
        harness.handoffStore.failCreate = false;

        harness.requestSelectRoomNetwork("creator-e", "mainnet");

        assert(
            harness.handoffStore.createCalls.length === 1,
            "retry after store failure must create the handoff exactly once"
        );

        assert(
            harness.lastRoomDeliveryFor(
                roomId,
                LOBBY_SERVER_EVENTS.ROOM_NETWORK_SELECTED
            )?.payload?.network === "mainnet",
            "retry must commit mainnet on the success path"
        );

        console.log("  test 5 (creation failure is atomic) passed");

    } finally {

        harness.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Test 6 — One-time selection / replay: after a committed MAINNET selection,
//          any second selection is rejected and never re-creates a handoff.
// ---------------------------------------------------------------------------

{

    const harness = buildHarness();

    try {

        const { roomId } = harness.createAuthenticatedRoom("creator-f", 2501);

        harness.requestSelectRoomNetwork("creator-f", "mainnet");

        assert(
            harness.handoffStore.createCalls.length === 1,
            "first mainnet selection arms the handoff exactly once"
        );

        harness.requestSelectRoomNetwork("creator-f", "mainnet");

        harness.requestSelectRoomNetwork("creator-f", "testnet");

        assert(
            harness.lastSocketError("creator-f")?.code
                === LOBBY_ERROR_CODES.ROOM_NETWORK_ALREADY_SELECTED,
            "replayed selection must be rejected per R20"
        );

        assert(
            harness.handoffStore.createCalls.length === 1,
            "replayed selection must not create a second handoff"
        );

        assert(
            harness.countHandoffReadyDeliveries() === 1,
            "replayed selection must not re-emit the handoff-ready event"
        );

        assert(
            harness.lastRoomDeliveryFor(
                roomId,
                LOBBY_SERVER_EVENTS.ROOM_NETWORK_SELECTED
            )?.payload?.network === "mainnet",
            "committed network must remain mainnet"
        );

        console.log("  test 6 (replay rejected, handoff not duplicated) passed");

    } finally {

        harness.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Test 7 — Room destruction releases the outstanding handoff through the
//          shared store (existing creator-leave path; no new subsystem).
// ---------------------------------------------------------------------------

{

    const harness = buildHarness();

    try {

        const { roomId } = harness.createAuthenticatedRoom("creator-g", 2601);

        harness.requestSelectRoomNetwork("creator-g", "mainnet");

        const handoffId = harness.lastSocketDeliveryFor(
            "creator-g",
            LOBBY_SERVER_EVENTS.ROOM_NETWORK_HANDOFF_READY
        )?.payload?.handoffId;

        assert(
            typeof handoffId === "string" && handoffId.length > 0,
            "precondition: Owner must hold a live handoffId"
        );

        assert(
            harness.roomLobbyBridge._roomNetworkHandoffIdByRoom.get(roomId)
                === handoffId,
            "precondition: bridge tracks the outstanding handoff for cleanup"
        );

        harness.requestLeaveRoom("creator-g");

        // _closeRoom is async; give the existing destruction path a moment.
        await wait(50);

        assert(
            !harness.roomManager.getRoom(roomId),
            "room must be destroyed by the existing creator-leave path"
        );

        assert(
            !harness.roomLobbyBridge._roomNetworkHandoffIdByRoom.has(roomId),
            "roomId → handoffId mapping must be dropped with the room"
        );

        assert(
            harness.handoffStore.releaseCalls.includes(handoffId),
            "room destruction must release the outstanding handoff"
        );

        // Prove the record is really gone from the shared store: a claim by
        // the legitimate owner identity must no longer find it.
        const claim = harness.handoffStore.claim({
            handoffId,
            ownerTelegramUserId: "2601"
        });

        assert(
            claim.ok === false
                && claim.reason === "NOT_FOUND_OR_EXPIRED",
            "released handoff must not be claimable by anyone"
        );

        console.log("  test 7 (cleanup releases outstanding handoff) passed");

    } finally {

        harness.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Test 8 — Runtime without an injected store keeps R20 legacy behavior:
//          MAINNET commits and broadcasts without arming any handoff.
//          (Production WheelWinServer always wires the shared store; this
//          documents the partial-harness fallback path explicitly.)
// ---------------------------------------------------------------------------

{

    const harness = buildHarness({ withHandoffStore: false });

    try {

        const { roomId } = harness.createAuthenticatedRoom("creator-h", 2701);

        harness.requestSelectRoomNetwork("creator-h", "mainnet");

        assert(
            harness.lastRoomDeliveryFor(
                roomId,
                LOBBY_SERVER_EVENTS.ROOM_NETWORK_SELECTED
            )?.payload?.network === "mainnet",
            "legacy runtime must still commit the mainnet selection"
        );

        assert(
            harness.countHandoffReadyDeliveries() === 0,
            "legacy runtime must not emit any handoff-ready event"
        );

        console.log("  test 8 (no-store legacy behavior preserved) passed");

    } finally {

        harness.shutdown();

    }

}

console.log(
    "roomNetworkHandoffCreation.r22.test.js: all assertions passed"
);






