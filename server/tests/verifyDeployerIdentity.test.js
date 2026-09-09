import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { mnemonicToPrivateKey } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

import {
    formatVerifyDeployerPublicLines,
    parseVerifyDeployerCliArgs,
    verifyDeployerIdentity
} from "../scripts/lib/verifyDeployerIdentity.js";

const TEST_MNEMONIC = [
    "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
    "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
    "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
    "abandon", "abandon", "abandon", "abandon", "abandon", "about"
].join(" ");

const ZERO_PIN = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const verifierCli = path.join(repoRoot, "server", "scripts", "verify-deployer-identity.mjs");

async function bounceableFromMnemonic(mnemonic) {
    const keyPair = await mnemonicToPrivateKey(mnemonic.split(/\s+/));
    const wallet = WalletContractV4.create({
        workchain: 0,
        publicKey: keyPair.publicKey
    });
    return {
        bounceable: wallet.address.toString({ bounceable: true, urlSafe: true }),
        nonBounceable: wallet.address.toString({ bounceable: false, urlSafe: true }),
        walletId: wallet.walletId,
        workchain: wallet.address.workChain
    };
}

test("CLI rejects mnemonic-like arguments", () => {
    assert.throws(
        () => parseVerifyDeployerCliArgs(["--mnemonic", "x"]),
        /does not accept command-line arguments/
    );
});

test("verifier matches WheelWin V4R2 derivation and bounceable pin", async () => {
    const derived = await bounceableFromMnemonic(TEST_MNEMONIC);
    const result = await verifyDeployerIdentity({
        mnemonic: TEST_MNEMONIC,
        expectedAddress: derived.bounceable,
        oracleAddress: derived.bounceable
    });

    assert.equal(result.ok, true);
    assert.equal(result.walletContractType, "WalletContractV4R2");
    assert.equal(result.workchain, 0);
    assert.equal(result.walletId, 698983191);
    assert.equal(result.address, derived.bounceable);
    assert.equal(result.identityMatch, true);
    assert.equal(result.oracleMatch, true);
});

test("verifier accepts non-bounceable expected address via tonAddressesEqual", async () => {
    const derived = await bounceableFromMnemonic(TEST_MNEMONIC);
    const result = await verifyDeployerIdentity({
        mnemonic: TEST_MNEMONIC,
        expectedAddress: derived.nonBounceable
    });

    assert.equal(result.identityMatch, true);
    assert.equal(result.address, derived.bounceable);
});

test("verifier fails closed on address mismatch and oracle mismatch", async () => {
    const derived = await bounceableFromMnemonic(TEST_MNEMONIC);

    await assert.rejects(
        () => verifyDeployerIdentity({
            mnemonic: TEST_MNEMONIC,
            expectedAddress: ZERO_PIN
        }),
        /identity mismatch/
    );

    await assert.rejects(
        () => verifyDeployerIdentity({
            mnemonic: TEST_MNEMONIC,
            expectedAddress: derived.bounceable,
            oracleAddress: ZERO_PIN
        }),
        /ORACLE_ADDRESS must match/
    );
});

test("stdout never contains mnemonic or key material", async () => {
    const derived = await bounceableFromMnemonic(TEST_MNEMONIC);
    const result = await verifyDeployerIdentity({
        mnemonic: TEST_MNEMONIC,
        expectedAddress: derived.bounceable
    });
    const stdout = formatVerifyDeployerPublicLines(result).join("\n");

    assert.match(stdout, /PASS/);
    assert.doesNotMatch(stdout, /secretKey/i);
    assert.doesNotMatch(stdout, /mnemonic/i);
    assert.equal(stdout.includes(TEST_MNEMONIC), false);
});

test("CLI process verifies from env only and does not require argv", async () => {
    const derived = await bounceableFromMnemonic(TEST_MNEMONIC);
    const result = spawnSync(process.execPath, [verifierCli], {
        encoding: "utf8",
        env: {
            ...process.env,
            TON_DEPLOYER_MNEMONIC: TEST_MNEMONIC,
            TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS: derived.bounceable,
            TON_MAINNET_ORACLE_ADDRESS: derived.nonBounceable
        }
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /walletContractType=WalletContractV4R2/);
    assert.match(result.stdout, /workchain=0/);
    assert.match(result.stdout, /walletId=698983191/);
    assert.match(result.stdout, /identityMatch=true/);
    assert.doesNotMatch(result.stdout + result.stderr, /abandon/);
});

test("CLI process fails without loading a mnemonic from argv", () => {
    const env = { ...process.env };
    delete env.TON_DEPLOYER_MNEMONIC;
    delete env.TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS;

    const result = spawnSync(process.execPath, [
        verifierCli,
        TEST_MNEMONIC
    ], {
        encoding: "utf8",
        env
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not accept command-line arguments/);
});
