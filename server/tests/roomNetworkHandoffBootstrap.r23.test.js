/**
 * R23 — server-side Mainnet bootstrap consuming the R22 cross-runtime
 * handoff (built on the R21 store/routes/client and the R20/R22 lobby flow).
 *
 * Architecture under test:
 *   authenticated Telegram socket (io.use initData → socket.data)
 *     → ROOM_NETWORK_HANDOFF_BOOTSTRAP_REQUEST envelope (handoffId ONLY)
 *     → RoomLobbyBridge._handleRoomNetworkHandoffBootstrap
 *     → claim(handoffId, server-authenticated telegram id) via the REAL R21
 *       RoomNetworkHandoffClient against a REAL R21 Testnet contract
 *       (express + shared-secret routes + RoomNetworkHandoffStore)
 *     → NEW ordinary Mainnet Room via the EXISTING _handleCreateRoom path
 *     → complete(handoffId, ownerTelegramUserId, authoritative new roomId)
 *     → Owner-only { roomId, network: "mainnet" } result
 *
 * Security invariants:
 *  1. Identity comes ONLY from the authenticated socket context; forged
 *     client identity fields are ignored.
 *  2. The handoffId is never an identity proof: Player 2 / Player 3 / an
 *     unauthenticated socket can never consume the Owner's handoff.
 *  3. Client-supplied roomId / playerId / ownerPlayerId / ownerTelegramUserId
 *     / network / targetNetwork / mainnetRoomId can never control the
 *     bootstrap.
 *  4. The new Mainnet room is created ONLY through the existing
 *     authoritative CREATE_ROOM path (admission, one-active-room-per-user
 *     quota, creator mapping); no privileged "handoff room" exists and no
 *     Testnet state is copied into it.
 *  5. complete() is called with the authoritative runtime room id and only
 *     AFTER the room exists; bootstrap success is reported only after a
 *     successful completion.
 *  6. ONE handoff → AT MOST ONE Mainnet room (server-side idempotency map,
 *     verified for retries, complete-failure recovery, repeated submissions
 *     and completed-handoff recovery).
 *  7. Precise cross-runtime reasons stay in server logs; the browser sees
 *     only coarse controlled lobby error codes.
 */
import express from "express";
import { EventBus } from "../events/EventBus.js";
import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { SetupSessionLifecycle } from "../gameplay/SetupSessionLifecycle.js";
import { PlayerManager } from "../managers/PlayerManager.js";
import { RoomManager } from "../managers/RoomManager.js";
import { LoggerService } from "../services/LoggerService.js";
import { RoomNetworkHandoffStore } from "../network/RoomNetworkHandoffStore.js";
import { RoomNetworkHandoffClient } from "../network/RoomNetworkHandoffClient.js";
import { registerRoomNetworkHandoffRoutes } from "../network/registerRoomNetworkHandoffRoutes.js";
import {
    LOBBY_ERROR_CODES,
    LOBBY_SERVER_EVENTS
} from "../socket/lobbyProtocol.js";
import { RoomLobbyBridge } from "../socket/RoomLobbyBridge.js";

const SECRET = "r23-test-shared-secret-do-not-use-in-production";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

function wait(ms) {

    return new Promise((resolve) => setTimeout(resolve, ms));

}

async function waitFor(predicate, timeoutMs = 3000, stepMs = 10) {

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {

        if (predicate()) {

            return true;

        }

        await wait(stepMs);

    }

    return predicate();

}

/**
 * Spy wrapper around the REAL R21 store. Store semantics are untouched; the
 * spy records the exact identity payloads that reach claim/complete and can
 * force the completion to fail AFTER the Mainnet room was created (simulating
 * a lost/failed completion response).
 */
class SpyHandoffStore extends RoomNetworkHandoffStore {

    constructor(options = {}) {

        super(options);

        this.createCalls = [];

        this.claimCalls = [];

        this.claimResults = [];

        this.completeAttempts = [];

        this.completeCalls = [];

        this.failComplete = false;

    }

    create(input) {

        this.createCalls.push({ ...input });

        return super.create(input);

    }

    claim(input) {

        const result = super.claim(input);

        this.claimCalls.push({ ...input });

        this.claimResults.push({
            ok: result.ok,
            reason: result.reason ?? null,
            state: result.state ?? null
        });

        return result;

    }

    complete(input) {

        this.completeAttempts.push({ ...input });

        if (this.failComplete) {

            throw new Error("forced handoff complete failure (test)");

        }

        const result = super.complete(input);

        this.completeCalls.push({ ...input });

        return result;

    }

}

