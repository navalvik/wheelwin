import assert from "node:assert/strict";

import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import {
    GAME_CONTRACT_STATUS,
    GameContract
} from "../models/GameContract.js";
import { EntryPaymentAuditLedger } from "../payment/BlockchainMonitor.js";
import { ContractSettlementManager } from "../payment/ContractSettlementManager.js";
import { GameContractDeployAdapter } from "../payment/GameContractDeployAdapter.js";
import { maskWalletAddress } from "../payment/maskWalletAddress.js";
import { OwnerConfiguration } from "../config/OwnerConfiguration.js";
import { GameplayPhaseLifecycle } from "../gameplay/GameplayPhaseLifecycle.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";

const OWNER = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";
const WINNER_WALLET = "EQAREREREREREREREREREREREREREREREREREREREREREeYT";

function createLogger() {

    return {
        info() {},
        error() {},
        warn() {},
        debug() {}
    };

}

function wait(ms) {

    return new Promise((resolve) => setTimeout(resolve, ms));

}

function buildContract({ status = GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE } = {}) {

    const snapshot = Object.freeze({
        gameId: "game-1",
        roomId: "room-1",
        ownerWallet: OWNER,
        totalPot: 100,
        payoutAmount: 95,
        organizerFee: 5,
        organizerFeeRate: 0.05,
        winnerPercentage: 0.95,
        players: Object.freeze([
            Object.freeze({
                playerId: "p1",
                wallet: WINNER_WALLET,
                requiredGram: 30
            }),
            Object.freeze({
                playerId: "p2",
                wallet: "EQOtherPlayerWalletXXXXXXXXXXXXXXXXXXXX",
                requiredGram: 35
            }),
            Object.freeze({
                playerId: "p3",
                wallet: "EQThirdPlayerWalletXXXXXXXXXXXXXXXXXXX",
                requiredGram: 35
            })
        ])
    });

    const contract = new GameContract({
        contractId: "contract_1",
        gameId: "game-1",
        roomId: "room-1",
        status: GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE,
        snapshot,
        contractAddress: "EQescrowaddressfortestsXXXXXXXXXXXXXX",
        paymentsCompletedAt: Date.now()
    });

    // Force status for tests that need non-ready states.
    contract.status = status;

    return contract;

}

function createHarness({ shouldFail = false } = {}) {

    OwnerConfiguration.resetForTests();

    const logger = createLogger();

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const auditLedger = new EntryPaymentAuditLedger();

    const contract = buildContract();

    const contracts = new Map([["room-1", contract]]);

    const gameContractManager = {
        getContract(roomId) {

            return contracts.get(roomId) ?? null;

        },
        getContractByGameId(gameId) {

            return gameId === "game-1" ? contract : null;

        },
        getContractById(contractId) {

            return contractId === "contract_1" ? contract : null;

        },
        markWinnerPending() {

            contract.status = GAME_CONTRACT_STATUS.SETTLEMENT_PREPARING;

        },
        markSettlementPending() {

            contract.status = GAME_CONTRACT_STATUS.SETTLEMENT_SUBMITTED;

            contract.status = GAME_CONTRACT_STATUS.SETTLEMENT_PENDING;

        },
        updateContractState(_roomId, status) {

            contract.status = status;

        },
        completeContract() {

            contract.status = GAME_CONTRACT_STATUS.SETTLEMENT_COMPLETED;

        },
        failContract(_roomId, reason) {

            contract.status = GAME_CONTRACT_STATUS.SETTLEMENT_FAILED;

            contract.failureReason = reason;

        },
        notifyClientUpdate() {}
    };

    const settlementAdapter = new GameContractDeployAdapter({
        deployDelayMs: 0,
        shouldFail
    });

    const destroyedSessions = [];

    const manager = new ContractSettlementManager({
        logger,
        eventBus,
        gameContractManager,
        winnerEngine: {
            getResult() {

                return {
                    winningPlayer: { playerId: "p1" },
                    traceSeed: "trace_1"
                };

            }
        },
        configurationEngine: {
            getConfiguration() {

                return { traceSeed: "trace_1" };

            }
        },
        settlementAdapter,
        auditLedger,
        paymentSessionManager: {
            destroySession(roomId) {

                destroyedSessions.push(roomId);

            }
        },
        gameplayContextResolver: {
            resolveRoomByGameId(gameId) {

                return gameId === "game-1" ? "room-1" : null;

            }
        },
        ownerConfiguration: {
            getOwnerWallet() {

                return OWNER;

            }
        },
        devMode: false
    });

    manager.initialize();

    const events = [];

    for (const type of [
        EVENT_TYPES.SETTLEMENT_STARTED,
        EVENT_TYPES.SETTLEMENT_SUBMITTED,
        EVENT_TYPES.SETTLEMENT_CONFIRMED,
        EVENT_TYPES.SETTLEMENT_COMPLETED,
        EVENT_TYPES.SETTLEMENT_FAILED,
        EVENT_TYPES.OPEN_PAGE6
    ]) {

        eventBus.subscribe(type, (envelope) => {

            events.push(envelope.type);

        });

    }

    return {
        eventBus,
        manager,
        contract,
        auditLedger,
        destroyedSessions,
        events,
        async win() {

            eventBus.emit({
                source: "test",
                type: EVENT_TYPES.WINNER_DETERMINED,
                payload: {
                    gameId: "game-1",
                    winningPlayerId: "p1"
                }
            });

            await wait(20);

        }
    };

}

