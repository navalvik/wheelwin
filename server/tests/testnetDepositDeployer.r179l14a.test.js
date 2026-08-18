/**
 * R17.9L.14A — Dedicated TESTNET Deposit deployer isolation tests.
 * Dummy credentials only. No live TON. No production mnemonic.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { mnemonicNew } from "@ton/crypto";

import { PRODUCTION_DEPLOY_WALLET } from "../payment/ton/depositTestnetFixture.js";
import {
    assertDedicatedTestnetDepositDeployer,
    TESTNET_DEPLOYMENT_CREDENTIAL_REQUIRED
} from "../payment/ton/depositTestnetDeploy.js";
import {
    TESTNET_DEPOSIT_DEPLOYER_CREDENTIAL_REQUIRED,
    TESTNET_DEPOSIT_DEPLOYER_MUST_NOT_EQUAL_PRODUCTION_DEPLOYER,
    TESTNET_DEPOSIT_DEPLOYER_REQUIRES_TESTNET,
    TESTNET_DEPOSIT_DEPLOYER_ROLE,
    TestnetDepositDeployerError,
    assertTestnetDepositDeployerConfig,
    getTestnetDepositDeployer,
    inspectTestnetDepositDeployerReadiness
} from "../payment/ton/getTestnetDepositDeployer.js";

const currentDir = dirname(fileURLToPath(import.meta.url));

const DEDICATED_DUMMY = "alpha ".repeat(24).trim();
const PRODUCTION_DUMMY = "bravo ".repeat(24).trim();
const MARKER_MNEMONIC = "r179l14amarkerword ".repeat(24).trim();

const TESTNET_ENV = Object.freeze({
    TON_NETWORK: "testnet",
    TON_ENDPOINT: "https://testnet.toncenter.com/api/v2/jsonRPC"
});

function sourceOf(relativePath) {

    return readFileSync(resolve(currentDir, relativePath), "utf8");

}

test("R17.9L.14A Test1: dedicated testnet credential present is accepted", () => {

    const config = assertTestnetDepositDeployerConfig({
        ...TESTNET_ENV,
        TON_TESTNET_DEPOSIT_DEPLOYER_MNEMONIC: DEDICATED_DUMMY
    });

    assert.equal(config.role, TESTNET_DEPOSIT_DEPLOYER_ROLE);
    assert.equal(config.network, "testnet");
    assert.equal(config.configured, true);
    assert.equal(config.mnemonic, undefined);
    assert.equal("mnemonic" in config, false);

});

test("R17.9L.14A Test2: dedicated credential missing blocks deployment", () => {

    assert.throws(
        () => assertTestnetDepositDeployerConfig({
            ...TESTNET_ENV
        }),
        (error) => error instanceof TestnetDepositDeployerError
            && error.code === TESTNET_DEPOSIT_DEPLOYER_CREDENTIAL_REQUIRED
    );

});

test("R17.9L.14A Test3: dedicated credential equal to production is blocked", () => {

    assert.throws(
        () => assertTestnetDepositDeployerConfig({
            ...TESTNET_ENV,
            TON_DEPLOYER_MNEMONIC: DEDICATED_DUMMY,
            TON_TESTNET_DEPOSIT_DEPLOYER_MNEMONIC: DEDICATED_DUMMY
        }),
        (error) => error instanceof TestnetDepositDeployerError
            && error.code === TESTNET_DEPOSIT_DEPLOYER_MUST_NOT_EQUAL_PRODUCTION_DEPLOYER
            && !String(error.message).includes(DEDICATED_DUMMY)
    );

});

test("R17.9L.14A Test4: production credential present and dedicated missing blocks deployment", () => {

    assert.throws(
        () => assertTestnetDepositDeployerConfig({
            ...TESTNET_ENV,
            TON_DEPLOYER_MNEMONIC: PRODUCTION_DUMMY
        }),
        (error) => error instanceof TestnetDepositDeployerError
            && error.code === TESTNET_DEPOSIT_DEPLOYER_CREDENTIAL_REQUIRED
    );

    assert.throws(
        () => assertDedicatedTestnetDepositDeployer({
            ...TESTNET_ENV,
            TON_DEPLOYER_MNEMONIC: PRODUCTION_DUMMY
        }),
        (error) => error.message === TESTNET_DEPLOYMENT_CREDENTIAL_REQUIRED
            && error.code === TESTNET_DEPOSIT_DEPLOYER_CREDENTIAL_REQUIRED
    );

});

test("R17.9L.14A Test5: mainnet rejects testnet Deposit deployer", () => {

    assert.throws(
        () => assertTestnetDepositDeployerConfig({
            TON_NETWORK: "mainnet",
            TON_TESTNET_DEPOSIT_DEPLOYER_MNEMONIC: DEDICATED_DUMMY
        }),
        (error) => error instanceof TestnetDepositDeployerError
            && error.code === TESTNET_DEPOSIT_DEPLOYER_REQUIRES_TESTNET
    );

});

test("R17.9L.14A Test6: testnet accepts dedicated credential", () => {

    const config = assertTestnetDepositDeployerConfig({
        TON_NETWORK: "testnet",
        TON_TESTNET_DEPOSIT_DEPLOYER_MNEMONIC: DEDICATED_DUMMY,
        TON_DEPLOYER_MNEMONIC: PRODUCTION_DUMMY
    });

    assert.equal(config.network, "testnet");
    assert.equal(config.configured, true);

});

test("R17.9L.14A Test7: wallet derivation returns only public identity", async () => {

    const words = await mnemonicNew(12);
    const mnemonic = words.join(" ");
    const deployer = await getTestnetDepositDeployer({
        ...TESTNET_ENV,
        TON_TESTNET_DEPOSIT_DEPLOYER_MNEMONIC: mnemonic
    });

    assert.equal(deployer.role, TESTNET_DEPOSIT_DEPLOYER_ROLE);
    assert.equal(deployer.network, "testnet");
    assert.equal(typeof deployer.walletAddress, "string");
    assert.match(deployer.walletAddress, /^(0Q|kQ)/);
    assert.equal(deployer.walletVersion, "WalletContractV5R1");
    assert.equal(deployer.workchain, 0);
    assert.equal(deployer.mnemonic, undefined);
    assert.equal(deployer.privateKey, undefined);
    assert.equal(deployer.secretKey, undefined);
    assert.equal(deployer.seed, undefined);
    assert.ok(!JSON.stringify(deployer).includes(mnemonic));
    assert.notEqual(deployer.walletAddress, PRODUCTION_DEPLOY_WALLET);

});

test("R17.9L.14A Test8: mnemonic is never included in error output", () => {

    const errors = [];

    try {

        assertTestnetDepositDeployerConfig({
            ...TESTNET_ENV,
            TON_DEPLOYER_MNEMONIC: MARKER_MNEMONIC,
            TON_TESTNET_DEPOSIT_DEPLOYER_MNEMONIC: MARKER_MNEMONIC
        });

    } catch (error) {

        errors.push(error);

    }

    try {

        assertTestnetDepositDeployerConfig({
            ...TESTNET_ENV,
            TON_DEPLOYER_MNEMONIC: MARKER_MNEMONIC
        });

    } catch (error) {

        errors.push(error);

    }

    assert.equal(errors.length, 2);

    for (const error of errors) {

        const serialized = `${error.message}\n${error.stack}\n${JSON.stringify(error)}`;

        assert.equal(serialized.includes(MARKER_MNEMONIC), false);
        assert.equal(/private key|secret key|seed/i.test(serialized), false);
        assert.doesNotMatch(serialized, /alpha |bravo |r179l14amarkerword /);

    }

});

test("R17.9L.14A Test9: deployment script cannot fall back to TON_DEPLOYER_MNEMONIC", () => {

    const script = sourceOf("../scripts/r179l14_deploy_deposit_testnet.mjs");
    const getter = sourceOf("../payment/ton/getTestnetDepositDeployer.js");
    const deploy = sourceOf("../payment/ton/depositTestnetDeploy.js");

    assert.match(script, /TON_TESTNET_DEPOSIT_DEPLOYER_MNEMONIC/);
    assert.match(script, /getTestnetDepositDeployer/);
    assert.doesNotMatch(script, /process\.env\.TON_DEPLOYER_MNEMONIC/);
    assert.doesNotMatch(
        `${script}\n${getter}\n${deploy}`,
        /TON_TESTNET_DEPOSIT_DEPLOYER_MNEMONIC[^\n]{0,120}\|\|[^\n]{0,80}TON_DEPLOYER_MNEMONIC/
    );
    assert.doesNotMatch(
        `${script}\n${getter}\n${deploy}`,
        /\|\|[^\n]{0,80}(?:env|process\.env)\.TON_DEPLOYER_MNEMONIC/
    );
    assert.match(getter, /Never falls back to TON_DEPLOYER_MNEMONIC/);
    assert.match(deploy, /Never falls back to TON_DEPLOYER_MNEMONIC/);

});

test("R17.9L.14A Test10: dedicated address differs from production when credentials differ", async () => {

    const dedicatedWords = await mnemonicNew(12);
    const productionWords = await mnemonicNew(24);
    const dedicatedMnemonic = dedicatedWords.join(" ");
    const productionMnemonic = productionWords.join(" ");

    assert.notEqual(dedicatedMnemonic, productionMnemonic);

    const dedicated = await getTestnetDepositDeployer({
        ...TESTNET_ENV,
        TON_TESTNET_DEPOSIT_DEPLOYER_MNEMONIC: dedicatedMnemonic,
        TON_DEPLOYER_MNEMONIC: productionMnemonic
    });

    const snapshot = await inspectTestnetDepositDeployerReadiness({
        ...TESTNET_ENV,
        TON_TESTNET_DEPOSIT_DEPLOYER_MNEMONIC: dedicatedMnemonic,
        TON_DEPLOYER_MNEMONIC: productionMnemonic
    });

    assert.equal(snapshot.dedicatedConfigured, true);
    assert.equal(snapshot.productionConfigured, true);
    assert.equal(snapshot.dedicatedAddress, dedicated.walletAddress);
    assert.notEqual(snapshot.productionAddress, snapshot.dedicatedAddress);
    assert.equal(snapshot.addressesIdentical, false);
    assert.ok(!JSON.stringify(snapshot).includes(dedicatedMnemonic));
    assert.ok(!JSON.stringify(snapshot).includes(productionMnemonic));

});

test("R17.9L.14A Security: TON_DEPLOYER_MNEMONIC present without dedicated credential blocks", () => {

    assert.throws(
        () => assertTestnetDepositDeployerConfig({
            TON_NETWORK: "testnet",
            TON_DEPLOYER_MNEMONIC: PRODUCTION_DUMMY
        }),
        (error) => error.code === TESTNET_DEPOSIT_DEPLOYER_CREDENTIAL_REQUIRED
            && !String(error.message).includes(PRODUCTION_DUMMY)
    );

    const snapshotPromise = inspectTestnetDepositDeployerReadiness({
        TON_NETWORK: "testnet",
        TON_DEPLOYER_MNEMONIC: PRODUCTION_DUMMY
    });

    return snapshotPromise.then((snapshot) => {

        assert.equal(snapshot.dedicatedConfigured, false);
        assert.equal(snapshot.productionConfigured, true);
        assert.equal(snapshot.dedicatedStatus, "NOT CONFIGURED");
        assert.equal(snapshot.liveDeploymentBlocked, true);
        assert.equal(snapshot.blocker, TESTNET_DEPOSIT_DEPLOYER_CREDENTIAL_REQUIRED);

    });

});