/**
 * Real R21 Testnet contract on an ephemeral port: shared-secret routes + the
 * spied store. The Mainnet-side client talks to it over real HTTP exactly
 * like production (R21 test conventions).
 */
async function startTestnetHandoffService({ store = null } = {}) {

    const app = express();

    app.use(express.json({ limit: "32kb" }));

    const handoffStore = store ?? new RoomNetworkHandoffStore();

    registerRoomNetworkHandoffRoutes(app, {
        handoffStore,
        logger: null,
        secret: SECRET
    });

    const server = app.listen(0, "127.0.0.1");

    await new Promise((resolve) => server.once("listening", resolve));

    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    return {
        handoffStore,
        baseUrl,
        close: () => new Promise((resolve) => server.close(resolve))
    };

}

/**
 * Mainnet-side harness (R22 test conventions): real managers + the bridge,
 * a simulated trusted socket-identity registry (the ONLY identity source the
 * bridge can ever see — mirrors the production SocketGateway io.use Telegram
 * initData authentication), delivery spying, and the REAL R21 client wired
 * to the Testnet service above.
 */
function buildMainnetHarness({ handoffBaseUrl = null, withClient = true } = {}) {

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
            setupDurationMs: 8000
        }
    });

    const playerManager = new PlayerManager({ logger, eventBus });

    const setupSessionLifecycle = new SetupSessionLifecycle({
        logger,
        eventBus,
        roomManager,
        roomConfig: { setupDurationMs: 8000 }
    });

    roomManager.initialize();

    playerManager.initialize();

    setupSessionLifecycle.initialize();

    roomManager.attachSetupSessionLifecycle(setupSessionLifecycle);

    const telegramIdentityBySocket = new Map();

    const roomLobbyBridge = new RoomLobbyBridge({
        logger,
        eventBus,
        roomManager,
        playerManager,
        setupSessionLifecycle,
        telegramIdentityResolver: (socketId) =>
            telegramIdentityBySocket.get(socketId) ?? null
    });

    roomLobbyBridge.initialize();

    if (withClient && handoffBaseUrl) {

        const handoffClient = new RoomNetworkHandoffClient({
            baseUrl: handoffBaseUrl,
            secret: SECRET
        });

        roomLobbyBridge.configureRoomNetworkHandoffClient(handoffClient);

    }

    const deliveries = [];

    eventBus.subscribe(EVENT_TYPES.LOBBY_SOCKET_DELIVERY, (envelope) => {

        deliveries.push(envelope.payload);

    });

    function authenticateSocket(socketId, telegramUserId) {

        telegramIdentityBySocket.set(socketId, telegramUserId ?? null);

    }

    function requestBootstrap(socketId, handoffId, forgedPayload = null) {

        // Mirrors the production SocketGateway envelope: ONLY socketId +
        // handoffId are forwarded. forgedPayload simulates smuggled client
        // fields injected directly into the EventBus envelope; the bridge
        // must never treat them as identity, room or ownership.
        eventBus.emit({
            source: EVENT_SOURCES.SOCKET_GATEWAY,
            type: EVENT_TYPES.LOBBY_ROOM_NETWORK_HANDOFF_BOOTSTRAP_REQUEST,
            payload: { socketId, handoffId, ...(forgedPayload ?? {}) }
        });

    }

    function socketDeliveries(socketId, event) {

        return deliveries.filter(
            (delivery) => delivery.target === "socket"
                && delivery.socketId === socketId
                && delivery.event === event
        );

    }

    function lastSocketDelivery(socketId, event) {

        const list = socketDeliveries(socketId, event);

        return list.length > 0 ? list[list.length - 1] : null;

    }

    function lastRoomError(socketId) {

        const entry = lastSocketDelivery(
            socketId,
            LOBBY_SERVER_EVENTS.ROOM_ERROR
        );

        return entry?.payload?.code ?? null;

    }

    function bootstrapResultFor(socketId) {

        return lastSocketDelivery(
            socketId,
            LOBBY_SERVER_EVENTS.ROOM_NETWORK_HANDOFF_BOOTSTRAP_RESULT
        );

    }

    function createdRoomIds() {

        const roomIds = new Set();

        for (const delivery of deliveries) {

            if (
                delivery.target === "socket"
                && delivery.event === LOBBY_SERVER_EVENTS.ROOM_CREATED
                && delivery.payload?.roomId
            ) {

                roomIds.add(delivery.payload.roomId);

            }

        }

        return roomIds;

    }

    function createAuthenticatedRoom(socketId, telegramUserId) {

        authenticateSocket(socketId, telegramUserId);

        eventBus.emit({
            source: EVENT_SOURCES.SOCKET_GATEWAY,
            type: EVENT_TYPES.LOBBY_CREATE_ROOM_REQUEST,
            payload: { socketId }
        });

        const created = lastSocketDelivery(
            socketId,
            LOBBY_SERVER_EVENTS.ROOM_CREATED
        );

        const roomId = created?.payload?.roomId ?? null;

        assert(
            roomId,
            `precondition: room must be created for ${socketId}`
        );

        return {
            roomId,
            ownerPlayerId: roomLobbyBridge._roomCreators.get(roomId)
        };

    }

    function shutdown() {

        roomLobbyBridge.shutdown();

    }

    return {
        logger,
        eventBus,
        roomManager,
        roomLobbyBridge,
        authenticateSocket,
        requestBootstrap,
        socketDeliveries,
        lastSocketDelivery,
        lastRoomError,
        bootstrapResultFor,
        createdRoomIds,
        createAuthenticatedRoom,
        shutdown
    };

}

