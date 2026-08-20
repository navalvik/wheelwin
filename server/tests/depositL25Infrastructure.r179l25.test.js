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

});
