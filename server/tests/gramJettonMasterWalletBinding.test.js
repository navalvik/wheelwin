import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectGramJettonMasterWalletBinding as inspect } from "../payment/toncenter/GramJettonMasterWalletBinding.js";

const jettonMaster = "0:" + "a".repeat(64);
const ownerWallet = "0:" + "b".repeat(64);
const observedJettonWallet = "0:" + "c".repeat(64);
const args = {
    jettonMaster, ownerWallet, observedJettonWallet,
    masterGetter: {
        method: "get_wallet_address", contractAddress: jettonMaster,
        ownerArgument: ownerWallet, walletAddress: observedJettonWallet, exitCode: 0
    },
    walletGetter: {
        method: "get_wallet_data", contractAddress: observedJettonWallet,
        ownerAddress: ownerWallet, jettonMasterAddress: jettonMaster, exitCode: 0
    }
};

test("matching master, owner and derived Jetton wallet yields advisory binding only", () => {
    const match = inspect(args);
    assert.equal(match.getterAddressesConsistent, true);
    assert.equal(match.jettonMaster, jettonMaster);
    assert.equal(match.jettonWallet, observedJettonWallet);
    assert.equal(match.getterChainStateAuthenticated, false);
    assert.equal(match.gramTransferVerified, false);
    assert.equal(match.paymentCreditAuthorized, false);
    assert.equal(match.kind, undefined);
});

test("reject a fake wallet that claims the right GRAM master but is not derived by it", () => {
    assert.equal(inspect({
        ...args, masterGetter: { ...args.masterGetter, walletAddress: "0:" + "d".repeat(64) }
    }), null);
    assert.equal(inspect({
        ...args, walletGetter: { ...args.walletGetter, jettonMasterAddress: "0:" + "d".repeat(64) }
    }), null);
    assert.equal(inspect({
        ...args, walletGetter: { ...args.walletGetter, ownerAddress: "0:" + "d".repeat(64) }
    }), null);
});

test("getter contract, owner argument, method, exit-code and address mismatch reject", () => {
    for (const [which, property, value] of [
        ["masterGetter", "contractAddress", "0:" + "d".repeat(64)],
        ["masterGetter", "ownerArgument", "0:" + "d".repeat(64)],
        ["masterGetter", "method", "get_wallet_data"],
        ["masterGetter", "exitCode", 2],
        ["walletGetter", "contractAddress", "0:" + "d".repeat(64)],
        ["walletGetter", "method", "get_wallet_address"],
        ["walletGetter", "exitCode", 13]
    ]) {
        assert.equal(inspect({
            ...args, [which]: { ...args[which], [property]: value }
        }), null);
    }
    assert.equal(inspect({ ...args, observedJettonWallet: "invalid-address" }), null);
    assert.equal(inspect({ ...args, masterGetter: null }), null);
    assert.equal(inspect({ ...args, walletGetter: null }), null);
});

test("owner, master and Jetton wallet must remain distinct identities", () => {
    assert.equal(inspect({ ...args, ownerWallet: jettonMaster }), null);
    assert.equal(inspect({ ...args, observedJettonWallet: ownerWallet }), null);
    assert.equal(inspect({ ...args, observedJettonWallet: jettonMaster }), null);
});
