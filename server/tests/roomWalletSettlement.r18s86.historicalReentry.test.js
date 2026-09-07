/**
 * R18-S86 — Historical prizeAmount FAILED can re-enter ordinary Room Wallet
 * settlement. Safety FAILED stays terminal. Mocked adapter only. No TON send.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_CONTRACT_STATUS, GameContract } from "../models/GameContract.js";
import { ContractSettlementManager } from "../payment/ContractSettlementManager.js";
import { RoomWalletSettlementRouter } from "../payment/RoomWalletSettlementRouter.js";
import { SETTLEMENT_SESSION_STATUS } from "../payment/SettlementSessionStates.js";
import { GAME_ESCROW_MODE_GAME } from "../payment/ton/buildGameEscrowStateInit.js";
import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";
import { UHQU_GAME_ID } from "../payment/roomWallet/sealedTerminalSettlementEvidence.js";
import { HISTORICAL_ROOM_WALLET_ADAPTER_INTERFACE_FAILURE } from "../payment/roomWallet/historicalRoomWalletSettlementReentry.js";

const OWNER = "0QBaklBYMdMsuq7a2eTYhMkz1OF7ZSHaO1mnFd1MZd3YjC5t";
const WINNER_WALLET = "EQC9qwKAy72kX1oPtryX-g5y44B2mYZEB2HVdJAeJprla_Le";

function createLogger() {
    return { info() {}, error() {}, warn() {}, debug() {} };
}

function persistFailed({
    gameId,
    roomId,
    reason,
    includeRequest = true
}) {
    const dataDir = mkdtempSync(join(tmpdir(), "ww-s86-"));
    const persistence = new TonFinancialPersistence({
        dataDir,
        logger: createLogger()
    });
    persistence.initialize();
    const request = includeRequest
        ? {
            gameId,
            roomId,
            roomNumber: 1,
            winnerId: "olga",
            winnerWallet: WINNER_WALLET,
            ownerWallet: OWNER,
            winnerAmount: 2.85,
            organizerAmount: 0.15,
            totalPot: 3,
            snapshot: {
                gameId,
                roomId,
                ownerWallet: OWNER,
                payoutAmount: 2.85,
                organizerFee: 0.15,
                totalPot: 3
            }
        }
        : null;
    persistence.createSettlementRecord({
        settlementSessionId: `settle_${gameId}`,
        gameId,
        roomId,
        winnerId: includeRequest ? "olga" : null,
        winnerWallet: includeRequest ? WINNER_WALLET : null,
        ownerWallet: includeRequest ? OWNER : null,
        prizeAmount: 2.85,
        winnerAmount: 2.85,
        organizerAmount: 0.15,
        totalPot: 3,
        status: SETTLEMENT_SESSION_STATUS.SETTLEMENT_FAILED,
        reason,
        request
    }, {
        gameId,
        roomId,
        status: SETTLEMENT_SESSION_STATUS.SETTLEMENT_FAILED
    });
    return persistence;
}

function createManager({ persistence, settle, inspectSettlement }) {
    const settleCalls = [];
    const logger = createLogger();
    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });
    eventBus.initialize();
    const snapshot = Object.freeze({
        gameId: UHQU_GAME_ID,
        roomId: "UhqU",
        ownerWallet: OWNER,
        payoutAmount: 2.85,
        organizerFee: 0.15,
        totalPot: 3
    });
    const contract = new GameContract({
        contractId: "contract_uhqu",
        gameId: UHQU_GAME_ID,
        roomId: "UhqU",
        status: GAME_CONTRACT_STATUS.SETTLEMENT_FAILED,
        snapshot,
        contractAddress: null
    });
    contract.status = GAME_CONTRACT_STATUS.SETTLEMENT_FAILED;
    const manager = new ContractSettlementManager({
        logger,
        eventBus,
        gameContractManager: {
            getContract() { return contract; },
            getContractByGameId() { return contract; },
            getContractById() { return contract; },
            markWinnerPending() {},
            markSettlementPending() {},
            updateContractState() {},
            completeContract() { contract.status = GAME_CONTRACT_STATUS.SETTLEMENT_COMPLETED; },
            failContract() {},
            notifyClientUpdate() {}
        },
        winnerEngine: { getResult() { return { winningPlayer: { playerId: "olga" } }; } },
        settlementAdapter: new RoomWalletSettlementRouter({
            legacySettlementAdapter: {
                async settleContract() {
                    throw new Error("legacy Game Escrow settlement must not run");
                }
            },
            roomWalletSettlementAdapter: {
                async settleContract(request) {
                    settleCalls.push(request);
                    return settle(request, settleCalls);
                },
                inspectSettlement: inspectSettlement ?? (async () => ({
                    unavailable: false,
                    unknown: false,
                    reused: false,
                    winnerPayout: null,
                    ownerPayout: null
                }))
            },
            enabled: true
        }),
        financialPersistence: persistence,
        gameplayContextResolver: { resolveRoomByGameId() { return "UhqU"; } },
        roomManager: { getRoom() { return { roomId: "UhqU", roomNumber: 1 }; } },
        ownerConfiguration: { getOwnerWallet() { return OWNER; } },
        gameEscrowMode: GAME_ESCROW_MODE_GAME,
        settlementTimeoutMs: 60_000
    });
    manager.initialize();
    return { manager, eventBus, settleCalls, contract };
}

test("historical prizeAmount FAILED re-enters ordinary Room Wallet settlement", async () => {
    const persistence = persistFailed({
        gameId: UHQU_GAME_ID,
        roomId: "UhqU",
        reason: HISTORICAL_ROOM_WALLET_ADAPTER_INTERFACE_FAILURE
    });
    const { manager, eventBus, settleCalls } = createManager({
        persistence,
        settle: async () => ({
            ok: true,
            chainInspected: true,
            winnerConfirmed: true,
            ownerConfirmed: true,
            winner: { txHash: "uhqu-w" },
            owner: { txHash: "uhqu-o" }
        })
    });
    const restored = manager.restoreSettlementSessions();
    assert.equal(restored.restored, 1);
    const live = manager.getSettlementSession(UHQU_GAME_ID);
    assert.equal(live.status, SETTLEMENT_SESSION_STATUS.READY);
    assert.equal(live.recoveryMetadata.originalStatus, SETTLEMENT_SESSION_STATUS.SETTLEMENT_FAILED);
    await manager.resumeRestoredSettlements();
    const after = manager.getSettlementSession(UHQU_GAME_ID);
    assert.equal(after.status, SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED);
    assert.equal(settleCalls.length, 1);
    assert.equal(settleCalls[0].winnerAmount, 2.85);
    assert.equal(settleCalls[0].organizerAmount, 0.15);
    assert.equal(settleCalls[0].winnerWallet, WINNER_WALLET);
    manager.shutdown();
    eventBus.shutdown();
});

test("WALLET_REUSED FAILED remains terminal and is not re-entered", async () => {
    const persistence = persistFailed({
        gameId: "game_safety_reused",
        roomId: "Safe",
        reason: "WALLET_REUSED"
    });
    let settleCalls = 0;
    const { manager, eventBus } = createManager({
        persistence,
        settle: async () => {
            settleCalls += 1;
            return { ok: true };
        }
    });
    const restored = manager.restoreSettlementSessions();
    assert.equal(restored.restored, 0);
    await manager.resumeRestoredSettlements();
    assert.equal(settleCalls, 0);
    assert.equal(manager.getSettlementSession("game_safety_reused"), null);
    const record = persistence.loadSettlementRecord("game_safety_reused");
    assert.equal(record.status, SETTLEMENT_SESSION_STATUS.SETTLEMENT_FAILED);
    manager.shutdown();
    eventBus.shutdown();
});

test("DUPLICATE_PAYOUT FAILED remains terminal and is not re-entered", async () => {
    const persistence = persistFailed({
        gameId: "game_safety_dup",
        roomId: "Dupl",
        reason: "DUPLICATE_PAYOUT"
    });
    let settleCalls = 0;
    const { manager, eventBus } = createManager({
        persistence,
        settle: async () => {
            settleCalls += 1;
            return { ok: true };
        }
    });
    const restored = manager.restoreSettlementSessions();
    assert.equal(restored.restored, 0);
    await manager.resumeRestoredSettlements();
    assert.equal(settleCalls, 0);
    manager.shutdown();
    eventBus.shutdown();
});

test("historical re-entry does not call operator-recovery or legacy escrow", async () => {
    const persistence = persistFailed({
        gameId: UHQU_GAME_ID,
        roomId: "UhqU",
        reason: HISTORICAL_ROOM_WALLET_ADAPTER_INTERFACE_FAILURE
    });
    const { manager, eventBus, settleCalls } = createManager({
        persistence,
        settle: async () => ({
            ok: true,
            chainInspected: true,
            winnerConfirmed: true,
            ownerConfirmed: true,
            winner: { txHash: "w" },
            owner: { txHash: "o" }
        })
    });
    manager.restoreSettlementSessions();
    await manager.resumeRestoredSettlements();
    assert.equal(settleCalls.length, 1);
    assert.equal(Object.hasOwn(manager, "_operatorRecovery"), false);
    manager.shutdown();
    eventBus.shutdown();
});
