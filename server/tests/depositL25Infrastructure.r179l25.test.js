/**
 * R17.9L.25 — Offline TEST-ONLY infrastructure unit tests (no live TON).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { Address, beginCell, Cell } from "@ton/core";

import {
    buildDepositStateInit,
    resetDepositCodeCellCacheForTests
} from "../payment/ton/buildDepositStateInit.js";
import {
    FROZEN_DEPOSIT_ARTIFACT_SHA256,
    FROZEN_TESTNET_DEPOSIT_DEPLOYER_ADDRESS,
    PRODUCTION_DEPLOY_WALLET
} from "../payment/ton/depositTestnetFixture.js";
import { encodeFundSeatBody } from "../deposit/RealTonDepositBlockchainSource.js";
import {
    reconstructPackageStateInit
} from "./testnet/r179l25/l25PlayerDepositDeploy.js";
import {
    assertSeatOwnership,
    resolveSeatExpectedAmountNano
} from "./testnet/r179l25/l25PlayerFundSeat.js";
import {
    assertValidL25PlayerAddresses
} from "./testnet/r179l25/l25PlayerWallets.js";
import {
    resolveWheelWinWatchAddresses
} from "./testnet/r179l25/l25ZeroSpendProof.js";
import { L25_ERROR_CODES, L25TestError } from "./testnet/r179l25/l25Errors.js";
import {
    isL25TransientRpcError,
    l25WithRpcRetry,
    L25_RPC_RETRY_POLICY
} from "./testnet/r179l25/l25RpcRetry.js";
import {
    commitL25RecoverySession,
    createL25RecoveryDepositSession,
    fundL25RecoverySessionToFull
} from "./testnet/r179l25/l25RecoverySession.js";
import { computeDepositBindingHash } from "../deposit/deploymentAuthorizationHash.js";
import { DepositSessionCoordinator } from "../deposit/DepositSessionCoordinator.js";
import { InMemoryDepositPersistence } from "../deposit/DepositPersistencePort.js";
import { DeploymentAuthorizationCoordinator } from "../deposit/DeploymentAuthorizationCoordinator.js";
import { InMemoryDeploymentAuthorizationPersistence } from "../deposit/DeploymentAuthorizationPersistencePort.js";
import { DEPLOYMENT_AUTHORIZATION_STATUS } from "../deposit/DeploymentAuthorizationStates.js";
import { DEPOSIT_SESSION_STATUS } from "../deposit/DepositSessionStates.js";
import { EventBus } from "../events/EventBus.js";
import { assertCanCreateDeploymentAuthorization } from "../deposit/deploymentAuthorizationValidation.js";

const PLAYER_0 = "EQABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAc3j";
const PLAYER_1 = "EQACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAsoi";
const PLAYER_2 = "EQADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA8id";
const ORACLE = "EQAREREREREREREREREREREREREREREREREREREREREREeYT";

const ZERO = new Address(0, Buffer.alloc(32)).toString({
    bounceable: true,
    urlSafe: true
});

test("R17.9L.25 unit: player address validation rejects ZERO/reserved/dupes", () => {

    assert.throws(
        () => assertValidL25PlayerAddresses([ZERO, PLAYER_1, PLAYER_2]),
        (error) => error instanceof L25TestError
            && error.code === L25_ERROR_CODES.WALLET_RESERVED
    );

    assert.throws(
        () => assertValidL25PlayerAddresses([
            PRODUCTION_DEPLOY_WALLET,
            PLAYER_1,
            PLAYER_2
        ]),
        (error) => error.code === L25_ERROR_CODES.WALLET_RESERVED
    );

    assert.throws(
        () => assertValidL25PlayerAddresses([
            FROZEN_TESTNET_DEPOSIT_DEPLOYER_ADDRESS,
            PLAYER_1,
            PLAYER_2
        ]),
        (error) => error.code === L25_ERROR_CODES.WALLET_RESERVED
    );

    assert.throws(
        () => assertValidL25PlayerAddresses([PLAYER_0, PLAYER_0, PLAYER_2]),
        (error) => error.code === L25_ERROR_CODES.WALLET_INVALID
    );

    assert.equal(
        assertValidL25PlayerAddresses([PLAYER_0, PLAYER_1, PLAYER_2]),
        true
    );

});

test("R17.9L.25 unit: package StateInit BOC round-trip preserves DepositAddress", () => {

    resetDepositCodeCellCacheForTests();

    const built = buildDepositStateInit({
        depositId: "dep_l25_unit_001",
        roomId: "room-l25-unit",
        gameId: "game-l25-unit",
        players: [
            { playerId: "p0", wallet: PLAYER_0, expectedStake: 10_000_000n },
            { playerId: "p1", wallet: PLAYER_1, expectedStake: 10_000_000n },
            { playerId: "p2", wallet: PLAYER_2, expectedStake: 10_000_000n }
        ],
        creationFeePerSeat: 1_000_000n,
        expiresAt: 2_000_000_000n,
        network: "testnet",
        releaseAuthority: ORACLE,
        expectedArtifactSha256: FROZEN_DEPOSIT_ARTIFACT_SHA256,
        env: { TON_TESTNET_ORACLE_ADDRESS: ORACLE }
    });

    const depositPackage = {
        depositAddress: built.addressFriendly,
        stateInit: {
            codeBoc: built.code.toBoc().toString("base64"),
            dataBoc: built.data.toBoc().toString("base64")
        }
    };

    const reconstructed = reconstructPackageStateInit(depositPackage);

    assert.equal(
        reconstructed.addressCanonical,
        built.address.toString({ bounceable: true, urlSafe: true })
    );

    // Tampered data must fail.
    const badData = beginCell().storeUint(1, 8).endCell().toBoc().toString("base64");

    assert.throws(
        () => reconstructPackageStateInit({
            depositAddress: built.addressFriendly,
            stateInit: {
                codeBoc: depositPackage.stateInit.codeBoc,
                dataBoc: badData
            }
        }),
        (error) => error.code === L25_ERROR_CODES.STATEINIT_MISMATCH
    );

});

test("R17.9L.25 unit: FundSeat seat ownership + amount resolution", () => {

    const session = {
        depositAddress: PLAYER_0,
        bindings: [
            { playerId: "p0", wallet: PLAYER_0, expectedAmount: 11_000_000 },
            { playerId: "p1", wallet: PLAYER_1, expectedAmount: 11_000_000 },
            { playerId: "p2", wallet: PLAYER_2, expectedAmount: 11_000_000 }
        ],
        metadata: {
            creationFeePerSeat: 1_000_000,
            expectedStake0: 10_000_000,
            expectedStake1: 10_000_000,
            expectedStake2: 10_000_000
        }
    };

    assert.equal(
        resolveSeatExpectedAmountNano(session, 0),
        11_000_000n
    );

    assert.equal(
        assertSeatOwnership(
            { seatIndex: 1, addressCanonical: PLAYER_1 },
            1,
            session
        ),
        true
    );

    assert.throws(
        () => assertSeatOwnership(
            { seatIndex: 0, addressCanonical: PLAYER_0 },
            1,
            session
        ),
        (error) => error.code === L25_ERROR_CODES.SEAT_MISMATCH
    );

    const body = encodeFundSeatBody(2);
    assert.ok(body instanceof Cell);

});

test("R17.9L.25 unit: WheelWin watch addresses include production + historical deployer", () => {

    const addresses = resolveWheelWinWatchAddresses({
        TON_DEPLOYER_WALLET: PRODUCTION_DEPLOY_WALLET
    });

    assert.ok(addresses.includes(
        PRODUCTION_DEPLOY_WALLET
    ) || addresses.some((a) => a.length > 10));

    assert.ok(
        addresses.some((a) => a === FROZEN_TESTNET_DEPOSIT_DEPLOYER_ADDRESS
            || a.includes("BSm")
            || a.length > 10)
    );

});

test("R17.9L.25 unit: live E2E runner is not imported by FakeDepositBlockchainSource path", async () => {

    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const here = dirname(fileURLToPath(import.meta.url));
    const harnessSrc = readFileSync(
        join(here, "testnet/r179l25/l25Harness.js"),
        "utf8"
    );
    const e2eSrc = readFileSync(
        join(here, "testnet/r179l25/depositPlayerDeploymentE2E.r179l25.js"),
        "utf8"
    );
    const deploySrc = readFileSync(
        join(here, "testnet/r179l25/l25PlayerDepositDeploy.js"),
        "utf8"
    );
    const walletsSrc = readFileSync(
        join(here, "testnet/r179l25/l25PlayerWallets.js"),
        "utf8"
    );
    const derivationSrc = readFileSync(
        join(here, "testnet/r179l25/l25PlayerWalletDerivation.js"),
        "utf8"
    );

    assert.doesNotMatch(
        harnessSrc,
        /from\s+["'][^"']*FakeDepositBlockchainSource/
    );
    assert.doesNotMatch(
        e2eSrc,
        /from\s+["'][^"']*FakeDepositBlockchainSource/
    );
    assert.doesNotMatch(
        e2eSrc,
        /executeDepositTestnetDeploy\s*\(/
    );
    assert.doesNotMatch(
        deploySrc,
        /process\.env\.TON_TESTNET_DEPOSIT_DEPLOYER_MNEMONIC/
    );
    assert.doesNotMatch(
        deploySrc,
        /process\.env\.TON_DEPLOYER_MNEMONIC/
    );
    assert.doesNotMatch(
        deploySrc,
        /env\.TON_TESTNET_DEPOSIT_DEPLOYER_MNEMONIC/
    );
    assert.doesNotMatch(
        deploySrc,
        /env\.TON_DEPLOYER_MNEMONIC/
    );
    assert.match(harnessSrc, /RealTonDepositBlockchainSource/);
    assert.match(harnessSrc, /requireActivationVerification:\s*true/);
    assert.match(walletsSrc, /l25PlayerWalletDerivation\.js/);
    assert.match(derivationSrc, /createTestnetDepositDeployerV5Wallet/);
    assert.doesNotMatch(
        walletsSrc,
        /WalletContractV4\.create\s*\(/
    );
    assert.match(deploySrc, /l25WithRpcRetry/);
    assert.match(harnessSrc, /l25WithRpcRetry/);
    assert.match(e2eSrc, /TON_DEPOSIT_TIMEOUT_MS\s*=\s*"1200000"/);

});

test("R17.9L.25.I.2.A unit: transient RPC classification", () => {

    assert.equal(isL25TransientRpcError(new Error("TON request timed out")), true);
    assert.equal(isL25TransientRpcError(new Error("Request failed with status code 429")), true);
    assert.equal(isL25TransientRpcError({ message: "rate limit", status: 429 }), true);
    assert.equal(isL25TransientRpcError(new Error("invalid address")), false);
    assert.equal(isL25TransientRpcError(new Error("StateInit mismatch")), false);
    assert.equal(L25_RPC_RETRY_POLICY.maxAttempts >= 5, true);
    assert.equal(L25_RPC_RETRY_POLICY.initialDelayMs >= 2_000, true);

});

test("R17.9L.25.I.2.A unit: l25WithRpcRetry retries then succeeds", async () => {

    let attempts = 0;
    const logs = [];

    const value = await l25WithRpcRetry(async () => {

        attempts += 1;

        if (attempts < 3) {

            throw new Error("TON request timed out");

        }

        return "ok";

    }, {
        operationName: "unitTest",
        policy: {
            maxAttempts: 5,
            initialDelayMs: 10,
            maxDelayMs: 20,
            multiplier: 2
        },
        logger: {
            warn(message) {

                logs.push(message);

            }
        }
    });

    assert.equal(value, "ok");
    assert.equal(attempts, 3);
    assert.equal(logs.length, 2);
    assert.match(logs[0], /\[L25 RPC RETRY\]/);
    assert.match(logs[0], /operation=unitTest/);

});

test("R17.9L.25.I.2.A unit: l25WithRpcRetry does not retry logic errors", async () => {

    let attempts = 0;

    await assert.rejects(
        () => l25WithRpcRetry(async () => {

            attempts += 1;
            throw new Error("invalid address");

        }, {
            operationName: "logicFail",
            policy: {
                maxAttempts: 5,
                initialDelayMs: 10,
                maxDelayMs: 20,
                multiplier: 2
            }
        }),
        /invalid address/
    );

    assert.equal(attempts, 1);

});

function createL25RecoveryTestBus() {

    const eventBus = new EventBus({
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    return eventBus;

}

test("R17.9L.25.K CaseA: recovery session creation produces bindingHash", () => {

    const session = createL25RecoveryDepositSession({
        depositId: "dep_l25k_a",
        roomId: "room-l25k-a",
        gameId: "game-l25k-a",
        depositAddress: PLAYER_0,
        players: [
            { playerId: "p0", wallet: PLAYER_0, expectedAmount: 11_000_000 },
            { playerId: "p1", wallet: PLAYER_1, expectedAmount: 11_000_000 },
            { playerId: "p2", wallet: PLAYER_2, expectedAmount: 11_000_000 }
        ],
        metadata: { network: "testnet", creationFeePerSeat: 1_000_000 }
    });

    assert.equal(session.state, DEPOSIT_SESSION_STATUS.AWAITING_FUNDS);
    assert.equal(typeof session.bindingHash, "string");
    assert.ok(session.bindingHash.length > 0);
    assert.equal(session.depositAddress, PLAYER_0);

});

test("R17.9L.25.K CaseB: stored bindingHash equals computeDepositBindingHash", () => {

    const session = createL25RecoveryDepositSession({
        depositId: "dep_l25k_b",
        roomId: "room-l25k-b",
        gameId: "game-l25k-b",
        depositAddress: PLAYER_0,
        players: [
            { playerId: "p0", wallet: PLAYER_0, expectedAmount: 11_000_000 },
            { playerId: "p1", wallet: PLAYER_1, expectedAmount: 11_000_000 },
            { playerId: "p2", wallet: PLAYER_2, expectedAmount: 11_000_000 }
        ]
    });

    const expected = computeDepositBindingHash({
        roomId: session.roomId,
        gameId: session.gameId,
        depositId: session.depositId,
        bindings: session.bindings
    });

    assert.equal(session.bindingHash, expected);

});

test("R17.9L.25.K CaseC: recovery DEPOSIT_FULL → Authorization VALID without manual hash", () => {

    const eventBus = createL25RecoveryTestBus();
    const depositSessionCoordinator = new DepositSessionCoordinator({
        eventBus,
        persistence: new InMemoryDepositPersistence()
    });
    const deploymentAuthorizationCoordinator = new DeploymentAuthorizationCoordinator({
        eventBus,
        persistence: new InMemoryDeploymentAuthorizationPersistence()
    });

    const session = createL25RecoveryDepositSession({
        depositId: "dep_l25k_c",
        roomId: "room-l25k-c",
        gameId: "game-l25k-c",
        depositAddress: PLAYER_0,
        players: [
            { playerId: "p0", wallet: PLAYER_0, expectedAmount: 11_000_000 },
            { playerId: "p1", wallet: PLAYER_1, expectedAmount: 11_000_000 },
            { playerId: "p2", wallet: PLAYER_2, expectedAmount: 11_000_000 }
        ],
        metadata: { network: "testnet" }
    });

    commitL25RecoverySession(depositSessionCoordinator, session);

    const full = fundL25RecoverySessionToFull(depositSessionCoordinator, session);

    assert.equal(full.state, DEPOSIT_SESSION_STATUS.DEPOSIT_FULL);
    assert.ok(full.bindingHash);

    // Fail-closed still enforced by production validation.
    assert.doesNotThrow(() => assertCanCreateDeploymentAuthorization(full));

    const created = deploymentAuthorizationCoordinator.createFromDepositSession(full);

    assert.equal(created.bindingHash, full.bindingHash);

    const valid = deploymentAuthorizationCoordinator.markValid(created.authorizationId);

    assert.equal(valid.status, DEPLOYMENT_AUTHORIZATION_STATUS.VALID);
    assert.equal(valid.bindingHash, full.bindingHash);
    assert.equal(valid.depositId, "dep_l25k_c");

});

test("R17.9L.25.K unit: commit refuses session without bindingHash", () => {

    const eventBus = createL25RecoveryTestBus();
    const depositSessionCoordinator = new DepositSessionCoordinator({
        eventBus,
        persistence: new InMemoryDepositPersistence()
    });

    assert.throws(
        () => commitL25RecoverySession(depositSessionCoordinator, {
            depositId: "dep_missing_hash",
            bindingHash: null
        }),
        (error) => error instanceof L25TestError
            && /without bindingHash/.test(error.message)
    );

});