{
    assert.equal(
        maskWalletAddress(OWNER),
        "EQAA...AM9c",
        "owner wallet must be masked in logs"
    );

    console.log("  maskWalletAddress passed");

}

{
    const harness = createHarness();

    await harness.win();

    assert.ok(
        harness.events.includes(EVENT_TYPES.SETTLEMENT_STARTED),
        "settlement started"
    );

    assert.ok(
        harness.events.includes(EVENT_TYPES.SETTLEMENT_CONFIRMED),
        "settlement confirmed"
    );

    assert.ok(
        harness.events.includes(EVENT_TYPES.SETTLEMENT_COMPLETED),
        "settlement completed"
    );

    assert.equal(
        harness.contract.status,
        GAME_CONTRACT_STATUS.SETTLEMENT_COMPLETED
    );

    const settlement = harness.manager.getSettlement("game-1");

    assert.equal(
        settlement.status,
        GAME_CONTRACT_STATUS.SETTLEMENT_COMPLETED
    );

    assert.equal(settlement.winnerAmount, 95);

    assert.equal(settlement.organizerAmount, 5);

    assert.equal(settlement.winnerId, "p1");

    assert.ok(settlement.settlementTxHash);

    assert.deepEqual(harness.destroyedSessions, ["room-1"]);

    const audit = harness.auditLedger.list("room-1")
        .filter((entry) => entry.category === "CONTRACT_SETTLEMENT");

    assert.ok(audit.some((entry) => entry.type === "SETTLEMENT_COMPLETED"));

    assert.ok(
        audit.every((entry) => entry.ownerWallet === undefined),
        "full owner wallet must not appear in audit (masked only)"
    );

    assert.ok(
        audit.some((entry) => entry.ownerWalletMasked),
        "masked owner wallet recorded"
    );

    // Idempotent duplicate
    harness.events.length = 0;

    await harness.win();

    assert.equal(
        harness.events.filter((type) => type === EVENT_TYPES.SETTLEMENT_COMPLETED)
            .length,
        0,
        "duplicate WINNER_DETERMINED must not resettle"
    );

    assert.ok(
        harness.auditLedger.list("room-1").some(
            (entry) => entry.type === "SETTLEMENT_DUPLICATE_IGNORED"
        )
    );

    console.log("  ContractSettlementManager happy path + idempotency passed");

    harness.manager.shutdown();

}

