/**
 * R8.6 — Page5 lifecycle ownership & settlement survival.
 *
 * Setup expiry / ROOM_DESTROYED after GAME_INITIALIZED must not wipe
 * financial context. GAME_DESTROYED waits for settlement terminal.
 */
import assert from "node:assert/strict";

import { GameCatalog } from "../catalog/GameCatalog.js";
import { GameplayLifecycle } from "../gameplay/GameplayLifecycle.js";
import { SetupSessionLifecycle } from "../gameplay/SetupSessionLifecycle.js";
import { GameContractManager } from "../gameplay/GameContractManager.js";
import { PaymentSessionManager } from "../gameplay/PaymentSessionManager.js";
import { GameManager } from "../managers/GameManager.js";
import { RoomManager } from "../managers/RoomManager.js";
import { PlayerManager } from "../managers/PlayerManager.js";
import {
    GAME_CONTRACT_STATUS,
    GameContract
} from "../models/GameContract.js";
import { ContractSettlementManager } from "../payment/ContractSettlementManager.js";
import { SettlementSession } from "../payment/SettlementSession.js";
import {
    SETTLEMENT_SESSION_STATUS,
    isSettlementSessionTerminal
} from "../payment/SettlementSessionStates.js";
import { LoggerService } from "../services/LoggerService.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { EventBus } from "../events/EventBus.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import { GameClockEngine } from "../engines/GameClockEngine.js";
import { GameStateEngine } from "../engines/GameStateEngine.js";
import { PhysicsEngine } from "../engines/PhysicsEngine.js";

function wait(ms) {

    return new Promise((resolve) => setTimeout(resolve, ms));

}

function createLoggerBus() {

    const logger = new LoggerService({ logLevel: "error" });

    logger.initialize();

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    return { logger, eventBus };

}

function emit(eventBus, type, payload) {

    eventBus.emit({
        source: "test",
        type,
        payload
    });

}

// ---------------------------------------------------------------------------
// TEST A + C23 regression — Setup expiry after GAME_INITIALIZED
// ---------------------------------------------------------------------------

{

    const { logger, eventBus } = createLoggerBus();

    const playerManager = new PlayerManager({ logger, eventBus });

    playerManager.initialize();

    const roomManager = new RoomManager({
        logger,
        eventBus,
        playerManager,
        roomConfig: { maxPlayers: 3, setupDurationMs: 80 }
    });

    const gameManager = new GameManager({ logger, eventBus });

    gameManager.initialize();

    const setup = new SetupSessionLifecycle({
        logger,
        eventBus,
        roomManager,
        gameManager,
        roomConfig: { setupDurationMs: 80 },
        devMode: false
    });

    setup.initialize();

    roomManager.attachSetupSessionLifecycle(setup);

    roomManager.initialize();

    const room = roomManager.createRoom();

    const roomId = room.roomId;

    for (const playerId of ["p1", "p2", "p3"]) {

        playerManager.createPlayer({ playerId });

        roomManager.addPlayer(roomId, playerId);

    }

    setup.archiveForPayment(roomId);

    const game = gameManager.createGame(roomId, {
        players: ["p1", "p2", "p3"]
    });

    gameManager.initializeGame(game.gameId);

    assert.equal(
        setup.isGameplayOwnershipReleased(roomId),
        true,
        "TEST A: Setup ownership released at GAME_INITIALIZED"
    );

    assert.equal(
        gameManager.hasInitializedGameplay(roomId),
        true,
        "TEST A: GameManager reports initialized gameplay"
    );

    const expired = [];

    eventBus.subscribe(EVENT_TYPES.SETUP_SESSION_EXPIRED, (envelope) => {

        expired.push(envelope.payload);

    });

    await wait(150);

    assert.equal(
        expired.length,
        0,
        "TEST A: Setup expiry must not emit after GAME_INITIALIZED"
    );

    assert.ok(
        roomManager.getRoom(roomId),
        "TEST A: Room must survive Setup Timer after GAME_INITIALIZED"
    );

    assert.ok(
        setup.getSession(roomId),
        "TEST A: Setup session record may remain without destroy authority"
    );

    console.log("  TEST A setup expiry after GAME_INITIALIZED passed");

    setup.shutdown();

    roomManager.shutdown();

    gameManager.shutdown();

    playerManager.shutdown();

    eventBus.shutdown();

    logger.shutdown();

}

// C23 regression — ARCHIVED expiry still destroys room BEFORE GAME_INITIALIZED

