import assert from "node:assert/strict";
import { test } from "node:test";
import {
    decodeGramMasterWalletAddressStack as decodeMaster,
    decodeGramWalletDataStack as decodeWallet
} from "../payment/toncenter/GramJettonGetterStackDecoder.js";
import { inspectTestnetGramJettonWallet } from "../payment/toncenter/GramJettonGetterBindingInspection.js";
import { ToncenterGramJettonGetMethodsClient } from "../payment/toncenter/ToncenterGramJettonGetMethodsClient.js";

const master = "0:" + "a".repeat(64);
const owner = "0:" + "b".repeat(64);
const wallet = "0:" + "c".repeat(64);
const foreignWallet = "0:" + "d".repeat(64);

function bitsToBoc(bits) {
    const data = Buffer.alloc(Math.ceil(bits.length / 8));
    bits.forEach((b, i) => { if (b) data[i >> 3] |= 1 << (7 - (i % 8)); });
    if (bits.length % 8) data[data.length - 1] |= 1 << (7 - (bits.length % 8));
    const desc = Math.floor(bits.length / 8) + Math.ceil(bits.length / 8);
    return Buffer.from([
        0xb5, 0xee, 0x9c, 0x72, 1, 1, 1, 1, 0, data.length + 2, 0,
        0, desc, ...data
    ]).toString("base64");
}
function addressBoc(address) {
    const [wc, h] = address.split(":");
    const bits = [];
    function uint(n, width) {
        const v = BigInt(n);
        for (let i = width - 1; i >= 0; i--)
            bits.push(Number((v >> BigInt(i)) & 1n));
    }
    uint(2, 2); uint(0, 1);
    uint(Number(wc) & 255, 8);
    for (const byte of Buffer.from(h, "hex")) uint(byte, 8);
    return bitsToBoc(bits);
}
const stackEntry = a => ({ type: "slice", value: addressBoc(a) });
const codeEntry = { type: "cell", value: bitsToBoc([1, 0, 1, 0, 1, 1]) };
const masterResult = a => ({
    method: "get_wallet_address", exitCode: 0, resultStack: [stackEntry(a)]
});
const walletResult = (o = owner, m = master) => ({
    method: "get_wallet_data", exitCode: 0,
    resultStack: [{ type: "num", value: "0x2a" }, stackEntry(o), stackEntry(m), codeEntry]
});
function client(derived = wallet, returnedOwner = owner, returnedMaster = master) {
    const calls = [];
    const c = new ToncenterGramJettonGetMethodsClient({
        apiKeyProvider: () => "test-key",
        fetchImpl: async (url, req) => {
            const body = JSON.parse(req.body);
            calls.push(body);
            const result = body.method === "get_wallet_address" ?
                { exit_code: 0, stack: masterResult(derived).resultStack } :
                { exit_code: 0, stack: walletResult(returnedOwner, returnedMaster).resultStack };
            return { status: 200, json: async () => result };
        }
    });
    return { c, calls };
}

test("decode canonical get_wallet_address slice without inferring payment confirmation", () => {
    const d = decodeMaster(masterResult(wallet));
    assert.equal(d.walletAddress, wallet);
    assert.equal(d.getterChainStateAuthenticated, false);
    assert.equal(d.paymentCreditAuthorized, false);
});

test("decode four-item get_wallet_data stack, owner/master and exact balance", () => {
    const d = decodeWallet(walletResult());
    assert.equal(d.balanceAtomic, "42");
    assert.equal(d.ownerAddress, owner);
    assert.equal(d.jettonMasterAddress, master);
    assert.equal(d.paymentCreditAuthorized, false);
});

test("reject truncated, malformed, swapped and dangerous TVM stack elements", () => {
    const wrong = [
        { ...masterResult(wallet), resultStack: [] },
        { ...masterResult(wallet), resultStack: [{ type: "cell", value: addressBoc(wallet) }] },
        { ...masterResult(wallet), resultStack: [{ type: "slice", value: "malformed" }] },
        { ...masterResult(wallet), resultStack: [stackEntry(wallet), stackEntry(wallet)] },
        { ...masterResult(wallet), exitCode: 13 }
    ];
    for (const item of wrong) assert.throws(() => decodeMaster(item), /Invalid GRAM getter/);
    const mutations = [
        { ...walletResult(), resultStack: walletResult().resultStack.slice(0, 3) },
        { ...walletResult(), resultStack: [
            { type: "num", value: "-1" }, stackEntry(owner), stackEntry(master), codeEntry
        ] },
        { ...walletResult(), resultStack: [
            { type: "num", value: "123.45" }, stackEntry(owner), stackEntry(master), codeEntry
        ] },
        { ...walletResult(), resultStack: [
            { type: "num", value: "42" }, stackEntry(master), { type: "cell", value: addressBoc(master) }, codeEntry
        ] },
        { ...walletResult(), resultStack: [
            { type: "num", value: "42" }, stackEntry(owner), stackEntry(master),
            { type: "cell", value: "not-base64" }
        ] }
    ];
    for (const item of mutations) assert.throws(() => decodeWallet(item), /Invalid GRAM getter/);
});

test("matched Testnet getter observations stay advisory and require two requests", async () => {
    const { c, calls } = client();
    const r = await inspectTestnetGramJettonWallet({
        client: c, jettonMaster: master, ownerWallet: owner, observedJettonWallet: wallet
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(x => x.method), ["get_wallet_address", "get_wallet_data"]);
    assert.equal(r.getterAddressesConsistent, true);
    assert.equal(r.getterChainStateAuthenticated, false);
    assert.equal(r.paymentCreditAuthorized, false);
});

test("wrong master-derived wallet rejects BEFORE wallet getter request", async () => {
    const { c, calls } = client(foreignWallet);
    const r = await inspectTestnetGramJettonWallet({
        client: c, jettonMaster: master, ownerWallet: owner, observedJettonWallet: wallet
    });
    assert.equal(r, null);
    assert.equal(calls.length, 1);
});

test("wrong wallet owner or master rejects despite valid matching master getter", async () => {
    for (const [o, m] of [[foreignWallet, master], [owner, foreignWallet]]) {
        const { c } = client(wallet, o, m);
        assert.equal(await inspectTestnetGramJettonWallet({
            client: c, jettonMaster: master, ownerWallet: owner,
            observedJettonWallet: wallet
        }), null);
    }
});
