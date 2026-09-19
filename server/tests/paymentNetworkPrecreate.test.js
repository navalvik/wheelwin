/**
 * Pre-create payment network (task 2026-09-17).
 *
 * Replaces the retired R24.1 room-network gate tests. Covers:
 * 1. Authenticated CREATE_ROOM carries paymentNetwork; the server commits
 *    the authoritative value ("testnet" | "mainnet") and ROOM_CREATED /
 *    ROOM_STATE expose it. RoomManager/runtime network is NOT changed.
 * 2. Invalid paymentNetwork values are safely normalized to "testnet";
 *    forged identity/roomId/ownerPlayerId claims are ignored.
 * 3. START_GAME is NOT gated by the payment selection.
 * 4. PAYMENT_CONNECTION_READY EventBus payload carries the authoritative
 *    paymentNetwork for the payment orchestration.
 * 5. Unauthenticated CREATE_ROOM stays rejected.
 * 6. Room destruction clears the payment-network state (no stale leak).
 * 7. Source contracts for the propagation pipeline; retired R24.1 gate
 *    symbols must be gone.
 * 8. DepositOrchestrator financials use the per-room payment network.
 * 9. GameContractManager snapshot network follows the room payment network.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventBus } from "../events/EventBus.js";
import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { SetupSessionLifecycle } from "../gameplay/SetupSessionLifecycle.js";
import { PlayerManager } from "../managers/PlayerManager.js";
import { RoomManager } from "../managers/RoomManager.js";
import { LoggerService } from "../services/LoggerService.js";
import { LOBBY_SERVER_EVENTS } from "../socket/lobbyProtocol.js";
import { RoomLobbyBridge } from "../socket/RoomLobbyBridge.js";
import { DepositOrchestrator } from "../deposit/DepositOrchestrator.js";
import { GameContractManager } from "../gameplay/GameContractManager.js";
import { PaymentSession } from "../models/PaymentSession.js";
import { SettlementSession } from "../payment/SettlementSession.js";
import { RoomWalletRegistry } from "../payment/roomWallet/RoomWalletRegistry.js";
import { resolveIntendedRoomWalletAddress } from "../payment/roomWallet/RoomWalletIncomingObserver.js";
import { RoomWalletAdapter } from "../payment/roomWallet/RoomWalletAdapter.js";
import {
    assertAuthorizationReadyForDeploy,
    resolveAuthorizationNetwork
} from "../deposit/deploymentAuthorizationValidation.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

function wait(ms) {

    return new Promise((resolve) => setTimeout(resolve, ms));

}

// ===== HARNESS =====

function buildHarness() {

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
            setupDurationMs: 60000
        }
    });

    const playerManager = new PlayerManager({ logger, eventBus });

    const setupSessionLifecycle = new SetupSessionLifecycle({
        logger,
        eventBus,
        roomManager,
        roomConfig: { setupDurationMs: 60000 }
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

    // ===== HARNESS HELPERS =====

    function authenticateSocket(socketId, telegramUserId) {

        telegramIdentityBySocket.set(socketId, telegramUserId ?? null);

    }

    // Mirrors SocketGateway's real envelope shape: socketId + paymentNetwork
    // ONLY (forged identity/roomId/owner claims are never delivered).
    function requestCreateRoom(socketId, paymentNetwork, forged = {}) {

        eventBus.emit({
            source: EVENT_SOURCES.SOCKET_GATEWAY,
            type: EVENT_TYPES.LOBBY_CREATE_ROOM_REQUEST,
            payload: {
                socketId,
                paymentNetwork: paymentNetwork ?? null,
                ...forged
            }
        });

    }

    function requestLeaveRoom(socketId) {

        eventBus.emit({
            source: EVENT_SOURCES.SOCKET_GATEWAY,
            type: EVENT_TYPES.LOBBY_LEAVE_ROOM_REQUEST,
            payload: { socketId }
        });

    }

    function requestGameCreated(roomId, gameId) {

        // Simulates the existing GameManager → GAME_CREATED room-full /
        // game-prep transition (the point where START_GAME is delivered).
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

        // startGame is delivered per-socket (one per room member).
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

    function createOwnedRoom(socketId, telegramUserId, paymentNetwork) {

        authenticateSocket(socketId, telegramUserId);

        requestCreateRoom(socketId, paymentNetwork);

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
        requestLeaveRoom,
        requestGameCreated,
        lastSocketDeliveryFor,
        lastRoomDeliveryFor,
        latestRoomState,
        lastSocketErrorCode,
        countStartGameDeliveries,
        createOwnedRoom
    };

}

// ===== TESTS =====

// Test 1 — authenticated CREATE_ROOM commits and exposes paymentNetwork.
async function test1_createRoomCarriesAndStoresPaymentNetwork() {

    const harness = buildHarness();

    // (a) Mainnet selection.
    const mainnetCreated = harness.createOwnedRoom(
        "sock-owner",
        "1001",
        "mainnet"
    );

    await wait(20);

    assert(mainnetCreated, "Owner must receive roomCreated");
    assert(
        mainnetCreated.paymentNetwork === "mainnet",
        "roomCreated must carry paymentNetwork=mainnet"
    );
    assert(
        harness.roomLobbyBridge._paymentNetworkByRoom.get(mainnetCreated.roomId)
            === "mainnet",
        "server must store the authoritative paymentNetwork=mainnet"
    );

    const mainnetState = harness.latestRoomState(mainnetCreated.roomId);

    assert(
        mainnetState?.paymentNetwork === "mainnet",
        "ROOM_STATE must expose paymentNetwork=mainnet for hydration"
    );

    // (b) Default (no selection) → testnet.
    const testnetCreated = harness.createOwnedRoom(
        "sock-owner-2",
        "1002",
        null
    );

    await wait(20);

    assert(
        testnetCreated?.paymentNetwork === "testnet",
        "absent paymentNetwork must default to testnet"
    );
    assert(
        harness.roomLobbyBridge._paymentNetworkByRoom.get(
            testnetCreated.roomId
        ) === "testnet",
        "server must store the default paymentNetwork=testnet"
    );

    // (c) Room creation itself remains a NORMAL room: no runtime network
    // concept on the Room model, RoomManager untouched.
    const room = harness.roomManager.getRoom(mainnetCreated.roomId);

    assert(room, "room must exist in RoomManager");
    assert(
        room.network === undefined,
        "RoomManager runtime network must NOT be introduced"
    );

    console.log(
        "Test 1 — CREATE_ROOM carries and stores paymentNetwork: passed"
    );

}

// Test 2 — invalid values normalize safely; forged claims are ignored.
async function test2_invalidValuesDefaultForgedClaimsIgnored() {

    const harness = buildHarness();

    const created = harness.createOwnedRoom(
        "sock-owner",
        "2001",
        "MAINNET-ULTIMATE; DROP TABLE rooms",
        {
            ownerPlayerId: "forged-player",
            telegramUserId: "999999",
            roomId: "forged-room",
            playerId: "forged-player"
        }
    );

    await wait(20);

    assert(created, "room must still be created");
    assert(
        created.paymentNetwork === "testnet",
        "invalid paymentNetwork must safely normalize to testnet"
    );
    assert(
        harness.roomLobbyBridge._paymentNetworkByRoom.get(created.roomId)
            === "testnet",
        "committed value for invalid input must be testnet"
    );
    assert(
        created.roomId !== "forged-room",
        "server-owned roomId must never come from the client"
    );
    assert(
        created.playerId !== "forged-player"
            && created.ownerPlayerId === created.playerId,
        "server-owned player identity must never come from the client"
    );
    assert(
        harness.roomLobbyBridge._paymentNetworkByRoom.get("forged-room")
            === undefined,
        "no paymentNetwork state may exist for a forged roomId"
    );

    console.log(
        "Test 2 — invalid paymentNetwork defaults, forged claims ignored: passed"
    );

}

// Test 3 — START_GAME is NOT gated by the payment selection.
async function test3_startGameNotGatedByPaymentNetwork() {

    for (const paymentNetwork of ["mainnet", "testnet", null]) {

        const harness = buildHarness();

        const created = harness.createOwnedRoom(
            "sock-owner",
            "3001",
            paymentNetwork
        );

        await wait(20);

        harness.requestGameCreated(created.roomId, "game-precreate-1");

        await wait(20);

        assert(
            harness.countStartGameDeliveries(created.roomId) === 1,
            `startGame must be delivered for paymentNetwork=${paymentNetwork}`
        );

    }

    console.log(
        "Test 3 — MAINNET selection does not block START_GAME: passed"
    );

}



// Test 4 � PAYMENT_CONNECTION_READY carries the authoritative network.
async function test4_paymentConnectionReadyCarriesPaymentNetwork() {

    const harness = buildHarness();

    let readyPayload = null;

    harness.eventBus.subscribe(
        EVENT_TYPES.PAYMENT_CONNECTION_READY,
        (envelope) => {

            readyPayload = envelope.payload;

        }
    );

    const created = harness.createOwnedRoom(
        "sock-owner",
        "4001",
        "mainnet"
    );

    await wait(20);

    harness.roomLobbyBridge._deliverPaymentConnectionReady(created.roomId);

    await wait(20);

    assert(readyPayload, "PAYMENT_CONNECTION_READY must be emitted");
    assert(
        readyPayload.roomId === created.roomId,
        "PAYMENT_CONNECTION_READY must carry the roomId"
    );
    assert(
        readyPayload.paymentNetwork === "mainnet",
        "PAYMENT_CONNECTION_READY must carry the authoritative paymentNetwork"
    );
    assert(
        typeof readyPayload.timestamp === "number",
        "PAYMENT_CONNECTION_READY must carry a timestamp"
    );

    console.log(
        "Test 4 � PAYMENT_CONNECTION_READY carries paymentNetwork: passed"
    );

}

// Test 5 � unauthenticated CREATE_ROOM remains rejected.
async function test5_unauthenticatedCreateRoomRejected() {

    const harness = buildHarness();

    harness.requestCreateRoom("sock-anon", "mainnet");

    await wait(20);

    const created = harness.lastSocketDeliveryFor(
        "sock-anon",
        LOBBY_SERVER_EVENTS.ROOM_CREATED
    );

    assert(
        created === null,
        "unauthenticated CREATE_ROOM must never create a room"
    );
    assert(
        harness.lastSocketErrorCode("sock-anon")
            === "ROOM_CREATION_REQUIRES_TELEGRAM",
        "unauthenticated CREATE_ROOM must be rejected with the Telegram gate"
    );

    console.log("Test 5 � unauthenticated CREATE_ROOM rejected: passed");

}

// Test 6 � destruction clears the payment-network state.
async function test6_destructionClearsPaymentNetworkState() {

    const harness = buildHarness();

    const created = harness.createOwnedRoom(
        "sock-owner",
        "6001",
        "mainnet"
    );

    await wait(20);

    assert(
        harness.roomLobbyBridge._paymentNetworkByRoom.has(created.roomId),
        "payment network state must exist while the room is alive"
    );

    // Owner leaves the single-player (unfilled pre-setup) room > the existing
    // empty-room destruction path must also release the payment state.
    harness.requestLeaveRoom("sock-owner");

    await wait(20);

    assert(
        !harness.roomLobbyBridge._paymentNetworkByRoom.has(created.roomId),
        "room destruction must clear the payment-network state"
    );

    const reused = harness.createOwnedRoom(
        "sock-owner",
        "6001",
        "mainnet"
    );

    await wait(20);

    assert(
        reused?.paymentNetwork === "mainnet",
        "a fresh room must get its own payment-network selection"
    );

    harness.roomLobbyBridge.shutdown();

    assert(
        harness.roomLobbyBridge._paymentNetworkByRoom.size === 0,
        "shutdown must clear all payment-network state"
    );

    console.log(
        "Test 6 � destruction clears payment-network state: passed"
    );

}

// Test 7 — source contracts for the payment-network propagation pipeline.
async function test7_sourceContracts() {

    const testsDir = dirname(fileURLToPath(import.meta.url));

    const read = (relativePath) =>
        readFileSync(join(testsDir, "..", relativePath), "utf8");

    const socketGateway = read("socket/SocketGateway.js");

    assert(
        socketGateway.includes(
            "paymentNetwork: payload?.paymentNetwork ?? null"
        ),
        "SocketGateway must forward ONLY the requested paymentNetwork"
    );
    assert(
        !socketGateway.includes("LOBBY_CLIENT_EVENTS.SELECT_ROOM_NETWORK"),
        "SocketGateway must no longer bind selectRoomNetwork"
    );

    const paymentSessionManager = read("gameplay/PaymentSessionManager.js");

    assert(
        paymentSessionManager.includes(
            "network: payload?.paymentNetwork ?? null"
        ),
        "PaymentSessionManager must pass the authoritative paymentNetwork "
            + "into session creation"
    );

    const depositOrchestrator = read("deposit/DepositOrchestrator.js");

    assert(
        depositOrchestrator.includes("setPaymentNetworkResolver"),
        "DepositOrchestrator must accept the authoritative payment network "
            + "resolver"
    );
    assert(
        depositOrchestrator.includes("this._resolveFinancials(roomId)"),
        "DepositOrchestrator must resolve financials per room"
    );

    const gameContractManager = read("gameplay/GameContractManager.js");

    assert(
        gameContractManager.includes("setPaymentNetworkResolver")
            && gameContractManager.includes("_resolveContractNetwork(roomId)"),
        "GameContractManager must build the contract snapshot from the "
            + "authoritative payment network"
    );

    const appSource = read("app.js");

    assert(
        appSource.includes(
            "this._depositOrchestrator?.setPaymentNetworkResolver?.("
        )
            && appSource.includes(
                "this._gameContractManager?.setPaymentNetworkResolver?.("
            ),
        "app.js must wire the RoomLobbyBridge payment network into the "
            + "payment orchestration"
    );
    assert(
        !appSource.includes("runtimeNetwork: this._tonConfig?.network ?? null"),
        "app.js must no longer inject the retired R24.1 runtimeNetwork gate"
    );

    const roomLobbyBridgeSource = read("socket/RoomLobbyBridge.js");

    assert(
        !roomLobbyBridgeSource.includes("_shouldReleaseStartGame")
            && !roomLobbyBridgeSource.includes("_startGamePendingByRoom")
            && !roomLobbyBridgeSource.includes("_roomNetworkByRoom")
            && !roomLobbyBridgeSource.includes("ROOM_NETWORK_SELECTED")
            && !roomLobbyBridgeSource.includes("_handleSelectRoomNetwork"),
        "RoomLobbyBridge must not retain the retired R24.1 gate machinery"
    );

    const lobbyProtocol = read("socket/lobbyProtocol.js");

    assert(
        !lobbyProtocol.includes("selectRoomNetwork")
            && !lobbyProtocol.includes("roomNetworkSelected"),
        "lobbyProtocol must no longer carry the retired selectRoomNetwork "
            + "protocol"
    );

    const eventTypes = read("events/EventTypes.js");

    assert(
        !eventTypes.includes("LOBBY_SELECT_ROOM_NETWORK_REQUEST"),
        "EventTypes must no longer carry the retired select-room-network "
            + "request"
    );

    console.log("Test 7 — source contracts: passed");

}

// __CHUNK5__
// Test 8 — DepositOrchestrator financials follow the room payment network.
function test8_depositOrchestratorFinancialsFollowRoomNetwork() {

    const env = {
        TON_DEPOSIT_CREATION_FEE_PER_SEAT_NANO: "10000000",
        TON_DEPOSIT_TIMEOUT_MS: "120000",
        TON_DEPOSIT_STAKE_NANOTON_BY_PROFILE: JSON.stringify({
            "1:1": "10000000",
            "1:2": "10000000",
            "2:1": "20000000",
            "2:2": "20000000"
        }),
        TON_NETWORK: "testnet"
    };

    const orchestrator = new DepositOrchestrator({ env });

    // Runtime env network (unchanged historical behavior) when no resolver.
    const runtimeFinancials = orchestrator._resolveFinancials("room-1");

    assert(
        runtimeFinancials.network === "testnet",
        "without a resolver the runtime env network must be used"
    );

    // Testnet room keeps the existing Testnet payment rails.
    orchestrator.setPaymentNetworkResolver(() => "testnet");

    assert(
        orchestrator._resolveFinancials("room-1").network === "testnet",
        "testnet selection must keep the existing Testnet payment rails"
    );

    // Mainnet room uses the existing Mainnet financial profile infrastructure.
    orchestrator.setPaymentNetworkResolver((roomId) =>
        roomId === "room-mainnet" ? "mainnet" : "testnet");

    assert(
        orchestrator._resolveFinancials("room-mainnet").network === "mainnet",
        "mainnet selection must use the existing Mainnet financial profile"
    );
    assert(
        orchestrator._resolveFinancials("room-testnet").network === "testnet",
        "other rooms must keep their own testnet rails (per-room routing)"
    );

    console.log(
        "Test 8 — DepositOrchestrator financials follow the room payment "
            + "network: passed"
    );

}


// Test 10 — GameContract oracle follows the authoritative payment network.
function test10_gameContractOracleFollowsRoomNetwork() {

    const manager = new GameContractManager({
        tonNetwork: "testnet",
        deployAdapter: {
            _tonConfig: {
                network: "testnet",
                oracleAddress: "EQTESTNET_RUNTIME_ORACLE"
            }
        }
    });

    const profiles = {
        testnet: { oracleWallet: "EQTESTNET_PROFILE_ORACLE" },
        mainnet: { oracleWallet: "EQMAINNET_PROFILE_ORACLE" }
    };

    assert.equal(
        manager._resolveContractOracleWallet("testnet", {
            network: "testnet",
            oracleAddress: "EQTESTNET_RUNTIME_ORACLE",
            profiles
        }),
        "EQTESTNET_PROFILE_ORACLE",
        "Testnet snapshot must use the Testnet profile oracle"
    );

    assert.equal(
        manager._resolveContractOracleWallet("mainnet", {
            network: "testnet",
            oracleAddress: "EQTESTNET_RUNTIME_ORACLE",
            profiles
        }),
        "EQMAINNET_PROFILE_ORACLE",
        "Mainnet snapshot must use the Mainnet profile oracle, not runtime Testnet"
    );

    assert.equal(
        manager._resolveContractOracleWallet("mainnet", {
            network: "testnet",
            oracleAddress: "EQTESTNET_RUNTIME_ORACLE"
        }),
        null,
        "Mainnet must not fall back to the runtime Testnet oracle"
    );

    console.log(
        "Test 10 — GameContract oracle follows room payment network: passed"
    );

}

// Test 9 — GameContractManager snapshot network follows the room network.
function test9_gameContractNetworkFollowsRoomPaymentNetwork() {

    const logger = new LoggerService({ logLevel: "error" });

    logger.initialize();

    const manager = new GameContractManager({
        logger,
        deployAdapter: {},
        tonNetwork: "testnet"
    });

    // Without a resolver → runtime network (unchanged legacy behavior).
    assert(
        manager._resolveContractNetwork("room-1") === "testnet",
        "without a resolver the runtime TON network must be used"
    );

    manager.setPaymentNetworkResolver(
        (roomId) => (roomId === "room-mainnet" ? "mainnet" : "testnet")
    );

    assert(
        manager._resolveContractNetwork("room-mainnet") === "mainnet",
        "a Mainnet payment room must produce a Mainnet contract snapshot "
            + "network even on a Testnet runtime"
    );
    assert(
        manager._resolveContractNetwork("room-testnet") === "testnet",
        "a Testnet payment room must keep the Testnet contract network"
    );

    console.log(
        "Test 9 — GameContract snapshot network follows the room payment "
            + "network: passed"
    );

}

// Test 11 — GameContract restart recovery preserves Mainnet from the immutable snapshot.
function test11_gameContractRestartPreservesSnapshotNetwork() {

    const manager = new GameContractManager({
        tonNetwork: "testnet",
        deployAdapter: {
            _tonConfig: {
                network: "testnet",
                oracleAddress: "EQTESTNET_RUNTIME_ORACLE"
            }
        }
    });

    const restored = manager._hydrateFromPersistenceRecord({
        recordId: "contract-mainnet-recovered",
        roomId: "room-mainnet",
        gameId: "game-mainnet",
        status: "AWAITING_PLAYER_PAYMENTS",
        tonNetwork: null,
        payload: {
            contractId: "contract-mainnet-recovered",
            roomId: "room-mainnet",
            gameId: "game-mainnet",
            status: "AWAITING_PLAYER_PAYMENTS",
            snapshot: {
                network: "mainnet",
                oracleWallet: "EQMAINNET_PROFILE_ORACLE",
                escrowMode: "game"
            }
        }
    });

    assert.equal(
        restored.tonNetwork,
        "mainnet",
        "restart recovery must use snapshot.network when top-level tonNetwork is absent"
    );
    assert.equal(
        restored.snapshot.network,
        "mainnet",
        "recovered snapshot must remain Mainnet"
    );
    assert.equal(
        restored.snapshot.oracleWallet,
        "EQMAINNET_PROFILE_ORACLE",
        "recovered snapshot must preserve Mainnet oracle"
    );
    assert.equal(
        restored.snapshot.escrowMode,
        "game",
        "recovered snapshot must preserve GameEscrow mode"
    );

    console.log(
        "Test 11 — GameContract restart preserves snapshot network: passed"
    );

}

// Test 12 — settlement handoff persists an explicit network routing hint.
function test12_settlementHandoffCarriesPaymentNetwork() {

    const settlementSource = readFileSync(
        join(
            dirname(fileURLToPath(import.meta.url)),
            "..",
            "payment/ContractSettlementManager.js"
        ),
        "utf8"
    );

    assert(
        settlementSource.includes("paymentNetwork: session.request?.paymentNetwork"),
        "settlement handoff must persist paymentNetwork"
    );
    assert(
        settlementSource.includes("contract.snapshot?.network"),
        "settlement handoff must derive network from the authoritative snapshot"
    );
    assert(
        settlementSource.includes("contract.tonNetwork"),
        "settlement handoff must retain the contract network fallback"
    );

    console.log(
        "Test 12 — settlement handoff carries paymentNetwork: passed"
    );

}

// Test 16 — PaymentSession restart recovery preserves Mainnet network.
function test16_paymentSessionRestartPreservesNetwork() {

    const restored = PaymentSession.fromRecord({
        recordId: "pay-mainnet-recovered",
        tonNetwork: "mainnet",
        payload: {
            paymentSessionId: "pay-mainnet-recovered",
            roomId: "room-mainnet",
            gameId: "game-mainnet",
            network: "mainnet",
            status: "WAITING_FOR_PAYMENTS",
            participants: []
        }
    });

    assert.equal(
        restored.network,
        "mainnet",
        "PaymentSession restore must preserve the persisted Mainnet network"
    );

    const legacyRecord = PaymentSession.fromRecord({
        recordId: "pay-mainnet-legacy",
        tonNetwork: "mainnet",
        payload: {
            paymentSessionId: "pay-mainnet-legacy",
            roomId: "room-mainnet",
            gameId: "game-mainnet",
            status: "WAITING_FOR_PAYMENTS",
            participants: []
        }
    });

    assert.equal(
        legacyRecord.network,
        "mainnet",
        "legacy PaymentSession records must recover network from tonNetwork"
    );

    console.log(
        "Test 16 — PaymentSession restart preserves network: passed"
    );

}

// Test 17 — SettlementSession restart recovery preserves network from all durable sources.
function test17_settlementSessionRestartPreservesNetwork() {

    const fromPayload = SettlementSession.fromRecord({
        payload: {
            settlementSessionId: "settle-mainnet-1",
            gameId: "game-mainnet",
            roomId: "room-mainnet",
            network: "mainnet",
            request: {
                paymentNetwork: "mainnet"
            }
        }
    });

    assert.equal(
        fromPayload.network,
        "mainnet",
        "SettlementSession restore must preserve payload.network"
    );

    const fromRequest = SettlementSession.fromRecord({
        payload: {
            settlementSessionId: "settle-mainnet-2",
            gameId: "game-mainnet",
            roomId: "room-mainnet",
            request: {
                paymentNetwork: "mainnet"
            }
        }
    });

    assert.equal(
        fromRequest.network,
        "mainnet",
        "SettlementSession restore must recover Mainnet from persisted request.paymentNetwork"
    );

    const fromSnapshot = SettlementSession.fromRecord({
        payload: {
            settlementSessionId: "settle-mainnet-3",
            gameId: "game-mainnet",
            roomId: "room-mainnet",
            request: {
                snapshot: {
                    network: "mainnet"
                }
            }
        }
    });

    assert.equal(
        fromSnapshot.network,
        "mainnet",
        "SettlementSession restore must recover Mainnet from the authoritative snapshot"
    );

    console.log(
        "Test 17 — SettlementSession restart preserves network: passed"
    );

}

// Test 18 — Mainnet deployment configuration is selected from the snapshot network,
// even when the process-level runtime network remains Testnet.
function test18_mainnetDeployUsesSnapshotNetwork() {

    const adapterSource = readFileSync(
        join(
            dirname(fileURLToPath(import.meta.url)),
            "..",
            "payment/TonGameContractAdapter.js"
        ),
        "utf8"
    );

    assert(
        adapterSource.includes(
            "const paymentNetwork = snapshot?.network"
        ),
        "deployment must derive paymentNetwork from the authoritative snapshot"
    );
    assert(
        adapterSource.includes(
            "const tonConfig = this._tonConfigForNetwork(paymentNetwork);"
        ),
        "deployment must resolve TON config by payment network"
    );
    assert(
        adapterSource.includes(
            "this._sendOracleMessage({"
        )
            && adapterSource.includes(
                "paymentNetwork\n        });"
            ),
        "deployment broadcast must carry the selected paymentNetwork"
    );

    console.log(
        "Test 18 — Mainnet deploy uses snapshot network: passed"
    );

}

// Test 19 — blockchain escrow status reads never fall back to global Testnet
// when a room has an explicit payment network.
function test19_blockchainMonitorNetworkRoutingIsStrict() {

    const source = readFileSync(
        join(
            dirname(fileURLToPath(import.meta.url)),
            "..",
            "payment/BlockchainMonitor.js"
        ),
        "utf8"
    );

    assert(
        source.includes(
            "const statusService = watch.paymentNetwork != null"
        ),
        "escrow status reads must select the room network service when network is explicit"
    );
    assert(
        source.includes(
            "? networkService\n                : this._tonService"
        ),
        "global TonService may only be used when no room payment network is specified"
    );

    console.log(
        "Test 19 — BlockchainMonitor network routing is strict: passed"
    );

}

// Test 20 — GameContractManager cancel keeps the immutable contract network.
function test20_cancelCarriesContractNetwork() {

    const source = readFileSync(
        join(
            dirname(fileURLToPath(import.meta.url)),
            "..",
            "gameplay/GameContractManager.js"
        ),
        "utf8"
    );

    assert(
        source.includes(
            "paymentNetwork: contract?.snapshot?.network"
        ),
        "cancel must use the contract snapshot network"
    );
    assert(
        source.includes(
            "contract?.snapshot?.paymentNetwork"
        ),
        "cancel must retain the paymentNetwork snapshot fallback"
    );

    console.log(
        "Test 20 — cancel carries contract network: passed"
    );

}

// Test 15 — deployment authorization retains the authoritative Mainnet network.
function test15_deploymentAuthorizationNetworkIsAuthoritative() {

    const mainnetSession = {
        depositId: "dep-mainnet",
        roomId: "room-mainnet",
        gameId: "game-mainnet",
        state: "DEPOSIT_FULL",
        bindingHash: "binding-mainnet",
        metadata: {
            network: "mainnet"
        },
        bindings: [
            { playerId: "p1", wallet: "EQMAINNETP1" }
        ]
    };

    assert.equal(
        resolveAuthorizationNetwork(mainnetSession),
        "mainnet",
        "authorization network must come from the DepositSession metadata"
    );

    assert.equal(
        resolveAuthorizationNetwork(mainnetSession, { network: "mainnet" }),
        "mainnet",
        "explicit Mainnet authorization override must remain Mainnet"
    );

    const authorization = {
        network: "mainnet",
        status: "VALID",
        expiresAt: Date.now() + 60_000
    };

    const ready = assertAuthorizationReadyForDeploy(
        authorization,
        {
            roomId: "room-mainnet",
            gameId: "game-mainnet",
            network: "mainnet"
        }
    );

    assert.equal(
        ready.network,
        "mainnet",
        "deploy authorization must validate against Mainnet"
    );

    let mismatchRejected = false;

    try {
        assertAuthorizationReadyForDeploy(
            authorization,
            {
                roomId: "room-mainnet",
                gameId: "game-mainnet",
                network: "testnet"
            }
        );
    } catch {
        mismatchRejected = true;
    }

    assert(
        mismatchRejected,
        "Mainnet authorization must be rejected for a Testnet deployment request"
    );

    console.log(
        "Test 15 — deployment authorization network is authoritative: passed"
    );

}

// Test 14 — settlement/cancel adapter paths are explicitly network-routed.
function test14_adapterSettlementAndCancelUsePaymentNetwork() {

    const adapterSource = readFileSync(
        join(
            dirname(fileURLToPath(import.meta.url)),
            "..",
            "payment/TonGameContractAdapter.js"
        ),
        "utf8"
    );

    assert(
        adapterSource.includes(
            "const paymentNetwork = settlementRequest?.paymentNetwork"
        ),
        "settlement adapter must read the persisted paymentNetwork"
    );
    assert(
        adapterSource.includes(
            "this._service(paymentNetwork)"
        ),
        "settlement adapter must select the network-specific TON service"
    );
    assert(
        adapterSource.includes(
            "async cancel({ contractAddress, reasonCode = 0, paymentNetwork = null })"
        ),
        "cancel path must accept the authoritative paymentNetwork"
    );
    assert(
        adapterSource.includes(
            "this._parseAddress(contractAddress, paymentNetwork)"
        ),
        "cancel path must parse the contract address on the selected network"
    );

    console.log(
        "Test 14 — adapter settlement/cancel use paymentNetwork: passed"
    );

}

// Test 13 — restored GameEscrow/refund watches retain the per-room network.
function test13_blockchainCheckpointRetainsPaymentNetwork() {

    const monitorSource = readFileSync(
        join(
            dirname(fileURLToPath(import.meta.url)),
            "..",
            "payment/BlockchainMonitor.js"
        ),
        "utf8"
    );

    assert(
        monitorSource.includes(
            "paymentNetwork: watch.paymentNetwork ?? null"
        ),
        "BlockchainMonitor checkpoint must persist paymentNetwork"
    );
    assert(
        monitorSource.includes(
            "this._gameEscrowRefunds.set(entry.watchId, {"
        )
            && monitorSource.includes(
                "paymentNetwork: watch.paymentNetwork ?? null"
            ),
        "GameEscrow refund checkpoint must retain paymentNetwork"
    );

    console.log(
        "Test 13 — BlockchainMonitor checkpoint retains paymentNetwork: passed"
    );

}

// Test 21 — deployment-cost capture preserves the authoritative room network
// and resolves its deploy wallet from the same network profile.
function test21_deploymentCostCapturePreservesNetwork() {

    const managerSource = readFileSync(
        join(
            dirname(fileURLToPath(import.meta.url)),
            "..",
            "gameplay/GameContractManager.js"
        ),
        "utf8"
    );

    assert(
        managerSource.includes("contractNetwork = String(")
            && managerSource.includes("networkProfile?.deployerExpectedAddress"),
        "deployment cost capture must resolve deploy wallet from the contract network profile"
    );
    assert(
        managerSource.includes("runtimeNetwork === contractNetwork"),
        "runtime deployer/oracle fallback must be allowed only when runtime network matches"
    );

    const serviceSource = readFileSync(
        join(
            dirname(fileURLToPath(import.meta.url)),
            "..",
            "payment/reimbursement/DeploymentCostService.js"
        ),
        "utf8"
    );

    assert(
        serviceSource.includes(
            "network: input.network ?? input.tonNetwork ?? null"
        ),
        "deployment cost capture must persist the event network"
    );

    console.log(
        "Test 21 — deployment cost capture preserves network: passed"
    );

}


// Test 22 — Room Wallet destination is published in every authoritative PaymentSession view.
function test22_paymentSessionPublishesRoomWalletDestination() {

    const session = new PaymentSession({
        paymentSessionId: "pay-mainnet-room-wallet",
        roomId: "room-mainnet",
        roomNumber: 42,
        gameId: "game-mainnet",
        network: "mainnet",
        roomWalletAddress: "EQRoomWalletMainnet",
        participants: []
    });

    const payload = session.toPayload();
    const snapshot = session.toSnapshot();
    const dashboard = session.toDashboardSnapshot();

    assert.equal(
        payload.roomWalletAddress,
        "EQRoomWalletMainnet",
        "PaymentSession persistence payload must retain Room Wallet destination"
    );
    assert.equal(
        snapshot.roomWalletAddress,
        "EQRoomWalletMainnet",
        "PAYMENT_SESSION authoritative snapshot must publish Room Wallet destination"
    );
    assert.equal(
        dashboard.roomWalletAddress,
        "EQRoomWalletMainnet",
        "PaymentSession dashboard view must retain Room Wallet destination"
    );

    const restored = PaymentSession.fromRecord({
        payload: {
            paymentSessionId: "pay-mainnet-room-wallet-restored",
            roomId: "room-mainnet",
            gameId: "game-mainnet",
            network: "mainnet",
            roomWalletAddress: "EQRoomWalletMainnet",
            participants: []
        }
    });

    assert.equal(
        restored.roomWalletAddress,
        "EQRoomWalletMainnet",
        "PaymentSession restart recovery must preserve Room Wallet destination"
    );

    console.log(
        "Test 22 — PaymentSession publishes Room Wallet destination: passed"
    );

}


// Test 23 — explicit Mainnet payment sessions cannot resolve a Testnet Room Wallet.
function test23_roomWalletResolutionFailsClosedAcrossNetworks() {

    const registry = new RoomWalletRegistry({
        entries: [
            {
                roomNumber: 7,
                address: "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",
                network: "testnet"
            }
        ]
    });

    const mainnetAddress = resolveIntendedRoomWalletAddress({
        roomNumber: 7,
        paymentNetwork: "mainnet"
    }, registry);

    const testnetAddress = resolveIntendedRoomWalletAddress({
        roomNumber: 7,
        paymentNetwork: "testnet"
    }, registry);

    assert.equal(
        mainnetAddress,
        null,
        "Mainnet payment must never resolve a Testnet Room Wallet"
    );
    assert.equal(
        testnetAddress,
        "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",
        "Testnet payment must resolve the matching Testnet Room Wallet"
    );

    assert(
        registry.getForNetwork(7, "mainnet") === null,
        "registry network lookup must fail closed for mismatched network"
    );

    console.log(
        "Test 23 — Room Wallet resolution fails closed across networks: passed"
    );

}

// Test 24 — Testnet and Mainnet Room Wallet records may coexist for one room number.
function test24_roomWalletRegistrySupportsPerNetworkCatalogs() {

    const registry = new RoomWalletRegistry({
        entries: [
            { roomNumber: 7, address: "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c", network: "testnet" },
            { roomNumber: 7, address: "EQABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAc3j", network: "mainnet" }
        ]
    });

    assert.equal(registry.getForNetwork(7, "testnet")?.address, "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c");
    assert.equal(registry.getForNetwork(7, "mainnet")?.address, "EQABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAc3j");
    assert.equal(registry.get(7), null, "ambiguous room lookup must not select a network implicitly");
    assert.equal(registry.size(), 2);

    console.log(
        "Test 24 — Room Wallet registry supports per-network catalogs: passed"
    );

}


// Test 25 — Room Wallet settlement transport follows the authoritative payment network.
async function test25_roomWalletAdapterUsesPaymentNetworkService() {

    const calls = [];

    const testnetService = {
        async getBalance() {
            calls.push("testnet");
            return 10_000n;
        }
    };

    const mainnetService = {
        async getBalance() {
            calls.push("mainnet");
            return 10_000n;
        }
    };

    const adapter = new RoomWalletAdapter({
        tonService: testnetService,
        tonNetworkServiceRegistry: {
            get(network) {
                return network === "mainnet"
                    ? mainnetService
                    : testnetService;
            }
        },
        walletResolver: async (roomNumber, network) => ({
            roomNumber,
            address: network === "mainnet"
                ? "EQABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAc3j"
                : "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",
            network,
            workchain: 0,
            publicKey: Buffer.alloc(32),
            secretKey: Buffer.alloc(64)
        })
    });

    await adapter.canFundTransfer({
        roomNumber: 7,
        network: "mainnet",
        amountNano: 1n,
        sourceReserveNano: 0n
    });

    assert.deepEqual(
        calls,
        ["mainnet"],
        "Mainnet Room Wallet settlement must use the Mainnet TON service"
    );

    console.log(
        "Test 25 — Room Wallet adapter uses payment-network service: passed"
    );

}


function test27_roomWalletIncomingAttributionUsesSessionNetwork() {

    const source = readFileSync(
        join(__dirname, "../payment/roomWallet/RoomWalletIncomingObserver.js"),
        "utf8"
    );

    assert(
        source.includes("paymentNetwork: session.network"),
        "incoming attribution must resolve the intended Room Wallet using the session payment network"
    );
    assert(
        source.includes("tonNetwork: fields.network ?? this._network"),
        "incoming observation persistence must retain the transaction/session payment network"
    );
    assert(
        source.includes("network: session.network ?? this._network"),
        "incoming payment events must propagate the authoritative session payment network"
    );

    console.log(
        "Test 27 — Room Wallet incoming attribution preserves session network: passed"
    );

}


function test26_roomWalletRecoveryNetworkRoutingSourceContract() {

    const workerSource = readFileSync(
        join(__dirname, "../payment/roomWallet/RoomWalletResidualSweepWorker.js"),
        "utf8"
    );
    const recoverySource = readFileSync(
        join(__dirname, "../payment/roomWallet/RoomWalletTerminalSettlementRecovery.js"),
        "utf8"
    );

    assert(
        workerSource.includes("resolvePaymentNetwork(record.payload)"),
        "residual sweep retry must recover its persisted payment network"
    );
    assert(
        workerSource.includes("getBalance(roomNumber, network)"),
        "residual sweep balance lookup must use payment network"
    );
    assert(
        workerSource.includes("network,\n                destination: destination.address"),
        "residual sweep transfer must carry payment network"
    );
    assert(
        workerSource.includes("paymentNetwork: resolvePaymentNetwork(record.payload)"),
        "residual sweep blockchain watch must carry payment network"
    );

    assert(
        recoverySource.includes("this._serviceForNetwork(paymentNetwork)"),
        "terminal recovery chain inspection/confirmation must use payment network service"
    );
    assert(
        recoverySource.includes("registry.getForNetwork?.(roomNumber, paymentNetwork)"),
        "terminal recovery must resolve Room Wallet by payment network"
    );
    assert(
        recoverySource.includes("paymentNetwork")
        && recoverySource.includes("reconstructed"),
        "terminal recovery must reconstruct and propagate payment network"
    );

    console.log(
        "Test 26 — Room Wallet recovery network routing source contract: passed"
    );

}

test("R18-S17 C13: settlement handoff persists contract payment network", () => {

    const source = readFileSync(
        join(__dirname, "../payment/ContractSettlementManager.js"),
        "utf8"
    );

    assert.match(
        source,
        /paymentNetwork:\s*contract\.tonNetwork\s*[\s\S]*contract\.snapshot\?\.network/
    );
    assert.match(
        source,
        /network:\s*contract\.tonNetwork\s*[\s\S]*contract\.snapshot\?\.network\s*[\s\S]*contract\.snapshot\?\.paymentNetwork\s*[\s\S]*null/
    );

    console.log(
        "Test 29 — Settlement handoff persists contract payment network: passed"
    );

});



test("R18-S17 C14: settlement adapter keeps explicit payment network through broadcast and confirmation", () => {

    const source = readFileSync(
        join(__dirname, "../payment/TonGameContractAdapter.js"),
        "utf8"
    );

    assert.match(
        source,
        /const paymentNetwork = settlementRequest\?\.paymentNetwork\s*\n\s*\?\? settlementRequest\?\.network/
    );
    assert.match(
        source,
        /_tonConfigForNetwork\(paymentNetwork\)/
    );
    assert.match(
        source,
        /_canBroadcast\(paymentNetwork\)/
    );
    assert.match(
        source,
        /_broadcastSettle\(settlementRequest, paymentNetwork\)/
    );
    assert.match(
        source,
        /operation:\s*"SETTLE"[\s\S]*paymentNetwork/
    );
    assert.match(
        source,
        /_service\(paymentNetwork\)\.broadcastTransaction/
    );
    assert.match(
        source,
        /_waitForDeployerSeqnoAdvance\([\s\S]*paymentNetwork/
    );
    assert.match(
        source,
        /_lookupDeployerAccountTxHash\([\s\S]*paymentNetwork/
    );
    assert.match(
        source,
        /_parseAddress\(contractAddress, paymentNetwork\)/
    );

    console.log(
        "Test 30 — Settlement adapter preserves payment network through broadcast/confirmation: passed"
    );

});



// Test 31 — GameEscrow confirmation/rejection/refund observations retain the authoritative network.
function test31_gameEscrowConfirmationNetworkPropagation() {

    const source = readFileSync(
        join(
            dirname(fileURLToPath(import.meta.url)),
            "..",
            "payment/BlockchainMonitor.js"
        ),
        "utf8"
    );

    assert(
        source.includes(
            "GAME_ESCROW_SETTLEMENT_VERIFIED"
        )
            && source.includes(
                "winnerAddress: watch.winnerAddress,\n                    ownerAddress: watch.ownerAddress,\n                    network: watch.paymentNetwork ?? this._network"
            ),
        "GameEscrow settlement verification must publish the authoritative payment network"
    );

    assert(
        source.includes(
            "GAME_ESCROW_SETTLEMENT_REJECTED"
        )
            && source.includes(
                "reason: result.reason,\n                            network: watch.paymentNetwork ?? this._network"
            ),
        "GameEscrow settlement rejection must publish the authoritative payment network"
    );

    assert(
        source.includes(
            "const transactions = await this._fetchTransactions(watch.escrowAddress, {\n                limit: 40\n            }, watch);"
        ),
        "GameEscrow refund observation must fetch transactions through the network-scoped watch"
    );

    assert(
        source.includes(
            "cancelTxHash: result.cancelTxHash,\n                    refundMask: result.confirmedMask,\n                    network: watch.paymentNetwork ?? this._network"
        ),
        "GameEscrow cancel confirmation must publish the authoritative payment network"
    );

    console.log(
        "Test 31 — GameEscrow confirmation/refund network propagation: passed"
    );

}


// Test 34 — GameContract lifecycle events retain the authoritative payment network.
function test34_gameContractLifecycleNetworkPropagation() {

    const source = readFileSync(
        join(
            dirname(fileURLToPath(import.meta.url)),
            "..",
            "gameplay/GameContractManager.js"
        ),
        "utf8"
    );

    assert(
        source.includes("_emitDomainLifecycle(type, contract, extra = {})")
            && source.includes("network: contract.tonNetwork")
            && source.includes("paymentNetwork: contract.tonNetwork")
            && source.includes("tonNetwork: contract.tonNetwork"),
        "GameContract lifecycle events must publish the immutable contract payment network"
    );

    console.log(
        "Test 34 — GameContract lifecycle network propagation: passed"
    );

}

// Test 33 — Legacy settlement consumers retain the authoritative payment network.
function test33_settlementLegacyRecordNetworkPropagation() {

    const source = readFileSync(
        join(
            dirname(fileURLToPath(import.meta.url)),
            "..",
            "payment/SettlementSession.js"
        ),
        "utf8"
    );

    assert(
        source.includes("network: this.network")
            && source.includes("paymentNetwork: this.network"),
        "legacy settlement record must retain the authoritative payment network"
    );

    console.log(
        "Test 33 — Settlement legacy record network propagation: passed"
    );

}

// Test 32 — Settlement completion/reconnect outputs retain the authoritative network.
function test32_settlementCompletionNetworkPropagation() {

    const source = readFileSync(
        join(
            dirname(fileURLToPath(import.meta.url)),
            "..",
            "payment/ContractSettlementManager.js"
        ),
        "utf8"
    );

    assert(
        source.includes("paymentNetwork: session.network")
            && source.includes("network: session.network"),
        "settlement completion outputs must publish the authoritative session network"
    );

    assert(
        source.includes("network: session.network ?? session.request?.paymentNetwork")
            && source.includes("paymentNetwork: session.network ?? session.request?.paymentNetwork"),
        "settlement reconnect snapshot must retain the authoritative network"
    );

    assert(
        source.includes("settlementTxHash: session.settlementTransactionHash")
            && source.includes("network: session.network ?? session.request?.paymentNetwork"),
        "settlement completion audit must retain the authoritative network"
    );

    console.log(
        "Test 32 — Settlement completion network propagation: passed"
    );

}


async function main() {

    await test1_createRoomCarriesAndStoresPaymentNetwork();

    await test2_invalidValuesDefaultForgedClaimsIgnored();

    await test3_startGameNotGatedByPaymentNetwork();

    await test4_paymentConnectionReadyCarriesPaymentNetwork();

    await test5_unauthenticatedCreateRoomRejected();

    await test6_destructionClearsPaymentNetworkState();

    await test7_sourceContracts();

    test8_depositOrchestratorFinancialsFollowRoomNetwork();

    test9_gameContractNetworkFollowsRoomPaymentNetwork();
    test10_gameContractOracleFollowsRoomNetwork();
    test11_gameContractRestartPreservesSnapshotNetwork();
    test12_settlementHandoffCarriesPaymentNetwork();
    test13_blockchainCheckpointRetainsPaymentNetwork();
    test14_adapterSettlementAndCancelUsePaymentNetwork();
    test15_deploymentAuthorizationNetworkIsAuthoritative();
    test19_blockchainMonitorNetworkRoutingIsStrict();
    test20_cancelCarriesContractNetwork();
    test21_deploymentCostCapturePreservesNetwork();
    test16_paymentSessionRestartPreservesNetwork();
    test17_settlementSessionRestartPreservesNetwork();
    test18_mainnetDeployUsesSnapshotNetwork();
    test22_paymentSessionPublishesRoomWalletDestination();
    test23_roomWalletResolutionFailsClosedAcrossNetworks();
    test24_roomWalletRegistrySupportsPerNetworkCatalogs();
    await test25_roomWalletAdapterUsesPaymentNetworkService();
    test26_roomWalletRecoveryNetworkRoutingSourceContract();
    test27_roomWalletIncomingAttributionUsesSessionNetwork();
    test31_gameEscrowConfirmationNetworkPropagation();
    test32_settlementCompletionNetworkPropagation();
    test33_settlementLegacyRecordNetworkPropagation();
    test34_gameContractLifecycleNetworkPropagation();

    console.log("all assertions passed");

    // EventBus/lifecycle timers keep the loop alive; exit explicitly.
    process.exit(0);

}

main().catch((error) => {

    console.error(
        "paymentNetworkPrecreate test FAILED:",
        error?.message ?? error
    );

    process.exit(1);

});




test("R18-S17 C12: payment completion event carries immutable contract network", () => {

    const source = readFileSync(
        join(__dirname, "../gameplay/GameContractManager.js"),
        "utf8"
    );

    assert.match(
        source,
        /GAME_CONTRACT_PAYMENTS_COMPLETE,\s*\{[\s\S]*paymentNetwork:\s*contract\.tonNetwork/
    );
    assert.match(
        source,
        /tonNetwork:\s*contract\.tonNetwork/
    );
    assert.match(
        source,
        /contract\.snapshot\?\.network/
    );

    console.log(
        "Test 28 — Game Contract payment completion network propagation: passed"
    );

});
