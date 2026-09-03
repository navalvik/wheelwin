/**
 * Reconcile recovered on-chain settlement after SETTLEMENT_FAILED (game du4w).
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
import {
    ContractSettlementManager,
    DU4W_RECOVERED_ON_CHAIN_SETTLEMENT
} from "../payment/ContractSettlementManager.js";
import { SETTLEMENT_SESSION_STATUS } from "../payment/SettlementSessionStates.js";
import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";

const CONFIRMED_TX = DU4W_RECOVERED_ON_CHAIN_SETTLEMENT.settlementTransactionHash;
const GAME_ID = DU4W_RECOVERED_ON_CHAIN_SETTLEMENT.gameId;
const ROOM_ID = DU4W_RECOVERED_ON_CHAIN_SETTLEMENT.roomId;
const WINNER_ID = DU4W_RECOVERED_ON_CHAIN_SETTLEMENT.winnerId;
const WINNER_WALLET = "EQDeWBnzASv1uz8OUCqjoGb_yrW_TVLc84S5szqFfjkHyCzp";
const OWNER_WALLET = "EQBaklBYMdMsuq7a2eTYhMkz1OF7ZSHaO1mnFd1MZd3YjMgi";
const CONTRACT_ID = "contract_a6a8a052-d80d-4f8d-9e96-e2d360912ded";
const FAILED_AT = 1_757_000_000_000;

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

function seedFailedSettlement(persistence) {

    return persistence.createSettlementRecord(
        {
            settlementSessionId: "settle_du4w_failed",
            contractId: CONTRACT_ID,
            gameId: GAME_ID,
            roomId: ROOM_ID,
            winnerId: WINNER_ID,
            winnerWallet: WINNER_WALLET,
            prizeAmount: 2.85,
            winnerAmount: 2.85,
            organizerAmount: 0.15,
            totalPot: 3,
            network: "testnet",
            status: SETTLEMENT_SESSION_STATUS.SETTLEMENT_FAILED,
            settlementTransactionHash: null,
            settlementTxHash: null,
            createdAt: FAILED_AT - 5_000,
            updatedAt: FAILED_AT,
            completedAt: null,
            failedAt: FAILED_AT,
            reason: "settle_failed",
            ownerWallet: OWNER_WALLET,
            recoveryMetadata: null,
            request: {
                gameId: GAME_ID,
                contractId: CONTRACT_ID,
                contractAddress: DU4W_RECOVERED_ON_CHAIN_SETTLEMENT.escrowAddress,
                winnerId: WINNER_ID,
                winnerWallet: WINNER_WALLET,
                ownerWallet: OWNER_WALLET,
                winnerAmount: 2.85,
                organizerAmount: 0.15,
                totalPot: 3
            }
        },
        {
            correlationId: "corr-du4w",
            roomId: ROOM_ID,
            gameId: GAME_ID,
            contractId: CONTRACT_ID,
            tonNetwork: "testnet",
            status: SETTLEMENT_SESSION_STATUS.SETTLEMENT_FAILED
        }
    );

}

function createHarness(dataDir) {

    const logger = createLogger();
    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const persistence = new TonFinancialPersistence({
        dataDir,
        autoCheckpoint: false
    });

    persistence.initialize();

    const contract = new GameContract({
        contractId: CONTRACT_ID,
        gameId: GAME_ID,
        roomId: ROOM_ID,
        status: GAME_CONTRACT_STATUS.SETTLEMENT_FAILED,
        contractAddress: DU4W_RECOVERED_ON_CHAIN_SETTLEMENT.escrowAddress,
        failureReason: "settle_failed",
        tonNetwork: "testnet",
        snapshot: Object.freeze({
            gameId: GAME_ID,
            roomId: ROOM_ID,
            ownerWallet: OWNER_WALLET,
            totalPot: 3,
            payoutAmount: 2.85,
            organizerFee: 0.15,
            players: Object.freeze([
                Object.freeze({
                    playerId: WINNER_ID,
                    wallet: WINNER_WALLET,
                    requiredGram: 1
                })
            ])
        })
    });

    const settleCalls = [];

    const gameContractManager = {
        getContract(roomId) {

            return roomId === ROOM_ID ? contract : null;

        },
        getContractByGameId(gameId) {

            return gameId === GAME_ID ? contract : null;

        },
        getContractById(contractId) {

            return contractId === CONTRACT_ID ? contract : null;

        },
        markWinnerPending() {},
        markSettlementPending() {},
        updateContractState(_roomId, status) {

            contract.status = status;

        },
        completeContract() {

            if (contract.status === GAME_CONTRACT_STATUS.SETTLEMENT_COMPLETED) {

                return contract;

            }

            const ok = contract.transitionTo(GAME_CONTRACT_STATUS.SETTLEMENT_COMPLETED);

            if (!ok) {

                throw new Error(`invalid complete from ${contract.status}`);

            }

            return contract;

        },
        failContract(_roomId, reason) {

            contract.status = GAME_CONTRACT_STATUS.SETTLEMENT_FAILED;
            contract.failureReason = reason;

        },
        notifyClientUpdate() {}
    };

    const auditLedger = new EntryPaymentAuditLedger();

    const manager = new ContractSettlementManager({
        logger,
        eventBus,
        gameContractManager,
        winnerEngine: {
            getResult() {

                return {
                    winningPlayer: { playerId: WINNER_ID },
                    traceSeed: "trace_du4w"
                };

            }
        },
        configurationEngine: {
            getConfiguration() {

                return { traceSeed: "trace_du4w" };

            }
        },
        settlementAdapter: {
            async settleContract(request) {

                settleCalls.push(request);

                return {
                    ok: true,
                    settlementTxId: "SHOULD_NOT_BROADCAST"
                };

            }
        },
        auditLedger,
        financialPersistence: persistence,
        ownerConfiguration: {
            getOwnerWallet() {

                return OWNER_WALLET;

            }
        },
        tonNetwork: "testnet"
    });

    manager.initialize();

    const events = [];

    for (const type of [
        EVENT_TYPES.SETTLEMENT_RECOVERED,
        EVENT_TYPES.SETTLEMENT_COMPLETED,
        EVENT_TYPES.SETTLEMENT_FAILED,
        EVENT_TYPES.SETTLEMENT_STARTED,
        EVENT_TYPES.SETTLEMENT_SUBMITTED
    ]) {

        eventBus.subscribe(type, (envelope) => {

            events.push(envelope.type);

        });

    }

    return {
        eventBus,
        manager,
        persistence,
        contract,
        auditLedger,
        settleCalls,
        events,
        shutdown() {

            manager.shutdown();
            persistence.shutdown();
            eventBus.shutdown();

        }
    };

}

async function main() {

    const dataDir = mkdtempSync(join(tmpdir(), "ww-du4w-settle-"));
    const harness = createHarness(dataDir);

    try {

        const failedRecord = seedFailedSettlement(harness.persistence);

        assert.equal(failedRecord.status, SETTLEMENT_SESSION_STATUS.SETTLEMENT_FAILED);
        assert.equal(failedRecord.immutable, true);
        assert.equal(failedRecord.payload.settlementTransactionHash, null);

        harness.auditLedger.append(ROOM_ID, {
            type: "SETTLEMENT_FAILED",
            gameId: GAME_ID,
            reason: "settle_failed",
            httpStatus: 429,
            finalStatus: SETTLEMENT_SESSION_STATUS.SETTLEMENT_FAILED
        });

        assert.equal(
            harness.manager.getSettlementSession(GAME_ID),
            null,
            "terminal FAILED is not restored into memory"
        );

        const session = await harness.manager.reconcileRecoveredOnChainSettlement(
            DU4W_RECOVERED_ON_CHAIN_SETTLEMENT
        );

        assert.ok(session, "reconcile returns the recovered session");
        assert.equal(session.status, SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED);
        assert.equal(session.settlementTransactionHash, CONFIRMED_TX);
        assert.equal(session.settlementTxHash, CONFIRMED_TX);
        assert.equal(session.prizeAmount, 2.85);
        assert.equal(session.organizerAmount, 0.15);
        assert.equal(session.winnerId, WINNER_ID);
        assert.equal(session.failedAt, FAILED_AT);
        assert.equal(session.reason, "settle_failed");
        assert.equal(
            session.recoveryMetadata?.originalStatus,
            SETTLEMENT_SESSION_STATUS.SETTLEMENT_FAILED
        );
        assert.equal(session.recoveryMetadata?.httpStatus, 429);
        assert.match(
            session.recoveryMetadata?.originalFailure ?? "",
            /HTTP 429/
        );
        assert.equal(session.recoveryMetadata?.probeStatus, "READY");
        assert.equal(session.recoveryMetadata?.onChainStatus, "SETTLED");

        const persisted = harness.persistence.loadSettlementRecord(GAME_ID);

        assert.equal(persisted.status, SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED);
        assert.equal(persisted.payload.status, SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED);
        assert.equal(persisted.payload.settlementTransactionHash, CONFIRMED_TX);
        assert.equal(persisted.payload.settlementTxHash, CONFIRMED_TX);
        assert.equal(persisted.payload.winnerAmount, 2.85);
        assert.equal(persisted.payload.organizerAmount, 0.15);
        assert.equal(persisted.payload.reason, "settle_failed");
        assert.equal(persisted.payload.failedAt, FAILED_AT);
        assert.equal(
            persisted.payload.recoveryMetadata.originalStatus,
            SETTLEMENT_SESSION_STATUS.SETTLEMENT_FAILED
        );

        assert.equal(
            harness.contract.status,
            GAME_CONTRACT_STATUS.SETTLEMENT_COMPLETED
        );
        assert.equal(harness.contract.failureReason, "settle_failed");

        const audit = harness.auditLedger.list(ROOM_ID);
        const auditTypes = audit.map((entry) => entry.type);

        assert.ok(
            auditTypes.includes("SETTLEMENT_FAILED"),
            "original SETTLEMENT_FAILED audit remains"
        );
        assert.ok(auditTypes.includes("SETTLEMENT_RECOVERED"));
        assert.ok(auditTypes.includes("SETTLEMENT_COMPLETED"));

        assert.ok(harness.events.includes(EVENT_TYPES.SETTLEMENT_RECOVERED));
        assert.ok(harness.events.includes(EVENT_TYPES.SETTLEMENT_COMPLETED));
        assert.equal(
            harness.events.includes(EVENT_TYPES.SETTLEMENT_FAILED),
            false,
            "reconcile must not re-emit SETTLEMENT_FAILED"
        );

        const again = await harness.manager.reconcileRecoveredOnChainSettlement(
            DU4W_RECOVERED_ON_CHAIN_SETTLEMENT
        );

        assert.equal(again.status, SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED);
        assert.equal(again.settlementTransactionHash, CONFIRMED_TX);

        const recoveredEvents = harness.events.filter(
            (type) => type === EVENT_TYPES.SETTLEMENT_RECOVERED
        );

        assert.equal(
            recoveredEvents.length,
            1,
            "idempotent reconcile does not re-emit recovery"
        );

        harness.eventBus.emit({
            source: "test",
            type: EVENT_TYPES.WINNER_DETERMINED,
            payload: {
                gameId: GAME_ID,
                roomId: ROOM_ID,
                winnerPlayerId: WINNER_ID
            }
        });

        await wait(40);

        assert.equal(
            harness.settleCalls.length,
            0,
            "already-reconciled SETTLED session must not be paid again"
        );
        assert.equal(
            harness.manager.getSettlementSession(GAME_ID).status,
            SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED
        );
        assert.equal(
            harness.manager.getSettlementSession(GAME_ID).settlementTransactionHash,
            CONFIRMED_TX
        );

        const duplicateAudit = harness.auditLedger.list(ROOM_ID)
            .some((entry) => entry.type === "SETTLEMENT_DUPLICATE_IGNORED");

        assert.equal(duplicateAudit, true);

        const missing = await harness.manager.reconcileRecoveredOnChainSettlement({
            ...DU4W_RECOVERED_ON_CHAIN_SETTLEMENT,
            gameId: "game_does_not_exist"
        });

        assert.equal(missing, null);

        console.log("  recovered settlement reconcile du4w: OK");

    } finally {

        harness.shutdown();
        TonFinancialPersistence.destroyStorage(dataDir);

    }

}

main().catch((error) => {

    console.error(error);
    process.exit(1);

});
