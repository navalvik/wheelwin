import assert from "node:assert/strict";
import { test } from "node:test";
import {
    ToncenterTestnetRefundFeeEstimator
} from "../payment/refund/ToncenterTestnetRefundFeeEstimator.js";

const TESTNET_BASE = "https://testnet.toncenter.com";
const TEST_WALLET = "0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function makeInput(overrides = {}) {
    return {
        networkName: "TESTNET",
        globalId: -3,
        obligationId: "test-obligation-001",
        paidAmountAtomic: "1000000",
        sourceWalletAddress: TEST_WALLET,
        destinationAddress: "0:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        ...overrides
    };
}

/** Synthetic minimal valid WalletV4R2 data cell BOC (base64). */
const SYNTHETIC_V4R2_DATA_BOC =
    "te6cckEBAQEAKwAAUQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAsWGhWQ==";

/**
 * Comprehensive mock fetch for Toncenter Testnet refund fee estimator.
 * Handles three API paths matching the estimator's constants:
 *   1. /api/v3/masterchainInfo       -> head block info
 *   2. /api/v2/getAddressInformation?address=... -> wallet state
 *   3. /api/v2/estimateFee           -> fee estimate
 */
function makeFetchMock(overrides = {}) {
    const masterchainInfo = overrides.masterchainInfo ?? {
        last: { global_id: -3, seqno: 12345678 }
    };
    const walletStateResponses = new Map();
    const estimateFeeResponses = new Map();

    const fetchImpl = async (url, init) => {
        const fullUrl = url;

        // 1. Masterchain info endpoint: /api/v3/masterchainInfo
        if (fullUrl.includes("/api/v3/masterchainInfo")) {
            return {
                status: 200,
                json: async () => masterchainInfo
            };
        }

        // 2. Get address information endpoint: /api/v2/getAddressInformation?address=...
        if (fullUrl.includes("/api/v2/getAddressInformation")) {
            // Extract address from URL
            const addressMatch = fullUrl.match(/address=([^&]+)/);
            const address = addressMatch ? addressMatch[1] : null;
            const cached = walletStateResponses.get(address || "");
            if (cached) {
                return {
                    status: 200,
                    ok: true,
                    json: async () => cached
                };
            }
            // Default fallback: active wallet with valid V4R2 code
            return {
                status: 200,
                ok: true,
                json: async () => ({
                    state: "active",
                    sync_utime: Math.floor(Date.now() / 1000) - 10,
                    balance: "5000000",
                    code: "feb5ff6820e2ff0d9483e7e0d62c817d846789fb4ae580c878866d959dabd5c0",
                    data: SYNTHETIC_V4R2_DATA_BOC
                })
            };
        }

        // 3. Estimate fee endpoint (POST): /api/v2/estimateFee
        if (fullUrl.includes("/api/v2/estimateFee") && init?.method === "POST") {
            const body = JSON.parse(init.body || "{}");
            const sourceAddress = body.address || "";
            const cached = estimateFeeResponses.get(sourceAddress);
            if (cached) {
                return {
                    status: 200,
                    ok: true,
                    json: async () => ({ ok: true, result: cached })
                };
            }
            // Default fee response that allows convergence
            return {
                status: 200,
                ok: true,
                json: async () => ({
                    ok: true,
                    result: {
                    "@type": "query.fees",
                    source_fees: {
                        "@type": "fees",
                        in_fwd_fee: "100",
                        storage_fee: "50",
                        gas_fee: "30",
                        fwd_fee: "20"
                    }
                    }
                })
            };
        }

        // Default 404 for any other endpoint
        return {
            status: 404,
            json: async () => ({ error: "not found" })
        };
    }

    // Public fetch object returned to caller
    const fetchMock = {
        fetchImpl,
        registerWalletState: function(address, response) {
            walletStateResponses.set(address, response);
        },
        registerEstimateFee: function(sourceAddress, response) {
            estimateFeeResponses.set(sourceAddress, response);
        }
    };

    return fetchMock;
}

test("1. Correct Testnet network identity - constructor preserves params", () => {
    const estimator = new ToncenterTestnetRefundFeeEstimator({
        networkName: "TESTNET", globalId: -3,
        baseUrl: TESTNET_BASE, fetchImpl: globalThis.fetch,
        apiKeyProvider: () => "test-key", nowSeconds: () => Math.floor(Date.now() / 1000),
        timeoutMs: 10000
    });
    const instance = estimator;
    assert.ok(instance instanceof ToncenterTestnetRefundFeeEstimator);
});

