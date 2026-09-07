/**
 * R18-S80 — UhqU regression: ContractSettlementManager handoff uses
 * winnerAmount / organizerAmount, not prizeAmount. Mocked sendTransfer only.
 * No chain broadcast.
 */

import assert from "node:assert/strict";
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
import { RoomWalletSettlementAdapter } from "../payment/roomWallet/RoomWalletSettlementAdapter.js";
import { SETTLEMENT_SESSION_STATUS } from "../payment/SettlementSessionStates.js";
import { OwnerConfiguration } from "../config/OwnerConfiguration.js";
import { GAME_ESCROW_MODE_GAME } from "../payment/ton/buildGameEscrowStateInit.js";

const OWNER = "0QBaklBYMdMsuq7a2eTYhMkz1OF7ZSHaO1mnFd1MZd3YjC5t";
const WINNER_WALLET = "EQC9qwKAy72kX1oPtryX-g5y44B2mYZEB2HVdJAeJprla_Le";
const UHQU_GAME_ID = "game_3618b43e-f127-4f8f-93ca-84eaa90f1345";

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

function buildUhqUContract() {
    const snapshot = Object.freeze({
        gameId: UHQU_GAME_ID,
        roomId: "UhqU",
        ownerWallet: OWNER,
        totalPot: 3,
        payoutAmount: 2.85,
        organizerFee: 0.15,
        organizerFeeRate: 0.05,
        winnerPercentage: 0.95,
        players: Object.freeze([
            Object.freeze({
                playerId: "olga",
                wallet: WINNER_WALLET,
                requiredGram: 1
            }),
            Object.freeze({
                playerId: "bob",
                wallet: "EQAtggW7l5wfQcPyy38Y7mVuXnh0wRHcpFKPIdtCbcRHb8wM",
                requiredGram: 1
            }),
            Object.freeze({
                playerId: "lena",
                wallet: "EQDeWBnzASv1uz8OUCqjoGb_yrW_TVLc84S5szqFfjkHyCzp",
                requiredGram: 1
            })
        ])
    });

    const contract = new GameContract({
        contractId: "contract_uhqu",
        gameId: UHQU_GAME_ID,
        roomId: "UhqU",
        status: GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE,
        snapshot,
        contractAddress: null,
        paymentsCompletedAt: Date.now()
    });

    contract.status = GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE;
    return contract;
}

test("CSM Room Wallet handoff accepts UhqU winnerAmount without prizeAmount", async () => {
    OwnerConfiguration.resetForTests();

    const sendCalls = [];
    const capturedRequests = [];
    const roomWalletSettlementAdapter = new RoomWalletSettlementAdapter({
        roomWalletAdapter: {
            getGasReserveNano() {
                return 3_000_000n;
            },
            async getBalance() {
                return 10_000_000_000n;
            },
            async sendTransfer(input) {
                sendCalls.push(input);
                return {
                    ok: true,
                    code: "SENT",
                    txHash: `mock-${sendCalls.length}`
                };
            }
        }
    });

    const innerSettle = roomWalletSettlementAdapter.settleContract.bind(
        roomWalletSettlementAdapter
    );
    roomWalletSettlementAdapter.settleContract = async (request) => {
        capturedRequests.push(request);
        return innerSettle(request);
    };

    const legacy = {
        async settleContract() {
            throw new Error("legacy Game Escrow settlement must not run");
        }
    };

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

    const contract = buildUhqUContract();
    const gameContractManager = {
        getContract(roomId) {
            return roomId === "UhqU" ? contract : null;
        },
        getContractByGameId(gameId) {
            return gameId === UHQU_GAME_ID ? contract : null;
        },
        getContractById(contractId) {
            return contractId === "contract_uhqu" ? contract : null;
        },
        markWinnerPending() {
            contract.status = GAME_CONTRACT_STATUS.SETTLEMENT_PREPARING;
        },
        markSettlementPending() {
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

    const manager = new ContractSettlementManager({
        logger,
        eventBus,
        gameContractManager,
        winnerEngine: {
            getResult() {
                return {
                    winningPlayer: { playerId: "olga" },
                    traceSeed: "trace_uhqu"
                };
            }
        },
        configurationEngine: {
            getConfiguration() {
                return { traceSeed: "trace_uhqu" };
            }
        },
        settlementAdapter,
        auditLedger: new EntryPaymentAuditLedger(),
        paymentSessionManager: {
            getSession() {
                return null;
            },
            destroySession() {}
        },
        gameplayContextResolver: {
            resolveRoomByGameId(gameId) {
                return gameId === UHQU_GAME_ID ? "UhqU" : null;
            }
        },
        roomManager: {
            getRoom(roomId) {
                return roomId === "UhqU"
                    ? { roomId: "UhqU", roomNumber: 1 }
                    : null;
            }
        },
        ownerConfiguration: {
            getOwnerWallet() {
                return OWNER;
            }
        },
        gameEscrowMode: GAME_ESCROW_MODE_GAME,
        devMode: false
    });

    manager.initialize();

    const events = [];
    for (const type of [
        EVENT_TYPES.SETTLEMENT_STARTED,
        EVENT_TYPES.SETTLEMENT_SUBMITTED,
        EVENT_TYPES.SETTLEMENT_CONFIRMED,
        EVENT_TYPES.SETTLEMENT_FAILED
    ]) {
        eventBus.subscribe(type, (envelope) => {
            events.push(envelope.type);
        });
    }

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.WINNER_DETERMINED,
        payload: {
            gameId: UHQU_GAME_ID,
            winningPlayerId: "olga"
        }
    });

    await wait(80);

    assert.equal(capturedRequests.length, 1, "adapter must receive the CSM request");
    const request = capturedRequests[0];
    assert.equal(request.winnerAmount, 2.85);
    assert.equal(request.organizerAmount, 0.15);
    assert.equal(request.prizeAmount, undefined);
    assert.equal(request.prizeAmountNano, undefined);
    assert.equal(request.roomNumber, 1);
    assert.equal(request.winnerWallet, WINNER_WALLET);
    assert.equal(request.ownerWallet, OWNER);
    assert.equal(request.contractAddress, null);

    assert.equal(sendCalls.length, 2);
    assert.equal(sendCalls[0].destination, WINNER_WALLET);
    assert.equal(sendCalls[0].amountNano, 2_850_000_000n);
    assert.equal(sendCalls[0].roomNumber, 1);
    assert.equal(sendCalls[1].destination, OWNER);
    assert.equal(sendCalls[1].amountNano, 140_000_000n);
    assert.equal(sendCalls[1].roomNumber, 1);

    const session = manager._byGameId.get(UHQU_GAME_ID);
    assert.ok(session, "settlement session must exist");
    assert.equal(session.status, SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED);
    assert.equal(contract.status, GAME_CONTRACT_STATUS.SETTLEMENT_COMPLETED);
    assert.equal(events.includes(EVENT_TYPES.SETTLEMENT_FAILED), false);
    assert.equal(events.includes(EVENT_TYPES.SETTLEMENT_CONFIRMED), true);
    assert.equal(session.reason, null);
});