// ---------------------------------------------------------------------------
// Test 1 — Authenticated Owner bootstrap end-to-end: claim (handoffId +
//          server-authenticated identity) → NEW ordinary Mainnet room via
//          the existing CREATE_ROOM path → complete with the authoritative
//          room id → Owner-only success payload. Forged client fields are
//          ignored everywhere.
// ---------------------------------------------------------------------------

const testnet1 = await startTestnetHandoffService({
    store: new SpyHandoffStore()
});

const store1 = testnet1.handoffStore;

const handoff1 = store1.create({
    roomId: "tn-room-1",
    ownerPlayerId: "tn-player-1",
    ownerTelegramUserId: "2001"
});

{

    const harness = buildMainnetHarness({ handoffBaseUrl: testnet1.baseUrl });

    try {

        harness.authenticateSocket("owner-a", "2001");

        harness.requestBootstrap("owner-a", handoff1.handoffId, {
            ownerTelegramUserId: "9999",
            ownerPlayerId: "FAKE-OWNER",
            roomId: "FAKE-ROOM",
            playerId: "FAKE-PLAYER",
            network: "testnet",
            mainnetRoomId: "FAKE-MAINNET-ROOM"
        });

        assert(
            await waitFor(() => harness.bootstrapResultFor("owner-a")),
            "bootstrap result must be delivered to the Owner socket"
        );

        const delivered = harness.bootstrapResultFor("owner-a");

        assert(
            Object.keys(delivered.payload).sort().join(",")
                === "network,roomId",
            "success payload must contain exactly roomId and network"
        );

        assert(
            delivered.payload.network === "mainnet",
            "success payload network must be exactly mainnet"
        );

        const mainnetRoomId = delivered.payload.roomId;

        assert(
            typeof mainnetRoomId === "string" && mainnetRoomId.length > 0
                && mainnetRoomId !== "FAKE-MAINNET-ROOM",
            "success payload must carry the authoritative runtime room id"
        );

        assert(
            store1.claimCalls.length === 1,
            "exactly one claim call must be made"
        );

        assert(
            store1.claimCalls[0].handoffId === handoff1.handoffId
                && store1.claimCalls[0].ownerTelegramUserId === "2001",
            "claim must receive handoffId + socket-authenticated identity"
        );

        assert(
            Object.keys(store1.claimCalls[0]).sort().join(",")
                === "handoffId,ownerTelegramUserId",
            "claim payload must contain exactly handoffId + ownerTelegramUserId"
        );

        assert(
            harness.roomManager.getRoom(mainnetRoomId),
            "the bootstrap-created room must be an ordinary Mainnet room"
        );

        assert(
            harness.roomLobbyBridge._roomCreators.has(mainnetRoomId),
            "the creator mapping must be registered by the existing path"
        );

        assert(
            store1.completeCalls.length === 1,
            "exactly one complete call must be made"
        );

        assert(
            store1.completeCalls[0].handoffId === handoff1.handoffId
                && store1.completeCalls[0].ownerTelegramUserId === "2001"
                && store1.completeCalls[0].mainnetRoomId === mainnetRoomId,
            "complete must receive the authoritative new mainnet roomId"
        );

        assert(
            harness.lastSocketDelivery(
                "owner-a",
                LOBBY_SERVER_EVENTS.ROOM_CREATED
            )?.payload?.roomId === mainnetRoomId,
            "the Owner must have received the normal ROOM_CREATED delivery"
        );

        assert(
            harness.roomLobbyBridge._roomNetworkHandoffRoomByHandoff
                .get(handoff1.handoffId) === mainnetRoomId,
            "the idempotency mapping must point at the created room"
        );

        console.log(
            "  test 1 (authenticated owner bootstrap end-to-end) passed"
        );

    } finally {

        harness.shutdown();

        await testnet1.close();

    }

}