{

    const { logger, eventBus } = createLoggerBus();

    const playerManager = new PlayerManager({ logger, eventBus });

    playerManager.initialize();

    const roomManager = new RoomManager({
        logger,
        eventBus,
        playerManager,
        roomConfig: { maxPlayers: 3, setupDurationMs: 80 }
    });

    const gameManager = new GameManager({ logger, eventBus });

    gameManager.initialize();

    const setup = new SetupSessionLifecycle({
        logger,
        eventBus,
        roomManager,
        gameManager,
        roomConfig: { setupDurationMs: 80 },
        devMode: false
    });

    setup.initialize();

    roomManager.attachSetupSessionLifecycle(setup);

    roomManager.initialize();

    const room = roomManager.createRoom();

    const roomId = room.roomId;

    for (const playerId of ["c1", "c2", "c3"]) {

        playerManager.createPlayer({ playerId });

        roomManager.addPlayer(roomId, playerId);

    }

    setup.archiveForPayment(roomId);

    const expired = [];

    eventBus.subscribe(EVENT_TYPES.SETUP_SESSION_EXPIRED, (envelope) => {

        expired.push(envelope.payload);

    });

    await wait(150);

    assert.ok(
        expired.some((payload) => payload.roomId === roomId),
        "C23: ARCHIVED Setup expiry still emits before GAME_INITIALIZED"
    );

    assert.equal(
        roomManager.getRoom(roomId),
        null,
        "C23: ARCHIVED Setup expiry still destroys room before GAME_INITIALIZED"
    );

    console.log("  C23 PAYMENT Setup Timer regression passed");

    setup.shutdown();

    roomManager.shutdown();

    gameManager.shutdown();

    playerManager.shutdown();

    eventBus.shutdown();

    logger.shutdown();

}

// ---------------------------------------------------------------------------
// TEST B — ROOM_DESTROYED after GAME_INITIALIZED preserves financial objects
// ---------------------------------------------------------------------------

{

    const { logger, eventBus } = createLoggerBus();

    const playerManager = new PlayerManager({ logger, eventBus });

    playerManager.initialize();

    const roomManager = {
        getRoom() {

            return null;

        }
    };

    const gameManager = new GameManager({ logger, eventBus });

    gameManager.initialize();

    const paymentSessionManager = new PaymentSessionManager({
        logger,
        eventBus,
        playerManager,
        roomManager,
        gameManager,
        devMode: false
    });

    paymentSessionManager.initialize();

    const gameContractManager = new GameContractManager({
        logger,
        eventBus,
        playerManager,
        roomManager,
        gameManager,
        deployAdapter: {
            async deploy() {

                return {
                    ok: true,
                    contractAddress: "EQ_TEST_CONTRACT",
                    deployTransactionHash: "hash"
                };

            }
        },
        creatingDelayMs: 0,
        devMode: false
    });

    gameContractManager.initialize();

    const settlementAdapter = {
        async settleContract() {

            return { ok: true, transactionHash: "settle_hash" };

        }
    };

    const contractSettlementManager = new ContractSettlementManager({
        logger,
        eventBus,
        gameContractManager,
        winnerEngine: { getResult() { return null; } },
        settlementAdapter,
        gameManager,
        ownerConfiguration: {
            getOwnerWallet() {

                return "EQ_OWNER";

            }
        },
        devMode: false
    });

    contractSettlementManager.initialize();

    const roomId = "ROOM_B86";

    const game = gameManager.createGame(roomId, {
        players: ["a", "b", "c"]
    });

    const gameId = game.gameId;

    gameManager.initializeGame(gameId);

    paymentSessionManager._sessionsByRoom.set(roomId, {
        paymentSessionId: "pay_test",
        roomId,
        gameId,
        status: "COMPLETED",
        isInProgress() {

            return false;

        }
    });

    const contract = new GameContract({
        contractId: "contract_test",
        roomId,
        gameId,
        contractAddress: "EQ_TEST_CONTRACT",
        status: GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE,
        snapshot: {
            players: [],
            payoutAmount: 2.85,
            organizerFee: 0.15,
            totalPot: 3,
            ownerWallet: "EQ_OWNER"
        }
    });

    gameContractManager._contractsByRoom.set(roomId, contract);

    gameContractManager._contractsById.set(contract.contractId, contract);

    gameContractManager._roomByGameId.set(gameId, roomId);

    const settlement = new SettlementSession({
        settlementSessionId: "settle_test",
        contractId: contract.contractId,
        gameId,
        roomId,
        winnerId: "a",
        winnerWallet: "EQ_WINNER",
        prizeAmount: 2.85,
        organizerAmount: 0.15,
        totalPot: 3,
        status: SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING,
        ownerWallet: "EQ_OWNER"
    });

    contractSettlementManager._byGameId.set(gameId, settlement);

    emit(eventBus, EVENT_TYPES.ROOM_DESTROYED, {
        roomId,
        playerCount: 0
    });

    assert.ok(
        paymentSessionManager.getSession(roomId),
        "TEST B: PaymentSession survives ROOM_DESTROYED after GAME_INITIALIZED"
    );

    assert.ok(
        gameContractManager.getContract(roomId),
        "TEST B: GameContract survives ROOM_DESTROYED after GAME_INITIALIZED"
    );

    assert.ok(
        contractSettlementManager.getSettlementSession(gameId),
        "TEST B: Settlement survives ROOM_DESTROYED after GAME_INITIALIZED"
    );

    assert.ok(
        gameManager.hasGame(gameId),
        "TEST B: Game record survives ROOM_DESTROYED"
    );

    console.log("  TEST B ROOM_DESTROYED financial survival passed");

    contractSettlementManager.shutdown();

    gameContractManager.shutdown();

    paymentSessionManager.shutdown();

    gameManager.shutdown();

    playerManager.shutdown();

    eventBus.shutdown();

    logger.shutdown();

}

