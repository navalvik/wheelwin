import assert from "node:assert/strict";
import { test } from "node:test";
import { runGramTestnetGetterSmoke } from "../payment/diagnostics/GramTestnetGetterSmoke.js";
import { ToncenterGramJettonGetMethodsClient } from "../payment/toncenter/ToncenterGramJettonGetMethodsClient.js";

const master = "0:" + "a".repeat(64);
const owner = "0:" + "b".repeat(64);
const wallet = "0:" + "c".repeat(64);
const env = {
    GRAM_JETTON_MASTER_TESTNET: master,
    GRAM_TESTNET_DIAGNOSTIC_OWNER: owner,
    TON_API_KEY: "mock-key"
};
function addressBoc(a) {
    const [wc, hex] = a.split(":");
    const bits = [1, 0, 0];
    const append = (value, length) => {
        const n = BigInt(value);
        for (let i = length - 1; i >= 0; i--) bits.push(Number((n >> BigInt(i)) & 1n));
    };
    append(Number(wc) & 255, 8);
    for (const b of Buffer.from(hex, "hex")) append(b, 8);
    const bytes = Buffer.alloc(34);
    bits.forEach((b, i) => { if (b) bytes[i >> 3] |= 1 << (7 - (i & 7)); });
    bytes[33] |= 1 << 4;
    return Buffer.concat([Buffer.from([
        0xb5, 0xee, 0x9c, 0x72, 1, 1, 1, 1, 0, 36, 0, 0, 67
    ]), bytes]).toString("base64");
}
const slice = x => ({ type: "slice", value: addressBoc(x) });
const walletCode = { type: "cell", value: Buffer.from([
    0xb5, 0xee, 0x9c, 0x72, 1, 1, 1, 1, 0, 3, 0, 0, 2, 0x7a
]).toString("base64") };

function makeClient({ derived = wallet, walletOwner = owner,
    walletMaster = master, failMethod = null } = {}) {
    const calls = [];
    const client = new ToncenterGramJettonGetMethodsClient({
        apiKeyProvider: () => env.TON_API_KEY,
        fetchImpl: async (_url, args) => {
            const data = JSON.parse(args.body);
            calls.push(data.method);
            if (data.method === failMethod)
                return { status: 429 };
            return { status: 200, json: async () => ({
                exit_code: 0,
                stack: data.method === "get_wallet_address"
                    ? [slice(derived)]
                    : [
                        { type: "num", value: "1" },
                        slice(walletOwner), slice(walletMaster), walletCode
                    ]
            }) };
        }
    });
    return { client, calls };
}
test("read-only GRAM Testnet getter diagnostic returns non-authoritative result", async () => {
    const { client, calls } = makeClient();
    const output = [];
    const result = await runGramTestnetGetterSmoke({
        env, client, report: message => output.push(message)
    });
    assert.deepEqual(calls, ["get_wallet_address", "get_wallet_data"]);
    assert.equal(result.getterAddressesConsistent, true);
    assert.equal(result.providerStateIndependentlyAuthenticated, false);
    assert.equal(result.paymentCreditAuthorized, false);
    assert.equal(output.length, 1);
    assert.equal(output[0].includes(env.TON_API_KEY), false);
});

test("diagnostic refuses absent master, bad owner and absent key before network", async () => {
    const { client, calls } = makeClient();
    for (const modified of [
        { ...env, GRAM_JETTON_MASTER_TESTNET: "" },
        { ...env, GRAM_TESTNET_DIAGNOSTIC_OWNER: "bad" },
        { ...env, TON_API_KEY: "" }
    ]) {
        await assert.rejects(runGramTestnetGetterSmoke({ env: modified, client }));
    }
    assert.deepEqual(calls, []);
});
test("mismatched contract owner and provider errors fail closed", async () => {
    for (const options of [
        { walletOwner: wallet },
        { walletMaster: wallet },
        { failMethod: "get_wallet_data" }
    ]) {
        const { client } = makeClient(options);
        await assert.rejects(runGramTestnetGetterSmoke({ env, client }));
    }
});
