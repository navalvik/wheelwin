/**
 * R10.4 — Settlement probe tri-state + hashless PENDING recovery safety.
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
import {
    ContractSettlementManager,
    ON_CHAIN_SETTLEMENT_PROBE_STATUS
} from "../payment/ContractSettlementManager.js";
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

function createProbeAdapter({
    status = GAME_CONTRACT_ON_CHAIN_STATUS.READY,
    settlementTxHash = null,
    throwOnProbe = false
} = {}) {

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
                settlementTxId: `tx-r104-${state.settleCalls}`,
                request
            };

        },
        async getSettlementState() {

            state.probeCalls += 1;

            if (throwOnProbe) {

                throw new Error("rpc_timeout");

            }

            return {
                status,
                settlementTxHash
            };

        },
        async getContractState() {

            state.probeCalls += 1;

            if (throwOnProbe) {

                throw new Error("rpc_timeout");

            }

            return {
                status,
                settlementTxHash
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
    gameEscrowMode = "game"
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
            updateContractState(_roomId, next) {

                contract.status = next;

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

                return { traceSeed: "trace_r104" };

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
    settlementTransactionHash = null,
    gameEscrowMode = "game"
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
        traceSeed: "trace_r104",
        timestamp: Date.now(),
        snapshot: contract.snapshot,
        snapshotHash: null,
        gameEscrowMode
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
        traceSeed: "trace_r104"
    });

    persistence.createSettlementRecord(session.toPayload(), {
        gameId: session.gameId,
        roomId: session.roomId,
        contractId: session.contractId,
        status: session.status
    });

    return session;

}

async function restartAndResume({
    dataDir,
    contract,
    adapter,
    gameEscrowMode = "game"
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

    const monitor = {
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
    };

    const manager = createManager({
        persistence,
        eventBus,
        contract,
        adapter,
        blockchainMonitor: monitor,
        gameEscrowMode
    });

    manager.initialize();

    manager.restoreSettlementSessions();

    const resume = await manager.resumeRestoredSettlements();

    return { manager, persistence, eventBus, monitor, resume };

}

async function run() {

    console.log("R10.4 settlementProbeSafety");

    // --- TEST A: RPC throws → UNKNOWN, no settleContract ---

    {
        const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-r104-a-"));

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

        const adapter = createProbeAdapter({ throwOnProbe: true });

        const { manager, persistence: p2, eventBus, resume } = await restartAndResume({
            dataDir,
            contract,
            adapter
        });

        const probe = await manager._probeOnChainSettlement(
            manager.getSettlementSession("game-a"),
            manager._buildResumeContext(manager.getSettlementSession("game-a"))
        );

        assert.equal(
            probe.status,
            ON_CHAIN_SETTLEMENT_PROBE_STATUS.UNKNOWN,
            "TEST A: probe UNKNOWN on RPC throw"
        );

        assert.equal(adapter.state.settleCalls, 0, "TEST A: settleContract not called");

        assert.equal(
            manager.getSettlementSession("game-a").status,
            SETTLEMENT_SESSION_STATUS.READY,
            "TEST A: session remains READY"
        );

        assert.ok(resume.resumed >= 1 || resume.attempted >= 1, "TEST A: resume attempted");

        manager.shutdown();

        p2.shutdown({ checkpoint: false });

        TonFinancialPersistence.destroyStorage(dataDir);

        eventBus.shutdown();

        console.log("  TEST A RPC throw → UNKNOWN: OK");

    }

    // --- TEST B: SETTLING → UNKNOWN, no submit ---

    {
        const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-r104-b-"));

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

        const adapter = createProbeAdapter({
            status: GAME_CONTRACT_ON_CHAIN_STATUS.SETTLING
        });

        const { manager, persistence: p2, eventBus } = await restartAndResume({
            dataDir,
            contract,
            adapter
        });

        assert.equal(adapter.state.settleCalls, 0, "TEST B: no submit on SETTLING");

        assert.equal(
            manager.getSettlementSession("game-b").status,
            SETTLEMENT_SESSION_STATUS.READY
        );

        manager.shutdown();

        p2.shutdown({ checkpoint: false });

        TonFinancialPersistence.destroyStorage(dataDir);

        eventBus.shutdown();

        console.log("  TEST B SETTLING → UNKNOWN: OK");

    }

    // --- TEST C: READY + NOT_SETTLED → one settleContract ---

    {
        const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-r104-c-"));

        const persistence = new TonFinancialPersistence({
            dataDir,
            autoCheckpoint: false
        });

        persistence.initialize();

        const contract = buildContract("game-c", "room-c");

        seedPersistedSession({
            persistence,
            contract,
            status: SETTLEMENT_SESSION_STATUS.READY
        });

        persistence.shutdown({ checkpoint: false });

        const adapter = createProbeAdapter({
            status: GAME_CONTRACT_ON_CHAIN_STATUS.READY
        });

        const { manager, persistence: p2, eventBus } = await restartAndResume({
            dataDir,
            contract,
            adapter,
            gameEscrowMode: null
        });

        assert.equal(adapter.state.settleCalls, 1, "TEST C: exactly one settle");

        assert.equal(
            manager.getSettlementSession("game-c").status,
            SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING
        );

        manager.shutdown();

        p2.shutdown({ checkpoint: false });

        TonFinancialPersistence.destroyStorage(dataDir);

        eventBus.shutdown();

        console.log("  TEST C NOT_SETTLED submit once: OK");

    }

    // --- TEST D: READY + SETTLED → adopt, zero settleContract ---

    {
        const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-r104-d-"));

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

        const adapter = createProbeAdapter({
            status: GAME_CONTRACT_ON_CHAIN_STATUS.SETTLED,
            settlementTxHash: "tx-already-on-chain"
        });

        const { manager, persistence: p2, eventBus, monitor } = await restartAndResume({
            dataDir,
            contract,
            adapter,
            gameEscrowMode: "game"
        });

        assert.equal(adapter.state.settleCalls, 0, "TEST D: no settleContract");

        assert.equal(
            manager.getSettlementSession("game-d").status,
            SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING_CONFIRMATION
        );

        assert.ok(
            monitor.escrowWatches.length >= 1,
            "TEST D: payout watch registered"
        );

        manager.shutdown();

        p2.shutdown({ checkpoint: false });

        TonFinancialPersistence.destroyStorage(dataDir);

        eventBus.shutdown();

        console.log("  TEST D SETTLED adopt/watch: OK");

    }

    // --- TEST E: Hashless PENDING + SETTLED → watch, no submit ---

    {
        const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-r104-e-"));

        const persistence = new TonFinancialPersistence({
            dataDir,
            autoCheckpoint: false
        });

        persistence.initialize();

        const contract = buildContract("game-e", "room-e");

        seedPersistedSession({
            persistence,
            contract,
            status: SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING,
            settlementTransactionHash: null
        });

        persistence.shutdown({ checkpoint: false });

        const adapter = createProbeAdapter({
            status: GAME_CONTRACT_ON_CHAIN_STATUS.SETTLED,
            settlementTxHash: "tx-from-probe"
        });

        const { manager, persistence: p2, eventBus, monitor } = await restartAndResume({
            dataDir,
            contract,
            adapter,
            gameEscrowMode: "game"
        });

        assert.equal(adapter.state.settleCalls, 0, "TEST E: no settleContract");

        const session = manager.getSettlementSession("game-e");

        assert.equal(
            session.status,
            SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING_CONFIRMATION
        );

        assert.equal(session.settlementTransactionHash, "tx-from-probe");

        assert.ok(monitor.escrowWatches.length >= 1, "TEST E: watch path");

        manager.shutdown();

        p2.shutdown({ checkpoint: false });

        TonFinancialPersistence.destroyStorage(dataDir);

        eventBus.shutdown();

        console.log("  TEST E hashless PENDING + SETTLED: OK");

    }

    // --- TEST F: Hashless PENDING + NOT_SETTLED → safe single submit ---

    {
        const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-r104-f-"));

        const persistence = new TonFinancialPersistence({
            dataDir,
            autoCheckpoint: false
        });

        persistence.initialize();

        const contract = buildContract("game-f", "room-f");

        seedPersistedSession({
            persistence,
            contract,
            status: SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING,
            settlementTransactionHash: null
        });

        persistence.shutdown({ checkpoint: false });

        const adapter = createProbeAdapter({
            status: GAME_CONTRACT_ON_CHAIN_STATUS.READY
        });

        const { manager, persistence: p2, eventBus, monitor } = await restartAndResume({
            dataDir,
            contract,
            adapter,
            gameEscrowMode: "game"
        });

        assert.equal(adapter.state.settleCalls, 1, "TEST F: one submit");

        const session = manager.getSettlementSession("game-f");

        assert.equal(
            session.status,
            SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING_CONFIRMATION
        );

        assert.ok(session.settlementTransactionHash, "TEST F: hash attached");

        assert.ok(monitor.escrowWatches.length >= 1, "TEST F: watch after submit");

        manager.shutdown();

        p2.shutdown({ checkpoint: false });

        TonFinancialPersistence.destroyStorage(dataDir);

        eventBus.shutdown();

        console.log("  TEST F hashless PENDING + NOT_SETTLED: OK");

    }

    // --- TEST G: Hashless PENDING + UNKNOWN → no submit, recoverable ---

    {
        const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-r104-g-"));

        const persistence = new TonFinancialPersistence({
            dataDir,
            autoCheckpoint: false
        });

        persistence.initialize();

        const contract = buildContract("game-g", "room-g");

        seedPersistedSession({
            persistence,
            contract,
            status: SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING,
            settlementTransactionHash: null
        });

        persistence.shutdown({ checkpoint: false });

        const adapter = createProbeAdapter({ throwOnProbe: true });

        const { manager, persistence: p2, eventBus } = await restartAndResume({
            dataDir,
            contract,
            adapter
        });

        assert.equal(adapter.state.settleCalls, 0, "TEST G: no submit");

        const session = manager.getSettlementSession("game-g");

        assert.equal(
            session.status,
            SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING,
            "TEST G: remains PENDING"
        );

        assert.equal(session.isTerminal(), false, "TEST G: still recoverable");

        assert.ok(session.settlementDeadline, "TEST G: deadline kept");

        manager.shutdown();

        p2.shutdown({ checkpoint: false });

        TonFinancialPersistence.destroyStorage(dataDir);

        eventBus.shutdown();

        console.log("  TEST G hashless PENDING + UNKNOWN: OK");

    }

    // --- TEST H: Double recovery → one session, one submit max ---

    {
        const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-r104-h-"));

        const persistence = new TonFinancialPersistence({
            dataDir,
            autoCheckpoint: false
        });

        persistence.initialize();

        const contract = buildContract("game-h", "room-h");

        seedPersistedSession({
            persistence,
            contract,
            status: SETTLEMENT_SESSION_STATUS.READY
        });

        persistence.shutdown({ checkpoint: false });

        const adapter = createProbeAdapter({
            status: GAME_CONTRACT_ON_CHAIN_STATUS.READY
        });

        const { manager, persistence: p2, eventBus } = await restartAndResume({
            dataDir,
            contract,
            adapter,
            gameEscrowMode: null
        });

        assert.equal(adapter.state.settleCalls, 1, "TEST H: first resume submits once");

        const resume2 = await manager.resumeRestoredSettlements();

        assert.equal(adapter.state.settleCalls, 1, "TEST H: second resume no extra submit");

        assert.equal(
            [...manager._byGameId.keys()].length,
            1,
            "TEST H: single session"
        );

        assert.ok(
            resume2.skipped >= 1 || resume2.attempted === 0 || resume2.resumed === 0,
            "TEST H: second pass skips hashed/in-progress"
        );

        manager.shutdown();

        p2.shutdown({ checkpoint: false });

        TonFinancialPersistence.destroyStorage(dataDir);

        eventBus.shutdown();

        console.log("  TEST H double recovery: OK");

    }

    console.log("R10.4 settlementProbeSafety: ALL PASSED");

}

run().catch((error) => {

    console.error(error);

    process.exitCode = 1;

});
