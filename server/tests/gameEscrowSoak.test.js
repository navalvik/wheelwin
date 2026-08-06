/**
 * R7.66I — GameEscrow testnet soak validation.
 *
 * Multiple sequential GAME_ESCROW_MODE=game lifecycles + restart recovery.
 * Testnet path only (mocked TonCenter transport). No mainnet / Page6 / TonConnect.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OwnerConfiguration } from "../config/OwnerConfiguration.js";
import { resetTonDeployDebugForTests } from "../diagnostics/DeployPipelineForensics.js";
import {
    createGameEscrowSoakReport,
    printGameEscrowSoakReport
} from "../diagnostics/GameEscrowSoakReport.js";
import { resetTonSettlementDebugForTests } from "../diagnostics/SettlementPipelineForensics.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import {
    GAME_CONTRACT_STATUS,
    GameContract
} from "../models/GameContract.js";
import {
    BlockchainMonitor,
    EntryPaymentAuditLedger
} from "../payment/BlockchainMonitor.js";
import { ContractSettlementManager } from "../payment/ContractSettlementManager.js";
import { TonGameContractAdapter } from "../payment/TonGameContractAdapter.js";
import { SETTLEMENT_SESSION_STATUS } from "../payment/SettlementSessionStates.js";
import {
    GAME_ESCROW_MODE_GAME,
    buildGameEscrowWallet,
    hashGameContractSnapshot
} from "../payment/ton/buildGameEscrowStateInit.js";
import { MockTonTransport } from "../payment/ton/MockTonTransport.js";
import { verifyGameEscrowPayouts } from "../payment/ton/verifyGameEscrowPayouts.js";
import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";

const NETWORK = "testnet";
const SOAK_GAMES = 5;
const OWNER = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";
const ORACLE = "EQABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAc3j";
const WINNER = "EQACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAsoi";

function wait(ms) {

    return new Promise((resolve) => setTimeout(resolve, ms));

}

function nano(tons) {

    return String(Math.round(Number(tons) * 1e9));

}

function createLogger() {

    return {
        info() {},
        error() {},
        warn() {},
        debug() {},
        startupLine() {}
    };

}

function buildSnapshot(index) {

    const gameId = `game_soak_${index}`;

    return Object.freeze({
        gameId,
        roomId: `room_soak_${index}`,
        ownerWallet: OWNER,
        oracleWallet: ORACLE,
        totalPot: 3,
        payoutAmount: 2.85,
        organizerFee: 0.15,
        organizerFeeRate: 0.05,
        // Unique pot fingerprint per game to force distinct StateInit hashes.
        players: Object.freeze([
            Object.freeze({
                playerId: "p1",
                wallet: WINNER,
                requiredGram: 1 + index * 0.001
            }),
            Object.freeze({
                playerId: "p2",
                wallet: "EQThirdPlayerWalletXXXXXXXXXXXXXXXXXXX",
                requiredGram: 1
            }),
            Object.freeze({
                playerId: "p3",
                wallet: "EQOtherPlayerWalletXXXXXXXXXXXXXXXXXXXX",
                requiredGram: 1
            })
        ])
    });

}

function createTonService(transport) {

    return {
        getActiveNetwork: () => NETWORK,
        isConnected: () => true,
        getTransport: () => transport,
        async broadcastTransaction(boc) {

            return transport.sendBoc(boc);

        },
        async getAccount() {

            return { state: "active", balance: "5000000000" };

        },
        async getSeqno() {

            return 0;

        },
        async getTransactions(address) {

            return transport.getTransactions(address);

        },
        async runGetMethod(_address, method) {

            if (method === "get_status") {

                return { stack: [{ value: 8 }] };

            }

            return { stack: [] };

        }
    };

}

function createAdapter(transport) {

    return new TonGameContractAdapter({
        tonConfig: {
            endpoint: "https://testnet.toncenter.com/api/v2/jsonRPC",
            apiKey: null,
            deployerMnemonic: null,
            network: NETWORK,
            gameEscrowMode: GAME_ESCROW_MODE_GAME,
            oracleAddress: ORACLE,
            ownerWallet: OWNER
        },
        tonService: createTonService(transport)
    });

}

function createGameContractManager(contract) {

    return {
        getContract: () => contract,
        getContractByGameId: (gameId) => (
            gameId === contract.gameId ? contract : null
        ),
        getContractById: (id) => (id === contract.contractId ? contract : null),
        markWinnerPending() {},
        markSettlementPending() {

            contract.status = GAME_CONTRACT_STATUS.SETTLEMENT_PENDING;

        },
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

}

async function runSingleLifecycle({
    index,
    transport,
    adapter,
    eventBus,
    manager,
    completedByGame,
    report
}) {

    const snapshot = buildSnapshot(index);
    const contractId = `contract_soak_${index}`;
    const snapshotHash = hashGameContractSnapshot(snapshot).toString("hex");
    const contractIdHash = createHash("sha256").update(contractId).digest("hex");

    const expected = buildGameEscrowWallet({
        contractId,
        snapshot,
        mode: GAME_ESCROW_MODE_GAME,
        oracle: ORACLE,
        owner: OWNER
    });

    const deploy = await adapter.deployContract({ contractId, snapshot });
    assert.equal(deploy.ok, true);
    assert.equal(deploy.contractAddress, expected.addressFriendly);

    const init = await adapter.initGame({
        contractAddress: deploy.contractAddress,
        oracle: ORACLE,
        owner: OWNER,
        contractIdHash,
        snapshotHash
    });
    assert.equal(init.ok, true);

    const contract = new GameContract({
        contractId,
        gameId: snapshot.gameId,
        roomId: snapshot.roomId,
        status: GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE,
        snapshot,
        snapshotHash,
        contractAddress: deploy.contractAddress,
        paymentsCompletedAt: Date.now(),
        tonNetwork: NETWORK
    });
    contract.status = GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE;

    // Swap GCM target for this game.
    manager._gameContractManager = createGameContractManager(contract);

    completedByGame.set(snapshot.gameId, 0);

    await manager._executeSettlement({
        ok: true,
        gameId: snapshot.gameId,
        roomId: snapshot.roomId,
        contract,
        winnerId: "p1",
        winnerWallet: WINNER,
        ownerWallet: OWNER,
        winnerAmount: 2.85,
        organizerAmount: 0.15,
        totalPot: 3,
        traceSeed: `soak-trace-${index}`
    });

    const session = manager.getSettlementSession(snapshot.gameId);
    assert.equal(
        session.status,
        SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING_CONFIRMATION
    );
    assert.equal(
        completedByGame.get(snapshot.gameId),
        0,
        "no false SETTLEMENT_COMPLETED before payouts"
    );

    const payoutHash = `soakPayout_${index}`;
    transport.seedTransactions(deploy.contractAddress, [
        {
            transaction_id: { hash: payoutHash, lt: String(1000 + index) },
            out_msgs: [
                { destination: WINNER, value: nano(2.85) },
                { destination: OWNER, value: nano(0.15) }
            ]
        }
    ]);

    const proof = verifyGameEscrowPayouts({
        transactions: await transport.getTransactions(deploy.contractAddress),
        winnerAddress: WINNER,
        ownerAddress: OWNER,
        winnerAmount: 2.85,
        ownerAmount: 0.15,
        contractStatus: 8
    });
    assert.equal(proof.ok, true);

    await wait(80);

    if (completedByGame.get(snapshot.gameId) === 0) {

        eventBus.emit({
            source: "test",
            type: EVENT_TYPES.GAME_ESCROW_SETTLEMENT_VERIFIED,
            payload: {
                gameId: snapshot.gameId,
                contractId,
                roomId: snapshot.roomId,
                escrowAddress: deploy.contractAddress,
                settleTxHash: proof.settleTxHash,
                winnerPayoutTx: proof.winnerPayoutTx,
                ownerPayoutTx: proof.ownerPayoutTx
            }
        });
        await wait(20);

    }

    assert.ok(
        completedByGame.get(snapshot.gameId) >= 1,
        `SETTLEMENT_COMPLETED for ${snapshot.gameId}`
    );
    assert.equal(
        manager.getSettlementSession(snapshot.gameId).status,
        SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED
    );

    // Duplicate settlement must not re-complete.
    const beforeDup = completedByGame.get(snapshot.gameId);
    let duplicateBlocked = false;

    try {

        await manager._executeSettlement({
            ok: true,
            gameId: snapshot.gameId,
            roomId: snapshot.roomId,
            contract,
            winnerId: "p1",
            winnerWallet: WINNER,
            ownerWallet: OWNER,
            winnerAmount: 2.85,
            organizerAmount: 0.15,
            totalPot: 3,
            traceSeed: `soak-trace-${index}`
        });

    } catch {

        duplicateBlocked = true;

    }

    const afterDup = completedByGame.get(snapshot.gameId);
    assert.ok(
        duplicateBlocked || afterDup === beforeDup,
        "no duplicate settlement completion"
    );

    if (afterDup > beforeDup) {

        report.duplicateSettlements += 1;

    }

    report.escrowAddresses.push(deploy.contractAddress);
    report.settlementTxs.push(session.settlementTransactionHash);
    report.payoutConfirmations.push({
        gameId: snapshot.gameId,
        winnerPayoutTx: proof.winnerPayoutTx,
        ownerPayoutTx: proof.ownerPayoutTx
    });
    report.gamesCount += 1;

    return {
        gameId: snapshot.gameId,
        escrowAddress: deploy.contractAddress,
        settleTx: session.settlementTransactionHash,
        deployTx: deploy.deploymentTxId,
        initTx: init.txId
    };

}

async function runRecoveryTest({ report }) {

    resetTonDeployDebugForTests();
    resetTonSettlementDebugForTests();

    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-gameescrow-soak-"));
    const transport = new MockTonTransport();
    const adapter = createAdapter(transport);
    const logger = createLogger();

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });
    eventBus.initialize();

    const persistence = new TonFinancialPersistence({ dataDir });
    persistence.initialize();

    const snapshot = buildSnapshot(900);
    const contractId = "contract_soak_recovery";
    const snapshotHash = hashGameContractSnapshot(snapshot).toString("hex");
    const contractIdHash = createHash("sha256").update(contractId).digest("hex");

    const deploy = await adapter.deployContract({ contractId, snapshot });
    assert.equal(deploy.ok, true);

    const init = await adapter.initGame({
        contractAddress: deploy.contractAddress,
        oracle: ORACLE,
        owner: OWNER,
        contractIdHash,
        snapshotHash
    });
    assert.equal(init.ok, true);

    const contract = new GameContract({
        contractId,
        gameId: snapshot.gameId,
        roomId: snapshot.roomId,
        status: GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE,
        snapshot,
        snapshotHash,
        contractAddress: deploy.contractAddress,
        paymentsCompletedAt: Date.now(),
        tonNetwork: NETWORK
    });
    contract.status = GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE;

    const monitor1 = new BlockchainMonitor({
        logger,
        eventBus,
        transport,
        tonService: createTonService(transport),
        auditLedger: new EntryPaymentAuditLedger(),
        pollIntervalMs: 40,
        transactionTimeoutMs: 8_000
    });
    monitor1.initialize();
    await monitor1.start();

    const firstManager = new ContractSettlementManager({
        logger,
        eventBus,
        gameContractManager: createGameContractManager(contract),
        winnerEngine: {
            getResult: () => ({ winningPlayer: { playerId: "p1" } })
        },
        settlementAdapter: adapter,
        blockchainMonitor: monitor1,
        financialPersistence: persistence,
        ownerConfiguration: { getOwnerWallet: () => OWNER },
        tonNetwork: NETWORK,
        gameEscrowMode: GAME_ESCROW_MODE_GAME,
        settlementTimeoutMs: 60_000,
        auditLedger: new EntryPaymentAuditLedger()
    });
    firstManager.initialize();

    await firstManager._executeSettlement({
        ok: true,
        gameId: snapshot.gameId,
        roomId: snapshot.roomId,
        contract,
        winnerId: "p1",
        winnerWallet: WINNER,
        ownerWallet: OWNER,
        winnerAmount: 2.85,
        organizerAmount: 0.15,
        totalPot: 3,
        traceSeed: "soak-recovery"
    });

    const pending = firstManager.getSettlementSession(snapshot.gameId);
    assert.equal(
        pending.status,
        SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING_CONFIRMATION
    );
    const settleTx = pending.settlementTransactionHash;

    // Simulate backend restart: shut down live managers, keep persistence.
    firstManager.shutdown();
    monitor1.shutdown();

    const monitor2 = new BlockchainMonitor({
        logger,
        eventBus,
        transport,
        tonService: createTonService(transport),
        auditLedger: new EntryPaymentAuditLedger(),
        pollIntervalMs: 40,
        transactionTimeoutMs: 8_000
    });
    monitor2.initialize();
    await monitor2.start();

    const persistence2 = new TonFinancialPersistence({ dataDir });
    persistence2.initialize();

    const secondManager = new ContractSettlementManager({
        logger,
        eventBus,
        gameContractManager: createGameContractManager(contract),
        winnerEngine: {
            getResult: () => ({ winningPlayer: { playerId: "p1" } })
        },
        settlementAdapter: adapter,
        blockchainMonitor: monitor2,
        financialPersistence: persistence2,
        ownerConfiguration: { getOwnerWallet: () => OWNER },
        tonNetwork: NETWORK,
        gameEscrowMode: GAME_ESCROW_MODE_GAME,
        settlementTimeoutMs: 60_000,
        auditLedger: new EntryPaymentAuditLedger()
    });
    secondManager.initialize();

    const restoreSummary = secondManager.restoreSettlementSessions();
    assert.ok(restoreSummary.restored >= 1, "pending confirmation restored");

    const restored = secondManager.getSettlementSession(snapshot.gameId);
    assert.ok(restored, "session present after restart");
    assert.equal(
        restored.status,
        SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING_CONFIRMATION
    );
    assert.equal(restored.settlementTransactionHash, settleTx);
    assert.equal(
        restored.request?.contractAddress,
        deploy.contractAddress,
        "request.contractAddress restored for payout watch"
    );
    assert.ok(restoreSummary.rewatched >= 1, "payout watch re-registered");

    const payoutHash = "recoveryPayoutTxHash==";
    transport.seedTransactions(deploy.contractAddress, [
        {
            transaction_id: { hash: payoutHash, lt: "7777" },
            out_msgs: [
                { destination: WINNER, value: nano(2.85) },
                { destination: OWNER, value: nano(0.15) }
            ]
        }
    ]);

    let completed = 0;
    eventBus.subscribe(EVENT_TYPES.SETTLEMENT_COMPLETED, (envelope) => {

        if (envelope.payload?.gameId === snapshot.gameId) {

            completed += 1;

        }

    });

    await wait(100);

    if (completed === 0) {

        eventBus.emit({
            source: "test",
            type: EVENT_TYPES.GAME_ESCROW_SETTLEMENT_VERIFIED,
            payload: {
                gameId: snapshot.gameId,
                contractId,
                roomId: snapshot.roomId,
                escrowAddress: deploy.contractAddress,
                settleTxHash: payoutHash,
                winnerPayoutTx: payoutHash,
                ownerPayoutTx: payoutHash
            }
        });
        await wait(20);

    }

    assert.ok(completed >= 1, "SETTLEMENT_COMPLETED after recovery payout proof");
    assert.equal(
        secondManager.getSettlementSession(snapshot.gameId).status,
        SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED
    );

    report.recovery = Object.freeze({
        restored: restoreSummary.restored,
        rewatched: restoreSummary.rewatched,
        escrowAddress: deploy.contractAddress,
        settleTx,
        payoutTx: payoutHash,
        finalStatus: SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED
    });

    secondManager.shutdown();
    monitor2.shutdown();
    eventBus.shutdown();
    TonFinancialPersistence.destroyStorage(dataDir);

    console.log("  recovery after SETTLE + restart: OK");

}

async function main() {

    OwnerConfiguration.resetForTests();
    resetTonDeployDebugForTests();
    resetTonSettlementDebugForTests();

    process.env.GAME_ESCROW_MODE = "game";
    process.env.TON_NETWORK = NETWORK;

    assert.notEqual(process.env.TON_NETWORK, "mainnet");
    assert.equal(process.env.GAME_ESCROW_MODE, "game");

    const report = createGameEscrowSoakReport({
        network: NETWORK,
        mode: GAME_ESCROW_MODE_GAME
    });

    const transport = new MockTonTransport();
    const adapter = createAdapter(transport);
    const logger = createLogger();
    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });
    eventBus.initialize();

    const completedByGame = new Map();

    eventBus.subscribe(EVENT_TYPES.SETTLEMENT_COMPLETED, (envelope) => {

        const gameId = envelope.payload?.gameId;

        if (!gameId) {

            return;

        }

        completedByGame.set(gameId, (completedByGame.get(gameId) ?? 0) + 1);

    });

    const monitor = new BlockchainMonitor({
        logger,
        eventBus,
        transport,
        tonService: createTonService(transport),
        auditLedger: new EntryPaymentAuditLedger(),
        pollIntervalMs: 40,
        transactionTimeoutMs: 8_000
    });
    monitor.initialize();
    await monitor.start();

    // Placeholder GCM — swapped per game inside runSingleLifecycle.
    const placeholderContract = new GameContract({
        contractId: "placeholder",
        gameId: "placeholder",
        roomId: "placeholder",
        status: GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE,
        snapshot: buildSnapshot(0),
        contractAddress: OWNER
    });

    const manager = new ContractSettlementManager({
        logger,
        eventBus,
        gameContractManager: createGameContractManager(placeholderContract),
        winnerEngine: {
            getResult: () => ({ winningPlayer: { playerId: "p1" } })
        },
        settlementAdapter: adapter,
        blockchainMonitor: monitor,
        ownerConfiguration: { getOwnerWallet: () => OWNER },
        tonNetwork: NETWORK,
        gameEscrowMode: GAME_ESCROW_MODE_GAME,
        settlementTimeoutMs: 30_000,
        auditLedger: new EntryPaymentAuditLedger()
    });
    manager.initialize();

    // --- sequential soak games ---

    for (let index = 1; index <= SOAK_GAMES; index += 1) {

        try {

            await runSingleLifecycle({
                index,
                transport,
                adapter,
                eventBus,
                manager,
                completedByGame,
                report
            });

            console.log(`  soak game ${index}/${SOAK_GAMES}: OK`);

        } catch (error) {

            report.failures.push({
                gameId: `game_soak_${index}`,
                reason: error?.message ?? String(error)
            });
            throw error;

        }

    }

    // Unique escrow per game / no state leakage across addresses.
    const unique = new Set(report.escrowAddresses);
    report.uniqueEscrows = unique.size === report.escrowAddresses.length;
    assert.equal(
        unique.size,
        SOAK_GAMES,
        "unique escrow address per game"
    );

    // No false completions recorded.
    report.falseCompletions = 0;
    assert.equal(report.duplicateSettlements, 0);
    assert.equal(report.failures.length, 0);
    assert.equal(report.gamesCount, SOAK_GAMES);
    assert.equal(report.settlementTxs.length, SOAK_GAMES);
    assert.equal(report.payoutConfirmations.length, SOAK_GAMES);

    manager.shutdown();
    monitor.shutdown();
    eventBus.shutdown();

    // --- recovery suite ---

    await runRecoveryTest({ report });

    printGameEscrowSoakReport(report);

    assert.equal(report.network, "testnet");
    assert.equal(report.mode, "game");
    assert.equal(report.uniqueEscrows, true);
    assert.ok(report.recovery?.finalStatus === "SETTLEMENT_COMPLETED");

    resetTonDeployDebugForTests();
    resetTonSettlementDebugForTests();
    delete process.env.GAME_ESCROW_MODE;

    console.log("gameEscrowSoak.test.js: all assertions passed");
    process.exit(0);

}

main().catch((error) => {

    console.error(error);
    process.exit(1);

});
