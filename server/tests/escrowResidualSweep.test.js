/**
 * Post-settlement residual sweep: trigger, idempotency, persistence, no re-SETTLE.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import {
    GAME_CONTRACT_STATUS,
    GameContract
} from "../models/GameContract.js";
import { EntryPaymentAuditLedger } from "../payment/BlockchainMonitor.js";
import { ContractSettlementManager } from "../payment/ContractSettlementManager.js";
import { SettlementSession } from "../payment/SettlementSession.js";
import { SETTLEMENT_SESSION_STATUS } from "../payment/SettlementSessionStates.js";
import { GAME_ESCROW_MODE_GAME } from "../payment/ton/buildGameEscrowStateInit.js";
import { GAME_ESCROW_SETTLE_GAS_RESERVE_TON } from "../payment/ton/gameContract/GameContractOpcodes.js";
import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";
import { TON_FINANCIAL_RECORD_TYPES } from "../persistence/TonFinancialRecordTypes.js";

const OWNER = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";
const WINNER_WALLET = "EQAREREREREREREREREREREREREREREREREREREREREREeYT";
const DEPLOY_WALLET = "EQDeployWalletSameAsOracleXXXXXXXXXXXXXX";
const ESCROW = "EQBWeMKZpNcixJiG-JOLE-9qpQ1hp6HXyEiLxgkoCew3914p";

function createLogger() {

    return {
        info() {},
        warn() {},
        error() {},
        debug() {}
    };

}

function wait(ms) {

    return new Promise((resolve) => setTimeout(resolve, ms));

}

function buildContract() {

    const snapshot = Object.freeze({
        gameId: "game-sweep-1",
        roomId: "room-sweep-1",
        ownerWallet: OWNER,
        escrowMode: GAME_ESCROW_MODE_GAME,
        totalPot: 3,
        payoutAmount: 2.85,
        organizerFee: 0.15,
        organizerFeeRate: 0.05,
        winnerPercentage: 0.95,
        players: Object.freeze([
            Object.freeze({
                playerId: "p1",
                wallet: WINNER_WALLET,
                requiredGram: 1
            }),
            Object.freeze({
                playerId: "p2",
                wallet: "EQOtherPlayerWalletXXXXXXXXXXXXXXXXXXXX",
                requiredGram: 1
            }),
            Object.freeze({
                playerId: "p3",
                wallet: "EQThirdPlayerWalletXXXXXXXXXXXXXXXXXXX",
                requiredGram: 1
            })
        ])
    });

    const contract = new GameContract({
        contractId: "contract_sweep_1",
        gameId: "game-sweep-1",
        roomId: "room-sweep-1",
        status: GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE,
        snapshot,
        contractAddress: ESCROW,
        paymentsCompletedAt: Date.now()
    });

    return contract;

}

function createCompletedSession() {

    return new SettlementSession({
        settlementSessionId: "settle_sweep_1",
        contractId: "contract_sweep_1",
        gameId: "game-sweep-1",
        roomId: "room-sweep-1",
        winnerId: "p1",
        winnerWallet: WINNER_WALLET,
        ownerWallet: OWNER,
        prizeAmount: 2.85,
        organizerAmount: 0.15,
        totalPot: 3,
        network: "testnet",
        status: SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED,
        settlementTransactionHash: "settle_tx_hash_1",
        completedAt: Date.now(),
        request: Object.freeze({
            gameId: "game-sweep-1",
            contractId: "contract_sweep_1",
            contractAddress: ESCROW,
            gameEscrowMode: GAME_ESCROW_MODE_GAME,
            winnerWallet: WINNER_WALLET,
            ownerWallet: OWNER,
            winnerAmount: 2.85,
            organizerAmount: 0.15
        })
    });

}

function createHarness({
    tonNetwork = "testnet",
    sweepResult = null,
    sweepImpl = null
} = {}) {

    const logger = createLogger();
    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });
    eventBus.initialize();

    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-residual-sweep-"));
    const persistence = new TonFinancialPersistence({ dataDir, autoCheckpoint: false });
    persistence.initialize();

    const contract = buildContract();
    const gameContractManager = {
        getContract() {

            return contract;

        },
        getContractByGameId(gameId) {

            return gameId === "game-sweep-1" ? contract : null;

        },
        getContractById(contractId) {

            return contractId === "contract_sweep_1" ? contract : null;

        },
        markWinnerPending() {},
        markSettlementPending() {},
        updateContractState() {},
        completeContract() {

            contract.status = GAME_CONTRACT_STATUS.SETTLEMENT_COMPLETED;

        },
        failContract() {},
        notifyClientUpdate() {}
    };

    const settleCalls = [];
    const sweepCalls = [];

    const settlementAdapter = {
        async settleContract(request) {

            settleCalls.push(request);

            return {
                ok: true,
                settlementTxId: "settle_tx_hash_1",
                settledAt: Date.now()
            };

        },
        async sweepSettledResidual(request) {

            sweepCalls.push(request);

            if (typeof sweepImpl === "function") {

                return sweepImpl(request, sweepCalls.length);

            }

            return sweepResult ?? {
                ok: true,
                txId: "sweep_tx_hash_1",
                recipient: DEPLOY_WALLET,
                residualAmountBefore: "81351049",
                residualAmountAfter: "40000000",
                reserveTon: GAME_ESCROW_SETTLE_GAS_RESERVE_TON,
                alreadySwept: false,
                completedAt: Date.now()
            };

        }
    };

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
        blockchainMonitor: {
            watchGameEscrowSettlement() {

                return true;

            }
        },
        auditLedger: new EntryPaymentAuditLedger(),
        financialPersistence: persistence,
        paymentSessionManager: {
            destroySession() {}
        },
        gameplayContextResolver: {
            resolveRoomByGameId(gameId) {

                return gameId === "game-sweep-1" ? "room-sweep-1" : null;

            }
        },
        ownerConfiguration: {
            getOwnerWallet() {

                return OWNER;

            }
        },
        tonNetwork,
        gameEscrowMode: GAME_ESCROW_MODE_GAME
    });

    manager.initialize();

    return {
        manager,
        contract,
        persistence,
        settleCalls,
        sweepCalls,
        eventBus,
        shutdown() {

            manager.shutdown();
            persistence.shutdown({ checkpoint: false });

        }
    };

}

async function main() {

    {
        const harness = createHarness();
        const session = createCompletedSession();
        harness.manager._byGameId.set(session.gameId, session);

        await harness.manager._maybeSweepSettledResidual(session);
        await wait(10);

        assert.equal(harness.settleCalls.length, 0, "sweep must not call SETTLE");
        assert.equal(harness.sweepCalls.length, 1);
        assert.equal(harness.sweepCalls[0].contractAddress, ESCROW);

        const audits = harness.persistence.findByGame("game-sweep-1")
            .filter((record) => record.recordType === TON_FINANCIAL_RECORD_TYPES.AUDIT);
        assert.equal(audits.length, 1);
        assert.equal(audits[0].payload.action, "RESIDUAL_SWEEP");
        assert.equal(audits[0].payload.recipientDeployWallet, DEPLOY_WALLET);
        assert.equal(audits[0].payload.sweepTransactionHash, "sweep_tx_hash_1");
        assert.equal(audits[0].payload.confirmationStatus, "CONFIRMED");
        assert.equal(audits[0].payload.escrowAddress, ESCROW);
        assert.equal(audits[0].payload.reserveTon, GAME_ESCROW_SETTLE_GAS_RESERVE_TON);
        assert.ok(audits[0].payload.timestamp);

        await harness.manager._maybeSweepSettledResidual(session);
        await wait(10);
        assert.equal(harness.sweepCalls.length, 1, "confirmed sweep must not repeat");

        harness.shutdown();
        console.log("  successful sweep records hash and is idempotent: OK");
    }

    {
        const harness = createHarness();
        const session = createCompletedSession();
        session.status = SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING_CONFIRMATION;
        harness.manager._byGameId.set(session.gameId, session);

        await harness.manager._maybeSweepSettledResidual(session);
        await wait(10);

        assert.equal(harness.sweepCalls.length, 0, "must not sweep before SETTLED/COMPLETED");

        harness.shutdown();
        console.log("  sweep blocked before completed settlement: OK");
    }

    {
        let sweepAttempts = 0;
        const harness = createHarness({
            sweepImpl() {

                sweepAttempts += 1;

                if (sweepAttempts === 1) {

                    return {
                        ok: false,
                        reason: "sweep_unconfirmed"
                    };

                }

                return {
                    ok: true,
                    txId: "sweep_tx_retry",
                    recipient: DEPLOY_WALLET,
                    reserveTon: GAME_ESCROW_SETTLE_GAS_RESERVE_TON,
                    alreadySwept: false,
                    completedAt: Date.now()
                };

            }
        });

        const session = createCompletedSession();
        harness.manager._byGameId.set(session.gameId, session);

        await harness.manager._maybeSweepSettledResidual(session);
        await wait(10);
        assert.equal(harness.settleCalls.length, 0);
        assert.equal(harness.sweepCalls.length, 1);
        assert.equal(
            harness.manager.getSettlementSession(session.gameId).status,
            SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED
        );

        const failedAudits = harness.persistence.findByGame("game-sweep-1")
            .filter((record) => record.recordType === TON_FINANCIAL_RECORD_TYPES.AUDIT);
        assert.equal(failedAudits.length, 0, "failed sweep must not write CONFIRMED audit");

        await harness.manager._maybeSweepSettledResidual(session);
        await wait(10);
        assert.equal(harness.settleCalls.length, 0, "failed sweep must not re-SETTLE");
        assert.equal(harness.sweepCalls.length, 2, "failed sweep is retryable");

        const audits = harness.persistence.findByGame("game-sweep-1")
            .filter((record) => record.recordType === TON_FINANCIAL_RECORD_TYPES.AUDIT);
        assert.equal(audits.length, 1);
        assert.equal(audits[0].payload.sweepTransactionHash, "sweep_tx_retry");

        harness.shutdown();
        console.log("  failed sweep retries without SETTLE: OK");
    }

    {
        const harness = createHarness({ tonNetwork: "mainnet" });
        const session = createCompletedSession();
        session.network = "mainnet";
        harness.manager._byGameId.set(session.gameId, session);

        await harness.manager._maybeSweepSettledResidual(session);
        await wait(10);

        assert.equal(harness.sweepCalls.length, 0, "mainnet must not sweep");

        harness.shutdown();
        console.log("  mainnet sweep skipped: OK");
    }

    {
        const harness = createHarness();

        harness.eventBus.emit({
            source: "test",
            type: EVENT_TYPES.WINNER_DETERMINED,
            payload: {
                gameId: "game-sweep-1",
                winningPlayerId: "p1"
            }
        });
        await wait(30);

        assert.equal(harness.settleCalls.length, 1);
        assert.equal(harness.settleCalls[0].winnerAmount, 2.85);
        assert.equal(harness.settleCalls[0].organizerAmount, 0.15);
        assert.equal(harness.sweepCalls.length, 0, "sweep waits for payout verification");

        const pending = harness.manager.getSettlementSession("game-sweep-1");
        assert.equal(
            pending.status,
            SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING_CONFIRMATION
        );

        harness.eventBus.emit({
            source: "test",
            type: EVENT_TYPES.GAME_ESCROW_SETTLEMENT_VERIFIED,
            payload: {
                gameId: "game-sweep-1",
                escrowAddress: ESCROW,
                settleTxHash: "settle_tx_hash_1"
            }
        });
        await wait(30);

        assert.equal(harness.settleCalls.length, 1, "payout confirm must not SETTLE again");
        assert.equal(harness.sweepCalls.length, 1);
        assert.equal(
            harness.manager.getSettlementSession("game-sweep-1").status,
            SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED
        );

        const audits = harness.persistence.findByGame("game-sweep-1")
            .filter((record) => record.recordType === TON_FINANCIAL_RECORD_TYPES.AUDIT);
        assert.ok(
            audits.some((record) => (
                record.payload.action === "RESIDUAL_SWEEP"
                && record.payload.sweepTransactionHash === "sweep_tx_hash_1"
                && record.payload.recipientDeployWallet === DEPLOY_WALLET
            ))
        );

        harness.eventBus.emit({
            source: "test",
            type: EVENT_TYPES.GAME_ESCROW_SETTLEMENT_VERIFIED,
            payload: {
                gameId: "game-sweep-1",
                escrowAddress: ESCROW,
                settleTxHash: "settle_tx_hash_1"
            }
        });
        await wait(20);
        assert.equal(harness.settleCalls.length, 1);
        assert.equal(harness.sweepCalls.length, 1);

        harness.shutdown();
        console.log("  sweep after payout verification, no duplicate SETTLE: OK");
    }

    console.log("escrowResidualSweep.test.js: all assertions passed");

}

main().catch((error) => {

    console.error(error);
    process.exitCode = 1;

});
