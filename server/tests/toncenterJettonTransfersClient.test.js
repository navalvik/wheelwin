import assert from "node:assert/strict";
import { test } from "node:test";
import {
    ToncenterJettonTransfersClient
} from "../payment/toncenter/ToncenterJettonTransfersClient.js";

const room = "0:" + "1".repeat(64);
const master = "0:" + "2".repeat(64);
const query = {
    roomWallet: room,
    jettonMaster: master,
    startUtime: 1700000000,
    endUtime: 1700000400
};

test("one authenticated Testnet indexer request returns UNVERIFIED candidates", async () => {
    const requests = [];
    const client = new ToncenterJettonTransfersClient({
        apiKeyProvider: () => "test-key",
        fetchImpl: async (url, init) => {
            requests.push({ url: new URL(url), init });
            return {
                status: 200,
                json: async () => ({ jetton_transfers: [{
                    source: "0:" + "3".repeat(64),
                    destination: room,
                    jetton_master: master,
                    amount: "1500000000",
                    transaction_aborted: false
                }] })
            };
        }
    });
    const result = await client.listIncoming(query);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url.hostname, "testnet.toncenter.com");
    assert.equal(requests[0].url.pathname, "/api/v3/jetton/transfers");
    assert.equal(requests[0].url.searchParams.get("owner_address"), room);
    assert.equal(requests[0].url.searchParams.get("jetton_master"), master);
    assert.equal(requests[0].url.searchParams.get("direction"), "in");
    assert.equal(requests[0].init.headers["X-API-Key"], "test-key");
    assert.equal(result.finalized, false);
    assert.equal(result.verifiedForSettlement, false);
    assert.equal(result.transfers.length, 1);
});

test("no TON API key means no HTTP call", async () => {
    let requests = 0;
    const client = new ToncenterJettonTransfersClient({
        apiKeyProvider: () => "",
        fetchImpl: async () => { requests++; throw Error("unexpected"); }
    });
    await assert.rejects(client.listIncoming(query), /TON_API_KEY required/);
    assert.equal(requests, 0);
});

test("reject Mainnet URL, invalid master, bad pagination and malformed envelope", async () => {
    assert.throws(() => new ToncenterJettonTransfersClient({
        baseUrl: "https://toncenter.com"
    }), /Testnet/);
    const client = new ToncenterJettonTransfersClient({
        apiKeyProvider: () => "key",
        fetchImpl: async () => ({ status: 200, json: async () => ({ transactions: [] }) })
    });
    await assert.rejects(client.listIncoming({ ...query, jettonMaster: "GRAM" }), /Invalid jettonMaster/);
    await assert.rejects(client.listIncoming({ ...query, limit: 1001 }), /range or limit/);
    await assert.rejects(client.listIncoming(query), /Malformed/);
});

test("HTTP failures and misleading success envelopes cannot authorize payment", async () => {
    const client = new ToncenterJettonTransfersClient({
        apiKeyProvider: () => "key",
        fetchImpl: async () => ({ status: 429 })
    });
    await assert.rejects(client.listIncoming(query), /HTTP 429/);
});

test("payer-specific candidate discovery refuses invalid requirements before HTTP", async () => {
    let requests = 0;
    const client = new ToncenterJettonTransfersClient({
        apiKeyProvider: () => "test-key",
        fetchImpl: async () => { requests++; throw Error("must not query"); }
    });
    await assert.rejects(client.findIncomingCandidates({
        ...query, expectedSender: "not-an-address", expectedAmountAtomic: "1500000000"
    }), /Invalid authoritative GRAM candidate filter/);
    await assert.rejects(client.findIncomingCandidates({
        ...query, expectedSender: "0:" + "3".repeat(64), expectedAmountAtomic: "1.5"
    }), /Invalid authoritative GRAM candidate filter/);
    assert.equal(requests, 0);
});

test("payer-specific discovery retains zero settlement authority", async () => {
    const sender = "0:" + "3".repeat(64);
    const client = new ToncenterJettonTransfersClient({
        apiKeyProvider: () => "test-key",
        fetchImpl: async () => ({
            status: 200,
            json: async () => ({ jetton_transfers: [{
                jetton_master: master,
                source: sender,
                destination: room,
                amount: "1500000000",
                transaction_aborted: false,
                transaction_hash: "a".repeat(64),
                transaction_lt: "123",
                transaction_now: 1700000001
            }] })
        })
    });
    const mapped = await client.findIncomingCandidates({
        ...query, expectedSender: sender, expectedAmountAtomic: "1500000000"
    });
    assert.equal(mapped.candidates.length, 1);
    assert.equal(mapped.candidates[0].finalized, false);
    assert.equal(mapped.candidates[0].paymentReference, null);
    assert.equal(mapped.verifiedForSettlement, false);
});
