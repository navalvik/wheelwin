/**
 * R18 S4 — DEPOSIT_PACKAGE_PUBLISHED restoration on reconnect.
 *
 * Scope (per task contract): client/server transport + authoritative-session
 * integration only. The server already owns Deposit financial state; this test
 * verifies the reconnect path re-delivers the requester-scoped Deposit
 * projection to the authenticated player (via projectDepositForPlayer) and:
 *   - does NOT broadcast private financial data to the room;
 *   - does NOT regenerate StateInit or trigger any TON/deployment transaction;
 *   - fails closed when no authoritative DepositSession exists.
 *
 * No DepositContract is created or deployed. Everything is outbound-information
 * delivery only.
 */
import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { CONNECTION_STATE } from "../models/ConnectionState.js";
import { PlayerManager } from "../managers/PlayerManager.js";
import { RoomManager } from "../managers/RoomManager.js";
import { LoggerService } from "../services/LoggerService.js";
import { GameplayContextResolver } from "../socket/GameplayContextResolver.js";
import { RoomLobbyBridge } from "../socket/RoomLobbyBridge.js";
import { SetupSessionLifecycle } from "../gameplay/SetupSessionLifecycle.js";
import { LOBBY_SERVER_EVENTS } from "../socket/lobbyProtocol.js";
import { DEPOSIT_SESSION_STATUS } from "../deposit/DepositSessionStates.js";

const GAME_ID = "game-r18";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

function stubDepositSessionCoordinator(session) {

    if (!session) {

        return { getByRoomAndGame() { return null; } };

    }

    return {
        getByRoomAndGame(roomId, gameId) {

            return session.roomId === roomId && session.gameId === gameId
                ? session
                : null;

        }
    };

}