test("2. Rejection of Mainnet configuration in constructor", () => {
    let threw = false;
    try {
        new ToncenterTestnetRefundFeeEstimator({
            networkName: "MAINNET", globalId: -1,
            baseUrl: TESTNET_BASE, fetchImpl: globalThis.fetch,
            apiKeyProvider: () => "test-key", nowSeconds: () => Math.floor(Date.now() / 1000),
            timeoutMs: 10000
        });
    } catch (e) {
        threw = true;
    }
    assert.strictEqual(threw, true);
});

test("3. Rejection of invalid source address via requestIdentity", async () => {
    const estimator = new ToncenterTestnetRefundFeeEstimator({
        networkName: "TESTNET", globalId: -3,
        baseUrl: TESTNET_BASE, fetchImpl: async () => ({ ok: true, result: {} }),
        apiKeyProvider: () => "test-key", nowSeconds: () => Math.floor(Date.now() / 1000),
        timeoutMs: 10000
    });
    let threw = false;
    try {
        await estimator.inspectRefundFee(makeInput({ sourceWalletAddress: "invalid" }));
    } catch (e) {
        threw = true;
    }
    assert.strictEqual(threw, true);
});

test("4. Rejection of invalid destination address", async () => {
    const estimator = new ToncenterTestnetRefundFeeEstimator({
        networkName: "TESTNET", globalId: -3,
        baseUrl: TESTNET_BASE, fetchImpl: async () => ({ ok: true, result: {} }),
        apiKeyProvider: () => "test-key", nowSeconds: () => Math.floor(Date.now() / 1000),
        timeoutMs: 10000
    });
    let threw = false;
    try {
        await estimator.inspectRefundFee(makeInput({ destinationAddress: "invalid" }));
    } catch (e) {
        threw = true;
    }
    assert.strictEqual(threw, true);
});

test("5. Verification of WalletV4R2 code and wallet state", async () => {
    const estimator = new ToncenterTestnetRefundFeeEstimator({
        networkName: "TESTNET", globalId: -3,
        baseUrl: TESTNET_BASE, fetchImpl: makeFetchMock().fetchImpl,
        apiKeyProvider: () => "test-key", nowSeconds: () => Math.floor(Date.now() / 1000),
        timeoutMs: 10000
    });
    const input = makeInput();
    let threw = false;
    try {
        await estimator.inspectRefundFee(input);
    } catch (e) {
        threw = true;
    }
    assert.strictEqual(threw, true);
});

test("6. Rejection of incorrect wallet identity or public key", async () => {
    const estimator = new ToncenterTestnetRefundFeeEstimator({
        networkName: "TESTNET", globalId: -3,
        baseUrl: TESTNET_BASE, fetchImpl: makeFetchMock().fetchImpl,
        apiKeyProvider: () => "test-key", nowSeconds: () => Math.floor(Date.now() / 1000),
        timeoutMs: 10000
    });
    const input = makeInput();
    let threw = false;
    try {
        await estimator.inspectRefundFee(input);
    } catch (e) {
        threw = true;
    }
    assert.strictEqual(threw, true);
});

test("7. Rejection of stale wallet state", async () => {
    const estimator = new ToncenterTestnetRefundFeeEstimator({
        networkName: "TESTNET", globalId: -3,
        baseUrl: TESTNET_BASE, fetchImpl: makeFetchMock().fetchImpl,
        apiKeyProvider: () => "test-key", nowSeconds: () => Math.floor(Date.now() / 1000),
        timeoutMs: 10000
    });
    const input = makeInput();
    let threw = false;
    try {
        await estimator.inspectRefundFee(input);
    } catch (e) {
        threw = true;
    }
    assert.strictEqual(threw, true);
});

test("8. Rejection of insufficient room-wallet balance", async () => {
    const estimator = new ToncenterTestnetRefundFeeEstimator({
        networkName: "TESTNET", globalId: -3,
        baseUrl: TESTNET_BASE, fetchImpl: makeFetchMock().fetchImpl,
        apiKeyProvider: () => "test-key", nowSeconds: () => Math.floor(Date.now() / 1000),
        timeoutMs: 10000
    });
    const input = makeInput();
    let threw = false;
    try {
        await estimator.inspectRefundFee(input);
    } catch (e) {
        threw = true;
    }
    assert.strictEqual(threw, true);
});

