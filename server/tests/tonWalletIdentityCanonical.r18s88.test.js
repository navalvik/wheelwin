/**
 * r18-s88 — Canonical TON wallet identity and Residues role labels.
 * No live TON. No secrets in assertions or logs.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Address } from "@ton/core";
import { keyPairFromSeed } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

import {
    WALLET_BALANCE_TYPES,
    WalletBalanceMonitor
} from "../console/wallet/WalletBalanceMonitor.js";
import { PaymentValidationError } from "../gameplay/PaymentSessionManagerErrors.js";
import { PaymentSessionManager } from "../gameplay/PaymentSessionManager.js";
import { PAYMENT_PARTICIPANT_STATUS } from "../models/PaymentSession.js";
import {
    canonicalizeTonWalletAddress,
    describeTonWalletIdentity,
    extractTonWalletAddressInput,
    tonWalletAccountsEqual
} from "../models/TonWalletAddress.js";
import { parseDepositCandidate } from "../payment/BlockchainMonitor.js";
import { RoomWalletRegistry } from "../payment/roomWallet/RoomWalletRegistry.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function v4Address(seedLabel) {
    const seed = createHash("sha256").update(seedLabel).digest();
    const keyPair = keyPairFromSeed(seed);
    return WalletContractV4.create({
        workchain: 0,
        publicKey: keyPair.publicKey
    }).address;
}

function forms(address) {
    return {
        eq: address.toString({ bounceable: true, urlSafe: true }),
        uq: address.toString({ bounceable: false, urlSafe: true }),
        kq: address.toString({ bounceable: true, urlSafe: true, testOnly: true }),
        zq: address.toString({ bounceable: false, urlSafe: true, testOnly: true }),
        eqUnsafe: address.toString({ bounceable: true, urlSafe: false })
    };
}

test("same-account EQ / 0Q / UQ / kQ and URL-safe forms compare equal", () => {
    const variants = forms(v4Address("s88-identity"));

    assert.ok(tonWalletAccountsEqual(variants.eq, variants.zq));
    assert.ok(tonWalletAccountsEqual(variants.eq, variants.uq));
    assert.ok(tonWalletAccountsEqual(variants.eq, variants.kq));
    assert.ok(tonWalletAccountsEqual(variants.eq, variants.eqUnsafe));
    assert.equal(canonicalizeTonWalletAddress(variants.zq), variants.eq);
    assert.equal(canonicalizeTonWalletAddress(variants.uq), variants.eq);
});

test("invalid addresses fail closed", () => {
    const eq = forms(v4Address("s88-valid")).eq;

    assert.equal(canonicalizeTonWalletAddress(""), null);
    assert.equal(canonicalizeTonWalletAddress(null), null);
    assert.equal(canonicalizeTonWalletAddress({ notAddress: true }), null);
    assert.equal(canonicalizeTonWalletAddress({ address: 12 }), null);
    assert.equal(canonicalizeTonWalletAddress("[object Object]"), null);
    assert.equal(tonWalletAccountsEqual(eq, "not-an-address"), false);
    assert.equal(tonWalletAccountsEqual("not-an-address", "not-an-address"), false);
    assert.equal(extractTonWalletAddressInput({ toString: () => eq }), null);
});

test("address-object unwrap is strict; invalid objects are not String(object)", () => {
    const eq = forms(v4Address("s88-object")).eq;
    const parsed = parseDepositCandidate({
        in_msg: {
            source: { address: eq },
            destination: { address: eq },
            value: "1000000000"
        },
        transaction_id: { hash: "hash-object" }
    });

    assert.equal(parsed.sender, eq);
    assert.equal(parsed.destination, eq);

    const rejected = parseDepositCandidate({
        in_msg: {
            source: { value: eq },
            destination: { toString: () => eq },
            value: "1000000000"
        },
        transaction_id: { hash: "hash-bad-object" }
    });

    assert.equal(rejected.sender, null);
    assert.equal(rejected.destination, null);
    assert.notEqual(rejected.sender, String({ value: eq }));
});

test("RoomWalletRegistry.getByAddress matches friendly-format variants", () => {
    const address = v4Address("s88-registry");
    const variants = forms(address);
    const registry = new RoomWalletRegistry({
        entries: [{ roomNumber: 3, address: variants.eq, network: "mainnet" }]
    });

    assert.equal(registry.getByAddress(variants.zq).roomNumber, 3);
    assert.equal(registry.getByAddress(variants.uq).roomNumber, 3);
    assert.equal(registry.getByAddress({ address: variants.kq }).roomNumber, 3);
    assert.equal(registry.getByAddress("not-an-address"), null);
    assert.equal(registry.getByAddress(forms(v4Address("s88-other")).eq), null);
});

test("PaymentSessionManager accepts same-account friendly variants and rejects invalid/other accounts", () => {
    const dest = v4Address("s88-room");
    const sender = v4Address("s88-player");
    const destForms = forms(dest);
    const senderForms = forms(sender);
    const other = forms(v4Address("s88-other-account"));

    const manager = new PaymentSessionManager({
        logger: { info() {}, warn() {}, error() {}, debug() {}, decisionTrace() {} },
        eventBus: { subscribe() {}, emit() {} },
        playerManager: {},
        roomManager: {},
        roomWalletPaymentIntakeEnabled: true
    });

    const participant = {
        playerId: "p1",
        wallet: senderForms.eq,
        status: PAYMENT_PARTICIPANT_STATUS.BLOCKCHAIN_PENDING,
        requiredGram: 1,
        contractAddress: destForms.eq
    };

    const session = {
        paymentSessionId: "pay_s88",
        roomId: "room-s88",
        contractId: null,
        network: "mainnet",
        paymentDeadline: Date.now() + 60_000,
        roomWalletAddress: destForms.eq,
        findParticipant(playerId) {
            return playerId === "p1" ? participant : null;
        }
    };

    assert.doesNotThrow(() => {
        manager._validateIncomingPayment(session, {
            playerId: "p1",
            address: destForms.zq,
            sender: senderForms.uq,
            amount: 1,
            network: "mainnet"
        });
    });

    assert.throws(
        () => manager._validateIncomingPayment(session, {
            playerId: "p1",
            address: destForms.eq,
            sender: senderForms.eq,
            amount: 2
        }),
        (error) => error instanceof PaymentValidationError
            && error.message.includes("Payment amount mismatch")
    );

    assert.throws(
        () => manager._validateIncomingPayment(session, {
            playerId: "p1",
            address: other.eq,
            sender: senderForms.eq,
            amount: 1
        }),
        (error) => error instanceof PaymentValidationError
            && error.message.includes("wrong contract")
    );

    assert.throws(
        () => manager._validateIncomingPayment(session, {
            playerId: "p1",
            address: destForms.eq,
            sender: other.zq,
            amount: 1
        }),
        (error) => error instanceof PaymentValidationError
            && error.message.includes("wrong wallet")
    );

    assert.throws(
        () => manager._validateIncomingPayment(session, {
            playerId: "p1",
            address: "not-a-ton-address",
            sender: senderForms.eq,
            amount: 1
        }),
        (error) => error instanceof PaymentValidationError
            && error.message.includes("wrong contract")
    );
});

test("WalletBalanceMonitor uses RESIDUES WALLET identity fields without reimbursement role or secrets", async () => {
    const dest = forms(v4Address("s88-residues"));
    const identity = describeTonWalletIdentity(dest.zq, "mainnet");

    assert.equal(identity.address, dest.eq);
    assert.equal(identity.network, "mainnet");
    assert.match(identity.accountId, /^0:[0-9a-f]{64}$/);

    const monitor = new WalletBalanceMonitor({
        tonService: {
            async getBalance() {
                return 1_000_000_000n;
            }
        },
        runtimeConfig: {
            ton: {
                network: "mainnet",
                deployerExpectedAddress: forms(v4Address("s88-deploy")).eq
            }
        },
        env: {
            OWNER_WALLET: forms(v4Address("s88-owner")).eq,
            TON_REIMBURSEMENT_EXPECTED_ADDRESS: dest.zq
        },
        setIntervalFn: () => 1,
        clearIntervalFn: () => {}
    });

    await monitor.initialize();
    const snapshot = await monitor.refresh();
    const payload = JSON.stringify(snapshot);

    assert.deepEqual(
        snapshot.wallets.map((w) => w.walletType),
        [
            WALLET_BALANCE_TYPES.OWNER_WALLET,
            WALLET_BALANCE_TYPES.DEPLOYMENT_WALLET,
            WALLET_BALANCE_TYPES.RESIDUES_WALLET
        ]
    );
    assert.equal(snapshot.wallets[2].address, dest.eq);
    assert.equal(snapshot.wallets[2].network, "mainnet");
    assert.equal(snapshot.wallets[2].accountId, identity.accountId);
    assert.equal(payload.includes("REIMBURSEMENT_WALLET"), false);
    assert.equal(payload.includes("mnemonic"), false);
    assert.equal(payload.includes("private"), false);
    assert.equal(payload.includes("secret"), false);
    assert.equal(payload.includes("seed"), false);

    monitor.shutdown();
});

test("operator console source uses RESIDUES WALLET, not active Reimbursement Wallet label", () => {
    const panel = readFileSync(
        join(HERE, "../../client/src/console/panels/WalletMonitoringPanel.jsx"),
        "utf8"
    );
    const monitor = readFileSync(
        join(HERE, "../console/wallet/WalletBalanceMonitor.js"),
        "utf8"
    );

    assert.match(panel, /RESIDUES WALLET/);
    assert.match(panel, /DEPLOYMENT WALLET/);
    assert.match(panel, /OWNER WALLET/);
    assert.doesNotMatch(panel, /Reimbursement Wallet/);
    assert.doesNotMatch(panel, /"Deploy Wallet"/);
    assert.match(monitor, /RESIDUES_WALLET: "RESIDUES_WALLET"/);
    assert.doesNotMatch(monitor, /REIMBURSEMENT_WALLET: "REIMBURSEMENT_WALLET"/);
});
