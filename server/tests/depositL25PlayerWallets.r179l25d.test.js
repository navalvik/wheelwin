/**
 * R17.9L.25.D — TEST-ONLY W5R1 player wallet loader unit tests (no live TON, no secrets).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Address } from "@ton/core";
import { mnemonicNew, mnemonicToPrivateKey } from "@ton/crypto";
import { WalletContractV4, WalletContractV5R1 } from "@ton/ton";

import {
    createL25PlayerWalletContract,
    deriveL25PlayerKeyPair,
    L25_KEY_DERIVATION_METHODS,
    L25_PLAYER_WALLET_CONTRACT_TYPES,
    resolveL25KeyDerivationMethod
} from "./testnet/r179l25/l25PlayerWalletDerivation.js";
import {
    assertExpectedPlayerAddresses,
    derivePlayerWallet,
    resolveRawAddressIdentity
} from "./testnet/r179l25/l25PlayerWallets.js";
import {
    printL25PlayerWalletReadinessReport,
    runL25PlayerWalletReadiness
} from "./testnet/r179l25/l25PlayerWalletReadiness.js";
import {
    TESTNET_DEPOSIT_DEPLOYER_NETWORK_GLOBAL_ID,
    TESTNET_DEPOSIT_DEPLOYER_SUBWALLET_NUMBER,
    TESTNET_DEPOSIT_DEPLOYER_WORKCHAIN
} from "../payment/ton/deriveTestnetDepositDeployerWalletIdentity.js";
import { L25_ERROR_CODES, L25TestError } from "./testnet/r179l25/l25Errors.js";

const here = dirname(fileURLToPath(import.meta.url));

test("R17.9L.25D TestA: default player wallet construction uses WalletContractV5R1", async () => {

    const words = await mnemonicNew(24);
    const wallet = await derivePlayerWallet(0, words, {
        L25_PLAYER_WALLET_CONTRACT: "W5R1"
    });

    assert.equal(wallet.walletContractType, "WalletContractV5R1");
    assert.match(wallet.wallet.constructor.name, /WalletContractV5R1/);
    assert.equal(wallet.keyDerivationMethod, L25_KEY_DERIVATION_METHODS.TON_NATIVE);

});

test("R17.9L.25D TestB: V4R2 address differs from W5R1 for same TON-native key", async () => {

    const words = await mnemonicNew(24);
    const { keyPair } = await deriveL25PlayerKeyPair(words, {
        L25_PLAYER_KEY_DERIVATION: "ton_native"
    });

    const v4 = WalletContractV4.create({
        workchain: TESTNET_DEPOSIT_DEPLOYER_WORKCHAIN,
        publicKey: keyPair.publicKey
    });
    const w5 = createL25PlayerWalletContract(keyPair.publicKey, {
        L25_PLAYER_WALLET_CONTRACT: "W5R1"
    });

    assert.notEqual(
        resolveRawAddressIdentity(
            v4.address.toString({ bounceable: true, urlSafe: true, testOnly: true })
        ),
        resolveRawAddressIdentity(
            w5.wallet.address.toString({ bounceable: true, urlSafe: true, testOnly: true })
        )
    );

});

test("R17.9L.25D TestC: 24-word auto selects ton_native; 12-word auto selects multichain", async () => {

    const words24 = await mnemonicNew(24);
    const words12 = await mnemonicNew(12);

    assert.equal(
        resolveL25KeyDerivationMethod(words24, {}),
        L25_KEY_DERIVATION_METHODS.TON_NATIVE
    );
    assert.equal(
        resolveL25KeyDerivationMethod(words12, {}),
        L25_KEY_DERIVATION_METHODS.MULTICHAIN
    );

    const derived24 = await deriveL25PlayerKeyPair(words24, {
        L25_PLAYER_KEY_DERIVATION: "auto"
    });
    const derived12 = await deriveL25PlayerKeyPair(words12, {
        L25_PLAYER_KEY_DERIVATION: "auto"
    });

    assert.equal(derived24.keyDerivationMethod, L25_KEY_DERIVATION_METHODS.TON_NATIVE);
    assert.equal(derived12.keyDerivationMethod, L25_KEY_DERIVATION_METHODS.MULTICHAIN);

    const w5 = WalletContractV5R1.create({
        publicKey: derived24.keyPair.publicKey,
        walletId: {
            networkGlobalId: TESTNET_DEPOSIT_DEPLOYER_NETWORK_GLOBAL_ID,
            context: {
                workchain: TESTNET_DEPOSIT_DEPLOYER_WORKCHAIN,
                walletVersion: "v5r1",
                subwalletNumber: TESTNET_DEPOSIT_DEPLOYER_SUBWALLET_NUMBER
            }
        }
    });

    const created = createL25PlayerWalletContract(derived24.keyPair.publicKey, {
        L25_PLAYER_WALLET_CONTRACT: "W5R1"
    });

    assert.equal(
        created.wallet.address.toRawString(),
        w5.address.toRawString()
    );

});

test("R17.9L.25D TestD: EQ / UQ / kQ normalize to same raw account identity", () => {

    const parsed = Address.parseFriendly(
        "EQC9qwKAy72kX1oPtryX-g5y44B2mYZEB2HVdJAeJprla_Le"
    );
    const eq = parsed.address.toString({ bounceable: true, urlSafe: true, testOnly: false });
    const uq = parsed.address.toString({ bounceable: false, urlSafe: true, testOnly: false });
    const kq = parsed.address.toString({ bounceable: true, urlSafe: true, testOnly: true });

    const raw = "0:bdab0280cbbda45f5a0fb6bc97fa0e72e380769986440761d574901e269ae56b";

    assert.equal(resolveRawAddressIdentity(eq), raw);
    assert.equal(resolveRawAddressIdentity(uq), raw);
    assert.equal(resolveRawAddressIdentity(kq), raw);

});

test("R17.9L.25D TestE: expected address mismatch fails closed", async () => {

    const words = await mnemonicNew(24);
    const wallet = await derivePlayerWallet(0, words, {
        L25_PLAYER_WALLET_CONTRACT: "W5R1"
    });

    assert.throws(
        () => assertExpectedPlayerAddresses([wallet], {
            L25_PLAYER_0_ADDRESS: "EQABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAc3j"
        }),
        (error) => error instanceof L25TestError
            && error.code === L25_ERROR_CODES.ADDRESS_MISMATCH
    );

});

test("R17.9L.25D TestF: reserved addresses remain rejected via loader validation", async () => {

    const { assertValidL25PlayerAddresses } = await import("./testnet/r179l25/l25PlayerWallets.js");
    const { PRODUCTION_DEPLOY_WALLET } = await import("../payment/ton/depositTestnetFixture.js");

    assert.throws(
        () => assertValidL25PlayerAddresses([
            PRODUCTION_DEPLOY_WALLET,
            "EQACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAsoi",
            "EQADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA8id"
        ]),
        (error) => error.code === L25_ERROR_CODES.WALLET_RESERVED
    );

});

test("R17.9L.25D TestG: three synthetic wallets are distinct", async () => {

    const wallets = [];

    for (let seatIndex = 0; seatIndex < 3; seatIndex += 1) {

        wallets.push(await derivePlayerWallet(
            seatIndex,
            await mnemonicNew(24),
            { L25_PLAYER_WALLET_CONTRACT: "W5R1" }
        ));

    }

    const rawIds = new Set(wallets.map((wallet) => wallet.rawAddressIdentity));

    assert.equal(rawIds.size, 3);

});

test("R17.9L.25D TestH: readiness module source has no transaction broadcast", () => {

    const readinessSrc = readFileSync(
        join(here, "testnet/r179l25/l25PlayerWalletReadiness.js"),
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

    assert.doesNotMatch(readinessSrc, /broadcastTransaction\s*\(/);
    assert.doesNotMatch(readinessSrc, /\.createTransfer\s*\(/);
    assert.match(readinessSrc, /transactionsSent:\s*0/);
    assert.match(walletsSrc, /l25PlayerWalletDerivation\.js/);
    assert.match(derivationSrc, /createTestnetDepositDeployerV5Wallet/);
    assert.doesNotMatch(
        walletsSrc,
        /WalletContractV4\.create\s*\(/
    );

});

test("R17.9L.25D TestH2: V4R2 requires explicit configuration", async () => {

    const words = await mnemonicNew(24);
    const wallet = await derivePlayerWallet(0, words, {
        L25_PLAYER_WALLET_CONTRACT: "V4R2"
    });

    assert.equal(wallet.walletContractType, L25_PLAYER_WALLET_CONTRACT_TYPES.V4R2);

});

test("R17.9L.25D TestH3: readiness report printer rejects secret-like fields", () => {

    assert.throws(
        () => printL25PlayerWalletReadinessReport({
            verdict: "BLOCKED",
            players: [{
                seatIndex: 0,
                label: "player0",
                walletContractType: "WalletContractV5R1",
                keyDerivationMethod: "ton_native",
                address: "EQtest",
                expectedAddress: "EQtest",
                rawIdentity: "0:00",
                addressMatch: true,
                state: "ACTIVE",
                balanceNano: "1",
                balanceTon: "0.000000001",
                reserved: false,
                ready: true,
                secretKey: "hidden"
            }],
            transactionsSent: 0,
            snapshot: []
        }),
        (error) => error instanceof L25TestError
    );

});

test("R17.9L.25D TestI: readiness blocked when env incomplete", async () => {

    await assert.rejects(
        () => runL25PlayerWalletReadiness({ env: { TON_NETWORK: "testnet" } }),
        (error) => error.code === L25_ERROR_CODES.READINESS_BLOCKED
    );

});
