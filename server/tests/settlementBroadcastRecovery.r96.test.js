/**
 * R9.6 — Settlement broadcast idempotency on recovery resume.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventBus } from "../events/EventBus.js";
import {
    GAME_CONTRACT_STATUS,
    GameContract
} from "../models/GameContract.js";
import { ContractSettlementManager } from "../payment/ContractSettlementManager.js";
import { SettlementSession } from "../payment/SettlementSession.js";
import { SETTLEMENT_SESSION_STATUS } from "../payment/SettlementSessionStates.js";
import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";
import { GAME_CONTRACT_ON_CHAIN_STATUS } from "../payment/ton/gameContract/GameContractOpcodes.js";

const OWNER = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";
const WINNER_WALLET = "EQAREREREREREREREREREREREREREREREREREREREREREeYT";
const DEPLOYER = "EQDeployerWalletForSettlementWatchXXXXXXXX";
const ESCROW = "EQescrowaddressfortestsXXXXXXXXXXXXXX";

function createLogger() {

    return {
        info() {},
        warn() {},
        error() {},
        debug() {},
        decisionTrace() {}
    };

}

function wait(ms) {

    return new Promise((resolve) => setTimeout(resolve, ms));

}

function buildContract(gameId, roomId) {

    const snapshot = Object.freeze({
        gameId,
        roomId,
        ownerWallet: OWNER,
        totalPot: 100,
        payoutAmount: 95,
        organizerFee: 5,
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

    return new GameContract({
        contractId: `contract_${gameId}`,
        gameId,
        roomId,
        status: GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE,
        snapshot,
        contractAddress: ESCROW,
        paymentsCompletedAt: Date.now(),
        tonNetwork: "testnet"
    });

}

function createProbeAdapter({ settled = false, settlementTxHash = null } = {}) {

    const state = {
        settleCalls: 0,
        probeCalls: 0
    };

    return {
        state,
        async settleContract(request) {

            state.settleCalls += 1;

            return {
                ok: true,
                settlementTxId: `tx-r96-${state.settleCalls}`,
                request
            };

        },
        async getContractState() {

            state.probeCalls += 1;

            return {
                status: settled
                    ? GAME_CONTRACT_ON_CHAIN_STATUS.SETTLED
                    : GAME_CONTRACT_ON_CHAIN_STATUS.READY,
                settlementTxHash: settled ? settlementTxHash : null
            };

        },
        async getSettlementState() {

            state.probeCalls += 1;

            return {
                status: settled
                    ? GAME_CONTRACT_ON_CHAIN_STATUS.SETTLED
                    : GAME_CONTRACT_ON_CHAIN_STATUS.READY,
                settlementTxHash: settled ? settlementTxHash : null
            };

        }
    };

}

function createManager({
    persistence,
    eventBus,
    contract,
    adapter,
    blockchainMonitor = null,
    gameEscrowMode = null
}) {

    return new ContractSettlementManager({
        logger: createLogger(),
        eventBus,
        gameContractManager: {
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
            failContract() {}
        },
        winnerEngine: {
            getResult() {

                return { winningPlayer: { playerId: "p1" } };

            }
        },
        configurationEngine: {
            getConfiguration() {

                return { traceSeed: "trace_r96" };

            }
        },
        settlementAdapter: adapter,
        financialPersistence: persistence,
        deployerWalletAddress: DEPLOYER,
        blockchainMonitor: blockchainMonitor ?? {
            watches: [],
            escrowWatches: [],
            watchTransaction(payload) {

                this.watches.push(payload);

                return 1;

            },
            watchGameEscrowSettlement(payload) {

                this.escrowWatches.push(payload);

                return 1;

            }
        },
        gameplayContextResolver: {
            resolveRoomByGameId() {

                return contract.roomId;

            }
        },
        ownerConfiguration: {
            getOwnerWallet() {

                return OWNER;

            }
        },
        settlementTimeoutMs: 60_000,
        tonNetwork: "testnet",
        gameEscrowMode
    });

}

function seedPersistedSession({
    persistence,
    contract,
    status,
    settlementTransactionHash = null
}) {

    const request = Object.freeze({
        gameId: contract.gameId,
        contractId: contract.contractId,
        contractAddress: contract.contractAddress,
        winnerId: "p1",
        winnerWallet: WINNER_WALLET,
        ownerWallet: OWNER,
        winnerAmount: 95,
        organizerAmount: 5,
        totalPot: 100,
        traceSeed: "trace_r96",
        timestamp: Date.now(),
        snapshot: contract.snapshot,
        snapshotHash: null,
        gameEscrowMode: null
    });

    const session = new SettlementSession({
        settlementSessionId: `settle_${contract.gameId}_${status}`,
        contractId: contract.contractId,
        gameId: contract.gameId,
        roomId: contract.roomId,
        winnerId: "p1",
        winnerWallet: WINNER_WALLET,
        prizeAmount: 95,
        organizerAmount: 5,
        totalPot: 100,
        ownerWallet: OWNER,
        network: "testnet",
        status,
        settlementTransactionHash,
        request,
        settlementDeadline: Date.now() + 60_000,
        traceSeed: "trace_r96"
    });

    persistence.createSettlementRecord(session.toPayload(), {
        gameId: session.gameId,
        roomId: session.roomId,
        contractId: session.contractId,
        status: session.status
    });

    return session;

}

async function restartManager({
    dataDir,
    contract,
    adapter,
    gameEscrowMode = null,
    blockchainMonitor = null
}) {

    const persistence = new TonFinancialPersistence({
        dataDir,
        autoCheckpoint: false
    });

    persistence.initialize();

    const eventBus = new EventBus({
        logger: createLogger(),
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const manager = createManager({
        persistence,
        eventBus,
        contract,
        adapter,
        blockchainMonitor,
        gameEscrowMode
    });

    manager.initialize();

    return { persistence, eventBus, manager };

}

async function main() {

    // --- TEST A: chain already settled → settleContract NOT called ---

    {
        const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-r96-a-"));

        const persistence = new TonFinancialPersistence({
            dataDir,
            autoCheckpoint: false
        });

        persistence.initialize();

        const contract = buildContract("game-a", "room-a");

        seedPersistedSession({
            persistence,
            contract,
            status: SETTLEMENT_SESSION_STATUS.READY
        });

        persistence.shutdown({ checkpoint: false });

        const adapter = createProbeAdapter({
            settled: true,
            settlementTxHash: "tx-already-on-chain"
        });

        const { manager, eventBus, persistence: persistence2 } = await restartManager({
            dataDir,
            contract,
            adapter
        });

        manager.restoreSettlementSessions();

        assert.equal(
            manager.getSettlementSession("game-a").status,
            SETTLEMENT_SESSION_STATUS.READY
        );

        const resume = await manager.resumeRestoredSettlements();

        assert.equal(resume.resumed, 1, "TEST A: resumed");

        assert.equal(adapter.state.settleCalls, 0, "TEST A: settleContract not called");

        assert.ok(adapter.state.probeCalls >= 1, "TEST A: on-chain probe used");

        const session = manager.getSettlementSession("game-a");

        assert.ok(
            session.status === SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING
            || session.status
                === SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING_CONFIRMATION
            || session.status === SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED
            || session.status === SETTLEMENT_SESSION_STATUS.SETTLEMENT_CONFIRMED,
            `TEST A: confirmation path status, got ${session.status}`
        );

        assert.equal(session.settlementTransactionHash, "tx-already-on-chain");

        manager.shutdown();

        persistence2.shutdown({ checkpoint: false });

        TonFinancialPersistence.destroyStorage(dataDir);

        eventBus.shutdown();

        console.log("  TEST A chain settled skip settle: OK");

    }

    // --- TEST B: chain not settled → settleContract once ---

    {
        const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-r96-b-"));

        const persistence = new TonFinancialPersistence({
            dataDir,
            autoCheckpoint: false
        });

        persistence.initialize();

        const contract = buildContract("game-b", "room-b");

        seedPersistedSession({
            persistence,
            contract,
            status: SETTLEMENT_SESSION_STATUS.READY
        });

        persistence.shutdown({ checkpoint: false });

        const adapter = createProbeAdapter({ settled: false });

        const { manager, eventBus, persistence: persistence2 } = await restartManager({
            dataDir,
            contract,
            adapter
        });

        manager.restoreSettlementSessions();

        await manager.resumeRestoredSettlements();

        assert.equal(adapter.state.settleCalls, 1, "TEST B: settle once");

        assert.equal(
            manager.getSettlementSession("game-b").status,
            SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING
        );

        manager.shutdown();

        persistence2.shutdown({ checkpoint: false });

        TonFinancialPersistence.destroyStorage(dataDir);

        eventBus.shutdown();

        console.log("  TEST B chain unsettle submit once: OK");

    }

    // --- TEST C: PENDING with hash → no submission ---

    {
        const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-r96-c-"));

        const persistence = new TonFinancialPersistence({
            dataDir,
            autoCheckpoint: false
        });

        persistence.initialize();

        const contract = buildContract("game-c", "room-c");

        seedPersistedSession({
            persistence,
            contract,
            status: SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING,
            settlementTransactionHash: "tx-pending-local"
        });

        persistence.shutdown({ checkpoint: false });

        const adapter = createProbeAdapter({ settled: true });

        const { manager, eventBus, persistence: persistence2 } = await restartManager({
            dataDir,
            contract,
            adapter
        });

        const restored = manager.restoreSettlementSessions();

        assert.ok(restored.rewatched >= 1, "TEST C: rewatch");

        const resume = await manager.resumeRestoredSettlements();

        assert.equal(resume.resumed, 0, "TEST C: resume skipped");

        assert.equal(adapter.state.settleCalls, 0, "TEST C: no settle");

        manager.shutdown();

        persistence2.shutdown({ checkpoint: false });

        TonFinancialPersistence.destroyStorage(dataDir);

        eventBus.shutdown();

        console.log("  TEST C PENDING no resubmit: OK");

    }

    // --- TEST D: recovery twice → one settlement attempt ---

    {
        const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-r96-d-"));

        const persistence = new TonFinancialPersistence({
            dataDir,
            autoCheckpoint: false
        });

        persistence.initialize();

        const contract = buildContract("game-d", "room-d");

        seedPersistedSession({
            persistence,
            contract,
            status: SETTLEMENT_SESSION_STATUS.READY
        });

        persistence.shutdown({ checkpoint: false });

        const adapter = createProbeAdapter({ settled: false });

        const { manager, eventBus, persistence: persistence2 } = await restartManager({
            dataDir,
            contract,
            adapter
        });

        manager.restoreSettlementSessions();

        manager.restoreSettlementSessions();

        await manager.resumeRestoredSettlements();

        await manager.resumeRestoredSettlements();

        assert.equal(adapter.state.settleCalls, 1, "TEST D: one settle only");

        assert.equal(
            [...manager._byGameId.keys()].length,
            1,
            "TEST D: one session"
        );

        manager.shutdown();

        persistence2.shutdown({ checkpoint: false });

        TonFinancialPersistence.destroyStorage(dataDir);

        eventBus.shutdown();

        console.log("  TEST D duplicate recovery one attempt: OK");

    }

    console.log("settlementBroadcastRecovery.r96.test.js: all assertions passed");

    process.exit(0);

}

main().catch((error) => {

    console.error(error);

    process.exit(1);

});
