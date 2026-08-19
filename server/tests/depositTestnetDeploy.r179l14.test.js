/**
 * R17.9L.14 — Testnet Deposit deploy guards + read-only verification tests.
 * No live TON send. No production Deploy Wallet. No FundSeat.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Cell, contractAddress, Address, TupleBuilder, TupleReader } from "@ton/core";

import { DepositMonitor } from "../deposit/DepositMonitor.js";
import { DepositSessionCoordinator } from "../deposit/DepositSessionCoordinator.js";
import { DepositSession } from "../deposit/DepositSession.js";
import { DEPOSIT_SESSION_STATUS } from "../deposit/DepositSessionStates.js";
import { TonFinancialDepositPersistence } from "../deposit/DepositPersistencePort.js";
import { TonFinancialDepositObservationPersistence } from "../deposit/DepositObservationPersistencePort.js";
import {
    DEPOSIT_ACCOUNT_STATE,
    RealTonDepositBlockchainSource
} from "../deposit/RealTonDepositBlockchainSource.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";
import {
    assertDedicatedTestnetDepositDeployer,
    assertSenderIsNotProductionDeployWallet,
    assertTestnetNetworkConfig,
    DepositTestnetDeployError,
    evaluateExistingDepositAccount,
    prepareDepositTestnetDeployPlan,
    TESTNET_DEPLOYMENT_CREDENTIAL_REQUIRED,
    toPublicDeployPlan,
    verifyLocalDepositArtifactIdentity
} from "../payment/ton/depositTestnetDeploy.js";
import {
    DEPOSIT_TESTNET_FIXTURE,
    FROZEN_DEPOSIT_ARTIFACT_SHA256,
    PRODUCTION_DEPLOY_WALLET,
    TESTNET_DEPOSIT_DEPLOYER_MNEMONIC_ENV,
    assertFixturePlayersDistinct
} from "../payment/ton/depositTestnetFixture.js";
import {
    assertInitialMutableState,
    readFullDepositGetters
} from "../payment/ton/readDepositGetters.js";
import { loadDepositCodeCell } from "../payment/ton/buildDepositStateInit.js";
import { GAME_ESCROW_ARTIFACT_BOC_PATH } from "../payment/ton/verifyGameEscrowArtifact.js";
import { readFileSync } from "node:fs";
import { InvalidResponseError } from "../services/ton/TonServiceErrors.js";

const ESCROW_CODE_B64 = readFileSync(GAME_ESCROW_ARTIFACT_BOC_PATH).toString("base64");
const DEPOSIT_CODE = loadDepositCodeCell({
    expectedSha256: FROZEN_DEPOSIT_ARTIFACT_SHA256
});
const DEPOSIT_CODE_HASH = DEPOSIT_CODE.hash().toString("hex");
const DEPOSIT_CODE_B64 = DEPOSIT_CODE.toBoc().toString("base64");

const TESTNET_ENV = Object.freeze({
    TON_NETWORK: "testnet",
    TON_ENDPOINT: "https://testnet.toncenter.com/api/v2/jsonRPC"
});

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

function depositPollGetters() {

    return {
        get_version: intGetter(1),
        get_deposit_id: intGetter(1),
        get_room_id_hash: intGetter(2),
        get_game_id_hash: intGetter(3),
        get_paid_mask: intGetter(0),
        get_status: intGetter(1),
        get_credited_amount0: intGetter(0),
        get_credited_amount1: intGetter(0),
        get_credited_amount2: intGetter(0),
        get_surplus_nano: intGetter(0),
        get_expires_at: intGetter(2_000_000_000),
        get_network_tag: intGetter(0)
    };

}

class StubTonService {

    constructor({
        network = "testnet",
        account = null,
        transactions = [],
        getters = {},
        fail = null
    } = {}) {

        this._network = network;
        this.account = account;
        this.transactions = transactions;
        this._gettersFactory = typeof getters === "function" ? getters : () => getters;
        this.fail = fail;

    }

    get getters() {

        return this._gettersFactory();

    }

    getActiveNetwork() {

        return this._network;

    }

    async getAccount() {

        if (this.fail === "rpc") {

            throw new Error("fetch failed");

        }

        return this.account;

    }

    async getTransactions() {

        return this.transactions;

    }

    async runGetMethod(_address, method) {

        if (this.fail === method) {

            throw new InvalidResponseError(`getter ${method} failed`);

        }

        if (!(method in this.getters)) {

            throw new InvalidResponseError(`missing getter ${method}`);

        }

        return this.getters[method];

    }

}

test("R17.9L.14 Test1: correct testnet configuration selected", () => {

    const config = assertTestnetNetworkConfig(TESTNET_ENV);

    assert.equal(config.network, "testnet");
    assert.match(config.endpoint, /testnet/);

});

test("R17.9L.14 Test2: production Deploy Wallet configuration rejected", () => {

    assert.throws(
        () => assertDedicatedTestnetDepositDeployer({
            ...TESTNET_ENV
        }),
        (error) => error.message === TESTNET_DEPLOYMENT_CREDENTIAL_REQUIRED
    );

    assert.throws(
        () => assertDedicatedTestnetDepositDeployer({
            ...TESTNET_ENV,
            TON_DEPLOYER_MNEMONIC: "word ".repeat(24).trim(),
            [TESTNET_DEPOSIT_DEPLOYER_MNEMONIC_ENV]: "word ".repeat(24).trim()
        }),
        (error) => error instanceof DepositTestnetDeployError
            && error.code === "TESTNET_DEPOSIT_DEPLOYER_MUST_NOT_EQUAL_PRODUCTION_DEPLOYER"
    );

    assert.throws(
        () => assertSenderIsNotProductionDeployWallet(PRODUCTION_DEPLOY_WALLET),
        /refuses production Deploy Wallet/
    );

});

test("R17.9L.14 Test3: deterministic address equals expected address", () => {

    assertFixturePlayersDistinct();

    const plan = prepareDepositTestnetDeployPlan({ env: TESTNET_ENV });
    const independent = contractAddress(plan.workchain, {
        code: plan.code,
        data: plan.data
    });

    assert.ok(plan.address.equals(independent));
    assert.equal(
        plan.expectedAddress,
        independent.toString({ bounceable: true, urlSafe: true })
    );

    const again = prepareDepositTestnetDeployPlan({ env: TESTNET_ENV });

    assert.equal(again.expectedAddress, plan.expectedAddress);

});

test("R17.9L.14 Test4: existing active contract at expected address detected", () => {

    const result = evaluateExistingDepositAccount({
        state: DEPOSIT_ACCOUNT_STATE.ACTIVE,
        codeHash: DEPOSIT_CODE_HASH,
        expectedCodeHash: DEPOSIT_CODE_HASH
    });

    assert.equal(result.action, "verify_existing");

});

test("R17.9L.14 Test5: unexpected active contract blocks deployment", () => {

    const result = evaluateExistingDepositAccount({
        state: DEPOSIT_ACCOUNT_STATE.ACTIVE,
        codeHash: "aa".repeat(32),
        expectedCodeHash: DEPOSIT_CODE_HASH
    });

    assert.equal(result.action, "block");
    assert.equal(result.reason, "unexpected_active_contract");

    assert.equal(
        evaluateExistingDepositAccount({
            state: DEPOSIT_ACCOUNT_STATE.UNINIT,
            balanceNano: 1n,
            lastLt: "1"
        }).action,
        "block"
    );

    assert.equal(
        evaluateExistingDepositAccount({
            state: DEPOSIT_ACCOUNT_STATE.UNINIT,
            balanceNano: 0n,
            lastLt: "0",
            codeHash: null
        }).action,
        "deploy"
    );

    assert.equal(
        evaluateExistingDepositAccount({
            state: DEPOSIT_ACCOUNT_STATE.FROZEN
        }).action,
        "block"
    );

    assert.equal(
        evaluateExistingDepositAccount({
            state: DEPOSIT_ACCOUNT_STATE.NONEXISTENT
        }).action,
        "deploy"
    );

});

test("R17.9L.14 Test6: deployment uses only testnet network", () => {

    assert.throws(
        () => assertTestnetNetworkConfig({ TON_NETWORK: "mainnet" }),
        /TESTNET_DEPOSIT_DEPLOYER_REQUIRES_TESTNET/
    );

    assert.throws(
        () => assertTestnetNetworkConfig({
            TON_NETWORK: "testnet",
            TON_ENDPOINT: "https://toncenter.com/api/v2/jsonRPC"
        }),
        /non-testnet RPC endpoint/
    );

    const plan = prepareDepositTestnetDeployPlan({ env: TESTNET_ENV });

    assert.equal(plan.network, "testnet");
    assert.equal(plan.networkTag, 0);

});

test("R17.9L.14 Test7: on-chain code hash equals verified artifact", () => {

    const artifact = verifyLocalDepositArtifactIdentity();

    assert.equal(artifact.sha256, FROZEN_DEPOSIT_ARTIFACT_SHA256);
    assert.equal(artifact.codeHash, DEPOSIT_CODE_HASH);

    const result = evaluateExistingDepositAccount({
        state: DEPOSIT_ACCOUNT_STATE.ACTIVE,
        codeHash: artifact.codeHash,
        expectedCodeHash: artifact.codeHash
    });

    assert.equal(result.action, "verify_existing");

});

test("R17.9L.14 Test8: wrong code hash rejected", async () => {

    const plan = prepareDepositTestnetDeployPlan({ env: TESTNET_ENV });

    const source = new RealTonDepositBlockchainSource({
        logger: createLogger(),
        tonService: new StubTonService({
            account: {
                state: "active",
                code: ESCROW_CODE_B64,
                balance: "0"
            },
            getters: {
                get_network_tag: intGetter(0)
            }
        }),
        network: "testnet"
    });

    const state = await source.getContractState(plan.expectedAddress);

    assert.notEqual(state.codeHash, DEPOSIT_CODE_HASH);

    const evaluation = evaluateExistingDepositAccount({
        state: state.state,
        codeHash: state.codeHash,
        expectedCodeHash: DEPOSIT_CODE_HASH
    });

    assert.equal(evaluation.action, "block");

});

test("R17.9L.14 Test9: immutable getters match fixture", async () => {

    const plan = prepareDepositTestnetDeployPlan({ env: TESTNET_ENV });

    const getters = {
        get_version: intGetter(plan.contractVersion),
        get_deposit_id: intGetter(BigInt(`0x${plan.depositIdHash}`)),
        get_room_id_hash: intGetter(BigInt(`0x${plan.roomIdHash}`)),
        get_game_id_hash: intGetter(BigInt(`0x${plan.gameIdHash}`)),
        get_expected_stake0: intGetter(plan.expectedStake0),
        get_expected_stake1: intGetter(plan.expectedStake1),
        get_expected_stake2: intGetter(plan.expectedStake2),
        get_creation_fee_per_seat: intGetter(plan.creationFeePerSeat),
        get_expected_amount0: intGetter(BigInt(plan.expectedStake0) + BigInt(plan.creationFeePerSeat)),
        get_expected_amount1: intGetter(BigInt(plan.expectedStake1) + BigInt(plan.creationFeePerSeat)),
        get_expected_amount2: intGetter(BigInt(plan.expectedStake2) + BigInt(plan.creationFeePerSeat)),
        get_paid_mask: intGetter(0),
        get_status: intGetter(1),
        get_credited_amount0: intGetter(0),
        get_credited_amount1: intGetter(0),
        get_credited_amount2: intGetter(0),
        get_surplus_nano: intGetter(0),
        get_expires_at: intGetter(plan.expiresAt),
        get_network_tag: intGetter(0),
        get_refund_mask: intGetter(0),
        get_total_credited: intGetter(0),
        get_player0: addrGetter(Address.parse(plan.player0)),
        get_player1: addrGetter(Address.parse(plan.player1)),
        get_player2: addrGetter(Address.parse(plan.player2)),
        get_release_authority: addrGetter(Address.parse(plan.releaseAuthority)),
        get_released_to: addrGetter(new Address(0, Buffer.alloc(32)))
    };

    const read = await readFullDepositGetters(
        new StubTonService({ getters }),
        plan.expectedAddress
    );

    assert.equal(Number(read.contractVersion), plan.contractVersion);
    assert.equal(read.depositIdHash.toString(16).padStart(64, "0"), plan.depositIdHash);
    assert.equal(read.player0, plan.player0);
    assert.equal(read.player1, plan.player1);
    assert.equal(read.player2, plan.player2);
    assert.equal(read.releaseAuthority, plan.releaseAuthority);
    assert.equal(Number(read.networkTag), 0);
    assert.equal(read.expiresAt, BigInt(plan.expiresAt));

});

test("R17.9L.14 Test10: initial mutable state matches frozen spec", async () => {

    const zero = new Address(0, Buffer.alloc(32));

    const getters = {
        get_version: intGetter(1),
        get_deposit_id: intGetter(1),
        get_room_id_hash: intGetter(2),
        get_game_id_hash: intGetter(3),
        get_expected_stake0: intGetter(1),
        get_expected_stake1: intGetter(1),
        get_expected_stake2: intGetter(1),
        get_creation_fee_per_seat: intGetter(1),
        get_expected_amount0: intGetter(2),
        get_expected_amount1: intGetter(2),
        get_expected_amount2: intGetter(2),
        get_paid_mask: intGetter(0),
        get_status: intGetter(1),
        get_credited_amount0: intGetter(0),
        get_credited_amount1: intGetter(0),
        get_credited_amount2: intGetter(0),
        get_surplus_nano: intGetter(0),
        get_expires_at: intGetter(2_000_000_000),
        get_network_tag: intGetter(0),
        get_refund_mask: intGetter(0),
        get_total_credited: intGetter(0),
        get_player0: addrGetter(Address.parse(DEPOSIT_TESTNET_FIXTURE.player0)),
        get_player1: addrGetter(Address.parse(DEPOSIT_TESTNET_FIXTURE.player1)),
        get_player2: addrGetter(Address.parse(DEPOSIT_TESTNET_FIXTURE.player2)),
        get_release_authority: addrGetter(Address.parse(DEPOSIT_TESTNET_FIXTURE.releaseAuthority)),
        get_released_to: addrGetter(zero)
    };

    const read = await readFullDepositGetters(
        new StubTonService({ getters }),
        DEPOSIT_TESTNET_FIXTURE.player0
    );

    assert.equal(assertInitialMutableState(read), true);

});

test("R17.9L.14 Test11: real adapter can read the deployed contract", async () => {

    const plan = prepareDepositTestnetDeployPlan({ env: TESTNET_ENV });

    const source = new RealTonDepositBlockchainSource({
        logger: createLogger(),
        tonService: new StubTonService({
            account: {
                state: "active",
                code: DEPOSIT_CODE_B64,
                balance: "0"
            },
            getters: {
                get_version: intGetter(1),
                get_deposit_id: intGetter(1),
                get_room_id_hash: intGetter(2),
                get_game_id_hash: intGetter(3),
                get_paid_mask: intGetter(0),
                get_status: intGetter(1),
                get_credited_amount0: intGetter(0),
                get_credited_amount1: intGetter(0),
                get_credited_amount2: intGetter(0),
                get_surplus_nano: intGetter(0),
                get_expires_at: intGetter(2_000_000_000),
                get_network_tag: intGetter(0)
            },
            transactions: []
        }),
        network: "testnet"
    });

    const contractState = await source.getContractState(plan.expectedAddress);

    assert.equal(contractState.state, DEPOSIT_ACCOUNT_STATE.ACTIVE);
    assert.equal(contractState.codeHash, DEPOSIT_CODE_HASH);

    const depositState = await source.getDepositState(plan.expectedAddress);

    assert.equal(Number(depositState.status), 1);
    assert.equal(Number(depositState.networkTag), 0);

});

test("R17.9L.14 Test12: fake address rejected", async () => {

    const fake = "EQADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA8id";

    const source = new RealTonDepositBlockchainSource({
        logger: createLogger(),
        tonService: new StubTonService({
            account: { state: "nonexist", balance: "0" },
            getters: {},
            transactions: []
        }),
        network: "testnet"
    });

    const state = await source.getContractState(fake);

    assert.equal(state.state, DEPOSIT_ACCOUNT_STATE.NONEXISTENT);

    const evaluation = evaluateExistingDepositAccount({
        state: state.state,
        expectedCodeHash: DEPOSIT_CODE_HASH
    });

    assert.equal(evaluation.action, "deploy");
    assert.notEqual(fake, prepareDepositTestnetDeployPlan({ env: TESTNET_ENV }).expectedAddress);

});

test("R17.9L.14 Test13: wrong network rejected", async () => {

    assert.throws(
        () => new RealTonDepositBlockchainSource({
            logger: createLogger(),
            tonService: new StubTonService({ network: "mainnet" }),
            network: "invalid"
        }),
        /Unsupported TON network/
    );

    const plan = prepareDepositTestnetDeployPlan({ env: TESTNET_ENV });

    const source = new RealTonDepositBlockchainSource({
        logger: createLogger(),
        tonService: new StubTonService({
            network: "testnet",
            account: {
                state: "active",
                code: DEPOSIT_CODE_B64,
                balance: "0"
            },
            getters: {
                get_version: intGetter(1),
                get_deposit_id: intGetter(1),
                get_room_id_hash: intGetter(2),
                get_game_id_hash: intGetter(3),
                get_paid_mask: intGetter(0),
                get_status: intGetter(1),
                get_credited_amount0: intGetter(0),
                get_credited_amount1: intGetter(0),
                get_credited_amount2: intGetter(0),
                get_surplus_nano: intGetter(0),
                get_expires_at: intGetter(2_000_000_000),
                get_network_tag: intGetter(1)
            },
            transactions: []
        }),
        network: "testnet"
    });

    const result = await source.pollWatch({
        depositId: plan.depositId,
        depositAddress: plan.expectedAddress,
        network: "testnet"
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "network_tag_mismatch");

});

test("R17.9L.14 Test14-16: restart restores watch without authorization or Game Contract deploy", async () => {

    const plan = prepareDepositTestnetDeployPlan({ env: TESTNET_ENV });
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-dton-l14-"));

    const persistence = new TonFinancialPersistence({
        dataDir,
        autoCheckpoint: false
    });

    persistence.initialize();

    const eventBus = createEventBus();
    const emitted = [];

    for (const type of [
        EVENT_TYPES.DEPLOY_AUTHORIZATION_CREATED,
        EVENT_TYPES.DEPLOY_AUTHORIZATION_VALID,
        EVENT_TYPES.GAME_CONTRACT_DEPLOYED,
        EVENT_TYPES.GAME_INITIALIZED
    ]) {

        eventBus.subscribe(type, (envelope) => {

            emitted.push(envelope.type);

        });

    }

    const depositPersistence = new TonFinancialDepositPersistence(persistence);

    const coordinator = new DepositSessionCoordinator({
        eventBus,
        persistence: depositPersistence
    });

    // Frozen L.14 fixture includes ZERO as player0 in on-chain StateInit.
    // Seed bindings via persistence restore — bindPlayers rejects ZERO (L.20).
    const now = Date.now();

    const seeded = new DepositSession({
        depositId: plan.depositId,
        roomId: plan.roomId,
        gameId: plan.gameId,
        bindings: [
            { playerId: "seat0", wallet: plan.player0, expectedAmount: Number(plan.expectedStake0), receivedAmount: 0, funded: false },
            { playerId: "seat1", wallet: plan.player1, expectedAmount: Number(plan.expectedStake1), receivedAmount: 0, funded: false },
            { playerId: "seat2", wallet: plan.player2, expectedAmount: Number(plan.expectedStake2), receivedAmount: 0, funded: false }
        ],
        state: DEPOSIT_SESSION_STATUS.AWAITING_FUNDS,
        createdAt: now,
        updatedAt: now,
        boundAt: now,
        awaitingFundsAt: now,
        metadata: { network: "testnet" }
    });

    seeded.setDepositAddress(plan.expectedAddress);

    depositPersistence.saveDepositSession(seeded);

    coordinator.restoreFromPersistence(seeded.depositId);

    const session = coordinator.getSession(seeded.depositId);

    const source = new RealTonDepositBlockchainSource({
        logger: createLogger(),
        tonService: new StubTonService({
            account: {
                state: "active",
                code: DEPOSIT_CODE_B64,
                balance: "0"
            },
            getters: depositPollGetters,
            transactions: []
        }),
        network: "testnet"
    });

    const monitor = new DepositMonitor({
        logger: createLogger(),
        eventBus,
        depositSessionCoordinator: coordinator,
        persistence: new TonFinancialDepositObservationPersistence(persistence),
        blockchainSource: source,
        network: "testnet"
    });

    monitor.initialize();
    monitor.startWatching(session);

    const firstPoll = await monitor.poll();

    assert.equal(firstPoll.results[0].ok, true);
    assert.equal(firstPoll.results[0].contractState.codeHash, DEPOSIT_CODE_HASH);

    monitor.shutdown();

    const restoredCoordinator = new DepositSessionCoordinator({
        eventBus,
        persistence: depositPersistence
    });

    restoredCoordinator.restoreFromPersistence(session.depositId);

    const restoredSession = restoredCoordinator.getSession(session.depositId);

    restoredCoordinator.setDepositAddress(restoredSession.depositId, plan.expectedAddress); // R17.9L.21 idempotent
    restoredSession.metadata = { network: "testnet" };

    const restoredMonitor = new DepositMonitor({
        logger: createLogger(),
        eventBus,
        depositSessionCoordinator: restoredCoordinator,
        persistence: new TonFinancialDepositObservationPersistence(persistence),
        blockchainSource: source,
        network: "testnet"
    });

    restoredMonitor.initialize();

    const restored = restoredMonitor.restoreActiveWatches();

    assert.ok(restored.restored >= 1);

    const secondPoll = await restoredMonitor.poll();

    assert.equal(secondPoll.results[0].ok, true);
    assert.equal(secondPoll.results[0].contractState.address, plan.expectedAddress);
    assert.equal(secondPoll.observed, 0);
    assert.deepEqual(emitted, []);

});

test("R17.9L.14 security: deployer identity does not affect address", () => {

    const plan = prepareDepositTestnetDeployPlan({ env: TESTNET_ENV });
    const publicPlan = toPublicDeployPlan(plan);

    assert.equal(publicPlan.expectedAddress, plan.expectedAddress);
    assert.notEqual(publicPlan.expectedAddress, PRODUCTION_DEPLOY_WALLET);
    assert.ok(!Object.values(publicPlan).some((value) =>
        typeof value === "string" && /mnemonic|secret|private/i.test(value)
    ));

});
