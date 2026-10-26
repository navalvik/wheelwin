import test from "node:test";
import assert from "node:assert/strict";
import { ToncenterTestnetRefundBroadcaster } from "../payment/refund/ToncenterTestnetRefundBroadcaster.js";
const boc = "dGVzdC1ib2M=";
test("accepted BOC is UNKNOWN until observed on chain", async () => {
    let calls = 0;
    const broadcaster = new ToncenterTestnetRefundBroadcaster({
        apiKeyProvider: () => "offline-test-key",
        fetchImpl: async (url, options) => {
            calls++;
            assert.equal(url, "https://testnet.toncenter.com/api/v2/sendBoc");
            assert.equal(options.method, "POST");
            assert.equal(JSON.parse(options.body).boc, boc);
            return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
        }
    });
    assert.deepEqual(await broadcaster.broadcast({ signedTransfer: { boc } }),
        { status: "UNKNOWN", reason: "ACCEPTED_AWAITING_ONCHAIN_IDENTITY" });
    assert.equal(calls, 1);
});
test("missing credentials do not reach network", async () => {
    const broadcaster = new ToncenterTestnetRefundBroadcaster({
        fetchImpl: () => { throw Error("network must not be called"); }
    });
    assert.equal((await broadcaster.broadcast({ signedTransfer: { boc } })).status, "REJECTED");
});
test("ambiguous network and provider failures cannot claim success", async () => {
    for (const fetchImpl of [
        async () => { throw Error("connection dropped"); },
        async () => ({ ok: false, status: 503 }),
        async () => ({ ok: true, status: 200, json: async () => { throw Error("bad json"); } })
    ]) {
        const broadcaster = new ToncenterTestnetRefundBroadcaster({
            apiKeyProvider: () => "offline-test-key", fetchImpl
        });
        assert.equal((await broadcaster.broadcast({ signedTransfer: { boc } })).status, "UNKNOWN");
    }
});
test("Mainnet endpoints cannot be configured", () => {
    assert.throws(() => new ToncenterTestnetRefundBroadcaster({
        endpoint: "https://toncenter.com/api/v2/sendBoc"
    }), /configuration invalid/);
});