// ---------------------------------------------------------------------------
// TEST C + D — GAME_DESTROYED settlement gate
// ---------------------------------------------------------------------------

async function buildTeardownStack() {

    const { logger, eventBus } = createLoggerBus();

    const catalog = new GameCatalog({ logger });

    catalog.initialize();

    catalog.getTimers = () => ({
        [GAME_STATES.RESULT]: { phase: GAME_STATES.RESULT, durationMs: 20 }
    });

    const gameStateEngine = new GameStateEngine({ logger, eventBus });

    const gameClockEngine = new GameClockEngine({
        logger,
        eventBus,
        gameCatalog: catalog
    });

    const physicsEngine = new PhysicsEngine({
        logger,
        eventBus,
        gameClock: gameClockEngine
    });

    const planted = {
        gameId: null,
        result: null
    };

    const winnerEngine = {
        getResult(gameId) {

            return planted.gameId === gameId ? planted.result : null;

        },
        removeResult() {}
    };

    const gameManager = new GameManager({ logger, eventBus });

    gameManager.initialize();

    const gameContractManager = {
        contracts: new Map(),
        getContractByGameId(gameId) {

            return this.contracts.get(gameId) ?? null;

        }
    };

    const contractSettlementManager = {
        sessions: new Map(),
        getSettlementSession(gameId) {

            return this.sessions.get(gameId) ?? null;

        }
    };

    gameStateEngine.initialize();

    gameClockEngine.initialize();

    physicsEngine.initialize();

    const gameplayLifecycle = new GameplayLifecycle({
        logger,
        eventBus,
        gameCatalog: catalog,
        physicsEngine,
        inputAuthority: {
            hasGame() { return false; },
            removeGame() {}
        },
        gameClockEngine,
        gameStateEngine,
        configurationEngine: {
            getConfiguration() { return null; },
            removeConfiguration() {}
        },
        winnerEngine,
        winnerActivation: { forgetGame() {} },
        gameManager,
        contractSettlementManager,
        gameContractManager,
        waitForAudit: false,
        devMode: true
    });

    gameplayLifecycle.initialize();

    return {
        logger,
        eventBus,
        gameManager,
        gameStateEngine,
        gameplayLifecycle,
        winnerEngine,
        planted,
        gameContractManager,
        contractSettlementManager,
        shutdown() {

            gameplayLifecycle.shutdown();

            gameManager.shutdown();

            physicsEngine.shutdown();

            gameClockEngine.shutdown();

            gameStateEngine.shutdown();

            eventBus.shutdown();

            logger.shutdown();

        }
    };

}

{

    const stack = await buildTeardownStack();

    const destroyed = [];

    stack.eventBus.subscribe(EVENT_TYPES.GAME_DESTROYED, (envelope) => {

        destroyed.push(envelope.payload?.gameId);

    });

    const game = stack.gameManager.createGame("room_gate", {
        players: ["w1", "w2", "w3"]
    });

    const gameId = game.gameId;

    stack.gameManager.initializeGame(gameId);

    stack.planted.gameId = gameId;

    stack.planted.result = Object.freeze({
        gameId,
        winningPlayer: { playerId: "w1" },
        winningSector: { index: 0, sectorId: "s0" },
        winnerPlayerId: "w1"
    });

    stack.gameContractManager.contracts.set(gameId, {
        contractId: "c1",
        gameId,
        roomId: "room_gate"
    });

    stack.contractSettlementManager.sessions.set(gameId, {
        status: SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING,
        isInProgress() {

            return true;

        }
    });

    emit(stack.eventBus, EVENT_TYPES.GAME_STATE_CHANGED, {
        gameId,
        currentState: GAME_STATES.RESULT,
        state: GAME_STATES.RESULT
    });

    await wait(80);

    assert.equal(
        destroyed.length,
        0,
        "TEST D: GAME_DESTROYED must not occur while settlement pending"
    );

    assert.equal(
        stack.gameManager.hasGame(gameId),
        true,
        "TEST D: game record still present while settlement pending"
    );

    console.log("  TEST D GAME_DESTROYED blocked while settlement pending passed");

    stack.contractSettlementManager.sessions.set(gameId, {
        status: SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED,
        isInProgress() {

            return false;

        }
    });

    assert.equal(
        isSettlementSessionTerminal(SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED),
        true
    );

    emit(stack.eventBus, EVENT_TYPES.SETTLEMENT_COMPLETED, { gameId });

    await wait(80);

    assert.ok(
        destroyed.includes(gameId),
        "TEST C: GAME_DESTROYED after SETTLEMENT_COMPLETED"
    );

    console.log("  TEST C GAME_DESTROYED after SETTLEMENT_COMPLETED passed");

    stack.shutdown();

}

