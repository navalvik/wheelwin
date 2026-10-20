import test from "node:test";
import assert from "node:assert/strict";
import { ToncenterTestnetWalletSeqnoProvider } from "../payment/fees/ToncenterTestnetWalletSeqnoProvider.js";
import {
    ToncenterApiKeyMissingError,
    ToncenterRequestError,
    ToncenterResponseError
} from "../payment/toncenter/ToncenterErrors.js";

const identity = { async getNetworkIdentity() { return { networkName: "TESTNET", globalId: -3 }; } };
const response = (payload, status = 200) => ({
    status,
    async json() { return payload; }
});

test("reads seqno from the documented runGetMethod stack without signing or broadcasting", async () => {
    let request;
    const provider = new ToncenterTestnetWalletSeqnoProvider({
        apiKeyProvider: () => "test-key",
        networkIdentityProvider: identity,
        fetchImpl: async (url, init) => {
            request = { url, init };
            return response({ ok: true, result: { exit_code: 0, stack: [["num", "0x2a"]] } });
        }
    });
    const result = await provider.getWalletSeqno({ walletAddress: "0:test-wallet" });
    assert.equal(result.seqno, 42);
    assert.equal(result.networkName, "TESTNET");
    assert.equal(result.globalId, -3);
    assert.equal(result.authorization, "OBSERVATION_ONLY");
    assert.equal(request.url, "https://testnet.toncenter.com/api/v2/runGetMethod");
    assert.equal(request.init.method, "POST");
    assert.equal(request.init.headers["X-API-Key"], "test-key");
    assert.deepEqual(JSON.parse(request.init.body), {
        address: "0:test-wallet",
        method: "seqno",
        stack: []
    });
});

test("accepts a decimal seqno stack value", async () => {
    const provider = new ToncenterTestnetWalletSeqnoProvider({
        apiKeyProvider: () => "test-key",
        networkIdentityProvider: identity,
        fetchImpl: async () => response({ ok: true, result: { exit_code: 0, stack: [["num", "429"]] } })
    });
    assert.equal((await provider.getWalletSeqno({ walletAddress: "wallet" })).seqno, 429);
});

test("fails closed before network access when Testnet identity is not confirmed", async () => {
    let requests = 0;
    const provider = new ToncenterTestnetWalletSeqnoProvider({
        apiKeyProvider: () => "test-key",
        networkIdentityProvider: { async getNetworkIdentity() { return { networkName: "MAINNET", globalId: -239 }; } },
        fetchImpl: async () => { requests += 1; return response({}); }
    });
    await assert.rejects(() => provider.getWalletSeqno({ walletAddress: "wallet" }), ToncenterRequestError);
    assert.equal(requests, 0);
});

test("does not send an unauthenticated request when TON_API_KEY is absent", async () => {
    let requests = 0;
    const provider = new ToncenterTestnetWalletSeqnoProvider({
        apiKeyProvider: () => "",
        networkIdentityProvider: identity,
        fetchImpl: async () => { requests += 1; return response({}); }
    });
    await assert.rejects(() => provider.getWalletSeqno({ walletAddress: "wallet" }), ToncenterApiKeyMissingError);
    assert.equal(requests, 0);
});

test("rejects failed get-method executions and malformed seqno stack values", async () => {
    for (const payload of [
        { ok: false, result: { exit_code: 11, stack: [["num", "1"]] } },
        { ok: true, result: { exit_code: 0, stack: [] } },
        { ok: true, result: { exit_code: 0, stack: [["cell", "abc"]] } },
        { ok: true, result: { exit_code: 0, stack: [["num", "-1"]] } },
        { ok: true, result: { exit_code: 0, stack: [["num", "0x100000000"]] } }
    ]) {
        const provider = new ToncenterTestnetWalletSeqnoProvider({
            apiKeyProvider: () => "test-key",
            networkIdentityProvider: identity,
            fetchImpl: async () => response(payload)
        });
        await assert.rejects(() => provider.getWalletSeqno({ walletAddress: "wallet" }), ToncenterResponseError);
    }
});

test("does not retry rate-limited requests", async () => {
    let requests = 0;
    const provider = new ToncenterTestnetWalletSeqnoProvider({
        apiKeyProvider: () => "test-key",
        networkIdentityProvider: identity,
        fetchImpl: async () => { requests += 1; return response({}, 429); }
    });
    await assert.rejects(() => provider.getWalletSeqno({ walletAddress: "wallet" }));
    assert.equal(requests, 1);
});