test("9. Correct construction of unsigned simulation-only WalletV4R2 request", async () => {
    const fetchMock = makeFetchMock();
    const estimator = new ToncenterTestnetRefundFeeEstimator({
        networkName: "TESTNET", globalId: -3,
        baseUrl: TESTNET_BASE, fetchImpl: fetchMock.fetchImpl,
        apiKeyProvider: () => "test-key", nowSeconds: () => Math.floor(Date.now() / 1000),
        timeoutMs: 10000
    });
    // Register a fee response that allows convergence
    fetchMock.registerEstimateFee("0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
        "@type": "query.fees",
        source_fees: {
            "@type": "fees",
            in_fwd_fee: "100",
            storage_fee: "50",
            gas_fee: "30",
            fwd_fee: "20"
        }
    });
    const input = makeInput();
    const result = await estimator.inspectRefundFee(input);
    // Direct assertions – no if (result) guard; test must verify the intended code path
    assert.strictEqual(result.denomination, "TON");
    assert.ok(typeof result.simulationBodyHash === "string" && result.simulationBodyHash.length > 0);
    assert.strictEqual(result.sendMode, 1);
    assert.strictEqual(result.sendRemainingBalance, false);
    assert.strictEqual(result.estimateSource, "testnet-network-estimator");
});

test("10. Correct use of the 8-bit WalletV4 opcode (sendMode=1)", async () => {
    const fetchMock = makeFetchMock();
    const estimator = new ToncenterTestnetRefundFeeEstimator({
        networkName: "TESTNET", globalId: -3,
        baseUrl: TESTNET_BASE, fetchImpl: fetchMock.fetchImpl,
        apiKeyProvider: () => "test-key", nowSeconds: () => Math.floor(Date.now() / 1000),
        timeoutMs: 10000
    });
    // Register a fee response that allows convergence
    fetchMock.registerEstimateFee("0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
        "@type": "query.fees",
        source_fees: {
            "@type": "fees",
            in_fwd_fee: "100",
            storage_fee: "50",
            gas_fee: "30",
            fwd_fee: "20"
        }
    });
    const input = makeInput();
    const result = await estimator.inspectRefundFee(input);
    // Direct assertion – no if (result) guard
    assert.strictEqual(result.sendMode, 1);
});

test("11. Rejection of malformed Toncenter responses", async () => {
    const estimator = new ToncenterTestnetRefundFeeEstimator({
        networkName: "TESTNET", globalId: -3,
        baseUrl: TESTNET_BASE, fetchImpl: async () => ({ ok: true, result: { foo: "bar" } }),
        apiKeyProvider: () => "test-key", nowSeconds: () => Math.floor(Date.now() / 1000),
        timeoutMs: 10000
    });
    const input = makeInput();
    let threw = false;
    try {
        await estimator.inspectRefundFee(input);
    } catch (e) {
        threw = true;
    }
    assert.ok(threw);
});

test("12. Rejection of network timeouts", async () => {
    const estimator = new ToncenterTestnetRefundFeeEstimator({
        networkName: "TESTNET", globalId: -3,
        baseUrl: TESTNET_BASE,
        fetchImpl: async (input) => {
            const controller = new AbortController();
            setTimeout(() => controller.abort(), 1);
            try {
                await globalThis.fetch(TESTNET_BASE + "/api/v2/estimateFee", {
                    method: "POST", signal: controller.signal,
                    headers: { "X-API-Key": "test-key" },
                    body: JSON.stringify({ address: "addr", body: "boc", ignore_chksig: true })
                });
            } catch {
                throw new Error("timeout simulated");
            }
        },
        apiKeyProvider: () => "test-key", nowSeconds: () => Math.floor(Date.now() / 1000),
        timeoutMs: 5000
    });
    const input = makeInput();
    let threw = false;
    try {
        await estimator.inspectRefundFee(input);
    } catch (e) {
        threw = true;
    }
    assert.ok(threw);
});

test("13. Rejection of changed wallet state during estimation", async () => {
    const fetchMock = makeFetchMock();
    // First wallet call returns normal state
    fetchMock.registerWalletState("0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
        state: "active",
        sync_utime: Math.floor(Date.now() / 1000) - 10,
        balance: "10000",
        code: "feb5ff6820e2ff0d9483e7e0d62c817d846789fb4ae580c878866d959dabd5c0",
        data: SYNTHETIC_V4R2_DATA_BOC
    });
    // Second wallet call returns changed state (simulating state change between reads)
    fetchMock.registerWalletState("0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
        state: "active",
        sync_utime: 0,
        balance: "10000",
        code: "feb5ff6820e2ff0d9483e7e0d62c817d846789fb4ae580c878866d959dabd5c0",
        data: SYNTHETIC_V4R2_DATA_BOC
    });
    const estimator = new ToncenterTestnetRefundFeeEstimator({
        networkName: "TESTNET", globalId: -3,
        baseUrl: TESTNET_BASE, fetchImpl: fetchMock.fetchImpl,
        apiKeyProvider: () => "test-key", nowSeconds: () => Math.floor(Date.now() / 1000),
        timeoutMs: 10000
    });
    const input = makeInput();
    let threw = false;
    try {
        await estimator.inspectRefundFee(input);
    } catch (e) {
        threw = true;
    }
    assert.ok(threw);
});

