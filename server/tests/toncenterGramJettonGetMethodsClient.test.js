import assert from "node:assert/strict";
import { test } from "node:test";
import { ToncenterGramJettonGetMethodsClient } from "../payment/toncenter/ToncenterGramJettonGetMethodsClient.js";
import { decodeGramMasterWalletAddressStack } from "../payment/toncenter/GramJettonGetterStackDecoder.js";
const master = "0:" + "a".repeat(64);
const owner = "0:" + "b".repeat(64);
const wallet = "0:" + "c".repeat(64);
const successful = { exit_code: 0, stack: [{ type: "cell", value: "te6ccgEBAQEAJAAAQ4AVoN3BhVDLKet4AYoVxOHz8WkaFncQfg/M79YWJEV4pxDg5fQi" }] };

test("Testnet get_wallet_address uses authenticated POST and encoded owner slice", async () => {
    const calls = [];
    const client = new ToncenterGramJettonGetMethodsClient({
        apiKeyProvider: () => "mock-testnet-key",
        fetchImpl: async (url, init) => {
            calls.push({ url, init });
            return { status: 200, json: async () => successful };
        }
    });
    const result = await client.getWalletAddress({ jettonMaster: master, ownerWallet: owner });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://testnet.toncenter.com/api/v3/runGetMethod");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers["X-API-Key"], "mock-testnet-key");
    const payload = JSON.parse(calls[0].init.body);
    assert.deepEqual(Object.keys(payload), ["address", "method", "stack"]);
    assert.equal(payload.address, master);
    assert.equal(payload.method, "get_wallet_address");
    assert.equal(payload.stack.length, 1);
    assert.equal(payload.stack[0].type, "slice");
    const boc = Buffer.from(payload.stack[0].value, "base64");
    assert.equal(boc.subarray(0, 4).toString("hex"), "b5ee9c72");
    assert.equal(boc[11], 0);
    assert.equal(boc[12], 0x43); // 267 bits => floor 33 + ceil 34
    assert.equal(boc.subarray(13).length, 34);
    assert.equal(boc[13] & 0xe0, 0x80); // addr_std$10, anycast absent$0
    const decodedArgument = decodeGramMasterWalletAddressStack({
        method: "get_wallet_address", exitCode: 0,
        resultStack: [payload.stack[0]]
    });
    assert.equal(decodedArgument.walletAddress, owner);
    assert.equal(result.exitCode, 0);
    assert.equal(result.getterChainStateAuthenticated, false);
    assert.equal(result.paymentCreditAuthorized, false);
});
test("get_wallet_data requests the wallet account with empty TVM arguments", async () => {
    let request;
    const client = new ToncenterGramJettonGetMethodsClient({
        apiKeyProvider: () => "mock",
        fetchImpl: async (url, init) => {
            request = JSON.parse(init.body);
            return { status: 200, json: async () => successful };
        }
    });
    const result = await client.getWalletData({ jettonWallet: wallet });
    assert.equal(request.method, "get_wallet_data");
    assert.equal(request.address, wallet);
    assert.deepEqual(request.stack, []);
    assert.equal(result.indexedStateOnly, true);
    assert.equal(result.paymentCreditAuthorized, false);
});
test("invalid request and missing secret fail before HTTP", async () => {
    let count = 0;
    const client = new ToncenterGramJettonGetMethodsClient({
        apiKeyProvider: () => "",
        fetchImpl: async () => { count++; throw Error("unexpected"); }
    });
    await assert.rejects(client.getWalletData({ jettonWallet: wallet }), /TON_API_KEY/);
    await assert.rejects(client.getWalletAddress({ jettonMaster: master, ownerWallet: "invalid" }), /Invalid owner/);
    await assert.rejects(client.getWalletAddress({ jettonMaster: "invalid", ownerWallet: owner }), /Invalid GRAM/);
    assert.equal(count, 0);
});
test("HTTP errors, failed TVM execution and malformed stack fail closed", async () => {
    for (const [status, payload] of [
        [429, successful], [200, { exit_code: 13, stack: successful.stack }],
        [200, { exit_code: 0, stack: "bad" }],
        [200, { exit_code: 0, stack: [{ type: "cell", value: 123 }] }],
        [200, { exit_code: 0, stack: Array.from({ length: 17 }, () => ({ type: "num", value: "0" })) }]
    ]) {
        const client = new ToncenterGramJettonGetMethodsClient({
            apiKeyProvider: () => "key",
            fetchImpl: async () => ({ status, json: async () => payload })
        });
        await assert.rejects(client.getWalletData({ jettonWallet: wallet }),
            /HTTP|invalid|unsuccessful/);
    }
});
