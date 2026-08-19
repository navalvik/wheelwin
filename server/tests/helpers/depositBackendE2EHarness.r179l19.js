/**
 * R17.9L.19 — Backend deposit E2E test harness.
 * FakeDepositBlockchainSource + full deposit stack. No real TON.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    OWNER_CONFIG_EXAMPLE_PATH,
    OwnerConfiguration
} from "../../config/OwnerConfiguration.js";
import { DepositFullAuthorizationAutomation } from "../../deposit/DepositFullAuthorizationAutomation.js";
import { DepositMonitor } from "../../deposit/DepositMonitor.js";
import { DepositOnChainVerificationCoordinator } from "../../deposit/DepositOnChainVerificationCoordinator.js";
import { DepositSessionCoordinator } from "../../deposit/DepositSessionCoordinator.js";
import { DeploymentAuthorizationCoordinator } from "../../deposit/DeploymentAuthorizationCoordinator.js";
import { FakeDepositBlockchainSource } from "../../deposit/FakeDepositBlockchainSource.js";
import { TonFinancialDepositPersistence } from "../../deposit/DepositPersistencePort.js";
import { TonFinancialDepositObservationPersistence } from "../../deposit/DepositObservationPersistencePort.js";
import { TonFinancialDeploymentAuthorizationPersistence } from "../../deposit/DeploymentAuthorizationPersistencePort.js";
import { EventBus } from "../../events/EventBus.js";
import { EVENT_TYPES } from "../../events/EventTypes.js";
import { GameContractManager } from "../../gameplay/GameContractManager.js";
import { PaymentSessionManager } from "../../gameplay/PaymentSessionManager.js";
import { TonFinancialPersistence } from "../../persistence/TonFinancialPersistence.js";

/** Distinct non-zero deterministic player fixtures (not ZERO / prod / deployer). */
export const PLAYER_WALLET_0 = "EQABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAc3j";
export const PLAYER_WALLET_1 = "EQACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAsoi";
export const PLAYER_WALLET_2 = "EQADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA8id";

export const ZERO_WALLET = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";
export const PRODUCTION_DEPLOY_WALLET = "EQB83s9XMOMseDFxyXxj4hrC0sS4FB4xhdNiUPkl_3zx3PDQ";
export const TESTNET_DEPOSIT_DEPLOYER = "0QBSm-tvehArk8g8VybQEUpI83rI1IZozP3KUK8WdvMSjaIl";

export const ORACLE_FIXTURE = "EQAREREREREREREREREREREREREREREREREREREREREREeYT";

export class TonSpendTracker {

    constructor() {

        this.broadcastTransaction = 0;
        this.sendTransaction = 0;
        this.adapterDeploy = 0;
        this.beforeDepositFull = 0;
        this.duringDepositDeployment = 0;
        this.afterValidAuthorization = 0;
        this._depositFullSeen = false;
        this._validAuthSeen = false;

    }

    markDepositFull() {

        this._depositFullSeen = true;

    }

    markValidAuthorization() {

        this._validAuthSeen = true;

    }

    recordBroadcast() {

        this.broadcastTransaction += 1;

        this._bucket();

    }

    recordSendTransaction() {

        this.sendTransaction += 1;

        this._bucket();

    }

    recordAdapterDeploy() {

        this.adapterDeploy += 1;
        this._bucket();

    }

    _bucket() {

        if (!this._depositFullSeen) {

            this.beforeDepositFull += 1;

            return;

        }

        if (!this._validAuthSeen) {

            this.duringDepositDeployment += 1;

            return;

        }

        this.afterValidAuthorization += 1;

    }

    total() {

        return this.broadcastTransaction + this.sendTransaction + this.adapterDeploy;

    }

    snapshot() {

        return Object.freeze({
            broadcastTransaction: this.broadcastTransaction,
            sendTransaction: this.sendTransaction,
            adapterDeploy: this.adapterDeploy,
            beforeDepositFull: this.beforeDepositFull,
            duringDepositDeployment: this.duringDepositDeployment,
            afterValidAuthorization: this.afterValidAuthorization,
            total: this.total()
        });

    }

}

export function createLogger() {

    return {
        info() {},
        warn() {},
        error() {},
        debug() {},
        decisionTrace() {}
    };

}

export function threePlayers({
    expectedAmount = 10
} = {}) {

    return [
        { playerId: "p0", wallet: PLAYER_WALLET_0, expectedAmount },
        { playerId: "p1", wallet: PLAYER_WALLET_1, expectedAmount },
        { playerId: "p2", wallet: PLAYER_WALLET_2, expectedAmount }
    ];

}

export function createDiskPersistence(prefix = "wheelwin-l19-") {

    const dataDir = mkdtempSync(join(tmpdir(), prefix));

    const persistence = new TonFinancialPersistence({
        dataDir,
        autoCheckpoint: false
    });

    persistence.initialize();

    return { dataDir, persistence };

}