test("transient Room Wallet adapter throw is retryable and does not strand SETTLEMENT_FAILED", async () => {
    OwnerConfiguration.resetForTests();

    const settlementAdapter = new RoomWalletSettlementRouter({
        legacySettlementAdapter: {
            async settleContract() {
                throw new Error("legacy must not run");
            }
        },
        roomWalletSettlementAdapter: {
            async settleContract() {
                throw new TypeError("wallet_unavailable");
            }
        },
        enabled: true
    });

    const logger = createLogger();
    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });
    eventBus.initialize();

    const contract = buildUhqUContract();
    const gameContractManager = {
        getContract() {
            return contract;
        },
        getContractByGameId() {
            return contract;
        },
        getContractById() {
            return contract;
        },
        markWinnerPending() {
            contract.status = GAME_CONTRACT_STATUS.SETTLEMENT_PREPARING;
        },
        markSettlementPending() {
            contract.status = GAME_CONTRACT_STATUS.SETTLEMENT_PENDING;
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

    const manager = new ContractSettlementManager({
        logger,
        eventBus,
        gameContractManager,
        winnerEngine: {
            getResult() {
                return {
                    winningPlayer: { playerId: "olga" },
                    traceSeed: "trace_fail"
                };
            }
        },
        configurationEngine: {
            getConfiguration() {
                return { traceSeed: "trace_fail" };
            }
        },
        settlementAdapter,
        auditLedger: new EntryPaymentAuditLedger(),
        paymentSessionManager: { destroySession() {} },
        gameplayContextResolver: {
            resolveRoomByGameId() {
                return "UhqU";
            }
        },
        roomManager: {
            getRoom() {
                return { roomId: "UhqU", roomNumber: 1 };
            }
        },
        ownerConfiguration: {
            getOwnerWallet() {
                return OWNER;
            }
        },
        roomWalletRetryDelayMs: 20,
        devMode: false
    });

    manager.initialize();

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.WINNER_DETERMINED,
        payload: {
            gameId: UHQU_GAME_ID,
            winningPlayerId: "olga"
        }
    });

    await wait(40);

    const session = manager._byGameId.get(UHQU_GAME_ID);
    assert.equal(session.status, SETTLEMENT_SESSION_STATUS.READY);
    assert.match(String(session.reason), /adapter_threw:wallet_unavailable/);
    assert.notEqual(contract.status, GAME_CONTRACT_STATUS.SETTLEMENT_FAILED);
    assert.notEqual(contract.status, GAME_CONTRACT_STATUS.SETTLEMENT_COMPLETED);
    manager.shutdown();
});