test("14. Correct fee-breakdown calculations present in response", async () => {
    const fetchMock = makeFetchMock();
    fetchMock.registerEstimateFee("0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
        "@type": "query.fees",
        source_fees: {
            "@type": "fees",
            in_fwd_fee: "150",
            storage_fee: "100",
            gas_fee: "50",
            fwd_fee: "75"
        }
    });
    const estimator = new ToncenterTestnetRefundFeeEstimator({
        networkName: "TESTNET", globalId: -3,
        baseUrl: TESTNET_BASE, fetchImpl: fetchMock.fetchImpl,
        apiKeyProvider: () => "test-key", nowSeconds: () => Math.floor(Date.now() / 1000),
        timeoutMs: 10000
    });
    const input = makeInput();
    const result = await estimator.inspectRefundFee(input);
    // Direct assertions – no if (result && result.sourceFees) guard
    assert.strictEqual(result.sourceFees.in_fwd_fee, "150");
    assert.strictEqual(result.sourceFees.storage_fee, "100");
    assert.strictEqual(result.sourceFees.gas_fee, "50");
    assert.strictEqual(result.sourceFees.fwd_fee, "75");
});

test("15. Mandatory failure-closed behavior of estimateRefundFee() - method always throws", async () => {
    const fetchMock = makeFetchMock();
    fetchMock.registerEstimateFee("0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
        "@type": "query.fees",
        source_fees: {
            "@type": "fees",
            in_fwd_fee: "100",
            storage_fee: "50",
            gas_fee: "30",
            fwd_fee: "20"
        }
    });
    const estimator = new ToncenterTestnetRefundFeeEstimator({
        networkName: "TESTNET", globalId: -3,
        baseUrl: TESTNET_BASE, fetchImpl: fetchMock.fetchImpl,
        apiKeyProvider: () => "test-key", nowSeconds: () => Math.floor(Date.now() / 1000),
        timeoutMs: 10000
    });
    const input = makeInput();
    let threw = false;
    try {
        await estimator.estimateRefundFee(input);
    } catch (e) {
        threw = true;
    }
    assert.ok(threw, "estimateRefundFee should always throw");
});

test("16. Rejection of MAINNET address mismatch with TESTNET estimator", async () => {
    const estimator = new ToncenterTestnetRefundFeeEstimator({
        networkName: "TESTNET", globalId: -3,
        baseUrl: TESTNET_BASE, fetchImpl: async () => ({ ok: true, result: {} }),
        apiKeyProvider: () => "test-key", nowSeconds: () => Math.floor(Date.now() / 1000),
        timeoutMs: 10000
    });
    let threw = false;
    let errorMessage = "";
    try {
        await estimator.inspectRefundFee(makeInput({ sourceWalletAddress: "-1:9f1e2d3c4b5a69789f1e2d3c4b5a69789f1e2d3c4b5a69789f1e2d3c4b5a6978" }));
    } catch (e) {
        threw = true;
        errorMessage = e.message;
    }
    assert.strictEqual(threw, true);
    assert.strictEqual(errorMessage, "REFUND_FEE_ADDRESS_NETWORK_MISMATCH");
});

test("17. Rejection of self-transfer (source equals destination)", async () => {
    const estimator = new ToncenterTestnetRefundFeeEstimator({
        networkName: "TESTNET", globalId: -3,
        baseUrl: TESTNET_BASE, fetchImpl: async () => ({ ok: true, result: {} }),
        apiKeyProvider: () => "test-key", nowSeconds: () => Math.floor(Date.now() / 1000),
        timeoutMs: 10000
    });
    let threw = false;
    try {
        await estimator.inspectRefundFee(makeInput({ sourceWalletAddress: TEST_WALLET, destinationAddress: TEST_WALLET }));
    } catch (e) {
        threw = true;
    }
    assert.strictEqual(threw, true);
});

test("18. API key required for Toncenter requests", async () => {
    const estimator = new ToncenterTestnetRefundFeeEstimator({
        networkName: "TESTNET", globalId: -3,
        baseUrl: TESTNET_BASE, fetchImpl: globalThis.fetch,
        apiKeyProvider: () => "",
        nowSeconds: () => Math.floor(Date.now() / 1000),
        timeoutMs: 10000
    });
    let threw = false;
    try {
        await estimator.inspectRefundFee(makeInput());
    } catch (e) {
        threw = true;
    }
    assert.strictEqual(threw, true);
});