// ---------------------------------------------------------------------------
// TEST E — zero clients: game + contract remain after ROOM_DESTROYED
// ---------------------------------------------------------------------------

{

    const { logger, eventBus } = createLoggerBus();

    const gameManager = new GameManager({ logger, eventBus });

    gameManager.initialize();

    const playerManager = new PlayerManager({ logger, eventBus });

    playerManager.initialize();

    const roomId = "room_zero";

    const game = gameManager.createGame(roomId, {
        players: ["z1", "z2", "z3"]
    });

    gameManager.initializeGame(game.gameId);

    const gameContractManager = new GameContractManager({
        logger,
        eventBus,
        playerManager,
        roomManager: {
            getRoom() { return null; }
        },
        gameManager,
        deployAdapter: { async deploy() { return { ok: true }; } },
        creatingDelayMs: 0
    });

    gameContractManager.initialize();

    const contract = new GameContract({
        contractId: "cz",
        roomId,
        gameId: game.gameId,
        contractAddress: "EQZ",
        status: GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE,
        snapshot: { players: [], payoutAmount: 1, organizerFee: 0, totalPot: 1 }
    });

    gameContractManager._contractsByRoom.set(roomId, contract);

    gameContractManager._contractsById.set(contract.contractId, contract);

    gameContractManager._roomByGameId.set(game.gameId, roomId);

    emit(eventBus, EVENT_TYPES.ROOM_DESTROYED, { roomId, playerCount: 0 });

    assert.ok(
        gameManager.hasGame(game.gameId),
        "TEST E: game remains after room destroy / zero clients"
    );

    assert.ok(
        gameContractManager.getContract(roomId),
        "TEST E: settlement contract context remains available"
    );

    console.log("  TEST E zero-client financial survival passed");

    gameContractManager.shutdown();

    gameManager.shutdown();

    playerManager.shutdown();

    eventBus.shutdown();

    logger.shutdown();

}

// ---------------------------------------------------------------------------
// TEST F — FAILED settlement evidence not deleted by gameplay teardown
// ---------------------------------------------------------------------------

{

    const stack = await buildTeardownStack();

    const game = stack.gameManager.createGame("room_fail", {
        players: ["w1", "w2", "w3"]
    });

    const gameId = game.gameId;

    stack.gameManager.initializeGame(gameId);

    stack.planted.gameId = gameId;

    stack.planted.result = Object.freeze({
        gameId,
        winningPlayer: { playerId: "w1" },
        winnerPlayerId: "w1"
    });

    const failedSession = {
        status: SETTLEMENT_SESSION_STATUS.SETTLEMENT_FAILED,
        reason: "adapter_failed",
        winnerWallet: "EQ_W",
        ownerWallet: "EQ_O",
        isInProgress() {

            return false;

        }
    };

    stack.contractSettlementManager.sessions.set(gameId, failedSession);

    stack.gameContractManager.contracts.set(gameId, {
        contractId: "cf",
        gameId,
        roomId: "room_fail",
        contractAddress: "EQ_KEEP"
    });

    emit(stack.eventBus, EVENT_TYPES.GAME_STATE_CHANGED, {
        gameId,
        currentState: GAME_STATES.RESULT,
        state: GAME_STATES.RESULT
    });

    await wait(80);

    assert.equal(
        stack.contractSettlementManager.getSettlementSession(gameId),
        failedSession,
        "TEST F: settlement FAILED evidence remains after gameplay teardown gate"
    );

    assert.ok(
        stack.gameContractManager.getContractByGameId(gameId),
        "TEST F: contract evidence remains for TonFinancialRecovery"
    );

    console.log("  TEST F settlement recovery evidence retained passed");

    stack.shutdown();

}

console.log("page5LifecycleOwnership.r86.test.js: all assertions passed");