function makeDepositSession({ roomId, gameId, playerIds, state, fundedSeat = -1 }) {

    const bindings = playerIds.map((playerId, index) => ({

        playerId,
        wallet: `wallet-${index}`,
        expectedAmount: index === 0 ? 120000000000 : 90000000000,
        funded: index === fundedSeat

    }));

    return {
        depositId: "dep_r18s4",
        roomId,
        gameId,
        state: state ?? DEPOSIT_SESSION_STATUS.AWAITING_FUNDS,
        depositAddress: "EQD_TEST_DEPOSIT_ADDRESS_0000000000000000000000",
        fundingEventIds: [],
        bindings,
        metadata: {
            depositPackage: {
                network: "testnet",
                baseStake: "30",
                stateInit: {
                    codeBoc: "te6ccgECCQAj/RASTl3GZs",
                    dataBoc: "abc123data"
                }
            }
        }
    };

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

    const deliveries = [];

    eventBus.subscribe(EVENT_TYPES.LOBBY_SOCKET_DELIVERY, (envelope) => {

        deliveries.push(envelope.payload);

    });

    return {

        logger,
        eventBus,
        playerManager,
        roomManager,
        setupSessionLifecycle,
        roomLobbyBridge,
        gameplayContextResolver,
        deliveries,
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

function bindPlayer(stack, { socketId, playerId, roomId }) {

    stack.roomLobbyBridge._registerSocketPlayer(socketId, playerId);

    stack.roomLobbyBridge._attachSocketToRoom(socketId, roomId);

    stack.playerManager.setConnectionState(playerId, CONNECTION_STATE.CONNECTED);

    return stack.roomLobbyBridge.issueRecoveryCredential(playerId, roomId);

}

function registerThreePlayers(stack) {

    const room = stack.roomManager.createRoom();

    const playerIds = [];

    const credentials = [];

    for (const nickname of ["Creator", "Second", "Third"]) {

        const player = stack.playerManager.createPlayer({ nickname });

        const playerId = player.identity.playerId;

        playerIds.push(playerId);

        stack.roomManager.addPlayer(room.roomId, playerId);

        stack.playerManager.updateRuntime(playerId, {
            roomId: room.roomId,
            gameId: GAME_ID
        });

        credentials.push(bindPlayer(stack, {
            socketId: `socket-original-${credentials.length}`,
            playerId,
            roomId: room.roomId
        }));

    }

    // The first admitted player is the Room Creator (mirrors RoomLobbyBridge's
    // authoritative `_roomCreators` binding produced by the real create path).
    stack.roomLobbyBridge._roomCreators.set(room.roomId, playerIds[0]);

    return { room, playerIds, credentials };

}

function reconnectPlayer(stack, { socketId, playerId, roomId, credential }) {

    const before = stack.deliveries.length;

    const reclaimed = stack.roomLobbyBridge.reconnectGameplaySession(
        socketId,
        { playerId, roomId, recoveryCredential: credential }
    );

    const depositDeliveries = stack.deliveries
        .slice(before)
        .filter((d) => d.event === LOBBY_SERVER_EVENTS.DEPOSIT_PACKAGE_PUBLISHED);

    return { reclaimed, depositDeliveries };

}

// ─── Scenario 1 — pre-funding creator reconnect receives the requester-scoped
// package (isCreator, seat 0); nothing is broadcast to the other two sockets. ───
{
    const stack = buildStack();

    try {

        const { room, playerIds, credentials } = registerThreePlayers(stack);

        const session = makeDepositSession({
            roomId: room.roomId,
            gameId: GAME_ID,
            playerIds,
            state: DEPOSIT_SESSION_STATUS.AWAITING_FUNDS
        });

        stack.roomLobbyBridge._depositSessionCoordinator =
            stubDepositSessionCoordinator(session);

        const creatorId = playerIds[0];

        const { reclaimed, depositDeliveries } = reconnectPlayer(stack, {
            socketId: "socket-creator-new",
            playerId: creatorId,
            roomId: room.roomId,
            credential: credentials[0]
        });

        assert(reclaimed.ok, "creator reclaim must succeed");

        assert(
            depositDeliveries.length === 1,
            "exactly one DEPOSIT_PACKAGE_PUBLISHED on reconnect"
        );

        assert(
            depositDeliveries[0].socketId === "socket-creator-new",
            "projection delivered only to the reconnecting creator socket"
        );

        const projection = depositDeliveries[0].payload.deposit;

        assert(projection.mySeatIndex === 0, "creator is server-derived seat 0");

        assert(projection.isCreator === true, "creator flag is server-derived");

        assert(
            projection.myExpectedAmountNanotons === 120000000000,
            "creator sees only their own expected amount"
        );

        assert(
            typeof projection.package === "object",
            "pre-funding creator still receives the frozen package"
        );

        console.log("  reconnect: creator pre-funding projection passed");

    } finally {

        stack.shutdown();

    }

}

// ─── Scenario 2 — after observed funding the package is NOT re-exposed and no
// other player's wallet or amount leaks into the requester projection. ──────
{
    const stack = buildStack();

    try {

        const { room, playerIds, credentials } = registerThreePlayers(stack);

        // Seat 2 observed funding.
        const session = makeDepositSession({
            roomId: room.roomId,
            gameId: GAME_ID,
            playerIds,
            state: DEPOSIT_SESSION_STATUS.AWAITING_FUNDS,
            fundedSeat: 2
        });

        stack.roomLobbyBridge._depositSessionCoordinator =
            stubDepositSessionCoordinator(session);

        const seatTwoId = playerIds[1];

        const { reclaimed, depositDeliveries } = reconnectPlayer(stack, {
            socketId: "socket-p2-new",
            playerId: seatTwoId,
            roomId: room.roomId,
            credential: credentials[1]
        });

        assert(reclaimed.ok, "reclaim must succeed");

        assert(
            depositDeliveries.length === 1,
            "a single requester-scoped projection is still delivered"
        );

        const projection = depositDeliveries[0].payload.deposit;

        assert(
            Object.prototype.hasOwnProperty.call(projection, "package") === false,
            "package must not be re-exposed after observed funding"
        );

        const raw = JSON.stringify(projection);

        assert(
            raw.includes("wallet-2") === false
                && raw.includes("wallet-0") === false,
            "no other player wallet leaks into the requester projection"
        );

        assert(
            raw.includes("120000000000") === false,
            "another player's expected amount must not leak"
        );

        assert(
            raw.includes("\"stateInit\"") === false
                && raw.includes("authorizationHash") === false,
            "no StateInit / deployment authorization data is delivered"
        );

        console.log("  reconnect: funding -> no package re-expose, no leak passed");

    } finally {

        stack.shutdown();

    }

}

// ─── Scenario 3 — terminal session receives no actionable package. ──────────
{
    const stack = buildStack();

    try {

        const { room, playerIds, credentials } = registerThreePlayers(stack);

        const session = makeDepositSession({
            roomId: room.roomId,
            gameId: GAME_ID,
            playerIds,
            state: DEPOSIT_SESSION_STATUS.GAME_CONTRACT_CREATED
        });

        stack.roomLobbyBridge._depositSessionCoordinator =
            stubDepositSessionCoordinator(session);

        const seatTwoId = playerIds[1];

        const { depositDeliveries } = reconnectPlayer(stack, {
            socketId: "socket-p2-new",
            playerId: seatTwoId,
            roomId: room.roomId,
            credential: credentials[1]
        });

        assert(
            depositDeliveries.length === 1,
            "terminal session still delivers a seat projection"
        );

        assert(
            Object.prototype.hasOwnProperty.call(
                depositDeliveries[0].payload.deposit,
                "package"
            ) === false,
            "terminal session re-connect receives no actionable package"
        );

        console.log("  reconnect: terminal session delivers no actionable package passed");

    } finally {

        stack.shutdown();

    }

}

// ─── Scenario 4 — no authoritative DepositSession fails closed (no deposit
// delivery, no StateInit, no TON/deployment transaction). ──────────────────
{
    const stack = buildStack();

    try {

        const { room, playerIds, credentials } = registerThreePlayers(stack);

        // Coordinator present but knows no session for this room/game.
        stack.roomLobbyBridge._depositSessionCoordinator =
            stubDepositSessionCoordinator(null);

        const seatTwoId = playerIds[1];

        const before = stack.deliveries.length;

        const { reclaimed, depositDeliveries } = reconnectPlayer(stack, {
            socketId: "socket-p2-new",
            playerId: seatTwoId,
            roomId: room.roomId,
            credential: credentials[1]
        });

        assert(reclaimed.ok, "reclaim still succeeds");

        assert(
            depositDeliveries.length === 0,
            "no Deposit projection delivered when no authoritative session exists"
        );

        const eventsAfter = stack.deliveries
            .slice(before)
            .map((d) => d.event);

        const deploymentLike = eventsAfter.filter((event) =>
            String(event).includes("DEPLOY")
            || String(event).includes("GAME_CONTRACT")
            || String(event).includes("STATE_INIT")
            || String(event).includes("GAME_ESCROW")
        );

        assert(
            deploymentLike.length === 0,
            "reconnect must not trigger any StateInit / deployment / escrow transaction"
        );

        console.log("  reconnect: no authoritative session -> fail closed passed");

    } finally {

        stack.shutdown();

    }

}

console.log("r18S4DepositReconnect.test.js: all assertions passed");