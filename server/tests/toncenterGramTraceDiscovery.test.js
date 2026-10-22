import assert from "node:assert/strict";
import { test } from "node:test";
import { ToncenterGramTraceDiscovery } from "../payment/toncenter/ToncenterGramTraceDiscovery.js";

const traceId = "9".repeat(64);
test("single authenticated trace lookup cannot confirm GRAM or a receiving wallet", async () => {
    const calls = [];
    const client = new ToncenterGramTraceDiscovery({
        apiKeyProvider: () => "test-api-key",
        fetchImpl: async (url, request) => {
            calls.push({ url: new URL(url), request });
            return { status: 200, json: async () => ({ traces: [{ trace_id: traceId }] }) };
        }
    });
    const result = await client.readTrace(traceId);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.origin, "https://testnet.toncenter.com");
    assert.equal(calls[0].url.pathname, "/api/v3/traces");
    assert.equal(calls[0].url.searchParams.get("trace_id"), traceId);
    assert.equal(calls[0].url.searchParams.get("limit"), "2");
    assert.equal(calls[0].request.headers["X-API-Key"], "test-api-key");
    assert.equal(result.traces.length, 1);
    assert.equal(result.indexerOnly, true);
    assert.equal(result.chainMessageLinkVerified, false);
    assert.equal(result.gramTransferVerified, false);
    assert.equal(result.paymentCreditAuthorized, false);
});

test("missing key and malformed trace ID cause zero HTTP requests", async () => {
    let requests = 0;
    const client = new ToncenterGramTraceDiscovery({
        apiKeyProvider: () => "",
        fetchImpl: async () => { requests++; throw Error("must not call"); }
    });
    await assert.rejects(client.readTrace(traceId), /TON_API_KEY/);
    await assert.rejects(client.readTrace("not-a-hash"), /Invalid authoritative/);
    assert.equal(requests, 0);
});

test("mismatched, ambiguous or malformed indexed trace records are rejected", async () => {
    for (const response of [
        { traces: [{ trace_id: "a".repeat(64) }] },
        { traces: [{ trace_id: traceId }, { trace_id: traceId }] },
        { transactions: [] },
        { traces: [null] }
    ]) {
        const client = new ToncenterGramTraceDiscovery({
            apiKeyProvider: () => "key",
            fetchImpl: async () => ({ status: 200, json: async () => response })
        });
        await assert.rejects(client.readTrace(traceId), /mismatched|ambiguous|invalid/);
    }
});

test("empty indexer trace response never proves payment absent", async () => {
    const client = new ToncenterGramTraceDiscovery({
        apiKeyProvider: () => "key",
        fetchImpl: async () => ({ status: 200, json: async () => ({ traces: [] }) })
    });
    const result = await client.readTrace(traceId);
    assert.equal(result.traces.length, 0);
    assert.equal(result.paymentCreditAuthorized, false);
});