export function reopenPersistence(dataDir) {

    const persistence = new TonFinancialPersistence({
        dataDir,
        autoCheckpoint: false
    });

    persistence.initialize();

    return persistence;

}

export function collectEvents(eventBus, types) {

    const emitted = [];

    for (const type of types) {

        eventBus.subscribe(type, (envelope) => {

            emitted.push({
                type,
                source: envelope.source,
                payload: envelope.payload
            });

        });

    }

    return emitted;

}

export function createDepositBackendE2EHarness({
    persistence = null,
    withGameContractManager = false,
    withPaymentSessionManager = false,
    tonSpendTracker = null
} = {}) {

    OwnerConfiguration.resetForTests();

    OwnerConfiguration.load({ configPath: OWNER_CONFIG_EXAMPLE_PATH });

    const logger = createLogger();

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const tracker = tonSpendTracker ?? new TonSpendTracker();

    const depositPersistence = persistence
        ? new TonFinancialDepositPersistence(persistence)
        : null;

    const observationPersistence = persistence
        ? new TonFinancialDepositObservationPersistence(persistence)
        : null;

    const authorizationPersistence = persistence
        ? new TonFinancialDeploymentAuthorizationPersistence(persistence)
        : null;

    const depositSessionCoordinator = new DepositSessionCoordinator({
        eventBus,
        persistence: depositPersistence
    });

    const deploymentAuthorizationCoordinator = new DeploymentAuthorizationCoordinator({
        eventBus,
        persistence: authorizationPersistence
    });

    const monitor = new DepositMonitor({
        logger,
        eventBus,
        depositSessionCoordinator,
        persistence: observationPersistence,
        network: "testnet"
    });

    monitor.initialize();

    const verificationCoordinator = new DepositOnChainVerificationCoordinator({
        logger,
        eventBus,
        depositSessionCoordinator,
        observationPersistence
    });

    verificationCoordinator.initialize();

    const automation = new DepositFullAuthorizationAutomation({
        logger,
        eventBus,
        depositSessionCoordinator,
        deploymentAuthorizationCoordinator
    });

    automation.initialize();

    eventBus.subscribe(EVENT_TYPES.DEPOSIT_FULL, () => {

        tracker.markDepositFull();

    });

    eventBus.subscribe(EVENT_TYPES.DEPLOY_AUTHORIZATION_VALID, () => {

        tracker.markValidAuthorization();

    });

    const source = new FakeDepositBlockchainSource({ monitor });

    const deployAdapter = {
        async deploy(payload) {

            tracker.recordAdapterDeploy();

            return {
                ok: true,
                contractAddress: `EQdeploy-${payload?.contractId ?? "mock"}`,
                deploymentTxId: "tx-mock",
                deployedAt: Date.now()
            };

        }
    };

    const tonService = {
        async broadcastTransaction(boc) {

            tracker.recordBroadcast();

            return { ok: true, boc };

        },
        async sendTransaction() {

            tracker.recordSendTransaction();

            return { ok: true };

        }
    };

    let gameContractManager = null;

    let paymentSessionManager = null;

    const beginDeployCalls = [];

    const createContractRequestCalls = [];

    if (withGameContractManager) {

        gameContractManager = new GameContractManager({
            logger,
            eventBus,
            playerManager: {
                getIdentity(playerId) {

                    return {
                        p0: { nickname: "A", baseStake: 10, sectorCount: 1 },
                        p1: { nickname: "B", baseStake: 10, sectorCount: 1 },
                        p2: { nickname: "C", baseStake: 10, sectorCount: 1 }
                    }[playerId] ?? null;

                }
            },
            roomManager: {
                getRoom(roomId) {

                    return roomId ? { players: ["p0", "p1", "p2"] } : null;

                }
            },
            sessionWalletStore: {
                getWallet() {

                    return PLAYER_WALLET_0;

                }
            },
            configurationEngine: {
                getConfiguration() {

                    return { stake: 10, players: [], sectors: [] };

                }
            },
            deployAdapter,
            deploymentAuthorizationCoordinator,
            tonNetwork: "testnet",
            creatingDelayMs: 0,
            devMode: false
        });

        const originalBeginDeploy = gameContractManager._beginDeploy.bind(gameContractManager);

        gameContractManager._beginDeploy = function (...args) {

            beginDeployCalls.push(args);

            return originalBeginDeploy(...args);

        };

        const originalCreateContractRequest = gameContractManager.createContractRequest.bind(
            gameContractManager
        );

        gameContractManager.createContractRequest = function (...args) {

            createContractRequestCalls.push(args);

            return originalCreateContractRequest(...args);

        };

        gameContractManager.initialize();

    }

    if (withPaymentSessionManager) {

        paymentSessionManager = new PaymentSessionManager({
            logger,
            eventBus,
            playerManager: {
                getIdentity(playerId) {

                    return {
                        p0: { baseStake: 10, sectorCount: 1 },
                        p1: { baseStake: 10, sectorCount: 1 },
                        p2: { baseStake: 10, sectorCount: 1 }
                    }[playerId] ?? null;

                }
            },
            roomManager: {
                getRoom(roomId) {

                    return roomId ? { players: ["p0", "p1", "p2"] } : null;

                }
            },
            roomConfig: { paymentSessionDurationMs: 60_000 },
            gameplayContextResolver: {
                resolveGameIdByRoomId(roomId) {

                    return roomId?.startsWith("room-") ? roomId.replace("room-", "game-") : null;

                }
            },
            sessionWalletStore: {
                getWallet() {

                    return PLAYER_WALLET_0;

                }
            },
            gameContractManager,
            tonNetwork: "testnet",
            devMode: false
        });

        paymentSessionManager.initialize();

    }

    return {
        logger,
        eventBus,
        depositSessionCoordinator,
        deploymentAuthorizationCoordinator,
        monitor,
        verificationCoordinator,
        automation,
        source,
        persistence,
        depositPersistence,
        observationPersistence,
        authorizationPersistence,
        gameContractManager,
        paymentSessionManager,
        deployAdapter,
        tonService,
        tracker,
        beginDeployCalls,
        createContractRequestCalls,
        shutdown() {

            paymentSessionManager?.shutdown?.();

            gameContractManager?.shutdown?.();

            monitor.shutdown();

            eventBus.shutdown();

        }
    };

}

