/**
 * R18-S83 — Room Wallet settlement is retryable, idempotent, and restart-safe.
 * Mocked chain inspect and sendTransfer only. No live broadcast.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import {
    GAME_CONTRACT_STATUS,
    GameContract
} from "../models/GameContract.js";
import { EntryPaymentAuditLedger } from "../payment/BlockchainMonitor.js";
import { ContractSettlementManager } from "../payment/ContractSettlementManager.js";
import { RoomWalletSettlementRouter } from "../payment/RoomWalletSettlementRouter.js";
import { SETTLEMENT_SESSION_STATUS } from "../payment/SettlementSessionStates.js";
import { OwnerConfiguration } from "../config/OwnerConfiguration.js";
import { GAME_ESCROW_MODE_GAME } from "../payment/ton/buildGameEscrowStateInit.js";
import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";
import { TON_FINANCIAL_RECORD_TYPES } from "../persistence/TonFinancialRecordTypes.js";

const OWNER = "0QBaklBYMdMsuq7a2eTYhMkz1OF7ZSHaO1mnFd1MZd3YjC5t";
const WINNER_WALLET = "EQC9qwKAy72kX1oPtryX-g5y44B2mYZEB2HVdJAeJprla_Le";
const GAME_ID = "game_s83_retryable_settlement";

function createLogger() {
    return { info() {}, error() {}, warn() {}, debug() {} };
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildContract(gameId = GAME_ID) {
    const snapshot = Object.freeze({
        gameId,
        roomId: "RmS3",
        roomNumber: 1,
        ownerWallet: OWNER,
        totalPot: 3,
        payoutAmount: 2.85,
        organizerFee: 0.15,
        organizerFeeRate: 0.05,
        winnerPercentage: 0.95,
        players: Object.freeze([
            Object.freeze({ playerId: "olga", wallet: WINNER_WALLET, requiredGram: 1 }),
            Object.freeze({ playerId: "bob", wallet: "EQAtggW7l5wfQcPyy38Y7mVuXnh0wRHcpFKPIdtCbcRHb8wM", requiredGram: 1 }),
            Object.freeze({ playerId: "lena", wallet: "EQDeWBnzASv1uz8OUCqjoGb_yrW_TVLc84S5szqFfjkHyCzp", requiredGram: 1 })
        ])
    });
    const contract = new GameContract({
        contractId: `contract_${gameId}`,
        gameId,
        roomId: "RmS3",
        status: GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE,
        snapshot,
        contractAddress: null,
        paymentsCompletedAt: Date.now()
    });
    contract.status = GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE;
    return contract;
}

function createHarness({ settle, inspectSettlement = null, persist = false, reimbursement = null }) {
    OwnerConfiguration.resetForTests();
    const settleCalls = [];
    const events = [];
    const destroyedSessions = [];
    const reimbursementCalls = [];
    const legacy = {
        async settleContract() {
            throw new Error("legacy Game Escrow settlement must not run");
        }
    };
    const roomWalletSettlementAdapter = {
        async settleContract(request) {
            settleCalls.push(request);
            return settle(request, settleCalls);
        },
        inspectSettlement: inspectSettlement
            ?? (async () => ({ unavailable: true }))
    };
    if (reimbursement) {
        roomWalletSettlementAdapter.reimburse = async (...args) => {
            reimbursementCalls.push(args);
            return reimbursement(...args);
        };
    }
    const settlementAdapter = new RoomWalletSettlementRouter({
        legacySettlementAdapter: legacy,
        roomWalletSettlementAdapter,
        enabled: true
    });
    const logger = createLogger();
    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });
    eventBus.initialize();
    eventBus.subscribe(EVENT_TYPES.SETTLEMENT_CONFIRMED, () => events.push(EVENT_TYPES.SETTLEMENT_CONFIRMED));
    eventBus.subscribe(EVENT_TYPES.SETTLEMENT_COMPLETED, () => events.push(EVENT_TYPES.SETTLEMENT_COMPLETED));
    eventBus.subscribe(EVENT_TYPES.SETTLEMENT_FAILED, () => events.push(EVENT_TYPES.SETTLEMENT_FAILED));
    const contract = buildContract();
    const gameContractManager = {
        getContract() { return contract; },
        getContractByGameId() { return contract; },
        getContractById() { return contract; },
        markWinnerPending() { contract.status = GAME_CONTRACT_STATUS.SETTLEMENT_PREPARING; },
        markSettlementPending() { contract.status = GAME_CONTRACT_STATUS.SETTLEMENT_PENDING; },
        updateContractState(_roomId, status) { contract.status = status; },
        completeContract() { contract.status = GAME_CONTRACT_STATUS.SETTLEMENT_COMPLETED; },
        failContract(_roomId, reason) {
            contract.status = GAME_CONTRACT_STATUS.SETTLEMENT_FAILED;
            contract.failureReason = reason;
        },
        notifyClientUpdate() {}
    };
    const dataDir = persist ? mkdtempSync(join(tmpdir(), "ww-s83-")) : null;
    const financialPersistence = persist
        ? new TonFinancialPersistence({ dataDir, logger })
        : null;
    financialPersistence?.initialize();
    const manager = new ContractSettlementManager({
        logger,
        eventBus,
        gameContractManager,
        winnerEngine: {
            getResult() {
                return { winningPlayer: { playerId: "olga" }, traceSeed: "s83" };
            }
        },
        configurationEngine: { getConfiguration() { return { traceSeed: "s83" }; } },
        settlementAdapter,
        auditLedger: new EntryPaymentAuditLedger(),
        paymentSessionManager: {
            destroySession(roomId) { destroyedSessions.push(roomId); }
        },
        gameplayContextResolver: { resolveRoomByGameId() { return "RmS3"; } },
        financialPersistence,
        roomManager: { getRoom() { return { roomId: "RmS3", roomNumber: 1 }; } },
        ownerConfiguration: { getOwnerWallet() { return OWNER; } },
        gameEscrowMode: GAME_ESCROW_MODE_GAME,
        roomWalletRetryDelayMs: 20,
        settlementTimeoutMs: 60_000
    });
    manager.initialize();
    return {
        manager,
        eventBus,
        contract,
        settleCalls,
        events,
        destroyedSessions,
        reimbursementCalls,
        financialPersistence,
        dataDir,
        async win(gameId = GAME_ID) {
            eventBus.emit({
                source: "test",
                type: EVENT_TYPES.WINNER_DETERMINED,
                payload: { gameId, winningPlayerId: "olga" }
            });
            await wait(40);
        },
        shutdown() {
            manager.shutdown();
            eventBus.shutdown();
        }
    };
}

test("transient adapter throw stays retryable and then confirms", async () => {
    let attempts = 0;
    const harness = createHarness({
        settle: async () => {
            attempts += 1;
            if (attempts === 1) {
                throw new TypeError("rpc_timeout");
            }
            return {
                ok: true,
                chainInspected: true,
                winnerConfirmed: true,
                ownerConfirmed: true,
                winner: { txHash: "w1" },
                owner: { txHash: "o1" }
            };
        }
    });
    await harness.win();
    const session = harness.manager.getSettlementSession(GAME_ID);
    assert.equal(harness.events.includes(EVENT_TYPES.SETTLEMENT_FAILED), false);
    assert.notEqual(session.status, SETTLEMENT_SESSION_STATUS.SETTLEMENT_FAILED);
    assert.notEqual(harness.contract.status, GAME_CONTRACT_STATUS.SETTLEMENT_FAILED);
    await wait(80);
    const after = harness.manager.getSettlementSession(GAME_ID);
    assert.equal(after.status, SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED);
    assert.equal(harness.events.includes(EVENT_TYPES.SETTLEMENT_CONFIRMED), true);
    assert.equal(harness.destroyedSessions.includes("RmS3"), true);
    assert.equal(attempts, 2);
    harness.shutdown();
});

test("RPC inspect unknown is retryable and does not fail terminal", async () => {
    const harness = createHarness({
        settle: async () => ({
            ok: false,
            retryable: true,
            chainInspected: true,
            code: "CHAIN_INSPECT_UNKNOWN"
        })
    });
    await harness.win();
    const session = harness.manager.getSettlementSession(GAME_ID);
    assert.equal(session.isTerminal(), false);
    assert.equal(harness.events.includes(EVENT_TYPES.SETTLEMENT_FAILED), false);
    harness.shutdown();
});

test("both existing payouts confirm settlement without a second architecture", async () => {
    const harness = createHarness({
        settle: async () => ({
            ok: true,
            code: "SETTLEMENT_ADOPTED",
            chainInspected: true,
            winnerConfirmed: true,
            ownerConfirmed: true,
            winner: { txHash: "w-adopt" },
            owner: { txHash: "o-adopt" }
        })
    });
    await harness.win();
    const session = harness.manager.getSettlementSession(GAME_ID);
    assert.equal(session.status, SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED);
    assert.equal(session.settlementTransactionHash, "w-adopt");
    assert.equal(harness.events.includes(EVENT_TYPES.SETTLEMENT_CONFIRMED), true);
    harness.shutdown();
});

test("duplicate payout history fails closed", async () => {
    const harness = createHarness({
        settle: async () => ({
            ok: false,
            retryable: false,
            chainInspected: true,
            code: "DUPLICATE_PAYOUT"
        })
    });
    await harness.win();
    const session = harness.manager.getSettlementSession(GAME_ID);
    assert.equal(session.status, SETTLEMENT_SESSION_STATUS.SETTLEMENT_FAILED);
    assert.equal(session.reason, "DUPLICATE_PAYOUT");
    harness.shutdown();
});

test("reused Room Wallet fails closed", async () => {
    const harness = createHarness({
        settle: async () => ({
            ok: false,
            retryable: false,
            chainInspected: true,
            code: "WALLET_REUSED"
        })
    });
    await harness.win();
    assert.equal(
        harness.manager.getSettlementSession(GAME_ID).status,
        SETTLEMENT_SESSION_STATUS.SETTLEMENT_FAILED
    );
    harness.shutdown();
});

test("restart after winner-only result resumes adapter instead of failing", async () => {
    const harness = createHarness({
        persist: true,
        settle: async () => ({
            ok: false,
            retryable: true,
            partial: true,
            chainInspected: true,
            code: "OWNER_PAYOUT_FAILED_AFTER_WINNER",
            winner: { txHash: "winner-only" },
            owner: null
        })
    });
    await harness.win();
    const live = harness.manager.getSettlementSession(GAME_ID);
    assert.equal(live.status, SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING);
    assert.equal(live.settlementTransactionHash, "winner-only");
    assert.equal(live.isTerminal(), false);
    harness.manager.shutdown();

    const logger = createLogger();
    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });
    eventBus.initialize();
    let resumed = 0;
    const second = new ContractSettlementManager({
        logger,
        eventBus,
        gameContractManager: {
            getContract() { return harness.contract; },
            getContractByGameId() { return harness.contract; },
            getContractById() { return harness.contract; },
            markWinnerPending() {},
            markSettlementPending() {},
            updateContractState() {},
            completeContract() { harness.contract.status = GAME_CONTRACT_STATUS.SETTLEMENT_COMPLETED; },
            failContract() {},
            notifyClientUpdate() {}
        },
        winnerEngine: { getResult() { return { winningPlayer: { playerId: "olga" } }; } },
        settlementAdapter: new RoomWalletSettlementRouter({
            legacySettlementAdapter: { async settleContract() { throw new Error("legacy"); } },
            roomWalletSettlementAdapter: {
                async settleContract() {
                    resumed += 1;
                    return {
                        ok: true,
                        chainInspected: true,
                        winnerConfirmed: true,
                        ownerConfirmed: true,
                        winner: { txHash: "winner-only" },
                        owner: { txHash: "owner-later" }
                    };
                },
                async inspectSettlement() {
                    return {
                        unavailable: false,
                        unknown: false,
                        reused: false,
                        winnerPayout: { hash: "winner-only" },
                        ownerPayout: null
                    };
                }
            },
            enabled: true
        }),
        financialPersistence: harness.financialPersistence,
        gameplayContextResolver: { resolveRoomByGameId() { return "RmS3"; } },
        roomManager: { getRoom() { return { roomId: "RmS3", roomNumber: 1 }; } },
        ownerConfiguration: { getOwnerWallet() { return OWNER; } },
        gameEscrowMode: GAME_ESCROW_MODE_GAME,
        roomWalletRetryDelayMs: 20
    });
    second.initialize();
    const restored = second.restoreSettlementSessions();
    assert.equal(restored.restored >= 1, true);
    await second.resumeRestoredSettlements();
    const session = second.getSettlementSession(GAME_ID);
    assert.equal(session.status, SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED);
    assert.equal(resumed, 1);
    second.shutdown();
    eventBus.shutdown();
    harness.shutdown();
});

test("historical SETTLEMENT_FAILED remains failed and is not rewritten", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ww-s83-failed-"));
    const persistence = new TonFinancialPersistence({ dataDir, logger: createLogger() });
    persistence.initialize();
    persistence.createSettlementRecord({
        gameId: "game_unclassified_failed",
        roomId: "XyzZ",
        status: SETTLEMENT_SESSION_STATUS.SETTLEMENT_FAILED,
        winnerAmount: 2.85,
        organizerAmount: 0.15,
        reason: "adapter_threw:rpc_timeout",
        originalStatus: "SETTLEMENT_FAILED"
    }, {
        gameId: "game_unclassified_failed",
        roomId: "XyzZ",
        status: SETTLEMENT_SESSION_STATUS.SETTLEMENT_FAILED
    });
    const logger = createLogger();
    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });
    eventBus.initialize();
    let settleCalls = 0;
    const manager = new ContractSettlementManager({
        logger,
        eventBus,
        gameContractManager: {
            getContract() { return null; },
            getContractByGameId() { return null; },
            getContractById() { return null; }
        },
        winnerEngine: { getResult() { return null; } },
        settlementAdapter: new RoomWalletSettlementRouter({
            legacySettlementAdapter: { async settleContract() { throw new Error("legacy"); } },
            roomWalletSettlementAdapter: {
                async settleContract() {
                    settleCalls += 1;
                    return { ok: true };
                }
            },
            enabled: true
        }),
        financialPersistence: persistence,
        gameEscrowMode: GAME_ESCROW_MODE_GAME
    });
    manager.initialize();
    const restored = manager.restoreSettlementSessions();
    assert.equal(restored.restored, 0);
    await manager.resumeRestoredSettlements();
    assert.equal(settleCalls, 0);
    const record = persistence.loadSettlementRecord("game_unclassified_failed");
    assert.equal(record.status, SETTLEMENT_SESSION_STATUS.SETTLEMENT_FAILED);
    assert.match(String(record.payload?.reason ?? record.reason ?? ""), /rpc_timeout/);
    manager.shutdown();
    eventBus.shutdown();
});

test("Room Wallet settlement does not invoke reimbursement or Game Escrow", async () => {
    const harness = createHarness({
        reimbursement: async () => ({ ok: true }),
        settle: async () => ({
            ok: true,
            chainInspected: true,
            winnerConfirmed: true,
            ownerConfirmed: true,
            winner: { txHash: "w" },
            owner: { txHash: "o" }
        })
    });
    await harness.win();
    assert.equal(harness.reimbursementCalls.length, 0);
    assert.equal(harness.settleCalls[0].winnerAmount, 2.85);
    assert.equal(harness.settleCalls[0].organizerAmount, 0.15);
    harness.shutdown();
});

test("src.copy adapter throw stays READY and retries instead of terminal FAILED", async () => {
    let attempts = 0;
    let releaseSecond;
    const secondAttempt = new Promise((resolve) => {
        releaseSecond = resolve;
    });
    const harness = createHarness({
        settle: async () => {
            attempts += 1;
            if (attempts === 1) {
                throw new TypeError("src.copy is not a function");
            }
            await secondAttempt;
            return {
                ok: true,
                chainInspected: true,
                winnerConfirmed: true,
                ownerConfirmed: true,
                winner: { txHash: "w-s85" },
                owner: { txHash: "o-s85" }
            };
        }
    });
    await harness.win();
    const first = harness.manager.getSettlementSession(GAME_ID);
    assert.equal(first.status, SETTLEMENT_SESSION_STATUS.READY);
    assert.match(String(first.reason), /src\.copy is not a function/);
    assert.equal(harness.events.includes(EVENT_TYPES.SETTLEMENT_FAILED), false);
    releaseSecond();
    await wait(80);
    const after = harness.manager.getSettlementSession(GAME_ID);
    assert.equal(after.status, SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED);
    assert.equal(harness.events.includes(EVENT_TYPES.SETTLEMENT_CONFIRMED), true);
    assert.equal(attempts >= 2, true);
    harness.shutdown();
});

test("Room Wallet READY resume uses persisted request snapshot when live contract is gone", async () => {
    const harness = createHarness({
        persist: true,
        settle: async () => {
            throw new TypeError("src.copy is not a function");
        }
    });
    await harness.win();
    const live = harness.manager.getSettlementSession(GAME_ID);
    assert.equal(live.status, SETTLEMENT_SESSION_STATUS.READY);
    assert.equal(Boolean(live.request?.snapshot), true);
    harness.manager.shutdown();

    const logger = createLogger();
    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });
    eventBus.initialize();
    let resumed = 0;
    const second = new ContractSettlementManager({
        logger,
        eventBus,
        gameContractManager: {
            getContract() { return null; },
            getContractByGameId() { return null; },
            getContractById() { return null; },
            markWinnerPending() {},
            markSettlementPending() {},
            updateContractState() {},
            completeContract() {},
            failContract() {},
            notifyClientUpdate() {}
        },
        winnerEngine: { getResult() { return { winningPlayer: { playerId: "olga" } }; } },
        settlementAdapter: new RoomWalletSettlementRouter({
            legacySettlementAdapter: { async settleContract() { throw new Error("legacy"); } },
            roomWalletSettlementAdapter: {
                async settleContract() {
                    resumed += 1;
                    return {
                        ok: true,
                        chainInspected: true,
                        winnerConfirmed: true,
                        ownerConfirmed: true,
                        winner: { txHash: "w-resume" },
                        owner: { txHash: "o-resume" }
                    };
                },
                async inspectSettlement() {
                    return {
                        unavailable: false,
                        unknown: false,
                        reused: false,
                        winnerPayout: null,
                        ownerPayout: null
                    };
                }
            },
            enabled: true
        }),
        financialPersistence: harness.financialPersistence,
        gameplayContextResolver: { resolveRoomByGameId() { return "RmS3"; } },
        roomManager: { getRoom() { return { roomId: "RmS3", roomNumber: 1 }; } },
        ownerConfiguration: { getOwnerWallet() { return OWNER; } },
        gameEscrowMode: GAME_ESCROW_MODE_GAME,
        roomWalletRetryDelayMs: 20
    });
    second.initialize();
    const restored = second.restoreSettlementSessions();
    assert.equal(restored.restored >= 1, true);
    await second.resumeRestoredSettlements();
    const session = second.getSettlementSession(GAME_ID);
    assert.equal(session.status, SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED);
    assert.equal(resumed, 1);
    second.shutdown();
    eventBus.shutdown();
    harness.shutdown();
});
