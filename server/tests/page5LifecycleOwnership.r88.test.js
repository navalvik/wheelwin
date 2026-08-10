/**
 * R8.8 — Close SESSION_FINISHED + paid-game destroy-gate holes from R8.7.
 */
import assert from "node:assert/strict";

import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import { GameCatalog } from "../catalog/GameCatalog.js";
import { GameClockEngine } from "../engines/GameClockEngine.js";
import { GameStateEngine } from "../engines/GameStateEngine.js";
import { PhysicsEngine } from "../engines/PhysicsEngine.js";
import { GameplayLifecycle } from "../gameplay/GameplayLifecycle.js";
import { GameContractManager } from "../gameplay/GameContractManager.js";
import { PaymentSessionManager } from "../gameplay/PaymentSessionManager.js";
import { shouldPreserveFinancialEvidence } from "../gameplay/financialEvidenceGuards.js";
import { GameManager } from "../managers/GameManager.js";
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
import { SetupSessionLifecycle } from "../gameplay/SetupSessionLifecycle.js";
import { RoomManager } from "../managers/RoomManager.js";

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

function seedFinancialStack({
    logger,
    eventBus,
    roomId,
    settlementStatus = SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING
}) {

    const playerManager = new PlayerManager({ logger, eventBus });

    playerManager.initialize();

    const roomManager = { getRoom() { return null; } };

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

                return { ok: true, contractAddress: "EQ_X", deployTransactionHash: "h" };

            }
        },
        creatingDelayMs: 0,
        paymentSessionManager,
        devMode: false
    });

    gameContractManager.initialize();

    const contractSettlementManager = new ContractSettlementManager({
        logger,
        eventBus,
        gameContractManager,
        winnerEngine: { getResult() { return null; } },
        settlementAdapter: {
            async settleContract() {

                return { ok: true, transactionHash: "s" };

            }
        },
        gameManager,
        paymentSessionManager,
        ownerConfiguration: {
            getOwnerWallet() {

                return "EQ_OWNER";

            }
        },
        devMode: false
    });

    contractSettlementManager.initialize();

    paymentSessionManager.setFinancialEvidenceDeps({
        gameContractManager,
        contractSettlementManager
    });

    gameContractManager.setFinancialEvidenceDeps({
        paymentSessionManager,
        contractSettlementManager
    });

    const game = gameManager.createGame(roomId, {
        players: ["a", "b", "c"]
    });

    const gameId = game.gameId;

    gameManager.initializeGame(gameId);

    gameManager.markEntryPaymentActivated(gameId);

    paymentSessionManager._sessionsByRoom.set(roomId, {
        paymentSessionId: "pay_r88",
        roomId,
        gameId,
        status: "COMPLETED",
        isInProgress() {

            return false;

        }
    });

    const contract = new GameContract({
        contractId: "contract_r88",
        roomId,
        gameId,
        contractAddress: "EQ_TEST",
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
        settlementSessionId: "settle_r88",
        contractId: contract.contractId,
        gameId,
        roomId,
        winnerId: "a",
        winnerWallet: "EQ_WINNER",
        prizeAmount: 2.85,
        organizerAmount: 0.15,
        totalPot: 3,
        status: settlementStatus,
        ownerWallet: "EQ_OWNER"
    });

    contractSettlementManager._byGameId.set(gameId, settlement);

    return {
        playerManager,
        gameManager,
        paymentSessionManager,
        gameContractManager,
        contractSettlementManager,
        gameId,
        roomId,
        settlement,
        shutdown() {

            contractSettlementManager.shutdown();

            gameContractManager.shutdown();

            paymentSessionManager.shutdown();

            gameManager.shutdown();

            playerManager.shutdown();

        }
    };

}

// ---------------------------------------------------------------------------
// PART 10 — SESSION_FINISHED while SETTLEMENT_PENDING
// ---------------------------------------------------------------------------

{

    const { logger, eventBus } = createLoggerBus();

    const stack = seedFinancialStack({
        logger,
        eventBus,
        roomId: "ROOM_SF_PENDING",
        settlementStatus: SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING
    });

    assert.equal(
        shouldPreserveFinancialEvidence({
            roomId: stack.roomId,
            gameManager: stack.gameManager,
            contractSettlementManager: stack.contractSettlementManager,
            gameContractManager: stack.gameContractManager,
            paymentSessionManager: stack.paymentSessionManager
        }),
        true,
        "pending settlement must preserve financial evidence"
    );

    emit(eventBus, EVENT_TYPES.SESSION_FINISHED, {
        roomId: stack.roomId,
        gameId: stack.gameId,
        reason: "result_session_finished"
    });

    assert.ok(
        stack.paymentSessionManager.getSession(stack.roomId),
        "PART10: PaymentSession survives SESSION_FINISHED while PENDING"
    );

    assert.ok(
        stack.gameContractManager.getContract(stack.roomId),
        "PART10: GameContract survives SESSION_FINISHED while PENDING"
    );

    assert.ok(
        stack.contractSettlementManager.getSettlementSession(stack.gameId),
        "PART10: SettlementSession survives SESSION_FINISHED while PENDING"
    );

    console.log("  PART10 SESSION_FINISHED while SETTLEMENT_PENDING passed");

    stack.shutdown();

    eventBus.shutdown();

    logger.shutdown();

}

