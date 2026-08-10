/**
 * R9.2 — Winner resolve retry + durable settlement handoff.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { WinnerActivation } from "../gameplay/WinnerActivation.js";
import {
    GAME_CONTRACT_STATUS,
    GameContract
} from "../models/GameContract.js";
import { ContractSettlementManager } from "../payment/ContractSettlementManager.js";
import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";
import { TON_FINANCIAL_RECORD_TYPES } from "../persistence/TonFinancialRecordTypes.js";
import { SETTLEMENT_SESSION_STATUS } from "../payment/SettlementSessionStates.js";

const OWNER = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";
const WINNER_WALLET = "EQAREREREREREREREREREREREREREREREREREREREREREeYT";

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

function buildContract() {

    const snapshot = Object.freeze({
        gameId: "game-r92",
        roomId: "room-r92",
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

    const contract = new GameContract({
        contractId: "contract_r92",
        gameId: "game-r92",
        roomId: "room-r92",
        status: GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE,
        snapshot,
        contractAddress: "EQescrowaddressfortestsXXXXXXXXXXXXXX",
        paymentsCompletedAt: Date.now()
    });

    return contract;

}

async function main() {

    // --- TEST A: first resolve fails, retry succeeds, single WINNER_DETERMINED ---

    {
        const logger = createLogger();

        const eventBus = new EventBus({
            logger,
            eventBusConfig: { logEvents: false, showDebugPanel: false }
        });

        eventBus.initialize();

        let attempts = 0;

        const winnerEngine = {
            resolveResult(gameId) {

                attempts += 1;

                if (attempts === 1) {

                    throw new Error("transient_resolve_failure");

                }

                return {
                    gameId,
                    winningSector: { index: 0, sectorId: "s0", color: "#f00", icon: "a" },
                    winningPlayer: { playerId: "p1", color: "#f00", icon: "a" },
                    winnerPlayerId: "p1",
                    winnerSectorIndex: 0,
                    finalAngle: 1.2,
                    wheelFinalAngle: 1.2,
                    triangleFinalAngle: 0.1,
                    resolvedAt: Date.now()
                };

            }
        };

        const determined = [];

        eventBus.subscribe(EVENT_TYPES.WINNER_DETERMINED, (envelope) => {

            determined.push(envelope.payload);

        });

        const activation = new WinnerActivation({
            logger,
            eventBus,
            physicsEngine: {},
            winnerEngine,
            gameStateEngine: {},
            resolveAttempts: 3,
            resolveRetryDelayMs: 10
        });

        activation.initialize();

        eventBus.emit({
            source: "test",
            type: EVENT_TYPES.PHYSICS_STOPPED,
            payload: { gameId: "game-retry-ok" }
        });

        await wait(80);

        assert.equal(attempts, 2, "TEST A: resolve attempted twice");

        assert.equal(determined.length, 1, "TEST A: single WINNER_DETERMINED");

        assert.equal(determined[0].winningPlayerId, "p1");

        // Second PHYSICS_STOPPED must not emit again (claimed).
        eventBus.emit({
            source: "test",
            type: EVENT_TYPES.PHYSICS_STOPPED,
            payload: { gameId: "game-retry-ok" }
        });

        await wait(40);

        assert.equal(determined.length, 1, "TEST A: no duplicate after re-emit");

        activation.shutdown();

        eventBus.shutdown();

        console.log("  TEST A winner retry success: OK");

    }

    // --- TEST B: permanent resolve failure — no WINNER_DETERMINED ---

    {
        const logger = createLogger();

        const eventBus = new EventBus({
            logger,
            eventBusConfig: { logEvents: false, showDebugPanel: false }
        });

        eventBus.initialize();

        let attempts = 0;

        const winnerEngine = {
            resolveResult() {

                attempts += 1;

                throw new Error("permanent_resolve_failure");

            }
        };

        const determined = [];

        eventBus.subscribe(EVENT_TYPES.WINNER_DETERMINED, (envelope) => {

            determined.push(envelope.payload);

        });

        const activation = new WinnerActivation({
            logger,
            eventBus,
            physicsEngine: {},
            winnerEngine,
            gameStateEngine: {},
            resolveAttempts: 3,
            resolveRetryDelayMs: 5
        });

        activation.initialize();

        eventBus.emit({
            source: "test",
            type: EVENT_TYPES.PHYSICS_STOPPED,
            payload: { gameId: "game-retry-fail" }
        });

        await wait(80);

        assert.equal(attempts, 3, "TEST B: exhausted resolve attempts");

        assert.equal(determined.length, 0, "TEST B: no WINNER_DETERMINED");

        eventBus.emit({
            source: "test",
            type: EVENT_TYPES.PHYSICS_STOPPED,
            payload: { gameId: "game-retry-fail" }
        });

        await wait(40);

        assert.equal(attempts, 3, "TEST B: no extra attempts after terminal failure");

        assert.equal(determined.length, 0, "TEST B: still no duplicate events");

        activation.shutdown();

        eventBus.shutdown();

        console.log("  TEST B permanent failure: OK");

    }

    // --- TEST C: SettlementSession persisted before adapter await ---

    {
        const logger = createLogger();

        const eventBus = new EventBus({
            logger,
            eventBusConfig: { logEvents: false, showDebugPanel: false }
        });

        eventBus.initialize();

        const contract = buildContract();

        const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-r92-handoff-"));

        const persistence = new TonFinancialPersistence({
            dataDir,
            autoCheckpoint: false
        });

        persistence.initialize();

        let adapterEntered = false;

        let persistedBeforeAdapter = false;

        let releaseAdapter;

        const adapterGate = new Promise((resolve) => {

            releaseAdapter = resolve;

        });

        const manager = new ContractSettlementManager({
            logger,
            eventBus,
            gameContractManager: {
                getContract: () => contract,
                getContractByGameId: () => contract,
                getContractById: () => contract,
                markWinnerPending() {},
                markSettlementPending() {},
                updateContractState() {},
                completeContract() {},
                failContract() {}
            },
            winnerEngine: {
                getResult() {

                    return { winningPlayer: { playerId: "p1" } };

                }
            },
            configurationEngine: {
                getConfiguration() {

                    return { traceSeed: "trace_r92" };

                }
            },
            settlementAdapter: {
                async settleContract() {

                    adapterEntered = true;

                    const records = persistence.listActive(
                        TON_FINANCIAL_RECORD_TYPES.SETTLEMENT
                    );

                    persistedBeforeAdapter = records.length >= 1
                        && records[0]?.payload?.winnerId === "p1"
                        && records[0]?.payload?.winnerWallet === WINNER_WALLET
                        && records[0]?.payload?.prizeAmount === 95
                        && records[0]?.payload?.organizerAmount === 5
                        && records[0]?.payload?.ownerWallet === OWNER
                        && records[0]?.payload?.gameId === "game-r92";

                    await adapterGate;

                    return { ok: true, settlementTxId: "tx-r92-c" };

                }
            },
            financialPersistence: persistence,
            deployerWalletAddress: "EQDeployerWalletForSettlementWatchXXXXXXXX",
            blockchainMonitor: {
                watchTransaction() {

                    return 1;

                }
            },
            gameplayContextResolver: {
                resolveRoomByGameId() {

                    return "room-r92";

                }
            },
            ownerConfiguration: {
                getOwnerWallet() {

                    return OWNER;

                }
            },
            settlementTimeoutMs: 60_000
        });

        manager.initialize();

        eventBus.emit({
            source: "test",
            type: EVENT_TYPES.WINNER_DETERMINED,
            payload: { gameId: "game-r92", winningPlayerId: "p1" }
        });

        // Sync handoff must complete during emit before microtasks drain adapter.
        const live = manager.getSettlementSession("game-r92");

        assert.ok(live, "TEST C: session present after WINNER_DETERMINED emit");

        assert.ok(
            ["CREATED", "PREPARING", "READY", "SETTLEMENT_PENDING"].includes(live.status)
            || live.isInProgress(),
            "TEST C: session in progress after handoff"
        );

        assert.equal(live.winnerId, "p1");

        assert.equal(live.winnerWallet, WINNER_WALLET);

        assert.equal(live.prizeAmount, 95);

        assert.equal(live.organizerAmount, 5);

        assert.equal(live.ownerWallet, OWNER);

        const disk = persistence.listActive(TON_FINANCIAL_RECORD_TYPES.SETTLEMENT);

        assert.equal(disk.length, 1, "TEST C: durable record before adapter completes");

        assert.equal(disk[0].payload.winnerId, "p1");

        // Let adapter proceed and assert it observed persistence.
        await wait(10);

        assert.equal(adapterEntered, true, "TEST C: adapter eventually entered");

        assert.equal(
            persistedBeforeAdapter,
            true,
            "TEST C: persistence visible before adapter await resolves"
        );

        releaseAdapter();

        await wait(30);

        manager.shutdown();

        persistence.shutdown({ checkpoint: false });

        TonFinancialPersistence.destroyStorage(dataDir);

        eventBus.shutdown();

        console.log("  TEST C persist before adapter await: OK");

    }

    // --- TEST D: crash after persist, before confirmation → restore ---

    {
        const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-r92-recover-"));

        const logger = createLogger();

        const eventBus = new EventBus({
            logger,
            eventBusConfig: { logEvents: false, showDebugPanel: false }
        });

        eventBus.initialize();

        const contract = buildContract();

        const persistence = new TonFinancialPersistence({
            dataDir,
            autoCheckpoint: false
        });

        persistence.initialize();

        const first = new ContractSettlementManager({
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
                completeContract() {},
                failContract() {}
            },
            winnerEngine: {
                getResult() {

                    return { winningPlayer: { playerId: "p1" } };

                }
            },
            configurationEngine: {
                getConfiguration() {

                    return { traceSeed: "trace_r92" };

                }
            },
            settlementAdapter: {
                async settleContract() {

                    return { ok: true, settlementTxId: "tx-r92-d" };

                }
            },
            financialPersistence: persistence,
            deployerWalletAddress: "EQDeployerWalletForSettlementWatchXXXXXXXX",
            blockchainMonitor: {
                watchTransaction() {

                    return 1;

                }
            },
            gameplayContextResolver: {
                resolveRoomByGameId() {

                    return "room-r92";

                }
            },
            ownerConfiguration: {
                getOwnerWallet() {

                    return OWNER;

                }
            },
            settlementTimeoutMs: 60_000
        });

        first.initialize();

        eventBus.emit({
            source: "test",
            type: EVENT_TYPES.WINNER_DETERMINED,
            payload: { gameId: "game-r92", winningPlayerId: "p1" }
        });

        await wait(40);

        const pending = first.getSettlementSession("game-r92");

        assert.ok(pending, "TEST D: session created");

        assert.equal(
            pending.status,
            SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING
        );

        assert.equal(pending.settlementTransactionHash, "tx-r92-d");

        first.shutdown();

        persistence.shutdown({ checkpoint: false });

        // Simulated restart
        const persistence2 = new TonFinancialPersistence({
            dataDir,
            autoCheckpoint: false
        });

        persistence2.initialize();

        const second = new ContractSettlementManager({
            logger,
            eventBus,
            gameContractManager: {
                getContract: () => contract,
                getContractByGameId: () => contract,
                getContractById: () => contract,
                markWinnerPending() {},
                markSettlementPending() {},
                updateContractState() {},
                completeContract() {},
                failContract() {}
            },
            winnerEngine: {
                getResult() {

                    return null;

                }
            },
            settlementAdapter: {
                async settleContract() {

                    throw new Error("must_not_resettle_on_restore");

                }
            },
            financialPersistence: persistence2,
            deployerWalletAddress: "EQDeployerWalletForSettlementWatchXXXXXXXX",
            blockchainMonitor: {
                watches: [],
                watchTransaction(payload) {

                    this.watches.push(payload);

                    return 1;

                }
            },
            ownerConfiguration: {
                getOwnerWallet() {

                    return OWNER;

                }
            },
            settlementTimeoutMs: 60_000
        });

        second.initialize();

        const summary = second.restoreSettlementSessions();

        assert.ok(summary.restored >= 1, "TEST D: restored settlement");

        const restored = second.getSettlementSession("game-r92");

        assert.ok(restored, "TEST D: session after restart");

        assert.equal(restored.winnerId, "p1");

        assert.equal(restored.winnerWallet, WINNER_WALLET);

        assert.equal(restored.prizeAmount, 95);

        assert.equal(restored.organizerAmount, 5);

        assert.equal(restored.ownerWallet, OWNER);

        assert.equal(
            restored.status,
            SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING
        );

        second.shutdown();

        persistence2.shutdown({ checkpoint: false });

        TonFinancialPersistence.destroyStorage(dataDir);

        eventBus.shutdown();

        console.log("  TEST D restart restore after handoff: OK");

    }

    console.log("winnerRetry.settlementHandoff.r92.test.js: all assertions passed");

    process.exit(0);

}

main().catch((error) => {

    console.error(error);

    process.exit(1);

});