// ---------------------------------------------------------------------------
// Tests 2 & 3 — Player 2 / Player 3 (different authenticated Telegram users)
//               can never consume the Owner's handoff.
// ---------------------------------------------------------------------------

const testnet2 = await startTestnetHandoffService({
    store: new SpyHandoffStore()
});

const store2 = testnet2.handoffStore;

const handoff2 = store2.create({
    roomId: "tn-room-2",
    ownerPlayerId: "tn-player-2",
    ownerTelegramUserId: "2001"
});

{

    const harness = buildMainnetHarness({ handoffBaseUrl: testnet2.baseUrl });

    try {

        for (const joiner of ["player-b", "player-c"]) {

            harness.authenticateSocket(
                joiner,
                joiner === "player-b" ? "2002" : "2003"
            );

            harness.requestBootstrap(joiner, handoff2.handoffId);

            assert(
                await waitFor(() => harness.lastRoomError(joiner) !== null),
                `bootstrap failure must be delivered to ${joiner}`
            );

            assert(
                harness.lastRoomError(joiner)
                    === LOBBY_ERROR_CODES.ROOM_NETWORK_HANDOFF_BOOTSTRAP_INVALID,
                "owner mismatch must surface as the controlled INVALID code"
            );

            assert(
                harness.bootstrapResultFor(joiner) === null,
                "no bootstrap success may be delivered"
            );

        }

        assert(
            store2.claimResults.every(
                (result) => result.ok === false
                    && result.reason === "OWNER_MISMATCH"
            ),
            "both joiners must be rejected with OWNER_MISMATCH"
        );

        assert(
            store2.completeAttempts.length === 0,
            "complete must never be called for a rejected identity"
        );

        assert(
            harness.createdRoomIds().size === 0,
            "no Mainnet room may be created for joiners"
        );

        console.log(
            "  tests 2 & 3 (player 2 / player 3 cannot consume the handoff)"
            + " passed"
        );

    } finally {

        harness.shutdown();

        await testnet2.close();

    }

}

// ---------------------------------------------------------------------------
// Test 4 — forged client Telegram identity is ignored: the claim identity
//          comes exclusively from the authenticated socket context.
// ---------------------------------------------------------------------------

const testnet4 = await startTestnetHandoffService({
    store: new SpyHandoffStore()
});

const store4 = testnet4.handoffStore;

const handoff4 = store4.create({
    roomId: "tn-room-4",
    ownerPlayerId: "tn-player-4",
    ownerTelegramUserId: "2001"
});

{

    const harness = buildMainnetHarness({ handoffBaseUrl: testnet4.baseUrl });

    try {

        // The socket is authenticated as Player 2 but claims (in the
        // envelope) to be the Owner.
        harness.authenticateSocket("attacker", "2002");

        harness.requestBootstrap("attacker", handoff4.handoffId, {
            ownerTelegramUserId: "2001",
            ownerPlayerId: "forged-owner"
        });

        assert(
            await waitFor(() => harness.lastRoomError("attacker") !== null),
            "bootstrap failure must be delivered to the attacker socket"
        );

        assert(
            harness.lastRoomError("attacker")
                === LOBBY_ERROR_CODES.ROOM_NETWORK_HANDOFF_BOOTSTRAP_INVALID,
            "forged identity must surface as the controlled INVALID code"
        );

        assert(
            store4.claimCalls.length === 1
                && store4.claimCalls[0].ownerTelegramUserId === "2002",
            "claim must use the socket identity, never the forged one"
        );

        assert(
            store4.completeAttempts.length === 0,
            "complete must never be called for a forged identity"
        );

        assert(
            harness.createdRoomIds().size === 0,
            "no Mainnet room may be created for a forged identity"
        );

        console.log(
            "  test 4 (forged client telegram identity is ignored) passed"
        );

    } finally {

        harness.shutdown();

        await testnet4.close();

    }

}

// ---------------------------------------------------------------------------
// Test 5 — client-supplied roomId / playerId / mainnetRoomId cannot control
//          the bootstrap: complete receives the authoritative runtime room.
// ---------------------------------------------------------------------------

const testnet5 = await startTestnetHandoffService({
    store: new SpyHandoffStore()
});