export function createWatchableSession(coordinator, {
    roomId = "room-a",
    gameId = "game-a",
    depositAddress = "EQ_deposit_fixture_D1",
    players = threePlayers(),
    depositPersistence = null
} = {}) {

    const session = coordinator.createSession({
        roomId,
        gameId,
        metadata: { network: "testnet" }
    });

    coordinator.bindPlayers(session.depositId, players);

    coordinator.markAwaitingFunds(session.depositId);

    session.depositAddress = depositAddress;

    if (depositPersistence) {

        depositPersistence.saveDepositSession(session);

    }

    return session;

}

export function fundSeat(source, session, {
    wallet,
    amount = 10,
    transactionHash,
    depositAddress = session.depositAddress
} = {}) {

    return source.emitValidPayment({
        depositId: session.depositId,
        depositAddress,
        senderWallet: wallet,
        amount,
        transactionHash: transactionHash ?? `tx-${session.depositId}-${wallet}`,
        network: "testnet"
    });

}

export function reopenDepositStack(dataDir) {

    const persistence = reopenPersistence(dataDir);

    const logger = createLogger();

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const depositPersistence = new TonFinancialDepositPersistence(persistence);

    const observationPersistence = new TonFinancialDepositObservationPersistence(persistence);

    const authorizationPersistence = new TonFinancialDeploymentAuthorizationPersistence(persistence);

    const depositSessionCoordinator = new DepositSessionCoordinator({
        eventBus,
        persistence: depositPersistence
    });

    depositSessionCoordinator.restoreActiveSessions();

    const deploymentAuthorizationCoordinator = new DeploymentAuthorizationCoordinator({
        eventBus,
        persistence: authorizationPersistence
    });

    deploymentAuthorizationCoordinator.restoreActiveAuthorizations();

    const monitor = new DepositMonitor({
        logger,
        eventBus,
        depositSessionCoordinator,
        persistence: observationPersistence,
        network: "testnet"
    });

    monitor.initialize();

    monitor.restoreActiveWatches();

    const verificationCoordinator = new DepositOnChainVerificationCoordinator({
        logger,
        eventBus,
        depositSessionCoordinator,
        observationPersistence
    });

    verificationCoordinator.initialize();

    verificationCoordinator.syncFromPersistedObservations();

    const automation = new DepositFullAuthorizationAutomation({
        logger,
        eventBus,
        depositSessionCoordinator,
        deploymentAuthorizationCoordinator
    });

    automation.initialize();

    automation.syncFromActiveDepositSessions();

    const source = new FakeDepositBlockchainSource({ monitor });

    return {
        logger,
        eventBus,
        depositSessionCoordinator,
        deploymentAuthorizationCoordinator,
        monitor,
        verificationCoordinator,
        automation,
        source,
        persistence,
        depositPersistence,
        observationPersistence,
        shutdown() {

            monitor.shutdown();

            eventBus.shutdown();

        }
    };

}

export function assertZeroWheelWinSpend(tracker, context = "") {

    const snap = tracker.snapshot();

    if (snap.total !== 0) {

        throw new Error(
            `${context} expected 0 WheelWin TON broadcasts, got ${JSON.stringify(snap)}`
        );

    }

}