// ---------------------------------------------------------------------------
// PART 11 — SESSION_FINISHED after SETTLEMENT_COMPLETED allows cleanup
// ---------------------------------------------------------------------------

{

    const { logger, eventBus } = createLoggerBus();

    const stack = seedFinancialStack({
        logger,
        eventBus,
        roomId: "ROOM_SF_DONE",
        settlementStatus: SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED
    });

    assert.equal(
        isSettlementSessionTerminal(SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED),
        true
    );

    // Game still initialized but settlement terminal → cleanup allowed.
    emit(eventBus, EVENT_TYPES.SESSION_FINISHED, {
        roomId: stack.roomId,
        gameId: stack.gameId,
        reason: "result_session_finished"
    });

    assert.equal(
        stack.paymentSessionManager.getSession(stack.roomId),
        null,
        "PART11: PaymentSession cleanup allowed after SETTLEMENT_COMPLETED"
    );

    assert.equal(
        stack.gameContractManager.getContract(stack.roomId),
        null,
        "PART11: GameContract cleanup allowed after SETTLEMENT_COMPLETED"
    );

    assert.equal(
        stack.contractSettlementManager.getSettlementSession(stack.gameId),
        null,
        "PART11: terminal SettlementSession may be forgotten after SESSION_FINISHED"
    );

    console.log("  PART11 SESSION_FINISHED after SETTLEMENT_COMPLETED passed");

    stack.shutdown();

    eventBus.shutdown();

    logger.shutdown();

}

// ---------------------------------------------------------------------------
// PART 12 / 13 — paid / unknown financial state → GAME_DESTROYED = NO
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

    const planted = { gameId: null, result: null };

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

        },
        getContract() {

            return null;

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
        gameplayLifecycle,
        planted,
        gameContractManager,
        contractSettlementManager,
        destroyed: [],
        trackDestroy() {

            eventBus.subscribe(EVENT_TYPES.GAME_DESTROYED, (envelope) => {

                this.destroyed.push(envelope.payload?.gameId);

            });

        },
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

    stack.trackDestroy();

    const game = stack.gameManager.createGame("room_missing_contract", {
        players: ["w1", "w2", "w3"]
    });

    const gameId = game.gameId;

    stack.gameManager.initializeGame(gameId);

    stack.gameManager.markEntryPaymentActivated(gameId);

    stack.planted.gameId = gameId;

    stack.planted.result = Object.freeze({
        gameId,
        winningPlayer: { playerId: "w1" },
        winnerPlayerId: "w1"
    });

    // Contract reference disappeared; no settlement session.
    stack.gameContractManager.contracts.clear();

    stack.contractSettlementManager.sessions.clear();

    emit(stack.eventBus, EVENT_TYPES.GAME_STATE_CHANGED, {
        gameId,
        currentState: GAME_STATES.RESULT,
        state: GAME_STATES.RESULT
    });

    await wait(80);

    assert.equal(
        stack.destroyed.length,
        0,
        "PART12: GAME_DESTROYED must NOT occur when entry-paid + missing contract"
    );

    assert.equal(
        stack.gameManager.hasGame(gameId),
        true,
        "PART12/13: UNKNOWN financial state keeps game alive"
    );

    console.log("  PART12/13 paid/unknown missing-contract keep-alive passed");

    stack.shutdown();

}

// ---------------------------------------------------------------------------
// C23 still works before GAME_INITIALIZED
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

    for (const playerId of ["x1", "x2", "x3"]) {

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
        "C23: ARCHIVED expiry before GAME_INITIALIZED still destroys room"
    );

    assert.equal(roomManager.getRoom(roomId), null);

    console.log("  R8.8 C23 regression still passed");

    setup.shutdown();

    roomManager.shutdown();

    gameManager.shutdown();

    playerManager.shutdown();

    eventBus.shutdown();

    logger.shutdown();

}

console.log("page5LifecycleOwnership.r88.test.js: all assertions passed");