const store5 = testnet5.handoffStore;

const handoff5 = store5.create({
    roomId: "tn-room-5",
    ownerPlayerId: "tn-player-5",
    ownerTelegramUserId: "2001"
});

{

    const harness = buildMainnetHarness({ handoffBaseUrl: testnet5.baseUrl });

    try {

        harness.authenticateSocket("owner-e", "2001");

        harness.requestBootstrap("owner-e", handoff5.handoffId, {
            roomId: "FAKE-ROOM",
            playerId: "FAKE-PLAYER",
            mainnetRoomId: "FAKE-MAINNET-ROOM",
            network: "testnet",
            targetNetwork: "testnet"
        });

        assert(
            await waitFor(() => harness.bootstrapResultFor("owner-e")),
            "bootstrap result must be delivered to the Owner socket"
        );

        const mainnetRoomId =
            harness.bootstrapResultFor("owner-e").payload.roomId;

        assert(
            mainnetRoomId !== "FAKE-MAINNET-ROOM",
            "the client-supplied mainnetRoomId must be ignored"
        );

        assert(
            store5.completeCalls.length === 1
                && store5.completeCalls[0].mainnetRoomId === mainnetRoomId,
            "complete must receive the authoritative runtime room id"
        );

        assert(
            harness.createdRoomIds().size === 1,
            "exactly one ordinary Mainnet room must exist"
        );

        console.log(
            "  test 5 (client room fields cannot control bootstrap) passed"
        );

    } finally {

        harness.shutdown();

        await testnet5.close();

    }

}

// ---------------------------------------------------------------------------
// Test 6 — expired/nonexistent handoff: no Mainnet room, controlled failure.
// ---------------------------------------------------------------------------

const testnet6 = await startTestnetHandoffService({
    store: new SpyHandoffStore()
});

const store6 = testnet6.handoffStore;

{

    const harness = buildMainnetHarness({ handoffBaseUrl: testnet6.baseUrl });

    try {

        harness.authenticateSocket("owner-f", "2001");

        harness.requestBootstrap("owner-f", "does-not-exist-123");

        assert(
            await waitFor(() => harness.lastRoomError("owner-f") !== null),
            "controlled failure must be delivered for a nonexistent handoff"
        );

        assert(
            harness.lastRoomError("owner-f")
                === LOBBY_ERROR_CODES.ROOM_NETWORK_HANDOFF_BOOTSTRAP_INVALID,
            "nonexistent handoff must surface as the controlled INVALID code"
        );

        assert(
            store6.claimResults.length === 1
                && store6.claimResults[0].reason === "NOT_FOUND_OR_EXPIRED",
            "the claim attempt must have been rejected by the store"
        );

        assert(
            store6.completeAttempts.length === 0
                && harness.createdRoomIds().size === 0,
            "no room and no complete call may happen for a dead handoff"
        );

        console.log(
            "  test 6 (expired/nonexistent handoff rejected) passed"
        );

    } finally {

        harness.shutdown();

        await testnet6.close();

    }

}

// ---------------------------------------------------------------------------
// Test 7 — reverse owner mismatch: an authenticated Owner submitting a
//          handoff that belongs to a DIFFERENT Telegram owner is rejected.
// ---------------------------------------------------------------------------

const testnet7 = await startTestnetHandoffService({
    store: new SpyHandoffStore()
});

const store7 = testnet7.handoffStore;

const handoff7 = store7.create({
    roomId: "tn-room-7",
    ownerPlayerId: "tn-player-7",
    ownerTelegramUserId: "2999"
});

{

    const harness = buildMainnetHarness({ handoffBaseUrl: testnet7.baseUrl });

    try {

        harness.authenticateSocket("owner-g", "2001");

        harness.requestBootstrap("owner-g", handoff7.handoffId);

        assert(
            await waitFor(() => harness.lastRoomError("owner-g") !== null),
            "controlled failure must be delivered for an owner mismatch"
        );

        assert(
            harness.lastRoomError("owner-g")
                === LOBBY_ERROR_CODES.ROOM_NETWORK_HANDOFF_BOOTSTRAP_INVALID,
            "owner mismatch must surface as the controlled INVALID code"
        );

        assert(
            store7.claimResults.length === 1
                && store7.claimResults[0].reason === "OWNER_MISMATCH",
            "the claim must be rejected with OWNER_MISMATCH"
        );

        assert(
            store7.completeAttempts.length === 0
                && harness.createdRoomIds().size === 0,
            "no room and no complete call may happen for an owner mismatch"
        );

        console.log("  test 7 (reverse owner mismatch rejected) passed");

    } finally {

        harness.shutdown();

        await testnet7.close();

    }

}

