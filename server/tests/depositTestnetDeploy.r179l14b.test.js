/**
 * R17.9L.14B — Live deploy path guards (no live TON send in this file).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { mnemonicNew } from "@ton/crypto";

import { DEPOSIT_ACCOUNT_STATE } from "../deposit/RealTonDepositBlockchainSource.js";
import {
    prepareDepositTestnetDeployPlan
} from "../payment/ton/depositTestnetDeploy.js";
import {
    FROZEN_DEPOSIT_ARTIFACT_SHA256,
    FROZEN_DEPOSIT_CODE_CELL_HASH,
    FROZEN_DEPOSIT_EXPECTED_ADDRESS,
    PRODUCTION_DEPLOY_WALLET
} from "../payment/ton/depositTestnetFixture.js";
import { executeDepositTestnetDeploy } from "../payment/ton/executeDepositTestnetDeploy.js";
import {
    assertImmutableGettersMatchPlan,
    assertInitialMutableState
} from "../payment/ton/readDepositGetters.js";
import { getZeroDepositAddress } from "../payment/ton/depositTestnetFixture.js";

const currentDir = dirname(fileURLToPath(import.meta.url));

const TESTNET_ENV = Object.freeze({
    TON_NETWORK: "testnet",
    TON_ENDPOINT: "https://testnet.toncenter.com/api/v2/jsonRPC"
});

function sourceOf(relativePath) {

    return readFileSync(resolve(currentDir, relativePath), "utf8");

}

test("R17.9L.14B Test: frozen fixture address and artifact hashes", () => {

    const plan = prepareDepositTestnetDeployPlan({ env: TESTNET_ENV });

    assert.equal(plan.expectedAddress, FROZEN_DEPOSIT_EXPECTED_ADDRESS);
    assert.equal(plan.artifactSha256, FROZEN_DEPOSIT_ARTIFACT_SHA256);
    assert.equal(plan.expectedCodeHash, FROZEN_DEPOSIT_CODE_CELL_HASH);
    assert.notEqual(plan.releaseAuthority, PRODUCTION_DEPLOY_WALLET);
    assert.notEqual(plan.player0, plan.player1);
    assert.notEqual(plan.player0, plan.player2);
    assert.notEqual(plan.player1, plan.player2);

});

test("R17.9L.14B Test: existing ACTIVE matching contract skips send", async () => {

    const words = await mnemonicNew(12);
    const plan = prepareDepositTestnetDeployPlan({ env: TESTNET_ENV });
    const calls = [];

    const result = await executeDepositTestnetDeploy({
        env: {
            ...TESTNET_ENV,
            TON_TESTNET_DEPOSIT_DEPLOYER_MNEMONIC: words.join(" "),
            TON_DEPLOYER_MNEMONIC: "other ".repeat(24).trim()
        },
        plan,
        tonService: {
            async getBalance() {

                calls.push("getBalance");

                return 0n;

            },
            async broadcastTransaction() {

                calls.push("broadcastTransaction");

                throw new Error("broadcast must not run");

            }
        },
        getContractState: async () => ({
            state: DEPOSIT_ACCOUNT_STATE.ACTIVE,
            codeHash: plan.expectedCodeHash,
            lastHash: "existing-hash",
            lastLt: "1"
        }),
        send: true
    });

    assert.equal(result.sent, false);
    assert.equal(result.action, "verify_existing");
    assert.equal(result.transactionHash, "existing-hash");
    assert.ok(!calls.includes("broadcastTransaction"));

});

test("R17.9L.14B Test: unexpected ACTIVE contract blocks deployment", async () => {

    const words = await mnemonicNew(12);
    const plan = prepareDepositTestnetDeployPlan({ env: TESTNET_ENV });

    await assert.rejects(
        () => executeDepositTestnetDeploy({
            env: {
                ...TESTNET_ENV,
                TON_TESTNET_DEPOSIT_DEPLOYER_MNEMONIC: words.join(" "),
                TON_DEPLOYER_MNEMONIC: "other ".repeat(24).trim()
            },
            plan,
            tonService: {
                async broadcastTransaction() {

                    throw new Error("broadcast must not run");

                }
            },
            getContractState: async () => ({
                state: DEPOSIT_ACCOUNT_STATE.ACTIVE,
                codeHash: "aa".repeat(32)
            }),
            send: true
        }),
        /unexpected_active_contract/
    );

});

test("R17.9L.14B Test: deploy path never uses production mnemonic or FundSeat", () => {

    const executeSrc = sourceOf("../payment/ton/executeDepositTestnetDeploy.js");
    const scriptSrc = sourceOf("../scripts/r179l14_deploy_deposit_testnet.mjs");

    assert.match(executeSrc, /getTestnetDepositDeployer/);
    assert.match(executeSrc, /TON_TESTNET_DEPOSIT_DEPLOYER_MNEMONIC/);
    assert.match(executeSrc, /deriveTestnetDepositDeployerSigningWallet/);
    assert.doesNotMatch(executeSrc, /WalletContractV4\.create/);
    assert.doesNotMatch(executeSrc, /encodeFundSeatBody|FUND_SEAT_OPCODE|\$\$type:\s*"FundSeat"/);
    assert.doesNotMatch(executeSrc, /GameContractManager/);
    assert.doesNotMatch(executeSrc, /TonGameContractAdapter/);
    assert.doesNotMatch(scriptSrc, /process\.env\.TON_DEPLOYER_MNEMONIC/);
    assert.doesNotMatch(scriptSrc, /GameContractManager/);
    assert.doesNotMatch(scriptSrc, /TonGameContractAdapter/);
    assert.doesNotMatch(scriptSrc, /encodeFundSeatBody|FUND_SEAT_OPCODE/);

});

test("R17.9L.14B Test: immutable getter helper matches fixture plan", () => {

    const plan = prepareDepositTestnetDeployPlan({ env: TESTNET_ENV });
    const fee = BigInt(plan.creationFeePerSeat);

    const getters = {
        contractVersion: BigInt(plan.contractVersion),
        depositIdHash: BigInt(`0x${plan.depositIdHash}`),
        roomIdHash: BigInt(`0x${plan.roomIdHash}`),
        gameIdHash: BigInt(`0x${plan.gameIdHash}`),
        player0: plan.player0,
        player1: plan.player1,
        player2: plan.player2,
        expectedStake0: BigInt(plan.expectedStake0),
        expectedStake1: BigInt(plan.expectedStake1),
        expectedStake2: BigInt(plan.expectedStake2),
        creationFeePerSeat: fee,
        expectedAmount0: BigInt(plan.expectedStake0) + fee,
        expectedAmount1: BigInt(plan.expectedStake1) + fee,
        expectedAmount2: BigInt(plan.expectedStake2) + fee,
        paidMask: 0n,
        status: 1n,
        creditedAmount0: 0n,
        creditedAmount1: 0n,
        creditedAmount2: 0n,
        surplusNano: 0n,
        expiresAt: BigInt(plan.expiresAt),
        releaseAuthority: plan.releaseAuthority,
        networkTag: 0n,
        releasedTo: getZeroDepositAddress(),
        refundMask: 0n,
        totalCredited: 0n
    };

    assert.equal(assertImmutableGettersMatchPlan(getters, plan), true);
    assert.equal(assertInitialMutableState(getters), true);

    assert.throws(
        () => assertImmutableGettersMatchPlan({
            ...getters,
            networkTag: 1n
        }, plan),
        /networkTag/
    );

});