{
    const harness = createHarness({ shouldFail: true });

    await harness.win();

    assert.ok(
        harness.events.includes(EVENT_TYPES.SETTLEMENT_FAILED),
        "adapter failure emits SETTLEMENT_FAILED"
    );

    assert.equal(
        harness.events.includes(EVENT_TYPES.SETTLEMENT_COMPLETED),
        false
    );

    assert.equal(
        harness.contract.status,
        GAME_CONTRACT_STATUS.SETTLEMENT_FAILED
    );

    console.log("  ContractSettlementManager adapter failure passed");

    harness.manager.shutdown();

}

{
    const harness = createHarness();

    harness.contract.status = GAME_CONTRACT_STATUS.AWAITING_PLAYER_PAYMENTS;

    await harness.win();

    assert.ok(harness.events.includes(EVENT_TYPES.SETTLEMENT_FAILED));

    assert.equal(
        harness.events.includes(EVENT_TYPES.SETTLEMENT_COMPLETED),
        false,
        "invalid contract state must not settle on-chain"
    );

    console.log("  ContractSettlementManager validation gate passed");

    harness.manager.shutdown();

}

{
    // Optional P6.8B gate: OPEN_PAGE6 waits for SETTLEMENT_COMPLETED when enabled.
    const logger = createLogger();

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const openPage6 = [];

    eventBus.subscribe(EVENT_TYPES.OPEN_PAGE6, (envelope) => {

        openPage6.push(envelope.payload);

    });

    const gatedLifecycle = new GameplayPhaseLifecycle({
        logger,
        eventBus,
        gameStateEngine: {
            getState() {

                return GAME_STATES.RESULT;

            },
            transition() {

                return { gameId: "game-1" };

            }
        },
        gameClockEngine: {},
        winnerEngine: {
            getResult() {

                return { winningPlayer: { playerId: "p1" } };

            }
        },
        requireSettlementBeforePage6: true,
        devMode: false
    });

    gatedLifecycle.initialize();

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.RESULT_COMPLETED,
        payload: { gameId: "game-1", phase: GAME_STATES.RESULT }
    });

    assert.equal(openPage6.length, 0, "OPEN_PAGE6 must wait for settlement when gated");

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.SETTLEMENT_COMPLETED,
        payload: { gameId: "game-1" }
    });

    assert.equal(openPage6.length, 1, "OPEN_PAGE6 after SETTLEMENT_COMPLETED when gated");

    gatedLifecycle.shutdown();

    // R5.19 — production wiring disables the gate so RESULT_COMPLETED alone opens Page6.
    openPage6.length = 0;

    const ungatedLifecycle = new GameplayPhaseLifecycle({
        logger,
        eventBus,
        gameStateEngine: {
            getState() {

                return GAME_STATES.RESULT;

            },
            transition() {

                return { gameId: "game-2" };

            }
        },
        gameClockEngine: {},
        winnerEngine: {
            getResult() {

                return { winningPlayer: { playerId: "p1" } };

            }
        },
        requireSettlementBeforePage6: false,
        devMode: false
    });

    ungatedLifecycle.initialize();

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.RESULT_COMPLETED,
        payload: { gameId: "game-2", phase: GAME_STATES.RESULT }
    });

    assert.equal(
        openPage6.length,
        1,
        "R5.19 OPEN_PAGE6 after RESULT_COMPLETED when settlement gate disabled"
    );

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.RESULT_COMPLETED,
        payload: { gameId: "game-2", phase: GAME_STATES.RESULT }
    });

    assert.equal(openPage6.length, 1, "OPEN_PAGE6 remains exactly once");

    ungatedLifecycle.shutdown();

    console.log("  OPEN_PAGE6 settlement gate + R5.19 ungated path passed");

}