// ---------------------------------------------------------------------------
// Test 8 — claim transport failure: no Mainnet room, controlled UNAVAILABLE.
// ---------------------------------------------------------------------------

{

    // Port 1 on loopback is not listening; the client must fail closed with
    // a normalized transport failure and the bridge must not create a room.
    const harness = buildMainnetHarness({
        handoffBaseUrl: "http://127.0.0.1:1"
    });

    try {

        harness.authenticateSocket("owner-h", "2001");

        harness.requestBootstrap("owner-h", "handoff-id-irrelevant");

        assert(
            await waitFor(() => harness.lastRoomError("owner-h") !== null),
            "controlled failure must be delivered on transport failure"
        );

        assert(
            harness.lastRoomError("owner-h")
                === LOBBY_ERROR_CODES.ROOM_NETWORK_HANDOFF_BOOTSTRAP_UNAVAILABLE,
            "transport failure must surface as the controlled UNAVAILABLE code"
        );

        assert(
            harness.createdRoomIds().size === 0,
            "no Mainnet room may be created when the claim cannot be verified"
        );

        console.log("  test 8 (claim transport failure) passed");

    } finally {

        harness.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Test 9 — Mainnet room creation failure: the existing CREATE_ROOM admission
//          (one active room per Telegram user) rejects the second creation;
//          complete is NOT called with a fake room.
// ---------------------------------------------------------------------------

const testnet9 = await startTestnetHandoffService({
    store: new SpyHandoffStore()
});

const store9 = testnet9.handoffStore;

const handoff9 = store9.create({
    roomId: "tn-room-9",
    ownerPlayerId: "tn-player-9",
    ownerTelegramUserId: "2001"
});

{

    const harness = buildMainnetHarness({ handoffBaseUrl: testnet9.baseUrl });

    try {

        // The owner already holds an active Mainnet room in this runtime.
        harness.createAuthenticatedRoom("owner-i-1", "2001");

        // A second socket of the SAME Telegram user tries the bootstrap.
        harness.authenticateSocket("owner-i-2", "2001");

        harness.requestBootstrap("owner-i-2", handoff9.handoffId);

        assert(
            await waitFor(() => harness.lastRoomError("owner-i-2") !== null),
            "controlled failure must be delivered on room creation failure"
        );

        assert(
            harness.lastRoomError("owner-i-2")
                === LOBBY_ERROR_CODES.ROOM_CREATION_USER_LIMIT,
            "the existing CREATE_ROOM quota error must be delivered unchanged"
        );

        assert(
            store9.claimCalls.length === 1,
            "the claim must have been made before the creation attempt"
        );

        assert(
            store9.completeAttempts.length === 0,
            "complete must NEVER be called without an authoritative room"
        );

        assert(
            harness.createdRoomIds().size === 1,
            "only the pre-existing ordinary room may exist"
        );

        assert(
            harness.roomLobbyBridge._roomNetworkHandoffRoomByHandoff.size === 0,
            "no idempotency mapping may exist without a created room"
        );

        console.log("  test 9 (room creation failure, no fake complete) passed");

    } finally {

        harness.shutdown();

        await testnet9.close();

    }

}

// ---------------------------------------------------------------------------
// Test 10 — COMPLETE failure: the created room stays authoritative, no
//           destructive rollback; retry reuses the SAME room (no duplicate)
//           and completes successfully.
// ---------------------------------------------------------------------------

const testnet10 = await startTestnetHandoffService({
    store: new SpyHandoffStore()
});

const store10 = testnet10.handoffStore;

const handoff10 = store10.create({
    roomId: "tn-room-10",
    ownerPlayerId: "tn-player-10",
    ownerTelegramUserId: "2001"
});

store10.failComplete = true;

{

    const harness = buildMainnetHarness({ handoffBaseUrl: testnet10.baseUrl });

    try {

        harness.authenticateSocket("owner-j", "2001");

        harness.requestBootstrap("owner-j", handoff10.handoffId);

        assert(
            await waitFor(() => harness.lastRoomError("owner-j") !== null),
            "controlled failure must be delivered when complete fails"
        );

        assert(
            harness.lastRoomError("owner-j")
                === LOBBY_ERROR_CODES
                    .ROOM_NETWORK_HANDOFF_BOOTSTRAP_RETRY_REQUIRED,
            "complete failure must surface as the RETRY_REQUIRED code"
        );

        const firstRoomId = harness.createdRoomIds().values().next().value;

        assert(
            firstRoomId && harness.roomManager.getRoom(firstRoomId),
            "the created Mainnet room must remain a normal authoritative room"
        );

        assert(
            store10.completeAttempts.length === 1
                && store10.completeCalls.length === 0,
            "the completion must have been attempted and failed"
        );

        assert(
            store10.completeAttempts[0].mainnetRoomId === firstRoomId,
            "the completion attempt must carry the authoritative room id"
        );

        assert(
            harness.roomLobbyBridge._roomNetworkHandoffRoomByHandoff
                .get(handoff10.handoffId) === firstRoomId,
            "the idempotency mapping must survive a failed completion"
        );

        // Retry: the mapped room must be reused, no second room created.
        store10.failComplete = false;

        harness.requestBootstrap("owner-j", handoff10.handoffId);

        assert(
            await waitFor(() => harness.bootstrapResultFor("owner-j")),
            "the retry must deliver the bootstrap success"
        );

        const retryRoomId = harness.bootstrapResultFor("owner-j").payload.roomId;

        assert(
            retryRoomId === firstRoomId,
            "the retry must resolve to the SAME Mainnet room"
        );

        assert(
            harness.createdRoomIds().size === 1,
            "no duplicate Mainnet room may be created on retry"
        );

        assert(
            store10.completeAttempts.length === 2
                && store10.completeCalls.length === 1,
            "the retry must attempt the completion again and succeed"
        );

        assert(
            harness.bootstrapResultFor("owner-j").payload.network === "mainnet",
            "the retry success must carry network mainnet"
        );

        console.log("  test 10 (complete failure + retry same room) passed");

    } finally {

        harness.shutdown();

        await testnet10.close();

    }

}

// ---------------------------------------------------------------------------
// Test 11 — repeated identical bootstrap: exactly one Mainnet room and the
//           same roomId returned (idempotent completion).
// ---------------------------------------------------------------------------

const testnet11 = await startTestnetHandoffService({
    store: new SpyHandoffStore()
});

const store11 = testnet11.handoffStore;

const handoff11 = store11.create({
    roomId: "tn-room-11",
    ownerPlayerId: "tn-player-11",
    ownerTelegramUserId: "2001"
});

{

    const harness = buildMainnetHarness({ handoffBaseUrl: testnet11.baseUrl });

    try {

        harness.authenticateSocket("owner-k", "2001");

        harness.requestBootstrap("owner-k", handoff11.handoffId);

        assert(
            await waitFor(() => harness.bootstrapResultFor("owner-k")),
            "the first bootstrap must succeed"
        );

        const firstRoomId = harness.bootstrapResultFor("owner-k").payload.roomId;

        // Duplicate submission of the SAME handoff (retry / reconnect case).
        harness.requestBootstrap("owner-k", handoff11.handoffId);

        assert(
            await waitFor(() => store11.claimCalls.length === 2),
            "the duplicate must re-verify the handoff claim"
        );

        assert(
            harness.bootstrapResultFor("owner-k").payload.roomId
                === firstRoomId,
            "the duplicate must resolve to the SAME room id"
        );

        assert(
            harness.createdRoomIds().size === 1,
            "exactly one Mainnet room must exist after the duplicate"
        );

        assert(
            store11.completeCalls.length === 2,
            "the duplicate must reach the idempotent completion"
        );

        console.log(
            "  test 11 (repeated identical bootstrap, one room) passed"
        );

    } finally {

        harness.shutdown();

        await testnet11.close();

    }

}

// ---------------------------------------------------------------------------
// Test 12 — completed-handoff recovery (restart semantics): after a runtime
//           restart the mapping is gone, but the Testnet store still holds
//           the completed record; the SAME live room is reused and no second
//           room is created.
// ---------------------------------------------------------------------------

const testnet12 = await startTestnetHandoffService({
    store: new SpyHandoffStore()
});

const store12 = testnet12.handoffStore;

const handoff12 = store12.create({
    roomId: "tn-room-12",
    ownerPlayerId: "tn-player-12",
    ownerTelegramUserId: "2001"
});

{

    const harness = buildMainnetHarness({ handoffBaseUrl: testnet12.baseUrl });

    try {

        // The Mainnet room already exists in this runtime (created before
        // the simulated restart).
        const { roomId } = harness.createAuthenticatedRoom("owner-l", "2001");

        // The completion landed on the Testnet side for that room (the
        // Testnet-side contract requires the claim first).
        const claimed = store12.claim({
            handoffId: handoff12.handoffId,
            ownerTelegramUserId: "2001"
        });

        assert(
            claimed.ok && claimed.state === "claimed",
            "precondition: the handoff must be claimable on the Testnet side"
        );

        const completed = store12.complete({
            handoffId: handoff12.handoffId,
            ownerTelegramUserId: "2001",
            mainnetRoomId: roomId
        });

        assert(
            completed.ok && completed.state === "completed",
            "precondition: the handoff must be completed on the Testnet side"
        );

        // Simulate the Mainnet restart: the runtime-local mapping is lost.
        harness.roomLobbyBridge._roomNetworkHandoffRoomByHandoff.clear();

        harness.authenticateSocket("owner-l-reconnect", "2001");

        harness.requestBootstrap("owner-l-reconnect", handoff12.handoffId);

        assert(
            await waitFor(() => harness.bootstrapResultFor("owner-l-reconnect")),
            "the completed handoff must be recovered"
        );

        const recovered =
            harness.bootstrapResultFor("owner-l-reconnect").payload;

        assert(
            recovered.roomId === roomId && recovered.network === "mainnet",
            "the recovery must resolve to the SAME live Mainnet room"
        );

        assert(
            harness.createdRoomIds().size === 1,
            "no second Mainnet room may be created for a completed handoff"
        );

        console.log(
            "  test 12 (completed handoff recovery reuses the live room) passed"
        );

    } finally {

        harness.shutdown();

        await testnet12.close();

    }

}

// ---------------------------------------------------------------------------
// Test 13 — unauthenticated socket and malformed handoffId: fail-closed
//           rejection without any cross-runtime call.
// ---------------------------------------------------------------------------

const testnet13 = await startTestnetHandoffService({
    store: new SpyHandoffStore()
});

const store13 = testnet13.handoffStore;

{

    const harness = buildMainnetHarness({ handoffBaseUrl: testnet13.baseUrl });

    try {

        // No Telegram identity on the socket (web guest).
        harness.authenticateSocket("guest", null);

        harness.requestBootstrap("guest", "some-handoff-id");

        assert(
            await waitFor(() => harness.lastRoomError("guest") !== null),
            "unauthenticated bootstrap must be rejected"
        );

        assert(
            harness.lastRoomError("guest")
                === LOBBY_ERROR_CODES.ROOM_CREATION_REQUIRES_TELEGRAM,
            "unauthenticated bootstrap must use the established Telegram code"
        );

        // Malformed handoffIds (non-string forwarded as null; oversized).
        harness.authenticateSocket("owner-m", "2001");

        harness.requestBootstrap("owner-m", null);

        harness.requestBootstrap("owner-m", "x".repeat(600));

        assert(
            await waitFor(
                () => harness.lastRoomError("owner-m")
                    === LOBBY_ERROR_CODES.ROOM_NETWORK_HANDOFF_BOOTSTRAP_INVALID
            ),
            "malformed handoffId must be rejected with the INVALID code"
        );

        assert(
            store13.claimCalls.length === 0,
            "no cross-runtime claim may happen for unauthenticated or malformed requests"
        );

        assert(
            harness.createdRoomIds().size === 0,
            "no Mainnet room may be created for unauthenticated or malformed requests"
        );

        console.log(
            "  test 13 (unauthenticated socket + malformed handoffId) passed"
        );

    } finally {

        harness.shutdown();

        await testnet13.close();

    }

}

// ---------------------------------------------------------------------------
// Test 14 — runtime without a configured handoff client: fail-closed
//           UNAVAILABLE without any network activity.
// ---------------------------------------------------------------------------

{

    const harness = buildMainnetHarness({ withClient: false });

    try {

        harness.authenticateSocket("owner-n", "2001");

        harness.requestBootstrap("owner-n", "some-handoff-id");

        assert(
            await waitFor(() => harness.lastRoomError("owner-n") !== null),
            "unconfigured runtime must reject the bootstrap"
        );

        assert(
            harness.lastRoomError("owner-n")
                === LOBBY_ERROR_CODES.ROOM_NETWORK_HANDOFF_BOOTSTRAP_UNAVAILABLE,
            "unconfigured runtime must surface the UNAVAILABLE code"
        );

        assert(
            harness.createdRoomIds().size === 0,
            "no Mainnet room may be created without a configured client"
        );

        console.log(
            "  test 14 (no configured client fails closed) passed"
        );

    } finally {

        harness.shutdown();

    }

}

console.log(
    "roomNetworkHandoffBootstrap.r23.test.js: all assertions passed"
);
