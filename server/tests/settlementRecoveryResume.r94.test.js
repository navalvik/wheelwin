/**
 * R9.4 — Settlement CREATED/READY/PENDING recovery resume.
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

const OWNER = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";
const WINNER_WALLET = "EQAREREREREREREREREREREREREREREREREREREREREREeYT";
const DEPLOYER = "EQDeployerWalletForSettlementWatchXXXXXXXX";

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

function buildContract(gameId = "game-r94", roomId = "room-r94") {

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
        contractAddress: "EQescrowaddressfortestsXXXXXXXXXXXXXX",
        paymentsCompletedAt: Date.now(),
        tonNetwork: "testnet"
    });

}

function createAdapterCounter() {

    const state = {
        calls: 0,
        lastRequest: null
    };

    return {
        state,
        async settleContract(request) {

            state.calls += 1;

            state.lastRequest = request;

            return {
                ok: true,
                settlementTxId: `tx-r94-${state.calls}`
            };

        },
        // R10.4 — Explicit NOT_SETTLED so resume may submit (no probe methods ⇒ UNKNOWN).
        async getSettlementState() {

            return {
                status: "READY",
                settlementTxHash: null
            };

        }
    };

}

function createManager({
    persistence,
    eventBus,
    contract,
    adapter,
    blockchainMonitor = null
}) {

    const logger = createLogger();

    return new ContractSettlementManager({
        logger,
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
            failContract() {

                contract.status = GAME_CONTRACT_STATUS.SETTLEMENT_FAILED;

            }
        },
        winnerEngine: {
            getResult() {

                return { winningPlayer: { playerId: "p1" } };

            }
        },
        configurationEngine: {
            getConfiguration() {

                return { traceSeed: "trace_r94" };

            }
        },
        settlementAdapter: adapter,
        financialPersistence: persistence,
        deployerWalletAddress: DEPLOYER,
        blockchainMonitor: blockchainMonitor ?? {
            watches: [],
            watchTransaction(payload) {

                this.watches.push(payload);

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
        tonNetwork: "testnet"
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
        traceSeed: "trace_r94",
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
        traceSeed: "trace_r94"
    });

    persistence.createSettlementRecord(session.toPayload(), {
        gameId: session.gameId,
        roomId: session.roomId,
        contractId: session.contractId,
        status: session.status
    });

    return session;

}

async function main() {

    // --- TEST A: CREATED → restore → resume → adapter once ---

    {
        const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-r94-created-"));

        const persistence = new TonFinancialPersistence({
            dataDir,
            autoCheckpoint: false
        });

        persistence.initialize();

        const contract = buildContract("game-a", "room-a");

        seedPersistedSession({
            persistence,
            contract,
            status: SETTLEMENT_SESSION_STATUS.CREATED
        });

        persistence.shutdown({ checkpoint: false });

        const persistence2 = new TonFinancialPersistence({
            dataDir,
            autoCheckpoint: false
        });

        persistence2.initialize();

        const eventBus = new EventBus({
            logger: createLogger(),
            eventBusConfig: { logEvents: false, showDebugPanel: false }
        });

        eventBus.initialize();

        const adapter = createAdapterCounter();

        const manager = createManager({
            persistence: persistence2,
            eventBus,
            contract,
            adapter
        });

        manager.initialize();

        const restored = manager.restoreSettlementSessions();

        assert.equal(restored.restored, 1, "TEST A: restored CREATED");

        const before = manager.getSettlementSession("game-a");

        assert.equal(before.status, SETTLEMENT_SESSION_STATUS.CREATED);

        assert.equal(adapter.state.calls, 0, "TEST A: no adapter before resume");

        const resume = await manager.resumeRestoredSettlements();

        assert.equal(resume.resumed, 1, "TEST A: resumed once");

        assert.equal(adapter.state.calls, 1, "TEST A: adapter called once");

        const after = manager.getSettlementSession("game-a");

        assert.equal(
            after.status,
            SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING
        );

        assert.ok(after.settlementTransactionHash);

        manager.shutdown();

        persistence2.shutdown({ checkpoint: false });

        TonFinancialPersistence.destroyStorage(dataDir);

        eventBus.shutdown();

        console.log("  TEST A CREATED resume: OK");

    }

    // --- TEST B: READY → restore → submit, no PREPARING transition ---

    {
        const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-r94-ready-"));

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

        const persistence2 = new TonFinancialPersistence({
            dataDir,
            autoCheckpoint: false
        });

        persistence2.initialize();

        const eventBus = new EventBus({
            logger: createLogger(),
            eventBusConfig: { logEvents: false, showDebugPanel: false }
        });

        eventBus.initialize();

        const adapter = createAdapterCounter();

        const statuses = [];

        const manager = createManager({
            persistence: persistence2,
            eventBus,
            contract,
            adapter
        });

        manager.initialize();

        manager.restoreSettlementSessions();

        const session = manager.getSettlementSession("game-b");

        assert.equal(session.status, SETTLEMENT_SESSION_STATUS.READY);

        const originalTransitionTo = session.transitionTo.bind(session);

        session.transitionTo = (nextStatus, patch) => {

            statuses.push(nextStatus);

            return originalTransitionTo(nextStatus, patch);

        };

        await manager.resumeRestoredSettlements();

        assert.equal(adapter.state.calls, 1, "TEST B: adapter once");

        assert.equal(
            statuses.includes(SETTLEMENT_SESSION_STATUS.PREPARING),
            false,
            "TEST B: must not transition back to PREPARING"
        );

        assert.equal(
            manager.getSettlementSession("game-b").status,
            SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING
        );

        manager.shutdown();

        persistence2.shutdown({ checkpoint: false });

        TonFinancialPersistence.destroyStorage(dataDir);

        eventBus.shutdown();

        console.log("  TEST B READY resume: OK");

    }

    // --- TEST C: PENDING → restore → rewatch only, adapter NOT called ---

    {
        const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-r94-pending-"));

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
            settlementTransactionHash: "tx-already-pending"
        });

        persistence.shutdown({ checkpoint: false });

        const persistence2 = new TonFinancialPersistence({
            dataDir,
            autoCheckpoint: false
        });

        persistence2.initialize();

        const eventBus = new EventBus({
            logger: createLogger(),
            eventBusConfig: { logEvents: false, showDebugPanel: false }
        });

        eventBus.initialize();

        const adapter = createAdapterCounter();

        const monitor = {
            watches: [],
            watchTransaction(payload) {

                this.watches.push(payload);

                return 1;

            }
        };

        const manager = createManager({
            persistence: persistence2,
            eventBus,
            contract,
            adapter,
            blockchainMonitor: monitor
        });

        manager.initialize();

        const restored = manager.restoreSettlementSessions();

        assert.equal(restored.restored, 1);

        assert.ok(restored.rewatched >= 1, "TEST C: rewatch registered");

        assert.equal(adapter.state.calls, 0);

        const resume = await manager.resumeRestoredSettlements();

        assert.equal(resume.resumed, 0, "TEST C: resume skipped for PENDING");

        assert.equal(adapter.state.calls, 0, "TEST C: adapter not called");

        assert.equal(
            manager.getSettlementSession("game-c").status,
            SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING
        );

        manager.shutdown();

        persistence2.shutdown({ checkpoint: false });

        TonFinancialPersistence.destroyStorage(dataDir);

        eventBus.shutdown();

        console.log("  TEST C PENDING rewatch only: OK");

    }

    // --- TEST D: duplicate restore/resume → one session, one adapter call ---

    {
        const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-r94-dup-"));

        const persistence = new TonFinancialPersistence({
            dataDir,
            autoCheckpoint: false
        });

        persistence.initialize();

        const contract = buildContract("game-d", "room-d");

        seedPersistedSession({
            persistence,
            contract,
            status: SETTLEMENT_SESSION_STATUS.CREATED
        });

        persistence.shutdown({ checkpoint: false });

        const persistence2 = new TonFinancialPersistence({
            dataDir,
            autoCheckpoint: false
        });

        persistence2.initialize();

        const eventBus = new EventBus({
            logger: createLogger(),
            eventBusConfig: { logEvents: false, showDebugPanel: false }
        });

        eventBus.initialize();

        const adapter = createAdapterCounter();

        const manager = createManager({
            persistence: persistence2,
            eventBus,
            contract,
            adapter
        });

        manager.initialize();

        const firstRestore = manager.restoreSettlementSessions();

        const secondRestore = manager.restoreSettlementSessions();

        assert.equal(firstRestore.restored, 1);

        assert.equal(secondRestore.restored, 0, "TEST D: second restore skips");

        assert.equal(
            [...manager._byGameId.keys()].length,
            1,
            "TEST D: one session in map"
        );

        const firstResume = await manager.resumeRestoredSettlements();

        const secondResume = await manager.resumeRestoredSettlements();

        assert.equal(firstResume.resumed, 1);

        assert.equal(secondResume.resumed, 0, "TEST D: second resume skipped");

        assert.equal(adapter.state.calls, 1, "TEST D: adapter once");

        manager.shutdown();

        persistence2.shutdown({ checkpoint: false });

        TonFinancialPersistence.destroyStorage(dataDir);

        eventBus.shutdown();

        console.log("  TEST D duplicate recovery: OK");

    }

    console.log("settlementRecoveryResume.r94.test.js: all assertions passed");

    process.exit(0);

}

main().catch((error) => {

    console.error(error);

    process.exit(1);

});
