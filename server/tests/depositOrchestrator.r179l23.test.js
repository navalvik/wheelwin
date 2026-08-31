/**
 * R17.9L.23 — DepositOrchestrator production integration tests.
 * Stubbed TON RPC only. No live send, no mnemonic, no Page4.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DepositActivationVerificationCoordinator } from "../deposit/DepositActivationVerificationCoordinator.js";
import { DEPOSIT_ACTIVATION_STATUS } from "../deposit/DepositActivationVerificationErrors.js";
import { DepositMonitor } from "../deposit/DepositMonitor.js";
import { DepositOrchestrator } from "../deposit/DepositOrchestrator.js";
import {
    DEPOSIT_ORCHESTRATOR_ERROR_CODES,
    DepositOrchestratorError
} from "../deposit/DepositOrchestratorErrors.js";
import { InMemoryDepositPersistence } from "../deposit/DepositPersistencePort.js";
import { DepositSessionCoordinator } from "../deposit/DepositSessionCoordinator.js";
import { DEPOSIT_SESSION_STATUS } from "../deposit/DepositSessionStates.js";
import { RealTonDepositBlockchainSource } from "../deposit/RealTonDepositBlockchainSource.js";
import {
    resolveDepositOrchestrationFinancials
} from "../deposit/resolveDepositOrchestrationFinancials.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GameplayContextResolver } from "../socket/GameplayContextResolver.js";
import { InvalidDepositBindingError } from "../deposit/DepositSessionErrors.js";
import { resolveReservedDepositWallets } from "../deposit/depositValidation.js";
import { canonicalizeTonWalletAddress } from "../models/TonWalletAddress.js";
import {
    buildDepositStateInit,
    resetDepositCodeCellCacheForTests
} from "../payment/ton/buildDepositStateInit.js";
import { FROZEN_DEPOSIT_ARTIFACT_SHA256 } from "../payment/ton/depositTestnetFixture.js";
import { NetworkUnavailableError } from "../services/ton/TonServiceErrors.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ORCHESTRATOR_SOURCE = readFileSync(
    join(HERE, "../deposit/DepositOrchestrator.js"),
    "utf8"
);

const PLAYER_0 = "EQABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAc3j";
const PLAYER_1 = "EQACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAsoi";
const PLAYER_2 = "EQADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA8id";
const ORACLE = "EQAREREREREREREREREREREREREREREREREREREREREREeYT";
const PRODUCTION_DEPLOY_WALLET = "EQB83s9XMOMseDFxyXxj4hrC0sS4FB4xhdNiUPkl_3zx3PDQ";

const ROOM_ID = "room-l23";
const GAME_ID = "game-l23";

const FINANCIAL_ENV = Object.freeze({
    TON_NETWORK: "testnet",
    TON_TESTNET_ORACLE_ADDRESS: ORACLE,
    TON_DEPLOYER_WALLET: PRODUCTION_DEPLOY_WALLET,
    TON_DEPOSIT_CREATION_FEE_PER_SEAT_NANO: "1000000",
    TON_DEPOSIT_STAKE_NANOTON_BY_PROFILE: JSON.stringify({
        "1:1": "10000000",
        "1:2": "25000000",
        "10:1": "100000000",
        "10:2": "250000000"
    }),
    TON_DEPOSIT_TIMEOUT_MS: "60000"
});

function canonicalAddress(address) {

    return canonicalizeTonWalletAddress(address) ?? address;

}

function createLogger() {

    return {
        info() {},
        warn() {},
        error() {},
        debug() {},
        decisionTrace() {}
    };

}

function createEventBus() {

    const eventBus = new EventBus({
        logger: createLogger(),
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    return eventBus;

}

function testFinancials() {

    return resolveDepositOrchestrationFinancials({
        env: FINANCIAL_ENV,
        network: "testnet",
        paymentDurationMs: 60_000
    });

}

class StubTonService {

    constructor({ account = null } = {}) {

        this.account = account ?? { state: "uninit", code: "", balance: "0" };
        this.broadcastTransactionCalls = 0;
        this.sendTransactionCalls = 0;

    }

    getActiveNetwork() {

        return "testnet";

    }

    async getAccount() {

        return this.account;

    }

    async getTransactions() {

        return [];

    }

    async runGetMethod() {

        throw new NetworkUnavailableError("getter unavailable in UNINIT test");

    }

    async broadcastTransaction() {

        this.broadcastTransactionCalls += 1;

        throw new Error("broadcastTransaction must not be called");

    }

    async sendTransaction() {

        this.sendTransactionCalls += 1;

        throw new Error("sendTransaction must not be called");

    }

}

function createPlayerManager(identities = null) {

    const defaults = {
        p0: { playerId: "p0", baseStake: 1, sectorCount: 1 },
        p1: { playerId: "p1", baseStake: 1, sectorCount: 1 },
        p2: { playerId: "p2", baseStake: 1, sectorCount: 1 }
    };

    const map = identities ?? defaults;

    return {
        getIdentity(playerId) {

            return map[playerId] ?? null;

        }
    };

}

function createSessionWalletStore(wallets = null) {

    const defaults = {
        p0: PLAYER_0,
        p1: PLAYER_1,
        p2: PLAYER_2
    };

    const map = wallets ?? defaults;

    return {
        getWallet(_roomId, playerId) {

            return map[playerId] ?? null;

        }
    };

}

function createRoomManager(playerIds = ["p0", "p1", "p2"]) {

    return {
        getRoom(roomId) {

            if (roomId !== ROOM_ID) {

                return null;

            }

            return {
                roomId,
                players: [...playerIds]
            };

        }
    };

}

function createStack({
    persistence = null,
    playerManager = null,
    sessionWalletStore = null,
    roomManager = null,
    activateGame = true,
    financialParameters = null,
    tonService = null,
    activationRetryIntervalMs = 60_000
} = {}) {

    resetDepositCodeCellCacheForTests();

    const logger = createLogger();
    const eventBus = createEventBus();
    const depositPersistence = persistence ?? new InMemoryDepositPersistence();

    const depositSessionCoordinator = new DepositSessionCoordinator({
        eventBus,
        persistence: depositPersistence,
        env: FINANCIAL_ENV,
        reservedWallets: resolveReservedDepositWallets(FINANCIAL_ENV)
    });

    const gameplayContextResolver = new GameplayContextResolver({
        logger,
        playerManager: createPlayerManager(),
        roomManager: createRoomManager()
    });

    if (activateGame) {

        gameplayContextResolver.activateRoomGame(ROOM_ID, GAME_ID);

    }

    const stubTon = tonService ?? new StubTonService();

    const depositMonitor = new DepositMonitor({
        logger,
        eventBus,
        depositSessionCoordinator,
        blockchainSource: new RealTonDepositBlockchainSource({
            logger,
            tonService: stubTon,
            network: "testnet"
        }),
        network: "testnet",
        requireActivationVerification: true
    });

    depositMonitor.initialize();

    const depositActivationVerification = new DepositActivationVerificationCoordinator({
        logger,
        eventBus,
        depositSessionCoordinator,
        depositMonitor,
        blockchainSource: new RealTonDepositBlockchainSource({
            logger,
            tonService: stubTon,
            network: "testnet"
        }),
        tonService: stubTon,
        network: "testnet",
        env: FINANCIAL_ENV
    });

    const gameContractManager = {
        deployCalls: 0,
        createContractCalls: 0,
        deployContract() {

            this.deployCalls += 1;

        },
        createContract() {

            this.createContractCalls += 1;

        }
    };

    const deploymentAuthorizationCoordinator = {
        createCalls: 0,
        createAuthorization() {

            this.createCalls += 1;

        }
    };

    const monitorSpies = {
        authorizeVerifiedWatchCalls: 0,
        startWatchingCalls: 0
    };

    const originalAuthorize = depositMonitor.authorizeVerifiedWatch.bind(depositMonitor);
    const originalStart = depositMonitor.startWatching.bind(depositMonitor);

    depositMonitor.authorizeVerifiedWatch = (...args) => {

        monitorSpies.authorizeVerifiedWatchCalls += 1;

        return originalAuthorize(...args);

    };

    depositMonitor.startWatching = (...args) => {

        monitorSpies.startWatchingCalls += 1;

        return originalStart(...args);

    };

    const orchestrator = new DepositOrchestrator({
        logger,
        eventBus,
        depositSessionCoordinator,
        depositActivationVerificationCoordinator: depositActivationVerification,
        gameplayContextResolver,
        roomManager: roomManager ?? createRoomManager(),
        playerManager: playerManager ?? createPlayerManager(),
        sessionWalletStore: sessionWalletStore ?? createSessionWalletStore(),
        financialParameters: financialParameters ?? testFinancials(),
        env: FINANCIAL_ENV,
        activationRetryIntervalMs
    });

    return {
        orchestrator,
        depositSessionCoordinator,
        depositMonitor,
        depositActivationVerification,
        depositPersistence,
        eventBus,
        stubTon,
        gameContractManager,
        deploymentAuthorizationCoordinator,
        monitorSpies,
        gameplayContextResolver
    };

}

// ─── A. Normal orchestration ───

test("R17.9L.23 TestA: PAYMENT_CONNECTION_READY → package → WAITING_FOR_PLAYER_DEPLOYMENT", async () => {

    const { orchestrator, depositSessionCoordinator, eventBus } = createStack();

    const packageEvents = [];

    eventBus.subscribe(EVENT_TYPES.DEPOSIT_PACKAGE_PUBLISHED, (envelope) => {

        packageEvents.push(envelope);

    });

    const result = await orchestrator.handlePaymentConnectionReady({ roomId: ROOM_ID });

    assert.equal(result.ok, true);
    assert.equal(result.activationStatus, DEPOSIT_ACTIVATION_STATUS.WAITING_FOR_PLAYER_DEPLOYMENT);
    assert.equal(result.watchStarted, false);

    const session = depositSessionCoordinator.getSession(result.depositId);

    assert.equal(session.state, DEPOSIT_SESSION_STATUS.AWAITING_FUNDS);
    assert.equal(session.bindings.length, 3);
    assert.ok(session.depositAddress);
    assert.ok(session.metadata?.depositPackage);
    assert.equal(
        canonicalAddress(session.metadata.depositPackage.depositAddress),
        canonicalAddress(session.depositAddress)
    );
    assert.equal(packageEvents.length, 1);
    assert.equal(packageEvents[0].source, EVENT_SOURCES.DEPOSIT_ORCHESTRATOR);
    assert.equal(packageEvents[0].payload.depositId, result.depositId);

});

test("R18-S16: freezeDepositPackage publishes deployValueNanotons=10000000 independent of B/C/D", async () => {

    const { orchestrator, depositSessionCoordinator, eventBus } = createStack();

    const packageEvents = [];

    eventBus.subscribe(EVENT_TYPES.DEPOSIT_PACKAGE_PUBLISHED, (envelope) => {

        packageEvents.push(envelope);

    });

    const result = await orchestrator.handlePaymentConnectionReady({ roomId: ROOM_ID });
    const session = depositSessionCoordinator.getSession(result.depositId);
    const frozen = session.metadata.depositPackage;
    const published = packageEvents[0].payload.package;

    assert.equal(frozen.deployValueNanotons, "10000000");
    assert.equal(published.deployValueNanotons, "10000000");
    assert.equal(frozen.creationFeePerSeat, "1000000");
    assert.equal(session.metadata.creationFeePerSeat, 1000000);
    assert.equal(session.metadata.expectedStake0, 10000000);
    assert.equal(session.metadata.expectedStake1, 10000000);
    assert.equal(session.metadata.expectedStake2, 10000000);
    assert.equal(session.bindings[0].expectedAmount, 11000000);
    assert.equal(session.bindings[1].expectedAmount, 11000000);
    assert.equal(session.bindings[2].expectedAmount, 11000000);
    assert.equal(frozen.bindings[0].expectedStake, 10000000);
    assert.equal(
        String(session.metadata.expectedStake0),
        "10000000",
        "1:1 C remains 10000000 from the stake map, not from deployValueNanotons"
    );
    assert.notEqual(
        frozen.deployValueNanotons,
        String(frozen.creationFeePerSeat),
        "A must not equal B (creationFeePerSeat)"
    );
    assert.notEqual(
        frozen.deployValueNanotons,
        String(session.bindings[0].expectedAmount),
        "A must not equal D (FundSeat expectedAmount)"
    );
    assert.notEqual(
        frozen.deployValueNanotons,
        String(Number(frozen.creationFeePerSeat) * session.bindings.length),
        "A must not equal seats × creationFeePerSeat"
    );
    assert.ok(frozen.stateInit?.codeBoc);
    assert.ok(frozen.stateInit?.dataBoc);
    assert.ok(frozen.depositId);
    assert.ok(frozen.depositAddress);

    assert.match(
        ORCHESTRATOR_SOURCE,
        /const DEPOSIT_CONTRACT_DEPLOY_VALUE_NANOTONS = "10000000"/
    );
    assert.doesNotMatch(
        ORCHESTRATOR_SOURCE,
        /deployValueNanotons:\s*financials/
    );
    assert.doesNotMatch(
        ORCHESTRATOR_SOURCE,
        /deployValueNanotons:\s*.*expectedAmount/
    );
    assert.doesNotMatch(
        ORCHESTRATOR_SOURCE,
        /deployValueNanotons:\s*.*creationFee/
    );

});

// ─── B. Duplicate event ───

test("R17.9L.23 TestB: duplicate PAYMENT_CONNECTION_READY is idempotent", async () => {

    const { orchestrator, depositSessionCoordinator, eventBus } = createStack();

    let packageCount = 0;

    eventBus.subscribe(EVENT_TYPES.DEPOSIT_PACKAGE_PUBLISHED, () => {

        packageCount += 1;

    });

    const first = await orchestrator.handlePaymentConnectionReady({ roomId: ROOM_ID });
    const second = await orchestrator.handlePaymentConnectionReady({ roomId: ROOM_ID });
    const third = await orchestrator.handlePaymentConnectionReady({ roomId: ROOM_ID });

    assert.equal(first.depositId, second.depositId);
    assert.equal(first.depositAddress, second.depositAddress);
    assert.equal(second.depositAddress, third.depositAddress);
    assert.equal(packageCount, 1);

    const sessions = [...depositSessionCoordinator.listActiveDepositSessions()]
        .filter((session) => session.roomId === ROOM_ID && session.gameId === GAME_ID);

    assert.equal(sessions.length, 1);

});

// ─── C. Missing game ───

test("R17.9L.23 TestC: missing gameId fails closed", async () => {

    const { orchestrator, depositSessionCoordinator } = createStack({ activateGame: false });

    await assert.rejects(
        () => orchestrator.handlePaymentConnectionReady({ roomId: ROOM_ID }),
        (error) => {
            assert.equal(error instanceof DepositOrchestratorError, true);
            assert.equal(error.code, DEPOSIT_ORCHESTRATOR_ERROR_CODES.GAME_NOT_FOUND);
            return true;
        }
    );

    const sessions = [...depositSessionCoordinator.listActiveDepositSessions()]
        .filter((session) => session.roomId === ROOM_ID);

    assert.equal(sessions.length, 0);

});

// ─── D. Missing player wallet ───

test("R17.9L.23 TestD: missing player wallet fails closed", async () => {

    const { orchestrator, depositSessionCoordinator } = createStack({
        sessionWalletStore: createSessionWalletStore({
            p0: PLAYER_0,
            p1: PLAYER_1,
            p2: null
        })
    });

    await assert.rejects(
        () => orchestrator.handlePaymentConnectionReady({ roomId: ROOM_ID }),
        (error) => {
            assert.equal(error.code, DEPOSIT_ORCHESTRATOR_ERROR_CODES.WALLET_UNAVAILABLE);
            return true;
        }
    );

    assert.equal(
        depositSessionCoordinator.getByRoomAndGame(ROOM_ID, GAME_ID),
        null
    );

});

// ─── E. Duplicate/reserved wallet ───

test("R17.9L.23 TestE: duplicate wallet rejected via bindPlayers validation", async () => {

    const { orchestrator } = createStack({
        sessionWalletStore: createSessionWalletStore({
            p0: PLAYER_0,
            p1: PLAYER_0,
            p2: PLAYER_2
        })
    });

    await assert.rejects(
        () => orchestrator.handlePaymentConnectionReady({ roomId: ROOM_ID }),
        (error) => {
            assert.ok(
                error instanceof InvalidDepositBindingError
                || error instanceof DepositOrchestratorError
            );
            return true;
        }
    );

});

test("R17.9L.23 TestE2: reserved deploy wallet rejected", async () => {

    const { orchestrator } = createStack({
        sessionWalletStore: createSessionWalletStore({
            p0: PRODUCTION_DEPLOY_WALLET,
            p1: PLAYER_1,
            p2: PLAYER_2
        })
    });

    await assert.rejects(
        () => orchestrator.handlePaymentConnectionReady({ roomId: ROOM_ID })
    );

});

// ─── F. Invalid financial configuration ───

test("R17.9L.23 TestF: invalid financial configuration fails closed", async () => {

    const { orchestrator } = createStack({
        financialParameters: null
    });

    orchestrator._financialParameters = null;
    orchestrator._resolveFinancialParameters = () => {

        throw new DepositOrchestratorError(
            "TON_DEPOSIT_CREATION_FEE_PER_SEAT_NANO is required",
            DEPOSIT_ORCHESTRATOR_ERROR_CODES.FINANCIAL_CONFIG_UNAVAILABLE
        );

    };

    await assert.rejects(
        () => orchestrator.handlePaymentConnectionReady({ roomId: ROOM_ID }),
        (error) => {
            assert.equal(error.code, DEPOSIT_ORCHESTRATOR_ERROR_CODES.FINANCIAL_CONFIG_UNAVAILABLE);
            return true;
        }
    );

});

test("R17.9L.23 TestF2: resolveDepositOrchestrationFinancials rejects missing env", () => {

    assert.throws(
        () => resolveDepositOrchestrationFinancials({ env: {}, network: "testnet" }),
        (error) => {
            assert.equal(error.code, DEPOSIT_ORCHESTRATOR_ERROR_CODES.FINANCIAL_CONFIG_UNAVAILABLE);
            return true;
        }
    );

});

// ─── G. Deterministic address ───

test("R17.9L.23 TestG: package address matches StateInit and setDepositAddress", async () => {

    const { orchestrator, depositSessionCoordinator } = createStack();

    const result = await orchestrator.handlePaymentConnectionReady({ roomId: ROOM_ID });

    const session = depositSessionCoordinator.getSession(result.depositId);
    const financials = testFinancials();
    const stake = financials.resolveExpectedStakeNano({ baseStake: 1, sectorCount: 1 });

    const built = buildDepositStateInit({
        depositId: session.depositId,
        roomId: session.roomId,
        gameId: session.gameId,
        players: session.bindings.map((binding) => ({
            playerId: binding.playerId,
            wallet: binding.wallet,
            expectedStake: stake
        })),
        creationFeePerSeat: financials.creationFeePerSeat,
        expiresAt: BigInt(session.metadata.contractExpiresAt),
        network: "testnet",
        env: FINANCIAL_ENV
    });

    assert.equal(
        canonicalAddress(session.depositAddress),
        canonicalAddress(built.addressFriendly)
    );
    assert.equal(
        canonicalAddress(session.metadata.depositPackage.depositAddress),
        canonicalAddress(built.addressFriendly)
    );
    assert.equal(
        canonicalAddress(result.depositAddress),
        canonicalAddress(built.addressFriendly)
    );

});

// ─── H. Package persistence ───

test("R17.9L.23 TestH: deposit package survives coordinator restoration", async () => {

    const persistence = new InMemoryDepositPersistence();
    const first = createStack({ persistence });

    const result = await first.orchestrator.handlePaymentConnectionReady({ roomId: ROOM_ID });

    const restoredCoordinator = new DepositSessionCoordinator({
        eventBus: createEventBus(),
        persistence,
        env: FINANCIAL_ENV,
        reservedWallets: resolveReservedDepositWallets(FINANCIAL_ENV)
    });

    const stats = restoredCoordinator.restoreActiveSessions();

    assert.equal(stats.restored, 1);

    const session = restoredCoordinator.getByRoomAndGame(ROOM_ID, GAME_ID);

    assert.ok(session);
    assert.equal(session.depositId, result.depositId);
    assert.equal(
        canonicalAddress(session.depositAddress),
        canonicalAddress(result.depositAddress)
    );
    assert.equal(
        canonicalAddress(session.metadata.depositPackage.depositAddress),
        canonicalAddress(result.depositAddress)
    );

});

// ─── I. Activation verification UNINIT ───

test("R17.9L.23 TestI: UNINIT → WAITING_FOR_PLAYER_DEPLOYMENT, authorizeVerifiedWatch not called", async () => {

    const { orchestrator, monitorSpies, depositMonitor } = createStack();

    const result = await orchestrator.handlePaymentConnectionReady({ roomId: ROOM_ID });

    assert.equal(result.activationStatus, DEPOSIT_ACTIVATION_STATUS.WAITING_FOR_PLAYER_DEPLOYMENT);
    assert.equal(result.watchStarted, false);
    assert.equal(monitorSpies.authorizeVerifiedWatchCalls, 0);
    assert.equal(monitorSpies.startWatchingCalls, 0);
    assert.equal(depositMonitor.listActiveWatches().length, 0);

    orchestrator.shutdown();

});

test("R18-S15: DEPOSIT_ACTIVATION_WAITING retries existing verifyActivation", async () => {

    const stack = createStack({ activationRetryIntervalMs: 20 });
    let verifyCalls = 0;
    const originalVerify = stack.depositActivationVerification.verifyActivation
        .bind(stack.depositActivationVerification);

    stack.depositActivationVerification.verifyActivation = async (...args) => {

        verifyCalls += 1;

        return originalVerify(...args);

    };

    stack.orchestrator.initialize();

    const result = await stack.orchestrator.handlePaymentConnectionReady({ roomId: ROOM_ID });

    assert.equal(result.activationStatus, DEPOSIT_ACTIVATION_STATUS.WAITING_FOR_PLAYER_DEPLOYMENT);
    assert.equal(verifyCalls, 1);

    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.ok(
        verifyCalls >= 2,
        `expected retry of verifyActivation, got ${verifyCalls}`
    );
    assert.equal(stack.monitorSpies.authorizeVerifiedWatchCalls, 0);

    stack.orchestrator.shutdown();

});

// ─── J. Monitor bypass protection ───

test("R17.9L.23 TestJ: orchestrator source does not call startWatching directly", () => {

    assert.doesNotMatch(ORCHESTRATOR_SOURCE, /\.startWatching\s*\(/);
    assert.doesNotMatch(ORCHESTRATOR_SOURCE, /\.authorizeVerifiedWatch\s*\(/);

});

// ─── K. Game deployment isolation ───

test("R17.9L.23 TestK: orchestrator source has no GameContract or DeploymentAuthorization paths", () => {

    assert.doesNotMatch(ORCHESTRATOR_SOURCE, /GameContractManager/);
    assert.doesNotMatch(ORCHESTRATOR_SOURCE, /DeploymentAuthorization/);
    assert.doesNotMatch(ORCHESTRATOR_SOURCE, /broadcastTransaction/);

});

// ─── L. Zero TON spend ───

test("R17.9L.23 TestL: orchestration path performs zero TON broadcasts", async () => {

    const { orchestrator, stubTon } = createStack();

    await orchestrator.handlePaymentConnectionReady({ roomId: ROOM_ID });

    assert.equal(stubTon.broadcastTransactionCalls, 0);
    assert.equal(stubTon.sendTransactionCalls, 0);

});

test("R17.9L.23 TestL2: EventBus subscription orchestrates without TON spend", async () => {

    const stack = createStack();

    stack.orchestrator.initialize();

    stack.eventBus.emit({
        source: EVENT_SOURCES.ROOM_LOBBY_BRIDGE,
        type: EVENT_TYPES.PAYMENT_CONNECTION_READY,
        payload: { roomId: ROOM_ID, timestamp: Date.now() }
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const session = stack.depositSessionCoordinator.getByRoomAndGame(ROOM_ID, GAME_ID);

    assert.ok(session);
    assert.equal(stack.stubTon.broadcastTransactionCalls, 0);
    assert.equal(stack.stubTon.sendTransactionCalls, 0);

    stack.orchestrator.shutdown();

});
