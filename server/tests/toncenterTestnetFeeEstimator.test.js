import test from "node:test";
import assert from "node:assert/strict";
import {
    ToncenterTestnetFeeEstimator
} from "../payment/fees/ToncenterTestnetFeeEstimator.js";
import {
    ToncenterApiKeyMissingError,
    ToncenterRateLimitError,
    ToncenterResponseError,
    ToncenterRequestError
} from "../payment/toncenter/ToncenterErrors.js";

const input = {
    operationId: "winner-payout",
    sourceWalletAddress: "room-wallet",
    destination: "winner-wallet",
    amountAtomic: 1_000_000_000,
    purpose: "WINNER_PAYOUT",
    body: "te6ccgEBAQEAAgAAAA=="
};

const response = (status, payload) => ({
    status,
    async json() { return payload; }
});

const feePayload = {
    source_fees: { fwd_fee: "1", gas_fee: "2", in_fwd_fee: "3", storage_fee: "4" },
    destination_fees: [
        { fwd_fee: "5", gas_fee: "6", in_fwd_fee: "7", storage_fee: "8" }
    ]
};

function makeEstimator({ payload = feePayload, status = 200, key = "test-key", network = { networkName: "TESTNET", globalId: -3 }, bindingOverrides = {}, fetchImpl, now = () => 123_000 } = {}) {
    const calls = [];
    const estimator = new ToncenterTestnetFeeEstimator({
        apiKeyProvider: () => key,
        networkIdentityProvider: { async getNetworkIdentity() { return network; } },
        preparedMessageVerifier: {
            async verifyPreparedOutgoingMessage(request) {
                return { verified: true, ...request, ...bindingOverrides };
            }
        },
        fetchImpl: fetchImpl ?? (async (url, init) => {
            calls.push({ url, init });
            return response(status, payload);
        }),
        now,
        idFactory: () => "estimate-1",
        timeoutMs: 1000
    });
    return { estimator, calls };
}

test("uses fixed Testnet endpoint and reserves source-paid fees without charging destination fees", async () => {
    const { estimator, calls } = makeEstimator();
    const result = await estimator.estimateOutgoingFee(input);
    assert.equal(result.feeAtomic, 10);
    assert.equal(result.sourceFeeAtomic, 10);
    assert.equal(result.destinationFeeAtomic, 26);
    assert.equal(result.globalId, -3);
    assert.equal(result.networkName, "TESTNET");
    assert.equal(result.estimateId, "estimate-1");
    assert.equal(result.quotedAtMs, 123_000);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://testnet.toncenter.com/api/v3/estimateFee");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers["X-API-Key"], "test-key");
    assert.deepEqual(JSON.parse(calls[0].init.body), {
        address: "room-wallet",
        body: input.body,
        ignore_chksig: false
    });
});

test("blocks fee estimation when the prepared BOC is not bound to the claimed transfer", async () => {
    const { estimator, calls } = makeEstimator({
        bindingOverrides: { destination: "attacker-wallet" }
    });
    await assert.rejects(() => estimator.estimateOutgoingFee(input), ToncenterRequestError);
    assert.equal(calls.length, 0);
});

test("does not make an HTTP request when API key is absent", async () => {
    const { estimator, calls } = makeEstimator({ key: "" });
    await assert.rejects(() => estimator.estimateOutgoingFee(input), ToncenterApiKeyMissingError);
    assert.equal(calls.length, 0);
});

test("fails closed when Testnet global ID is not independently verified", async () => {
    const { estimator, calls } = makeEstimator({ network: { networkName: "MAINNET", globalId: -239 } });
    await assert.rejects(() => estimator.estimateOutgoingFee(input), ToncenterRequestError);
    assert.equal(calls.length, 0);
});

test("rate limit does not retry", async () => {
    const { estimator, calls } = makeEstimator({ status: 429 });
    await assert.rejects(() => estimator.estimateOutgoingFee(input), ToncenterRateLimitError);
    assert.equal(calls.length, 1);
});

test("malformed fee fields fail closed", async () => {
    const { estimator } = makeEstimator({
        payload: { source_fees: { fwd_fee: "bad", gas_fee: "2", in_fwd_fee: "3", storage_fee: "4" }, destination_fees: [feePayload.destination_fees[0]] }
    });
    await assert.rejects(() => estimator.estimateOutgoingFee(input), ToncenterResponseError);
});

test("empty destination fee array fails closed", async () => {
    const { estimator } = makeEstimator({ payload: { source_fees: feePayload.source_fees, destination_fees: [] } });
    await assert.rejects(() => estimator.estimateOutgoingFee(input), ToncenterResponseError);
});

test("non-200 errors are not converted into fee quotes", async () => {
    const { estimator } = makeEstimator({ status: 503 });
    await assert.rejects(() => estimator.estimateOutgoingFee(input));
});
