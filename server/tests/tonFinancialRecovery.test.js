/**
 * T2.9 — TonFinancialRecovery tests.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { keyPairFromSeed } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

import { EventBus } from "../events/EventBus.js";
import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_CONTRACT_STATUS } from "../models/GameContract.js";
import {
    PAYMENT_PARTICIPANT_STATUS,
    PAYMENT_SESSION_STATUS,
    PaymentParticipant,
    PaymentSession
} from "../models/PaymentSession.js";
import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";
import { TON_FINANCIAL_RECORD_TYPES } from "../persistence/TonFinancialRecordTypes.js";
import { SettlementSession } from "../payment/SettlementSession.js";
import { SETTLEMENT_SESSION_STATUS } from "../payment/SettlementSessionStates.js";
import { TonFinancialRecovery } from "../recovery/TonFinancialRecovery.js";
import {
    RecoveryOrderError
} from "../recovery/TonFinancialRecoveryErrors.js";
import {
    FINANCIAL_RECOVERY_PHASE,
    FINANCIAL_RECOVERY_STATE
} from "../recovery/TonFinancialRecoveryStates.js";
import { SessionWalletStore } from "../session/SessionWalletStore.js";
import { WalletManager } from "../session/WalletManager.js";
import { WalletSession } from "../session/WalletSession.js";
import { WALLET_SESSION_STATUS } from "../session/WalletSessionStates.js";

function friendlyAddress(seedLabel) {

    const seed = createHash("sha256").update(seedLabel).digest();

    const keyPair = keyPairFromSeed(seed);

    return WalletContractV4.create({
        workchain: 0,
        publicKey: keyPair.publicKey
    }).address.toString({
        bounceable: true,
        urlSafe: true
    });

}

function createLogger() {

    return {
        info() {},
        warn() {},
        error() {},
        debug() {}
    };

}

function createMockBlockchainMonitor() {

    const contracts = new Map();

    const transactions = new Map();

    const paymentWatches = new Map();

    return {
        contracts,
        transactions,
        paymentWatches,
        restoreCheckpoint(checkpoint) {

            contracts.clear();

            transactions.clear();

            paymentWatches.clear();

            for (const entry of checkpoint.contracts ?? []) {

                contracts.set(entry.contractId, { ...entry });

            }

            for (const entry of checkpoint.transactions ?? []) {

                transactions.set(entry.watchId, { ...entry });

            }

            for (const entry of checkpoint.paymentWatches ?? []) {

                paymentWatches.set(`${entry.roomId}:${entry.playerId}`, { ...entry });

            }

            return true;

        },
        registerContract(contractId, address, meta = {}) {

            contracts.set(contractId, {
                contractId,
                address,
                ...meta
            });

            return { contractId, address, ...meta };

        },
        watchPayment(payload) {

            const key = `${payload.roomId}:${payload.playerId}`;

            paymentWatches.set(key, { ...payload });

            return payload;

        },
        watchTransaction({ transactionId, kind = "GENERIC" }) {

            const watchId = `${kind}:${transactionId}`;

            if (transactions.has(watchId)) {

                return transactions.get(watchId);

            }

            const watch = { watchId, transactionId, kind, status: "PENDING" };

            transactions.set(watchId, watch);

            return watch;

        },
        listWatchedContracts() {

            return [...contracts.values()];

        }
    };

}

function createRecoveryHarness({
    dataDir = null,
    withPlayers = true,
    withRooms = true
} = {}) {

    const logger = createLogger();

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const persistence = dataDir
        ? (() => {

            const store = new TonFinancialPersistence({ dataDir });

            store.initialize();

            return store;

        })()
        : null;

    const sessionWalletStore = new SessionWalletStore({
        financialPersistence: persistence,
        logger
    });

    const walletManager = new WalletManager({
        logger,
        eventBus,
        sessionWalletStore,
        financialPersistence: persistence,
        defaultNetwork: "testnet"
    });

    walletManager.initialize();

    const blockchainMonitor = createMockBlockchainMonitor();

    const contracts = new Map();

    const paymentSessions = new Map();

    const settlementSessions = new Map();

    const gameContractManager = {
        restoreContracts() {

            return Object.freeze({
                restored: contracts.size,
                incompleteDeployments: Object.freeze([]),
                unfinishedTransitions: Object.freeze([])
            });

        },
        listContracts() {

            return [...contracts.values()];

        },
        getContract(roomId) {

            return [...contracts.values()].find((entry) => entry.roomId === roomId) ?? null;

        },
        getContractById(contractId) {

            return contracts.get(contractId) ?? null;

        },
        seedContract(contract) {

            contracts.set(contract.contractId, contract);

        }
    };

    const paymentSessionManager = {
        restorePaymentSessions() {

            return Object.freeze({
                restored: paymentSessions.size,
                recovered: paymentSessions.size,
                rewatched: 0
            });

        },
        listSessionRoomIds() {

            return [...paymentSessions.keys()];

        },
        getSession(roomId) {

            return paymentSessions.get(roomId) ?? null;

        },
        getSessionByGameId(gameId) {

            for (const session of paymentSessions.values()) {

                if (session.gameId === gameId) {

                    return session;

                }

            }

            return null;

        },
        seedSession(session) {

            paymentSessions.set(session.roomId, session);

        }
    };

    const contractSettlementManager = {
        restoreSettlementSessions() {

            return Object.freeze({
                restored: settlementSessions.size,
                recovered: settlementSessions.size,
                rewatched: 0
            });

        },
        getSettlementSession(gameId) {

            return settlementSessions.get(gameId) ?? null;

        },
        listSettlementSnapshots() {

            return [...settlementSessions.values()].map((session) => ({
                gameId: session.gameId,
                roomId: session.roomId,
                status: session.status
            }));

        },
        seedSession(session) {

            settlementSessions.set(session.gameId, session);

        }
    };

    const playerManager = withPlayers
        ? {
            hasPlayer(playerId) {

                return ["p1", "p2", "p3"].includes(playerId);

            },
            getPlayer(playerId) {

                return this.hasPlayer(playerId) ? { playerId } : null;

            }
        }
        : null;

    const roomManager = withRooms
        ? {
            hasRoom(roomId) {

                return roomId === "room-1";

            }
        }
        : null;

    const recovery = new TonFinancialRecovery({
        logger,
        eventBus,
        walletManager,
        sessionWalletStore,
        paymentSessionManager,
        gameContractManager,
        contractSettlementManager,
        blockchainMonitor,
        financialPersistence: persistence,
        playerManager,
        roomManager
    });

    recovery.initialize();

    return {
        recovery,
        eventBus,
        persistence,
        sessionWalletStore,
        walletManager,
        blockchainMonitor,
        gameContractManager,
        paymentSessionManager,
        contractSettlementManager
    };

}

// --- full recovery ---

{
    const harness = createRecoveryHarness();

    const events = [];

    harness.eventBus.subscribe(EVENT_TYPES.FINANCIAL_RECOVERY_STARTED, (envelope) => {

        events.push(envelope.type);

    });

    harness.eventBus.subscribe(EVENT_TYPES.FINANCIAL_RECOVERY_COMPLETED, (envelope) => {

        events.push(envelope.type);

        assert.equal(envelope.source, EVENT_SOURCES.TON_FINANCIAL_RECOVERY);

    });

    const report = await harness.recovery.recover({ trigger: "server_restart" });

    assert.equal(report.walletSessionsRecovered, 0);

    assert.equal(harness.recovery.health().state, FINANCIAL_RECOVERY_STATE.COMPLETED);

    assert.ok(events.includes(EVENT_TYPES.FINANCIAL_RECOVERY_STARTED));

    assert.ok(events.includes(EVENT_TYPES.FINANCIAL_RECOVERY_COMPLETED));

    console.log("  full recovery: OK");
}

// --- recovery ordering ---

{
    const harness = createRecoveryHarness();

    assert.throws(
        () => harness.recovery.recoverContracts(),
        RecoveryOrderError
    );

    harness.recovery.recoverWallets();

    harness.recovery.recoverContracts();

    assert.throws(
        () => harness.recovery.recoverWallets(),
        RecoveryOrderError
    );

    console.log("  recovery ordering: OK");
}

// --- wallet recovery ---

{
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-fin-recovery-wallet-"));

    const harness = createRecoveryHarness({ dataDir });

    harness.sessionWalletStore.create(new WalletSession({
        walletSessionId: "ws-1",
        playerId: "p1",
        roomId: "room-1",
        walletAddress: friendlyAddress("wallet-1"),
        status: WALLET_SESSION_STATUS.VERIFIED,
        network: "testnet"
    }));

    harness.persistence?.shutdown();

    const restarted = createRecoveryHarness({ dataDir });

    const report = await restarted.recovery.recover();

    assert.equal(report.walletSessionsRecovered, 1);

    TonFinancialPersistence.destroyStorage(dataDir);

    console.log("  wallet recovery: OK");
}

// --- contract + payment + settlement recovery ---

{
    const harness = createRecoveryHarness();

    harness.gameContractManager.seedContract({
        contractId: "contract-1",
        roomId: "room-1",
        gameId: "game-1",
        contractAddress: friendlyAddress("contract"),
        status: GAME_CONTRACT_STATUS.AWAITING_PLAYER_PAYMENTS,
        correlationId: "corr-1"
    });

    harness.paymentSessionManager.seedSession(new PaymentSession({
        paymentSessionId: "pay-1",
        roomId: "room-1",
        gameId: "game-1",
        contractId: "contract-1",
        status: PAYMENT_SESSION_STATUS.WAITING_FOR_PAYMENTS,
        participants: [
            new PaymentParticipant({
                playerId: "p1",
                requiredGram: 10,
                wallet: friendlyAddress("wallet-1"),
                paymentReference: "ref-1",
                status: PAYMENT_PARTICIPANT_STATUS.BLOCKCHAIN_PENDING
            })
        ]
    }));

    harness.contractSettlementManager.seedSession(new SettlementSession({
        settlementSessionId: "settle-1",
        contractId: "contract-1",
        gameId: "game-1",
        roomId: "room-1",
        winnerId: "p1",
        winnerWallet: friendlyAddress("wallet-1"),
        prizeAmount: 25,
        status: SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING,
        settlementTransactionHash: "tx-settle-1"
    }));

    const report = await harness.recovery.recover();

    assert.equal(report.contractsRecovered, 1);

    assert.equal(report.paymentSessionsRecovered, 1);

    assert.equal(report.settlementsRecovered, 1);

    assert.ok(report.blockchainWatchesRecovered >= 2);

    console.log("  contract/payment/settlement recovery: OK");
}

// --- blockchain checkpoint restore ---

{
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-fin-recovery-chain-"));

    const harness = createRecoveryHarness({ dataDir });

    harness.persistence.createRecoveryCheckpoint(
        {
            kind: "blockchain_monitor",
            checkpointAt: Date.now(),
            monitorCheckpoint: {
                contracts: [{
                    contractId: "contract-1",
                    address: friendlyAddress("checkpoint-contract"),
                    roomId: "room-1",
                    gameId: "game-1"
                }],
                transactions: [],
                paymentWatches: [],
                seenTxByRoom: {},
                confirmedRefsByRoom: {},
                emittedObservations: []
            }
        },
        {
            checkpointId: "blockchain_monitor_checkpoint",
            status: "OPEN"
        }
    );

    const report = await harness.recovery.recover();

    assert.equal(harness.blockchainMonitor.contracts.size, 1);

    assert.ok(report.blockchainWatchesRecovered >= 0);

    TonFinancialPersistence.destroyStorage(dataDir);

    console.log("  blockchain checkpoint restore: OK");
}

// --- duplicate watch protection ---

{
    const harness = createRecoveryHarness();

    harness.gameContractManager.seedContract({
        contractId: "contract-dup",
        roomId: "room-1",
        gameId: "game-1",
        contractAddress: friendlyAddress("dup-contract"),
        status: GAME_CONTRACT_STATUS.AWAITING_PLAYER_PAYMENTS
    });

    harness.paymentSessionManager.seedSession(new PaymentSession({
        paymentSessionId: "pay-dup",
        roomId: "room-1",
        gameId: "game-1",
        contractId: "contract-dup",
        status: PAYMENT_SESSION_STATUS.WAITING_FOR_PAYMENTS,
        participants: [
            new PaymentParticipant({
                playerId: "p1",
                requiredGram: 10,
                wallet: friendlyAddress("wallet-dup"),
                paymentReference: "ref-dup",
                status: PAYMENT_PARTICIPANT_STATUS.BLOCKCHAIN_PENDING
            })
        ]
    }));

    await harness.recovery.recover();

    const firstContracts = harness.blockchainMonitor.contracts.size;

    const firstPayments = harness.blockchainMonitor.paymentWatches.size;

    harness.recovery.initialize();

    harness.recovery._phaseOrderGuard = 4;

    const second = harness.recovery.recoverBlockchain();

    assert.equal(harness.blockchainMonitor.contracts.size, firstContracts);

    assert.equal(harness.blockchainMonitor.paymentWatches.size, firstPayments);

    assert.equal(second.contractWatches, firstContracts);

    console.log("  duplicate watch protection: OK");
}

// --- consistency validation ---

{
    const harness = createRecoveryHarness();

    harness.gameContractManager.seedContract({
        contractId: "contract-orphan",
        roomId: "room-1",
        gameId: "game-1",
        contractAddress: friendlyAddress("orphan-contract"),
        status: GAME_CONTRACT_STATUS.AWAITING_PLAYER_PAYMENTS
    });

    harness.paymentSessionManager.seedSession(new PaymentSession({
        paymentSessionId: "pay-orphan",
        roomId: "room-1",
        gameId: "game-1",
        contractId: "contract-orphan",
        status: PAYMENT_SESSION_STATUS.WAITING_FOR_PAYMENTS,
        participants: [
            new PaymentParticipant({
                playerId: "missing-player",
                requiredGram: 10,
                wallet: friendlyAddress("wallet-orphan"),
                status: PAYMENT_PARTICIPANT_STATUS.BLOCKCHAIN_PENDING
            })
        ]
    }));

    const validation = harness.recovery.validateRecovery();

    assert.ok(validation.consistencyErrors.length > 0);

    const report = await harness.recovery.recover();

    assert.equal(harness.recovery.health().state, FINANCIAL_RECOVERY_STATE.FAILED);

    assert.ok(report.errors.length > 0);

    console.log("  consistency validation: OK");
}

// --- partial failure tolerance ---

{
    const harness = createRecoveryHarness();

    harness.gameContractManager.restoreContracts = () => {

        throw new Error("contract restore unavailable");

    };

    const report = await harness.recovery.recover();

    assert.ok(report.failedRecoveries.some((entry) => entry.phase === FINANCIAL_RECOVERY_PHASE.CONTRACTS));

    assert.ok(report.errors.length > 0);

    console.log("  partial failure tolerance: OK");
}

// --- manager unavailable ---

{
    const logger = createLogger();

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const recovery = new TonFinancialRecovery({
        logger,
        eventBus
    });

    recovery.initialize();

    const report = await recovery.recover();

    assert.equal(report.walletSessionsRecovered, 0);

    assert.ok(report.warnings.length > 0);

    console.log("  manager unavailable: OK");
}

// --- recovery report + health ---

{
    const harness = createRecoveryHarness();

    await harness.recovery.recover({ trigger: "process_restart" });

    const report = harness.recovery.getRecoveryReport();

    assert.ok(report.timestamp);

    assert.equal(typeof report.duration, "number");

    const health = harness.recovery.health();

    assert.equal(health.state, FINANCIAL_RECOVERY_STATE.COMPLETED);

    assert.ok(Array.isArray(health.recoveredManagers));

    const dashboard = harness.recovery.getDashboardSnapshot();

    assert.equal(dashboard.state, FINANCIAL_RECOVERY_STATE.COMPLETED);

    assert.ok(dashboard.lastSuccessfulRecovery);

    console.log("  recovery report + health: OK");
}

// --- restart recovery ---

{
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-fin-recovery-restart-"));

    const first = createRecoveryHarness({ dataDir });

    first.sessionWalletStore.create(new WalletSession({
        walletSessionId: "ws-restart",
        playerId: "p1",
        roomId: "room-1",
        walletAddress: friendlyAddress("wallet-restart"),
        status: WALLET_SESSION_STATUS.VERIFIED,
        network: "testnet"
    }));

    await first.recovery.recover({ trigger: "server_restart" });

    first.persistence?.shutdown();

    const second = createRecoveryHarness({ dataDir });

    const report = await second.recovery.recover({ trigger: "server_restart" });

    assert.equal(report.walletSessionsRecovered, 1);

    TonFinancialPersistence.destroyStorage(dataDir);

    console.log("  restart recovery: OK");
}

console.log("tonFinancialRecovery.test.js: all assertions passed");
