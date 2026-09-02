/**
 * R17.9L.22 — DepositActivationVerificationCoordinator tests.
 * Stubbed TON RPC only. No live send, no mnemonic, no TonConnect.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Address, TupleBuilder, TupleReader } from "@ton/core";

import { DepositActivationVerificationCoordinator } from "../deposit/DepositActivationVerificationCoordinator.js";
import {
    DEPOSIT_ACTIVATION_ERROR_CODES,
    DEPOSIT_ACTIVATION_STATUS,
    DepositActivationVerificationError
} from "../deposit/DepositActivationVerificationErrors.js";
import { DepositMonitor } from "../deposit/DepositMonitor.js";
import { DepositWatchNotAuthorizedError } from "../deposit/DepositMonitorErrors.js";
import { InMemoryDepositPersistence } from "../deposit/DepositPersistencePort.js";
import { DepositSessionCoordinator } from "../deposit/DepositSessionCoordinator.js";
import {
    DEPOSIT_ACCOUNT_STATE,
    DEPOSIT_ONCHAIN_STATUS,
    RealTonDepositBlockchainSource
} from "../deposit/RealTonDepositBlockchainSource.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { canonicalizeTonWalletAddress } from "../models/TonWalletAddress.js";
import {
    buildDepositStateInit,
    loadDepositCodeCell
} from "../payment/ton/buildDepositStateInit.js";
import { FROZEN_DEPOSIT_ARTIFACT_SHA256 } from "../payment/ton/depositTestnetFixture.js";
import { GAME_ESCROW_ARTIFACT_BOC_PATH } from "../payment/ton/verifyGameEscrowArtifact.js";
import {
    InvalidResponseError,
    NetworkUnavailableError
} from "../services/ton/TonServiceErrors.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const COORDINATOR_SOURCE = readFileSync(
    join(HERE, "../deposit/DepositActivationVerificationCoordinator.js"),
    "utf8"
);

const PLAYER_0 = "EQABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAc3j";
const PLAYER_1 = "EQACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAsoi";
const PLAYER_2 = "EQADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA8id";
const ORACLE = "EQAREREREREREREREREREREREREREREREREREREREREREeYT";
const OTHER_ADDRESS = "EQAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBMWg";
const OTHER_PLAYER = "EQAFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBccf";

const STAKE_NANO = 10_000_000n;
const FEE_NANO = 1_000_000n;
const EXPIRES_AT = 2_000_000_000n;

const DEPOSIT_CODE = loadDepositCodeCell({
    expectedSha256: FROZEN_DEPOSIT_ARTIFACT_SHA256
});
const DEPOSIT_CODE_B64 = DEPOSIT_CODE.toBoc().toString("base64");
const ESCROW_CODE_B64 = readFileSync(GAME_ESCROW_ARTIFACT_BOC_PATH).toString("base64");

const TEST_ENV = Object.freeze({
    TON_NETWORK: "testnet",
    TON_TESTNET_ORACLE_ADDRESS: ORACLE
});

function createLogger() {

    return {
        info() {},
        warn() {},
        error() {},
        debug() {},
        decisionTrace() {}
    };

}

function intGetter(value) {

    const builder = new TupleBuilder();

    builder.writeNumber(BigInt(value));

    return {
        exit_code: 0,
        stack: new TupleReader(builder.build())
    };

}

function addrGetter(address) {

    const parsed = address instanceof Address ? address : Address.parse(address);
    const builder = new TupleBuilder();

    builder.writeAddress(parsed);

    return {
        exit_code: 0,
        stack: new TupleReader(builder.build())
    };

}

function threePlayers() {

    return [
        { playerId: "p0", wallet: PLAYER_0, expectedAmount: Number(STAKE_NANO) },
        { playerId: "p1", wallet: PLAYER_1, expectedAmount: Number(STAKE_NANO) },
        { playerId: "p2", wallet: PLAYER_2, expectedAmount: Number(STAKE_NANO) }
    ];

}

function sessionMetadata() {

    return {
        network: "testnet",
        creationFeePerSeat: FEE_NANO,
        contractExpiresAt: EXPIRES_AT,
        releaseAuthority: ORACLE,
        contractVersion: 1
    };

}

class StubTonService {

    constructor({
        network = "testnet",
        account = null,
        getters = {},
        fail = null
    } = {}) {

        this._network = network;
        this.account = account;
        this.getters = getters;
        this.fail = fail;
        this.calls = [];
        this.broadcastTransactionCalls = 0;
        this.sendTransactionCalls = 0;

    }

    getActiveNetwork() {

        return this._network;

    }

    async getAccount(address) {

        this.calls.push(["getAccount", address]);

        if (this.fail === "getAccount" || this.fail === "rpc") {

            throw new NetworkUnavailableError("TON RPC unavailable");

        }

        return this.account;

    }

    async getTransactions(address) {

        this.calls.push(["getTransactions", address]);

        return [];

    }

    async runGetMethod(address, method) {

        this.calls.push(["runGetMethod", method]);

        if (this.fail === "runGetMethod" || this.fail === "rpc" || this.fail === method) {

            throw new InvalidResponseError(`getter ${method} failed`);

        }

        if (!(method in this.getters)) {

            throw new InvalidResponseError(`missing getter ${method}`);

        }

        const entry = this.getters[method];

        return typeof entry === "function" ? entry() : entry;

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

function matchingGetters(plan, overrides = {}) {

    const fee = BigInt(plan.creationFeePerSeat);
    const stake0 = BigInt(plan.bindings[0].expectedAmount);
    const stake1 = BigInt(plan.bindings[1].expectedAmount);
    const stake2 = BigInt(plan.bindings[2].expectedAmount);
    const zero = new Address(0, Buffer.alloc(32));

    const getters = {
        get_version: () => intGetter(plan.contractVersion),
        get_deposit_id: () => intGetter(BigInt(`0x${plan.depositIdHash}`)),
        get_room_id_hash: () => intGetter(BigInt(`0x${plan.roomIdHash}`)),
        get_game_id_hash: () => intGetter(BigInt(`0x${plan.gameIdHash}`)),
        get_expected_stake0: () => intGetter(stake0),
        get_expected_stake1: () => intGetter(stake1),
        get_expected_stake2: () => intGetter(stake2),
        get_creation_fee_per_seat: () => intGetter(fee),
        get_expected_amount0: () => intGetter(stake0 + fee),
        get_expected_amount1: () => intGetter(stake1 + fee),
        get_expected_amount2: () => intGetter(stake2 + fee),
        get_paid_mask: () => intGetter(0),
        get_status: () => intGetter(DEPOSIT_ONCHAIN_STATUS.AWAITING_FUNDS),
        get_credited_amount0: () => intGetter(0),
        get_credited_amount1: () => intGetter(0),
        get_credited_amount2: () => intGetter(0),
        get_surplus_nano: () => intGetter(0),
        get_expires_at: () => intGetter(plan.expiresAt),
        get_network_tag: () => intGetter(plan.networkTag),
        get_refund_mask: () => intGetter(0),
        get_total_credited: () => intGetter(0),
        get_player0: () => addrGetter(plan.bindings[0].wallet),
        get_player1: () => addrGetter(plan.bindings[1].wallet),
        get_player2: () => addrGetter(plan.bindings[2].wallet),
        get_release_authority: () => addrGetter(plan.releaseAuthority),
        get_released_to: () => addrGetter(zero)
    };

    for (const [key, value] of Object.entries(overrides)) {

        getters[key] = typeof value === "function" ? value : () => value;

    }

    return getters;

}

function activeAccount(codeB64 = DEPOSIT_CODE_B64, balance = "0") {

    return {
        state: "active",
        code: codeB64,
        balance
    };

}

function buildPlan(session) {

    return buildDepositStateInit({
        depositId: session.depositId,
        roomId: session.roomId,
        gameId: session.gameId,
        players: session.bindings.map((binding) => ({
            playerId: binding.playerId,
            wallet: binding.wallet,
            expectedStake: binding.expectedAmount
        })),
        creationFeePerSeat: FEE_NANO,
        expiresAt: EXPIRES_AT,
        network: "testnet",
        releaseAuthority: ORACLE,
        env: TEST_ENV
    });

}

function createEventBus() {

    const eventBus = new EventBus({
        logger: createLogger(),
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    return eventBus;

}

function createStack({
    roomId = "room-l22",
    gameId = "game-l22",
    account = null,
    getters = null,
    fail = null,
    assignDerivedAddress = true,
    persistence = null,
    roomManager = null
} = {}) {

    const logger = createLogger();
    const eventBus = createEventBus();
    const depositPersistence = persistence ?? new InMemoryDepositPersistence();

    const depositSessionCoordinator = new DepositSessionCoordinator({
        eventBus,
        persistence: depositPersistence,
        env: TEST_ENV
    });

    const session = depositSessionCoordinator.createSession({
        roomId,
        gameId,
        metadata: sessionMetadata()
    });

    depositSessionCoordinator.bindPlayers(session.depositId, threePlayers());
    depositSessionCoordinator.markAwaitingFunds(session.depositId);

    const plan = buildPlan(session);

    if (assignDerivedAddress) {

        depositSessionCoordinator.setDepositAddress(
            session.depositId,
            plan.addressFriendly
        );

    }

    const tonService = new StubTonService({
        account: account ?? activeAccount(),
        getters: getters ?? matchingGetters(plan),
        fail
    });

    const blockchainSource = new RealTonDepositBlockchainSource({
        logger,
        tonService,
        network: "testnet",
        expectedArtifactSha256: FROZEN_DEPOSIT_ARTIFACT_SHA256
    });

    const gameContractManager = {
        createCalls: 0,
        createGameContract() {

            this.createCalls += 1;

            throw new Error("GameContractManager must not be called");

        }
    };

    const deploymentAuthorizationCoordinator = {
        createCalls: 0,
        createAuthorization() {

            this.createCalls += 1;

            throw new Error("DeploymentAuthorization must not be called");

        }
    };

    const monitor = new DepositMonitor({
        logger,
        eventBus,
        depositSessionCoordinator,
        blockchainSource,
        network: "testnet",
        requireActivationVerification: true,
        roomManager
    });

    monitor.initialize();

    const activation = new DepositActivationVerificationCoordinator({
        logger,
        eventBus,
        depositSessionCoordinator,
        depositMonitor: monitor,
        blockchainSource,
        tonService,
        network: "testnet",
        expectedArtifactSha256: FROZEN_DEPOSIT_ARTIFACT_SHA256,
        env: TEST_ENV,
        gameContractManager,
        deploymentAuthorizationCoordinator,
        roomManager
    });

    return {
        session: depositSessionCoordinator.getSession(session.depositId),
        plan,
        tonService,
        blockchainSource,
        monitor,
        activation,
        depositSessionCoordinator,
        depositPersistence,
        eventBus,
        gameContractManager,
        deploymentAuthorizationCoordinator
    };

}

async function expectReject(activation, depositId, code, extra = undefined) {

    await assert.rejects(
        () => activation.verifyActivation(depositId, extra),
        (error) => {

            assert.equal(error instanceof DepositActivationVerificationError, true);
            assert.equal(error.code, code);

            return true;

        }
    );

}

test("R17.9L.22 Test1: UNINIT → WAITING_FOR_PLAYER_DEPLOYMENT, no watch", async () => {

    const { activation, session, monitor, tonService } = createStack({
        account: { state: "uninit", code: "", balance: "0" }
    });

    const result = await activation.verifyActivation(session.depositId);

    assert.equal(result.status, DEPOSIT_ACTIVATION_STATUS.WAITING_FOR_PLAYER_DEPLOYMENT);
    assert.equal(result.watchStarted, false);
    assert.equal(monitor.listActiveWatches().length, 0);
    assert.equal(tonService.broadcastTransactionCalls, 0);

});

test("R17.9L.22 Test2: ACTIVE + correct artifact → VERIFIED + watch", async () => {

    const { activation, session, monitor } = createStack();

    const result = await activation.verifyActivation(session.depositId);

    assert.equal(result.status, DEPOSIT_ACTIVATION_STATUS.VERIFIED);
    assert.equal(result.watchStarted, true);
    assert.equal(monitor.listActiveWatches().length, 1);
    assert.equal(monitor.listActiveWatches()[0].depositId, session.depositId);

});

test("R17.9L.22 Test3: ACTIVE + wrong code hash → REJECT, no watch", async () => {

    const { activation, session, monitor } = createStack({
        account: activeAccount(ESCROW_CODE_B64)
    });

    await expectReject(
        activation,
        session.depositId,
        DEPOSIT_ACTIVATION_ERROR_CODES.CODE_HASH_MISMATCH
    );

    assert.equal(monitor.listActiveWatches().length, 0);

});

test("R17.9L.22 Test4: wrong deterministic address → REJECT", async () => {

    const { activation, session, monitor, depositSessionCoordinator, plan } = createStack({
        assignDerivedAddress: false
    });

    depositSessionCoordinator.setDepositAddress(session.depositId, OTHER_ADDRESS);

    assert.notEqual(
        canonicalizeTonWalletAddress(plan.addressFriendly),
        canonicalizeTonWalletAddress(OTHER_ADDRESS)
    );

    await expectReject(
        activation,
        session.depositId,
        DEPOSIT_ACTIVATION_ERROR_CODES.ADDRESS_MISMATCH
    );

    assert.equal(monitor.listActiveWatches().length, 0);

});

test("R17.9L.22 Test5: wrong depositId hash → REJECT", async () => {

    const stack = createStack();
    stack.tonService.getters = matchingGetters(stack.plan, {
        get_deposit_id: intGetter(0xdead)
    });

    await expectReject(
        stack.activation,
        stack.session.depositId,
        DEPOSIT_ACTIVATION_ERROR_CODES.IMMUTABLE_BINDING_MISMATCH
    );

    assert.equal(stack.monitor.listActiveWatches().length, 0);

});

test("R17.9L.22 Test6: wrong roomId hash → REJECT", async () => {

    const stack = createStack();
    stack.tonService.getters = matchingGetters(stack.plan, {
        get_room_id_hash: intGetter(0xbeef)
    });

    await expectReject(
        stack.activation,
        stack.session.depositId,
        DEPOSIT_ACTIVATION_ERROR_CODES.IMMUTABLE_BINDING_MISMATCH
    );

    assert.equal(stack.monitor.listActiveWatches().length, 0);

});

test("R17.9L.22 Test7: wrong gameId hash → REJECT", async () => {

    const stack = createStack();
    stack.tonService.getters = matchingGetters(stack.plan, {
        get_game_id_hash: intGetter(0xcafe)
    });

    await expectReject(
        stack.activation,
        stack.session.depositId,
        DEPOSIT_ACTIVATION_ERROR_CODES.IMMUTABLE_BINDING_MISMATCH
    );

    assert.equal(stack.monitor.listActiveWatches().length, 0);

});

test("R17.9L.22 Test8: wrong player → REJECT", async () => {

    const stack = createStack();
    stack.tonService.getters = matchingGetters(stack.plan, {
        get_player0: addrGetter(OTHER_PLAYER)
    });

    await expectReject(
        stack.activation,
        stack.session.depositId,
        DEPOSIT_ACTIVATION_ERROR_CODES.PLAYER_BINDING_MISMATCH
    );

    assert.equal(stack.monitor.listActiveWatches().length, 0);

});

test("R17.9L.22 Test9: wrong stake / expected amount → REJECT", async () => {

    const stack = createStack();
    stack.tonService.getters = matchingGetters(stack.plan, {
        get_expected_stake0: intGetter(STAKE_NANO + 1n),
        get_expected_amount0: intGetter(STAKE_NANO + FEE_NANO + 1n)
    });

    await expectReject(
        stack.activation,
        stack.session.depositId,
        DEPOSIT_ACTIVATION_ERROR_CODES.FINANCIAL_PARAMETER_MISMATCH
    );

    assert.equal(stack.monitor.listActiveWatches().length, 0);

});

test("R17.9L.22 Test10: wrong release authority → REJECT", async () => {

    const stack = createStack();
    stack.tonService.getters = matchingGetters(stack.plan, {
        get_release_authority: addrGetter(OTHER_PLAYER)
    });

    await expectReject(
        stack.activation,
        stack.session.depositId,
        DEPOSIT_ACTIVATION_ERROR_CODES.RELEASE_AUTHORITY_MISMATCH
    );

    assert.equal(stack.monitor.listActiveWatches().length, 0);

});

test("R17.9L.22 Test11: wrong networkTag → REJECT", async () => {

    const stack = createStack();
    stack.tonService.getters = matchingGetters(stack.plan, {
        get_network_tag: intGetter(1)
    });

    await expectReject(
        stack.activation,
        stack.session.depositId,
        DEPOSIT_ACTIVATION_ERROR_CODES.NETWORK_MISMATCH
    );

    assert.equal(stack.monitor.listActiveWatches().length, 0);

});

test("R17.9L.22 Test12: already PARTIALLY_FUNDED → REJECT", async () => {

    const stack = createStack();
    stack.tonService.getters = matchingGetters(stack.plan, {
        get_status: intGetter(DEPOSIT_ONCHAIN_STATUS.PARTIALLY_FUNDED),
        get_paid_mask: intGetter(1)
    });

    await expectReject(
        stack.activation,
        stack.session.depositId,
        DEPOSIT_ACTIVATION_ERROR_CODES.INITIAL_STATE_INVALID
    );

    assert.equal(stack.monitor.listActiveWatches().length, 0);

});

test("R17.9L.22 Test13: already FULL → REJECT", async () => {

    const stack = createStack();
    stack.tonService.getters = matchingGetters(stack.plan, {
        get_status: intGetter(DEPOSIT_ONCHAIN_STATUS.FULL),
        get_paid_mask: intGetter(7)
    });

    await expectReject(
        stack.activation,
        stack.session.depositId,
        DEPOSIT_ACTIVATION_ERROR_CODES.INITIAL_STATE_INVALID
    );

    assert.equal(stack.monitor.listActiveWatches().length, 0);

});

test("R17.9L.22 Test14: already RELEASED → REJECT", async () => {

    const stack = createStack();
    stack.tonService.getters = matchingGetters(stack.plan, {
        get_status: intGetter(DEPOSIT_ONCHAIN_STATUS.RELEASED)
    });

    await expectReject(
        stack.activation,
        stack.session.depositId,
        DEPOSIT_ACTIVATION_ERROR_CODES.INITIAL_STATE_INVALID
    );

    assert.equal(stack.monitor.listActiveWatches().length, 0);

});

test("R17.9L.22 Test15: non-zero initial credit → REJECT", async () => {

    const stack = createStack();
    stack.tonService.getters = matchingGetters(stack.plan, {
        get_credited_amount0: intGetter(1)
    });

    await expectReject(
        stack.activation,
        stack.session.depositId,
        DEPOSIT_ACTIVATION_ERROR_CODES.INITIAL_STATE_INVALID
    );

    assert.equal(stack.monitor.listActiveWatches().length, 0);

});

test("R17.9L.22 Test16: idempotent verification → one watch", async () => {

    const { activation, session, monitor } = createStack();

    const first = await activation.verifyActivation(session.depositId);
    const second = await activation.verifyActivation(session.depositId);

    assert.equal(first.status, DEPOSIT_ACTIVATION_STATUS.VERIFIED);
    assert.equal(second.status, DEPOSIT_ACTIVATION_STATUS.ALREADY_VERIFIED);
    assert.equal(monitor.listActiveWatches().length, 1);

});

test("R17.9L.22 Test17: RPC failure → no activation, no watch", async () => {

    const { activation, session, monitor } = createStack({ fail: "rpc" });

    await expectReject(
        activation,
        session.depositId,
        DEPOSIT_ACTIVATION_ERROR_CODES.RPC_FAILURE
    );

    assert.equal(monitor.listActiveWatches().length, 0);

});

test("R17.9L.22 Test18: getter failure → no activation, no watch", async () => {

    const { activation, session, monitor } = createStack({ fail: "get_status" });

    await expectReject(
        activation,
        session.depositId,
        DEPOSIT_ACTIVATION_ERROR_CODES.GETTER_READ_FAILED
    );

    assert.equal(monitor.listActiveWatches().length, 0);

});

test("R17.9L.22 Test19: restart does not auto-activate from persisted flag", async () => {

    const persistence = new InMemoryDepositPersistence();
    const first = createStack({ persistence });

    await first.activation.verifyActivation(first.session.depositId);

    assert.equal(first.monitor.listActiveWatches().length, 1);

    const record = persistence.loadDepositSession(first.session.depositId);

    assert.equal(
        record.payload.metadata.activationVerification.status,
        DEPOSIT_ACTIVATION_STATUS.VERIFIED
    );

    const eventBus = createEventBus();
    const coordinator = new DepositSessionCoordinator({
        eventBus,
        persistence,
        env: TEST_ENV
    });

    const restored = coordinator.restoreFromPersistence(first.session.depositId);

    assert.equal(
        restored.metadata.activationVerification.status,
        DEPOSIT_ACTIVATION_STATUS.VERIFIED
    );

    const monitor = new DepositMonitor({
        eventBus,
        depositSessionCoordinator: coordinator,
        network: "testnet",
        requireActivationVerification: true
    });

    monitor.initialize();

    const restoreSummary = monitor.restoreActiveWatches();

    assert.equal(monitor.listActiveWatches().length, 0);
    assert.equal(restoreSummary.restored, 0);

    const activation = new DepositActivationVerificationCoordinator({
        eventBus,
        depositSessionCoordinator: coordinator,
        depositMonitor: monitor,
        blockchainSource: first.blockchainSource,
        tonService: first.tonService,
        network: "testnet",
        expectedArtifactSha256: FROZEN_DEPOSIT_ARTIFACT_SHA256,
        env: TEST_ENV
    });

    const reverified = await activation.verifyActivation(restored.depositId);

    assert.equal(reverified.status, DEPOSIT_ACTIVATION_STATUS.VERIFIED);
    assert.equal(monitor.listActiveWatches().length, 1);

});

test("R17.9L.22 Test20: security isolation — no send / GCM / authorization", async () => {

    const stack = createStack();

    await stack.activation.verifyActivation(stack.session.depositId);

    assert.equal(stack.tonService.broadcastTransactionCalls, 0);
    assert.equal(stack.tonService.sendTransactionCalls, 0);
    assert.equal(stack.gameContractManager.createCalls, 0);
    assert.equal(stack.deploymentAuthorizationCoordinator.createCalls, 0);
    assert.equal(COORDINATOR_SOURCE.includes("broadcastTransaction("), false);
    assert.equal(COORDINATOR_SOURCE.includes("createDeploymentAuthorization"), false);

});

test("R17.9L.22 Test21: canonical TON address encodings pass", async () => {

    const stack = createStack();
    const player0 = Address.parse(PLAYER_0);

    stack.tonService.getters = matchingGetters(stack.plan, {
        get_player0: addrGetter(player0.toString({ bounceable: false, urlSafe: true })),
        get_player1: addrGetter(
            Address.parse(PLAYER_1).toString({ bounceable: true, urlSafe: true, testOnly: true })
        ),
        get_release_authority: addrGetter(
            Address.parse(ORACLE).toString({ bounceable: false, urlSafe: true })
        )
    });

    const result = await stack.activation.verifyActivation(stack.session.depositId);

    assert.equal(result.status, DEPOSIT_ACTIVATION_STATUS.VERIFIED);
    assert.equal(stack.monitor.listActiveWatches().length, 1);

});

test("R17.9L.22 Test22: session A contract cannot activate session B", async () => {

    const a = createStack({ roomId: "room-a", gameId: "game-a" });
    const b = createStack({
        roomId: "room-b",
        gameId: "game-b",
        assignDerivedAddress: false
    });

    await a.activation.verifyActivation(a.session.depositId);

    b.depositSessionCoordinator.setDepositAddress(
        b.session.depositId,
        a.session.depositAddress
    );

    await expectReject(
        b.activation,
        b.session.depositId,
        DEPOSIT_ACTIVATION_ERROR_CODES.ADDRESS_MISMATCH
    );

    assert.equal(b.monitor.listActiveWatches().length, 0);
    assert.equal(a.monitor.listActiveWatches().length, 1);

});

test("R17.9L.22 Test23: client-substituted address cannot override session D", async () => {

    const { activation, session, monitor, plan } = createStack();

    const result = await activation.verifyActivation(session.depositId, {
        depositAddress: OTHER_ADDRESS,
        roomId: "client-room",
        gameId: "client-game"
    });

    assert.equal(result.status, DEPOSIT_ACTIVATION_STATUS.VERIFIED);
    assert.equal(
        canonicalizeTonWalletAddress(result.depositAddress),
        canonicalizeTonWalletAddress(plan.addressFriendly)
    );
    assert.notEqual(
        canonicalizeTonWalletAddress(result.depositAddress),
        canonicalizeTonWalletAddress(OTHER_ADDRESS)
    );
    assert.equal(monitor.listActiveWatches().length, 1);
    assert.equal(monitor.listActiveWatches()[0].depositAddress, session.depositAddress);

});

test("R17.9L.22 Test24: balance is never activation proof", async () => {

    const { activation, session, monitor } = createStack({
        account: activeAccount(ESCROW_CODE_B64, "1000000000")
    });

    await expectReject(
        activation,
        session.depositId,
        DEPOSIT_ACTIVATION_ERROR_CODES.CODE_HASH_MISMATCH
    );

    assert.equal(monitor.listActiveWatches().length, 0);
    assert.notEqual(session.state, "DEPOSIT_FULL");

});

test("R17.9L.22 WatchGate: startWatching without verification is rejected", () => {

    const { monitor, session } = createStack();

    assert.throws(
        () => monitor.startWatching(session),
        DepositWatchNotAuthorizedError
    );

    assert.equal(monitor.listActiveWatches().length, 0);

});

test("R17.9L.22 missing depositAddress fails closed", async () => {

    const { activation, session, monitor } = createStack({
        assignDerivedAddress: false
    });

    await expectReject(
        activation,
        session.depositId,
        DEPOSIT_ACTIVATION_ERROR_CODES.DEPOSIT_ADDRESS_MISSING
    );

    assert.equal(monitor.listActiveWatches().length, 0);

});

test("R18-S15: syncFromActiveSessions skips deposits whose room is no longer live", async () => {

    const { activation, tonService } = createStack({
        roomManager: {
            getRoom() {

                return null;

            }
        }
    });

    const callsBefore = tonService.calls.length;
    const summary = await activation.syncFromActiveSessions();

    assert.equal(summary.scanned, 1);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.verified, 0);
    assert.equal(tonService.calls.length, callsBefore);

});

test("R18-S15: live-room deposit still reaches DEPOSIT_ACTIVATION_VERIFIED", async () => {

    const { activation, session, monitor, eventBus } = createStack({
        roomManager: {
            getRoom(roomId) {

                return roomId === "room-l22" ? { roomId } : null;

            }
        }
    });

    const verified = [];

    eventBus.subscribe(EVENT_TYPES.DEPOSIT_ACTIVATION_VERIFIED, (envelope) => {

        verified.push(envelope.payload);

    });

    const result = await activation.verifyActivation(session.depositId);

    assert.equal(result.status, DEPOSIT_ACTIVATION_STATUS.VERIFIED);
    assert.equal(result.watchStarted, true);
    assert.equal(monitor.listActiveWatches().length, 1);
    assert.equal(verified.length, 1);
    assert.equal(verified[0].depositId, session.depositId);

});

function creatorFundSeatNanotons(plan) {

    return BigInt(plan.creationFeePerSeat) + BigInt(plan.bindings[0].expectedAmount);

}

test("R18-S16: creator one-wallet PARTIALLY_FUNDED FundSeat → VERIFIED", async () => {

    const stack = createStack();
    const credit = creatorFundSeatNanotons(stack.plan);

    stack.tonService.getters = matchingGetters(stack.plan, {
        get_status: intGetter(DEPOSIT_ONCHAIN_STATUS.PARTIALLY_FUNDED),
        get_paid_mask: intGetter(1),
        get_credited_amount0: intGetter(credit),
        get_total_credited: intGetter(credit)
    });

    const result = await stack.activation.verifyActivation(stack.session.depositId);

    assert.equal(result.status, DEPOSIT_ACTIVATION_STATUS.VERIFIED);
    assert.equal(stack.monitor.listActiveWatches().length, 1);

});

test("R18-S16: PARTIALLY_FUNDED with non-creator credit → REJECT", async () => {

    const stack = createStack();
    const credit = creatorFundSeatNanotons(stack.plan);

    stack.tonService.getters = matchingGetters(stack.plan, {
        get_status: intGetter(DEPOSIT_ONCHAIN_STATUS.PARTIALLY_FUNDED),
        get_paid_mask: intGetter(2),
        get_credited_amount1: intGetter(credit),
        get_total_credited: intGetter(credit)
    });

    await expectReject(
        stack.activation,
        stack.session.depositId,
        DEPOSIT_ACTIVATION_ERROR_CODES.INITIAL_STATE_INVALID
    );

    assert.equal(stack.monitor.listActiveWatches().length, 0);

});

test("R18-S16: PARTIALLY_FUNDED with wrong creator credit → REJECT", async () => {

    const stack = createStack();

    stack.tonService.getters = matchingGetters(stack.plan, {
        get_status: intGetter(DEPOSIT_ONCHAIN_STATUS.PARTIALLY_FUNDED),
        get_paid_mask: intGetter(1),
        get_credited_amount0: intGetter(BigInt(stack.plan.bindings[0].expectedAmount)),
        get_total_credited: intGetter(BigInt(stack.plan.bindings[0].expectedAmount))
    });

    await expectReject(
        stack.activation,
        stack.session.depositId,
        DEPOSIT_ACTIVATION_ERROR_CODES.INITIAL_STATE_INVALID
    );

    assert.equal(stack.monitor.listActiveWatches().length, 0);

});
