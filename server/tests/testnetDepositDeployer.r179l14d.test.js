/**
 * R17.9L.14D — Dedicated W5 testnet Deposit deployer derivation tests.
 * Loads configured mnemonic from env when present. No live TON send.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { mnemonicNew } from "@ton/crypto";

import {
    DEPLOYER_WALLET_CONTRACT_TYPE,
    deriveDeployerWalletIdentity
} from "../payment/ton/deriveDeployerWalletIdentity.js";
import {
    TESTNET_DEPOSIT_DEPLOYER_WALLET_CONTRACT_TYPE,
    TESTNET_DEPOSIT_DEPLOYER_NETWORK_GLOBAL_ID,
    TESTNET_DEPOSIT_DEPLOYER_SUBWALLET_NUMBER,
    TESTNET_DEPOSIT_DEPLOYER_WORKCHAIN,
    deriveTestnetDepositDeployerSigningWallet,
    deriveTestnetDepositDeployerWalletIdentity
} from "../payment/ton/deriveTestnetDepositDeployerWalletIdentity.js";
import {
    FROZEN_DEPOSIT_EXPECTED_ADDRESS,
    FROZEN_TESTNET_DEPOSIT_DEPLOYER_ACCOUNT_ID,
    FROZEN_TESTNET_DEPOSIT_DEPLOYER_ADDRESS,
    TESTNET_DEPOSIT_DEPLOYER_MNEMONIC_ENV
} from "../payment/ton/depositTestnetFixture.js";
import { DEPOSIT_ACCOUNT_STATE } from "../deposit/RealTonDepositBlockchainSource.js";
import { prepareDepositTestnetDeployPlan } from "../payment/ton/depositTestnetDeploy.js";
import { executeDepositTestnetDeploy } from "../payment/ton/executeDepositTestnetDeploy.js";
import {
    TESTNET_DEPOSIT_DEPLOYER_CREDENTIAL_REQUIRED,
    getTestnetDepositDeployer,
    inspectTestnetDepositDeployerReadiness
} from "../payment/ton/getTestnetDepositDeployer.js";

const currentDir = dirname(fileURLToPath(import.meta.url));

const TESTNET_ENV = Object.freeze({
    TON_NETWORK: "testnet",
    TON_ENDPOINT: "https://testnet.toncenter.com/api/v2/jsonRPC"
});

function loadEnvFile(filePath) {

    if (!existsSync(filePath)) {

        return;

    }

    for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {

        const trimmed = line.trim();

        if (!trimmed || trimmed.startsWith("#")) {

            continue;

        }

        const index = trimmed.indexOf("=");

        if (index <= 0) {

            continue;

        }

        const key = trimmed.slice(0, index).trim();
        let value = trimmed.slice(index + 1).trim();

        if (
            (value.startsWith("\"") && value.endsWith("\""))
            || (value.startsWith("'") && value.endsWith("'"))
        ) {

            value = value.slice(1, -1);

        }

        if (process.env[key] === undefined) {

            process.env[key] = value;

        }

    }

}

for (const candidate of [
    resolve(currentDir, "../.env"),
    resolve(currentDir, "../../.env")
]) {

    loadEnvFile(candidate);

}

function configuredDedicatedMnemonic() {

    const raw = process.env[TESTNET_DEPOSIT_DEPLOYER_MNEMONIC_ENV];

    if (typeof raw !== "string" || !raw.trim()) {

        return null;

    }

    return raw.trim();

}

function sourceOf(relativePath) {

    return readFileSync(resolve(currentDir, relativePath), "utf8");

}

test("R17.9L.14D Test1: exact W5 testnet address from configured mnemonic", async () => {

    const mnemonic = configuredDedicatedMnemonic();

    assert.ok(mnemonic, "TON_TESTNET_DEPOSIT_DEPLOYER_MNEMONIC must be configured for exact-address verification");

    const identity = await deriveTestnetDepositDeployerWalletIdentity({ mnemonic });

    assert.equal(identity.address, FROZEN_TESTNET_DEPOSIT_DEPLOYER_ADDRESS);

});

test("R17.9L.14D Test2: exact account ID from configured mnemonic", async () => {

    const mnemonic = configuredDedicatedMnemonic();

    assert.ok(mnemonic, "TON_TESTNET_DEPOSIT_DEPLOYER_MNEMONIC must be configured for exact-account verification");

    const identity = await deriveTestnetDepositDeployerWalletIdentity({ mnemonic });

    assert.equal(identity.accountId, FROZEN_TESTNET_DEPOSIT_DEPLOYER_ACCOUNT_ID);

});

test("R17.9L.14D Test3: wallet type is WalletContractV5R1", async () => {

    const words = await mnemonicNew(12);
    const identity = await deriveTestnetDepositDeployerWalletIdentity({
        mnemonic: words.join(" ")
    });

    assert.equal(identity.walletContractType, TESTNET_DEPOSIT_DEPLOYER_WALLET_CONTRACT_TYPE);
    assert.equal(identity.walletContractType, "WalletContractV5R1");

});

test("R17.9L.14D Test4: network configuration matches audit", async () => {

    const words = await mnemonicNew(12);
    const identity = await deriveTestnetDepositDeployerWalletIdentity({
        mnemonic: words.join(" ")
    });

    assert.equal(identity.networkGlobalId, TESTNET_DEPOSIT_DEPLOYER_NETWORK_GLOBAL_ID);
    assert.equal(identity.networkGlobalId, -3);
    assert.equal(identity.workchain, TESTNET_DEPOSIT_DEPLOYER_WORKCHAIN);
    assert.equal(identity.workchain, 0);
    assert.equal(identity.subwalletNumber, TESTNET_DEPOSIT_DEPLOYER_SUBWALLET_NUMBER);
    assert.equal(identity.subwalletNumber, 0);

});

test("R17.9L.14D Test5: production isolation — V4R2 != dedicated W5", async () => {

    const dedicatedWords = await mnemonicNew(12);
    const productionWords = await mnemonicNew(24);
    const dedicatedMnemonic = dedicatedWords.join(" ");
    const productionMnemonic = productionWords.join(" ");

    const dedicated = await deriveTestnetDepositDeployerWalletIdentity({
        mnemonic: dedicatedMnemonic
    });
    const production = await deriveDeployerWalletIdentity({
        mnemonic: productionMnemonic
    });

    assert.equal(production.walletContractType, DEPLOYER_WALLET_CONTRACT_TYPE);
    assert.equal(production.walletContractType, "WalletContractV4R2");
    assert.notEqual(dedicated.accountId, production.address);
    assert.notEqual(dedicated.address, production.address);

});

test("R17.9L.14D Test6: no fallback when dedicated credential missing", async () => {

    await assert.rejects(
        () => getTestnetDepositDeployer({
            ...TESTNET_ENV,
            TON_DEPLOYER_MNEMONIC: "prod ".repeat(24).trim()
        }),
        (error) => error.code === TESTNET_DEPOSIT_DEPLOYER_CREDENTIAL_REQUIRED
    );

});

test("R17.9L.14D Test7: signing wallet matches dedicated identity address", async () => {

    const mnemonic = configuredDedicatedMnemonic()
        || (await mnemonicNew(12)).join(" ");
    const signing = await deriveTestnetDepositDeployerSigningWallet(mnemonic);
    const deployer = await getTestnetDepositDeployer({
        ...TESTNET_ENV,
        TON_TESTNET_DEPOSIT_DEPLOYER_MNEMONIC: mnemonic,
        TON_DEPLOYER_MNEMONIC: "other ".repeat(24).trim()
    });

    const signingAddress = signing.wallet.address.toString({
        bounceable: false,
        urlSafe: true,
        testOnly: true
    });

    assert.equal(signingAddress, deployer.walletAddress);
    assert.equal(signing.identity.address, deployer.walletAddress);

    if (configuredDedicatedMnemonic()) {

        assert.equal(deployer.walletAddress, FROZEN_TESTNET_DEPOSIT_DEPLOYER_ADDRESS);

    }

    assert.equal(signing.keyPair.secretKey.length > 0, true);
    assert.equal(JSON.stringify(deployer).includes(mnemonic), false);

});

test("R17.9L.14D Test8: Deposit Contract address unchanged", () => {

    const plan = prepareDepositTestnetDeployPlan({ env: TESTNET_ENV });

    assert.equal(plan.expectedAddress, FROZEN_DEPOSIT_EXPECTED_ADDRESS);

});

test("R17.9L.14D Test9: production derivation remains V4R2", async () => {

    const words = await mnemonicNew(24);
    const identity = await deriveDeployerWalletIdentity({
        mnemonic: words.join(" ")
    });

    assert.equal(identity.walletContractType, "WalletContractV4R2");
    assert.match(identity.address, /^(EQ|UQ)/);

    const productionSrc = sourceOf("../payment/ton/deriveDeployerWalletIdentity.js");

    assert.match(productionSrc, /WalletContractV4/);
    assert.doesNotMatch(productionSrc, /WalletContractV5R1/);

});

test("R17.9L.14D Test10: secret redaction in readiness output", async () => {

    const dedicatedWords = await mnemonicNew(12);
    const productionWords = await mnemonicNew(24);
    const dedicatedMnemonic = dedicatedWords.join(" ");
    const productionMnemonic = productionWords.join(" ");

    const snapshot = await inspectTestnetDepositDeployerReadiness({
        ...TESTNET_ENV,
        TON_TESTNET_DEPOSIT_DEPLOYER_MNEMONIC: dedicatedMnemonic,
        TON_DEPLOYER_MNEMONIC: productionMnemonic
    });

    const serialized = JSON.stringify(snapshot);

    assert.equal(serialized.includes(dedicatedMnemonic), false);
    assert.equal(serialized.includes(productionMnemonic), false);
    assert.equal(/private key|secret key|seed/i.test(serialized), false);

});

test("R17.9L.14D Test11: execute dry-run uses W5 signing path without send", async () => {

    const words = await mnemonicNew(12);
    const plan = prepareDepositTestnetDeployPlan({ env: TESTNET_ENV });

    const result = await executeDepositTestnetDeploy({
        env: {
            ...TESTNET_ENV,
            TON_TESTNET_DEPOSIT_DEPLOYER_MNEMONIC: words.join(" "),
            TON_DEPLOYER_MNEMONIC: "other ".repeat(24).trim()
        },
        plan,
        tonService: {
            async getBalance() {

                return 0n;

            },
            async broadcastTransaction() {

                throw new Error("broadcast must not run");

            }
        },
        getContractState: async () => ({
            state: DEPOSIT_ACCOUNT_STATE.NONEXISTENT,
            codeHash: null,
            balanceNano: 0n,
            lastLt: 0
        }),
        send: false
    });

    assert.equal(result.sent, false);
    assert.equal(result.action, "dry_run");
    assert.match(result.senderAddress, /^(0Q|kQ)/);

    const executeSrc = sourceOf("../payment/ton/executeDepositTestnetDeploy.js");

    assert.match(executeSrc, /deriveTestnetDepositDeployerSigningWallet/);
    assert.doesNotMatch(executeSrc, /WalletContractV4\.create/);

});