{
    const harness = createHarness();

    const blockchainMonitor = {
        watches: [],
        watchTransaction(payload) {

            this.watches.push(payload);

        }
    };

    harness.manager._blockchainMonitor = blockchainMonitor;

    await harness.win();

    assert.equal(blockchainMonitor.watches.length, 1);

    assert.equal(
        harness.manager.getSettlementSession("game-1").status,
        "SETTLEMENT_PENDING"
    );

    harness.eventBus.emit({
        source: "test",
        type: EVENT_TYPES.SETTLEMENT_TRANSACTION_CONFIRMED,
        payload: {
            gameId: "game-1",
            contractId: "contract_1",
            transactionId: blockchainMonitor.watches[0].transactionId
        }
    });

    await wait(10);

    assert.equal(
        harness.manager.getSettlement("game-1").status,
        GAME_CONTRACT_STATUS.SETTLEMENT_COMPLETED
    );

    console.log("  blockchain confirmation path: OK");

    harness.manager.shutdown();

}

{
    const { EventBus } = await import("../events/EventBus.js");
    const { TonFinancialPersistence } = await import("../persistence/TonFinancialPersistence.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-settlement-"));

    const logger = createLogger();

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const contract = buildContract();

    const persistence = new TonFinancialPersistence({ dataDir });

    persistence.initialize();

    const gameContractManager = {
        getContract: () => contract,
        getContractByGameId: () => contract,
        getContractById: () => contract,
        markWinnerPending() {},
        markSettlementPending() {},
        updateContractState(_roomId, status) {

            contract.status = status;

        },
        completeContract() {

            contract.status = GAME_CONTRACT_STATUS.SETTLEMENT_COMPLETED;

        },
        failContract() {

            contract.status = GAME_CONTRACT_STATUS.SETTLEMENT_FAILED;

        }
    };

    const firstManager = new ContractSettlementManager({
        logger,
        eventBus,
        gameContractManager,
        winnerEngine: {
            getResult() {

                return { winningPlayer: { playerId: "p1" } };

            }
        },
        configurationEngine: {
            getConfiguration() {

                return { traceSeed: "trace_1" };

            }
        },
        settlementAdapter: new GameContractDeployAdapter({ deployDelayMs: 0 }),
        financialPersistence: persistence,
        gameplayContextResolver: {
            resolveRoomByGameId() {

                return "room-1";

            }
        },
        ownerConfiguration: {
            getOwnerWallet() {

                return OWNER;

            }
        }
    });

    firstManager.initialize();

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.WINNER_DETERMINED,
        payload: { gameId: "game-1", winningPlayerId: "p1" }
    });

    await wait(20);

    persistence.shutdown();

    const secondManager = new ContractSettlementManager({
        logger,
        eventBus,
        gameContractManager,
        winnerEngine: {
            getResult() {

                return { winningPlayer: { playerId: "p1" } };

            }
        },
        settlementAdapter: new GameContractDeployAdapter({ deployDelayMs: 0 }),
        financialPersistence: new TonFinancialPersistence({ dataDir }),
        gameplayContextResolver: {
            resolveRoomByGameId() {

                return "room-1";

            }
        },
        ownerConfiguration: {
            getOwnerWallet() {

                return OWNER;

            }
        }
    });

    secondManager._financialPersistence.initialize();

    secondManager.initialize();

    const summary = secondManager.restoreSettlementSessions();

    assert.equal(summary.restored, 0, "completed settlement not restored as active");

    TonFinancialPersistence.destroyStorage(dataDir);

    firstManager.shutdown();

    secondManager.shutdown();

    eventBus.shutdown();

    console.log("  persistence restore skips completed: OK");

}

{
    const harness = createHarness();

    const health = harness.manager.health();

    assert.equal(typeof health.activeSettlements, "number");

    assert.equal(typeof health.lastSettlement, "object");

    const dashboard = harness.manager.getDashboardSnapshot("game-1");

    assert.equal(dashboard.health.activeSettlements, 0);

    console.log("  health + dashboard: OK");

    harness.manager.shutdown();

}

console.log("contractSettlement.manager.test.js: all assertions passed");
