import test from "node:test";
import assert from "node:assert/strict";
import { beginCell } from "@ton/core";
import { TestnetToncenterTransport } from "../payment/roomWallet/TestnetToncenterTransport.js";

const address = "0:" + "a".repeat(64);
const offlineFetch = async () => { throw new Error("network must not be used"); };

test("transport rejects Mainnet and never broadcasts by default", async () => {
    assert.throws(() => new TestnetToncenterTransport({
        network: "mainnet", client: {}, fetchImpl: offlineFetch
    }), /Testnet only/);
    let calls = 0;
    const transport = new TestnetToncenterTransport({
        client: { sendFile: async () => { calls++; } },
        fetchImpl: offlineFetch
    });
    await assert.rejects(transport.broadcastTransaction("abc"), /disabled/);
    assert.equal(calls, 0);
});

test("balance and seqno are read from chain without treating RPC errors as seqno zero", async () => {
    const client = {
        getBalance: async () => 3_000_000_000n,
        getContractState: async () => ({ state: "uninitialized" }),
        runMethod: async () => { throw new Error("uninitialized wallet must not call get-method"); }
    };
    const transport = new TestnetToncenterTransport({ client, fetchImpl: offlineFetch });
    assert.equal(await transport.getBalance(address), 3_000_000_000n);
    assert.equal(await transport.getSeqno(address), 0);
    client.getContractState = async () => ({ state: "active" });
    client.runMethod = async () => ({ stack: { readNumber: () => 4 } });
    assert.equal(await transport.getSeqno(address), 4);
    client.runMethod = async () => { throw new Error("Toncenter timeout"); };
    await assert.rejects(transport.getSeqno(address), /Toncenter timeout/);
    client.getContractState = async () => ({ state: "frozen" });
    await assert.rejects(transport.getSeqno(address), /not active/);
});

test("fee estimate returns precise bigint components and rejects missing evidence", async () => {
    const client = {
        estimateExternalMessageFee: async () => ({
            source_fees: { in_fwd_fee: 2, storage_fee: 3, gas_fee: 5, fwd_fee: 7 }
        })
    };
    const transport = new TestnetToncenterTransport({ client, fetchImpl: offlineFetch });
    const fee = await transport.estimateExternalMessageFee(address, {
        body: beginCell().endCell(), ignoreSignature: true
    });
    assert.deepEqual(fee, {
        inFwdFeeNano: 2n, storageFeeNano: 3n,
        gasFeeNano: 5n, fwdFeeNano: 7n, totalFeeNano: 17n
    });
    client.estimateExternalMessageFee = async () => ({ source_fees: { in_fwd_fee: 1 } });
    await assert.rejects(transport.estimateExternalMessageFee(address, {
        body: beginCell().endCell()
    }), /invalid Testnet fee component/);
});

test("history preserves Toncenter v2 payout evidence and fails closed on RPC errors", async () => {
    let url;
    const fetchImpl = async (target, options) => {
        url = target;
        assert.equal(options.headers["X-API-Key"], "test-key");
        return { ok: true, json: async () => ({
            ok: true, result: [{
                transaction_id: { hash: "hash", lt: "42" },
                out_msgs: [{ destination: address, value: "100" }]
            }]
        }) };
    };
    const transport = new TestnetToncenterTransport({
        client: {}, fetchImpl, apiKey: "test-key"
    });
    const history = await transport.getTransactions(address, { limit: 40, archival: true });
    assert.equal(history[0].transaction_id.lt, "42");
    assert.equal(history[0].out_msgs[0].value, "100");
    assert.ok(url.startsWith("https://testnet.toncenter.com/api/v2/getTransactions?"));
    await assert.rejects(transport.getTransactions(address, { limit: 101 }), /limit/);
    const broken = new TestnetToncenterTransport({
        client: {}, fetchImpl: async () => ({ ok: true, json: async () => ({ ok: false }) })
    });
    await assert.rejects(broken.getTransactions(address), /invalid/);
});

test("explicit Testnet broadcast returns only submission acknowledgement, never finality", async () => {
    let sends = 0;
    const transport = new TestnetToncenterTransport({
        client: { sendFile: async bytes => { sends++; assert.ok(bytes.length > 0); } },
        fetchImpl: offlineFetch, enableBroadcast: true
    });
    const boc = beginCell().storeUint(7, 8).endCell().toBoc().toString("base64");
    const result = await transport.broadcastTransaction(boc);
    assert.deepEqual(result, { status: "BROADCAST_ACCEPTED_NO_TX_HASH" });
    assert.equal(sends, 1);
    await assert.rejects(transport.broadcastTransaction("not-a-boc"), /invalid/);
    assert.equal(sends, 1);
});
