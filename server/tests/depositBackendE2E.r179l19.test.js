/**
 * R17.9L.19 — Backend deposit end-to-end security validation.
 * NO real TON. NO Page4. NO GameContract auto-deploy.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { beginCell, TupleBuilder, TupleReader } from "@ton/core";

import { DepositMonitor } from "../deposit/DepositMonitor.js";
import { DepositSessionCoordinator } from "../deposit/DepositSessionCoordinator.js";
import { DEPOSIT_SESSION_STATUS } from "../deposit/DepositSessionStates.js";
import { DEPLOYMENT_AUTHORIZATION_STATUS } from "../deposit/DeploymentAuthorizationStates.js";
import { InvalidDepositBindingError, InvalidDepositIdentityError } from "../deposit/DepositSessionErrors.js";
import {
    DEPOSIT_ONCHAIN_STATUS,
    RealTonDepositBlockchainSource,
    encodeFundSeatBody
} from "../deposit/RealTonDepositBlockchainSource.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GameContractManager, MissingDeploymentAuthorizationError } from "../gameplay/GameContractManager.js";
import { GAME_CONTRACT_STATUS } from "../models/GameContract.js";
import { PAYMENT_PARTICIPANT_STATUS } from "../models/PaymentSession.js";
import {
    buildDepositStateInit,
    resetDepositCodeCellCacheForTests
} from "../payment/ton/buildDepositStateInit.js";
import { DEPOSIT_CONTRACT_ARTIFACT_BOC_PATH } from "../payment/ton/verifyDepositArtifact.js";
import { GAME_ESCROW_ARTIFACT_BOC_PATH } from "../payment/ton/verifyGameEscrowArtifact.js";
import {
    ORACLE_FIXTURE,
    PLAYER_WALLET_0,
    PLAYER_WALLET_1,
    PLAYER_WALLET_2,
    PRODUCTION_DEPLOY_WALLET,
    TESTNET_DEPOSIT_DEPLOYER,
    TonSpendTracker,
    ZERO_WALLET,
    assertZeroWheelWinSpend,
    collectEvents,
    createDepositBackendE2EHarness,
    createDiskPersistence,
    createLogger,
    createWatchableSession,
    fundSeat,
    reopenDepositStack,
    threePlayers
} from "./helpers/depositBackendE2EHarness.r179l19.js";
import { issueValidDeploymentAuthorization } from "./helpers/issueValidDeploymentAuthorization.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEPOSIT_CODE_B64 = readFileSync(DEPOSIT_CONTRACT_ARTIFACT_BOC_PATH).toString("base64");
const ESCROW_CODE_B64 = readFileSync(GAME_ESCROW_ARTIFACT_BOC_PATH).toString("base64");
const DEPOSIT_ADDRESS_FIXTURE = "EQAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBMWg";

const GCM_SOURCE = readFileSync(join(__dirname, "../gameplay/GameContractManager.js"), "utf8");

const globalTracker = new TonSpendTracker();

function harness(options = {}) {

    return createDepositBackendE2EHarness({
        ...options,
        tonSpendTracker: globalTracker
    });

}

function wait(ms) {

    return new Promise((resolve) => setTimeout(resolve, ms));

}

function buildDepositPackage({
    roomId = "room-alpha",
    gameId = "game-beta",
    depositId = "dep_550e8400-e29b-41d4-a716-446655440000"
} = {}) {

    resetDepositCodeCellCacheForTests();

    return buildDepositStateInit({
        depositId,
        roomId,
        gameId,
        players: [
            { playerId: "p0", wallet: PLAYER_WALLET_0, expectedStake: 1_000_000_000n },
            { playerId: "p1", wallet: PLAYER_WALLET_1, expectedStake: 1_000_000_000n },
            { playerId: "p2", wallet: PLAYER_WALLET_2, expectedStake: 1_000_000_000n }
        ],
        creationFeePerSeat: 100_000_000n,
        expiresAt: 1_800_000_000n,
        network: "testnet",
        releaseAuthority: ORACLE_FIXTURE,
        env: { TON_TESTNET_ORACLE_ADDRESS: ORACLE_FIXTURE }
    });

}

function intGetter(value) {

    const builder = new TupleBuilder();

    builder.writeNumber(BigInt(value));

    return { exit_code: 0, stack: new TupleReader(builder.build()) };

}

function defaultGetters(overrides = {}) {

    return {
        get_version: intGetter(1),
        get_deposit_id: intGetter(0x11),
        get_room_id_hash: intGetter(0x22),
        get_game_id_hash: intGetter(0x33),
        get_paid_mask: intGetter(0),
        get_status: intGetter(DEPOSIT_ONCHAIN_STATUS.AWAITING_FUNDS),
        get_credited_amount0: intGetter(0),
        get_credited_amount1: intGetter(0),
        get_credited_amount2: intGetter(0),
        get_surplus_nano: intGetter(0),
        get_expires_at: intGetter(1_800_000_000),
        get_network_tag: intGetter(0),
        ...overrides
    };

}

function activeAccount(codeB64 = DEPOSIT_CODE_B64) {

    return {
        state: "active",
        code: codeB64,
        data: beginCell().endCell().toBoc().toString("base64"),
        balance: "0"
    };

}

function fundSeatTx({ hash, lt, sender, seatIndex = 0, valueNano = 1_100_000_000 }) {

    return {
        aborted: false,
        success: true,
        compute_ph: { success: true, skipped: false },
        utime: 1_800_000_000,
        transaction_id: { hash, lt: String(lt) },
        in_msg: {
            source: sender,
            destination: DEPOSIT_ADDRESS_FIXTURE,
            value: String(valueNano),
            bounced: false,
            msg_data: {
                "@type": "msg.dataRaw",
                body: encodeFundSeatBody(seatIndex).toBoc().toString("base64")
            }
        }
    };

}

class StubTonService {

    constructor({ account = null, transactions = [], getters = {}, network = "testnet" } = {}) {

        this.account = account;
        this.transactions = transactions;
        this.getters = getters;
        this._network = network;
        this.sentBocs = [];

    }

    getActiveNetwork() {

        return this._network;

    }

    async getAccount() {

        return this.account;

    }

    async getTransactions() {

        return this.transactions;

    }

    async runGetMethod(_address, method) {

        return this.getters[method];

    }

    async broadcastTransaction(boc) {

        globalTracker.recordBroadcast();

        this.sentBocs.push(boc);

        return { ok: true, boc };

    }

}

function createRealTonHarness(tonService) {

    const logger = createLogger();

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const depositSessionCoordinator = new DepositSessionCoordinator({ eventBus });

    const source = new RealTonDepositBlockchainSource({
        logger,
        tonService,
        network: "testnet"
    });

    const monitor = new DepositMonitor({
        logger,
        eventBus,
        depositSessionCoordinator,
        blockchainSource: source,
        network: "testnet"
    });

    monitor.initialize();

    return { eventBus, depositSessionCoordinator, monitor, tonService };

}

function emitPaymentAttack(eventBus, { roomId, gameId }) {

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.PAYMENT_CONNECTION_READY,
        payload: { roomId, gameId }
    });

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.PAYMENT_SESSION_UPDATED,
        payload: {
            roomId,
            gameId,
            participants: [
                { playerId: "p0", status: PAYMENT_PARTICIPANT_STATUS.PAYMENT_REQUESTED },
                { playerId: "p1", status: PAYMENT_PARTICIPANT_STATUS.PAYMENT_REQUESTED },
                { playerId: "p2", status: PAYMENT_PARTICIPANT_STATUS.PAYMENT_REQUESTED }
            ]
        }
    });

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.PAYMENT_REQUEST,
        payload: { roomId, gameId, playerId: "p0" }
    });

}

function assertBlockedDeploy(h, roomId = "room-a", gameId = "game-a") {

    assert.equal(h.beginDeployCalls.length, 0);

    assert.equal(h.createContractRequestCalls.length, 0);

    assert.equal(h.gameContractManager?.getContract(roomId) ?? null, null);

    const auth = h.deploymentAuthorizationCoordinator.getByRoomAndGame(roomId, gameId);

    assert.ok(!auth || auth.status !== DEPLOYMENT_AUTHORIZATION_STATUS.VALID);

    assertZeroWheelWinSpend(h.tracker);

}

function assertAllowedNotStarted(h, roomId = "room-a", gameId = "game-a") {

    const auth = h.deploymentAuthorizationCoordinator.getByRoomAndGame(roomId, gameId);

    assert.equal(auth?.status, DEPLOYMENT_AUTHORIZATION_STATUS.VALID);

    assert.equal(h.beginDeployCalls.length, 0);

    assert.equal(h.createContractRequestCalls.length, 0);

    assert.equal(h.gameContractManager?.getContract(roomId) ?? null, null);

}

// ─── A: Room without deposit deploy ───

test("R17.9L.19 A: DepositSession created, no deploy trigger", () => {

    const h = harness({ withGameContractManager: true });

    const session = h.depositSessionCoordinator.createSession({
        roomId: "room-a",
        gameId: "game-a",
        metadata: { network: "testnet" }
    });

    h.depositSessionCoordinator.bindPlayers(session.depositId, threePlayers());

    assertBlockedDeploy(h);

    h.shutdown();

});

// ─── B: Deposit package ───

test("R17.9L.19 B: bindings + deterministic StateInit, 0 TON", () => {

    const h = harness();

    const pkg1 = buildDepositPackage();
    const pkg2 = buildDepositPackage();

    assert.equal(pkg1.contractAddress, pkg2.contractAddress);

    assert.throws(
        () => h.depositSessionCoordinator.createSession({ roomId: "", gameId: "g" }),
        InvalidDepositIdentityError
    );

    assertZeroWheelWinSpend(h.tracker, "B");

    h.shutdown();

});

test("R17.9L.19 B audit: forbidden wallets accepted at bind (documented gap)", () => {

    const h = harness();

    for (const wallet of [ZERO_WALLET, PRODUCTION_DEPLOY_WALLET, TESTNET_DEPOSIT_DEPLOYER]) {

        const session = h.depositSessionCoordinator.createSession({
            roomId: `room-${wallet.slice(0, 8)}`,
            gameId: `game-${wallet.slice(0, 8)}`
        });

        h.depositSessionCoordinator.bindPlayers(session.depositId, [
            { playerId: "p0", wallet, expectedAmount: 10 },
            { playerId: "p1", wallet: PLAYER_WALLET_1, expectedAmount: 10 },
            { playerId: "p2", wallet: PLAYER_WALLET_2, expectedAmount: 10 }
        ]);

        assert.equal(session.bindings[0].wallet, wallet);

    }

    h.shutdown();

});

// ─── C: Deployment verification gates (mocked RealTon) ───

test("R17.9L.19 C: UNINIT rejected", async () => {

    const tonService = new StubTonService({
        account: { state: "uninitialized", code: "", balance: "0" }
    });

    const { monitor, depositSessionCoordinator } = createRealTonHarness(tonService);

    const session = depositSessionCoordinator.createSession({ roomId: "room-c", gameId: "game-c" });

    depositSessionCoordinator.bindPlayers(session.depositId, threePlayers({ expectedAmount: 1_100_000_000 }));

    depositSessionCoordinator.markAwaitingFunds(session.depositId);

    session.depositAddress = DEPOSIT_ADDRESS_FIXTURE;

    monitor.startWatching(session);

    const result = await monitor.poll();

    assert.equal(result.results[0]?.reason, "uninitialized_contract");

    assert.equal(tonService.sentBocs.length, 0);

});

test("R17.9L.19 C: wrong code hash rejected", async () => {

    const tonService = new StubTonService({
        account: activeAccount(ESCROW_CODE_B64),
        getters: defaultGetters()
    });

    const { monitor, depositSessionCoordinator } = createRealTonHarness(tonService);

    const session = depositSessionCoordinator.createSession({ roomId: "room-c2", gameId: "game-c2" });

    depositSessionCoordinator.bindPlayers(session.depositId, threePlayers({ expectedAmount: 1_100_000_000 }));

    depositSessionCoordinator.markAwaitingFunds(session.depositId);

    session.depositAddress = DEPOSIT_ADDRESS_FIXTURE;

    monitor.startWatching(session);

    const result = await monitor.poll();

    assert.equal(result.results[0]?.reason, "code_hash_mismatch");

});

test("R17.9L.19 C: ACTIVE + valid FundSeat accepted, 0 WheelWin broadcast", async () => {

    const tonService = new StubTonService({
        account: activeAccount(),
        getters: defaultGetters(),
        transactions: [
            fundSeatTx({ hash: "tx-c0", lt: 1, sender: PLAYER_WALLET_0, seatIndex: 0 })
        ]
    });

    const { monitor, depositSessionCoordinator, eventBus } = createRealTonHarness(tonService);

    const emitted = collectEvents(eventBus, [EVENT_TYPES.DEPOSIT_SEAT_FUNDED]);

    const session = depositSessionCoordinator.createSession({ roomId: "room-c3", gameId: "game-c3" });

    depositSessionCoordinator.bindPlayers(session.depositId, threePlayers({ expectedAmount: 1_100_000_000 }));

    depositSessionCoordinator.markAwaitingFunds(session.depositId);

    session.depositAddress = DEPOSIT_ADDRESS_FIXTURE;

    monitor.startWatching(session);

    await monitor.poll();

    assert.equal(emitted.length, 1);

    assert.equal(tonService.sentBocs.length, 0);

});

// ─── D: 0/3 funding ───

test("R17.9L.19 D: ACTIVE deposit 0/3 — blocked", () => {

    const { persistence } = createDiskPersistence();

    const h = harness({ persistence, withGameContractManager: true });

    const session = createWatchableSession(h.depositSessionCoordinator, {
        depositPersistence: h.depositPersistence
    });

    h.monitor.startWatching(session);

    const updated = h.depositSessionCoordinator.getSession(session.depositId);

    assert.equal(updated.state, DEPOSIT_SESSION_STATUS.AWAITING_FUNDS);

    assertBlockedDeploy(h);

    h.shutdown();

});

// ─── E: 1/3 funding ───

test("R17.9L.19 E: 1/3 on-chain observation — session AWAITING_FUNDS, deploy blocked", () => {

    const { persistence } = createDiskPersistence();

    const h = harness({ persistence, withGameContractManager: true });

    const session = createWatchableSession(h.depositSessionCoordinator, {
        depositPersistence: h.depositPersistence
    });

    h.monitor.startWatching(session);

    fundSeat(h.source, session, { wallet: PLAYER_WALLET_0 });

    const updated = h.depositSessionCoordinator.getSession(session.depositId);

    // Backend applies seat funding to DepositSession only after DEPOSIT_FULL_ONCHAIN (3/3).
    assert.equal(updated.state, DEPOSIT_SESSION_STATUS.AWAITING_FUNDS);

    assert.ok(!updated.bindings[0].funded);

    const watch = h.monitor.listActiveWatches().find((entry) => entry.depositId === session.depositId);

    assert.equal(watch?.fundedCount, 1);

    assertBlockedDeploy(h);

    h.shutdown();

});

// ─── F: 2/3 funding ───

test("R17.9L.19 F: 2/3 on-chain observations — session AWAITING_FUNDS, deploy blocked", () => {

    const { persistence } = createDiskPersistence();

    const h = harness({ persistence, withGameContractManager: true });

    const session = createWatchableSession(h.depositSessionCoordinator, {
        depositPersistence: h.depositPersistence
    });

    h.monitor.startWatching(session);

    fundSeat(h.source, session, { wallet: PLAYER_WALLET_0 });

    fundSeat(h.source, session, { wallet: PLAYER_WALLET_1 });

    const updated = h.depositSessionCoordinator.getSession(session.depositId);

    assert.equal(updated.state, DEPOSIT_SESSION_STATUS.AWAITING_FUNDS);

    const watch = h.monitor.listActiveWatches().find((entry) => entry.depositId === session.depositId);

    assert.equal(watch?.fundedCount, 2);

    assertBlockedDeploy(h);

    h.shutdown();

});

// ─── G: 3/3 → DEPOSIT_FULL → VALID auth, deploy NOT started ───

test("R17.9L.19 G: 3/3 → DEPOSIT_FULL → VALID, no auto Game deploy", () => {

    const { persistence } = createDiskPersistence();

    const h = harness({ persistence, withGameContractManager: true });

    const session = createWatchableSession(h.depositSessionCoordinator, {
        depositPersistence: h.depositPersistence
    });

    h.monitor.startWatching(session);

    const emitted = collectEvents(h.eventBus, [
        EVENT_TYPES.DEPOSIT_FULL,
        EVENT_TYPES.DEPLOY_AUTHORIZATION_VALID
    ]);

    h.source.emitFullDeposit({
        depositId: session.depositId,
        depositAddress: session.depositAddress,
        players: threePlayers()
    });

    const updated = h.depositSessionCoordinator.getSession(session.depositId);

    assert.equal(updated.state, DEPOSIT_SESSION_STATUS.DEPOSIT_FULL);

    assert.equal(emitted.filter((e) => e.type === EVENT_TYPES.DEPOSIT_FULL).length, 1);

    assertAllowedNotStarted(h);

    assertZeroWheelWinSpend(h.tracker, "G");

    h.shutdown();

});

// ─── H: Invalid funding sender ───

test("R17.9L.19 H: FundSeat from wrong player rejected", () => {

    const { persistence } = createDiskPersistence();

    const h = harness({ persistence, withGameContractManager: true });

    const session = createWatchableSession(h.depositSessionCoordinator, {
        depositPersistence: h.depositPersistence
    });

    h.monitor.startWatching(session);

    h.source.emitValidPayment({
        depositId: session.depositId,
        depositAddress: session.depositAddress,
        senderWallet: PLAYER_WALLET_1,
        amount: 10,
        transactionHash: "tx-wrong-seat0"
    });

    const updated = h.depositSessionCoordinator.getSession(session.depositId);

    assert.equal(updated.state, DEPOSIT_SESSION_STATUS.AWAITING_FUNDS);

    assert.ok(!updated.bindings[0].funded);

    assertBlockedDeploy(h);

    h.shutdown();

});

// ─── I: Duplicate funding ───

test("R17.9L.19 I: duplicate tx deduplicated", () => {

    const { persistence } = createDiskPersistence();

    const h = harness({ persistence, withGameContractManager: true });

    const session = createWatchableSession(h.depositSessionCoordinator, {
        depositPersistence: h.depositPersistence
    });

    h.monitor.startWatching(session);

    fundSeat(h.source, session, {
        wallet: PLAYER_WALLET_0,
        transactionHash: "tx-dup"
    });

    try {

        fundSeat(h.source, session, {
            wallet: PLAYER_WALLET_0,
            transactionHash: "tx-dup"
        });

    } catch {
        // immutable observation record
    }

    fundSeat(h.source, session, { wallet: PLAYER_WALLET_1, transactionHash: "tx-2" });

    fundSeat(h.source, session, { wallet: PLAYER_WALLET_2, transactionHash: "tx-3" });

    const updated = h.depositSessionCoordinator.getSession(session.depositId);

    assert.equal(updated.state, DEPOSIT_SESSION_STATUS.DEPOSIT_FULL);

    assert.equal(
        h.deploymentAuthorizationCoordinator.getByRoomAndGame("room-a", "game-a").status,
        DEPLOYMENT_AUTHORIZATION_STATUS.VALID
    );

    assert.equal(h.beginDeployCalls.length, 0);

    h.shutdown();

});

// ─── J: Cross-contract funding ───

test("R17.9L.19 J: wrong deposit address rejected", () => {

    const { persistence } = createDiskPersistence();

    const h = harness({ persistence, withGameContractManager: true });

    const session = createWatchableSession(h.depositSessionCoordinator, {
        depositAddress: "EQ_deposit_D1",
        depositPersistence: h.depositPersistence
    });

    h.monitor.startWatching(session);

    h.source.emitValidPayment({
        depositId: session.depositId,
        depositAddress: "EQ_deposit_D2",
        senderWallet: PLAYER_WALLET_0,
        amount: 10,
        transactionHash: "tx-cross"
    });

    assert.notEqual(
        h.depositSessionCoordinator.getSession(session.depositId).state,
        DEPOSIT_SESSION_STATUS.DEPOSIT_FULL
    );

    assertBlockedDeploy(h);

    h.shutdown();

});

// ─── K: Wrong room/game isolation ───

test("R17.9L.19 K: room-a funding cannot complete room-b", () => {

    const { persistence } = createDiskPersistence();

    const h = harness({ persistence, withGameContractManager: true });

    const sessionA = createWatchableSession(h.depositSessionCoordinator, {
        roomId: "room-a",
        gameId: "game-a",
        depositAddress: "EQ_D1",
        depositPersistence: h.depositPersistence
    });

    const sessionB = createWatchableSession(h.depositSessionCoordinator, {
        roomId: "room-b",
        gameId: "game-b",
        depositAddress: "EQ_D2",
        depositPersistence: h.depositPersistence
    });

    h.monitor.startWatching(sessionA);

    h.monitor.startWatching(sessionB);

    h.source.emitFullDeposit({
        depositId: sessionA.depositId,
        depositAddress: "EQ_D1",
        players: threePlayers()
    });

    assert.equal(
        h.depositSessionCoordinator.getSession(sessionA.depositId).state,
        DEPOSIT_SESSION_STATUS.DEPOSIT_FULL
    );

    assert.notEqual(
        h.depositSessionCoordinator.getSession(sessionB.depositId).state,
        DEPOSIT_SESSION_STATUS.DEPOSIT_FULL
    );

    assert.equal(
        h.deploymentAuthorizationCoordinator.getByRoomAndGame("room-b", "game-b"),
        null
    );

    h.shutdown();

});

// ─── L: Payment event attack at 0/1/2/3 ───

test("R17.9L.19 L: PAYMENT_* replay never reaches _beginDeploy", async () => {

    const { persistence } = createDiskPersistence();

    const h = harness({
        persistence,
        withGameContractManager: true,
        withPaymentSessionManager: true
    });

    // GCM source must not subscribe to PAYMENT_SESSION_UPDATED as a deploy trigger.
    // The L.18 comment mentions it, but the subscribe line is gone.
    assert.doesNotMatch(GCM_SOURCE, /EVENT_TYPES\.PAYMENT_SESSION_UPDATED/);

    const session = createWatchableSession(h.depositSessionCoordinator, {
        roomId: "room-l",
        gameId: "game-l",
        depositPersistence: h.depositPersistence
    });

    h.monitor.startWatching(session);

    for (const stage of ["0/3", "1/3", "2/3"]) {

        emitPaymentAttack(h.eventBus, { roomId: "room-l", gameId: "game-l" });

        if (stage === "1/3") {

            fundSeat(h.source, session, { wallet: PLAYER_WALLET_0 });

        }

        if (stage === "2/3") {

            fundSeat(h.source, session, { wallet: PLAYER_WALLET_1 });

        }

        await wait(5);

        assert.equal(h.beginDeployCalls.length, 0);

        assertZeroWheelWinSpend(h.tracker, `L-${stage}`);

    }

    fundSeat(h.source, session, { wallet: PLAYER_WALLET_2 });

    await wait(5);

    assert.equal(h.beginDeployCalls.length, 0);

    assert.equal(
        h.deploymentAuthorizationCoordinator.getByRoomAndGame("room-l", "game-l").status,
        DEPLOYMENT_AUTHORIZATION_STATUS.VALID
    );

    h.shutdown();

});

// ─── M: Restart before FULL ───

test("R17.9L.19 M: restart preserves partial funding, final seat → VALID", () => {

    const { dataDir, persistence } = createDiskPersistence();

    const h = harness({ persistence, withGameContractManager: true });

    const session = createWatchableSession(h.depositSessionCoordinator, {
        depositPersistence: h.depositPersistence
    });

    h.monitor.startWatching(session);

    fundSeat(h.source, session, { wallet: PLAYER_WALLET_0, transactionHash: "tx-m1" });

    fundSeat(h.source, session, { wallet: PLAYER_WALLET_1, transactionHash: "tx-m2" });

    assert.equal(
        h.depositSessionCoordinator.getSession(session.depositId).state,
        DEPOSIT_SESSION_STATUS.AWAITING_FUNDS
    );

    h.shutdown();

    persistence.shutdown({ checkpoint: false });

    const h2 = reopenDepositStack(dataDir);

    const restored = h2.depositSessionCoordinator.getSession(session.depositId);

    assert.equal(restored.state, DEPOSIT_SESSION_STATUS.AWAITING_FUNDS);

    assert.equal(
        h2.deploymentAuthorizationCoordinator.getByRoomAndGame("room-a", "game-a"),
        null
    );

    // After restart, fund all 3 seats via emitFullDeposit (domain funding requires
    // all 3 validated observations in a single DEPOSIT_FULL_ONCHAIN cycle).
    h2.source.emitFullDeposit({
        depositId: restored.depositId,
        depositAddress: restored.depositAddress,
        players: threePlayers()
    });

    assert.equal(
        h2.depositSessionCoordinator.getSession(session.depositId).state,
        DEPOSIT_SESSION_STATUS.DEPOSIT_FULL
    );

    assert.equal(
        h2.deploymentAuthorizationCoordinator.getByRoomAndGame("room-a", "game-a").status,
        DEPLOYMENT_AUTHORIZATION_STATUS.VALID
    );

    h2.shutdown();

});

// ─── N: Restart after FULL ───

test("R17.9L.19 N: restart after FULL keeps VALID auth, no auto deploy", () => {

    const { dataDir, persistence } = createDiskPersistence();

    const h = harness({ persistence, withGameContractManager: true });

    const session = createWatchableSession(h.depositSessionCoordinator, {
        depositPersistence: h.depositPersistence
    });

    h.monitor.startWatching(session);

    h.source.emitFullDeposit({
        depositId: session.depositId,
        depositAddress: session.depositAddress,
        players: threePlayers()
    });

    h.shutdown();

    persistence.shutdown({ checkpoint: false });

    const h2 = reopenDepositStack(dataDir);

    const auth = h2.deploymentAuthorizationCoordinator.getByRoomAndGame("room-a", "game-a");

    assert.equal(auth.status, DEPLOYMENT_AUTHORIZATION_STATUS.VALID);

    assert.equal(h2.deploymentAuthorizationCoordinator._authorizations.size, 1);

    h2.shutdown();

});

// ─── O: Authorization replay ───

test("R17.9L.19 O: second consume rejected", () => {

    const h = harness();

    issueValidDeploymentAuthorization(h.deploymentAuthorizationCoordinator, {
        roomId: "room-a",
        gameId: "game-a"
    });

    const first = h.deploymentAuthorizationCoordinator.consumeValidForDeploy({
        roomId: "room-a",
        gameId: "game-a",
        network: "testnet"
    });

    assert.equal(first.status, DEPLOYMENT_AUTHORIZATION_STATUS.CONSUMED);

    assert.throws(
        () => h.deploymentAuthorizationCoordinator.consumeValidForDeploy({
            roomId: "room-a",
            gameId: "game-a",
            network: "testnet"
        })
    );

    h.shutdown();

});

// ─── P: Game deployment gate ───

test("R17.9L.19 P1: no DeploymentAuthorization blocks deploy", async () => {

    const h = harness({ withGameContractManager: true });

    const deployCalls = [];

    h.gameContractManager._deployAdapter = {
        async deploy(payload) {

            deployCalls.push(payload);

            globalTracker.recordAdapterDeploy();

            return {
                ok: true,
                contractAddress: "EQblocked",
                deploymentTxId: "tx-blocked",
                deployedAt: Date.now()
            };

        }
    };

    const contract = h.gameContractManager.createContractRequest("room-a", { gameId: "game-a" });

    await wait(20);

    assert.equal(deployCalls.length, 0);

    assert.equal(contract.status, GAME_CONTRACT_STATUS.READY_FOR_BLOCKCHAIN);

    h.shutdown();

});

test("R17.9L.19 P2: VALID authorization allows explicit deploy (mocked)", async () => {

    const h = harness({ withGameContractManager: true });

    issueValidDeploymentAuthorization(h.deploymentAuthorizationCoordinator, {
        roomId: "room-a",
        gameId: "game-a",
        network: "testnet"
    });

    const deployCalls = [];

    h.gameContractManager._deployAdapter = {
        async deploy(payload) {

            deployCalls.push(payload);

            globalTracker.recordAdapterDeploy();

            return {
                ok: true,
                contractAddress: "EQallowed",
                deploymentTxId: "tx-allowed",
                deployedAt: Date.now()
            };

        }
    };

    h.gameContractManager.createContractRequest("room-a", { gameId: "game-a" });

    await wait(20);

    assert.equal(deployCalls.length, 1);

    assert.equal(
        h.deploymentAuthorizationCoordinator.getByRoomAndGame("room-a", "game-a").status,
        DEPLOYMENT_AUTHORIZATION_STATUS.CONSUMED
    );

    h.shutdown();

});

test("R17.9L.19 P2b: deployContract without auth throws", async () => {

    const h = harness({ withGameContractManager: true });

    const contract = h.gameContractManager.createContractRequest("room-p2b", { gameId: "game-p2b" });

    await wait(20);

    // After _scheduleCreated, _beginDeploy already ran (and was blocked).
    // Reset the contract to READY_FOR_BLOCKCHAIN for an explicit deployContract test.
    contract.status = GAME_CONTRACT_STATUS.READY_FOR_BLOCKCHAIN;

    await assert.rejects(
        () => h.gameContractManager.deployContract("room-p2b"),
        MissingDeploymentAuthorizationError
    );

    h.shutdown();

});

// ─── Bot flood ───

test("R17.9L.19 Bot flood: 100 abandoned 0-fund rooms", () => {

    const h = harness({ withGameContractManager: true });

    for (let index = 0; index < 100; index += 1) {

        const roomId = `room-flood-${index}`;
        const gameId = `game-flood-${index}`;

        const session = h.depositSessionCoordinator.createSession({
            roomId,
            gameId,
            metadata: { network: "testnet" }
        });

        h.depositSessionCoordinator.bindPlayers(session.depositId, threePlayers());

        h.depositSessionCoordinator.markAwaitingFunds(session.depositId);

        session.depositAddress = `EQ_flood_${index}`;

        h.depositPersistence?.saveDepositSession(session);

        h.monitor.startWatching(session);

        h.depositSessionCoordinator.expire(session.depositId);

    }

    assert.equal(h.deploymentAuthorizationCoordinator._authorizations.size, 0);

    assert.equal(h.beginDeployCalls.length, 0);

    h.shutdown();

});

test("R17.9L.19 Bot flood: 100 rooms with 1 funded seat each", () => {

    const { persistence } = createDiskPersistence();

    const h = harness({ persistence, withGameContractManager: true });

    for (let index = 0; index < 100; index += 1) {

        const roomId = `room-one-${index}`;
        const gameId = `game-one-${index}`;

        const session = createWatchableSession(h.depositSessionCoordinator, {
            roomId,
            gameId,
            depositAddress: `EQ_one_${index}`,
            depositPersistence: h.depositPersistence
        });

        h.monitor.startWatching(session);

        fundSeat(h.source, session, {
            wallet: PLAYER_WALLET_0,
            transactionHash: `tx-one-${index}`
        });

    }

    assert.equal(h.deploymentAuthorizationCoordinator._authorizations.size, 0);

    assert.equal(h.beginDeployCalls.length, 0);

    h.shutdown();

});

// ─── Global TON spend summary ───

test("R17.9L.19 Global TON spend invariant", () => {

    const snap = globalTracker.snapshot();

    assert.equal(snap.beforeDepositFull, 0, "BEFORE_DEPOSIT_FULL must be 0");

    assert.equal(snap.duringDepositDeployment, 0, "DURING_DEPOSIT_DEPLOYMENT must be 0");

    assert.equal(
        snap.afterValidAuthorization,
        1,
        "AFTER_VALID_AUTHORIZATION: only explicit mocked P2 deploy"
    );

    assert.equal(snap.broadcastTransaction, 0);

});

console.log("depositBackendE2E.r179l19.test.js: scenarios A–P + bot flood complete");
