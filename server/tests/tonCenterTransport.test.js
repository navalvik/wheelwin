/**
 * R7.52 — TonCenterTransport sendBoc HTTP error body capture.
 */

import assert from "node:assert/strict";

import {
    getTonDeployDebug,
    resetTonDeployDebugForTests
} from "../diagnostics/DeployPipelineForensics.js";
import { TonCenterTransport } from "../payment/ton/TonCenterTransport.js";

resetTonDeployDebugForTests();

{
    const transport = new TonCenterTransport({
        endpoint: "https://testnet.toncenter.com/api/v2/jsonRPC",
        fetchImpl: async () => ({
            ok: false,
            status: 500,
            statusText: "Internal Server Error",
            headers: {
                forEach(callback) {
                    callback("application/json", "content-type");
                }
            },
            async text() {
                return JSON.stringify({
                    ok: false,
                    error: "Failed to unpack Message",
                    code: 500
                });
            }
        })
    });

    let caught = null;

    try {

        await transport.sendBoc("dGVzdGJvYw==");

    } catch (error) {

        caught = error;

    }

    assert.ok(caught, "sendBoc must throw on HTTP 500");
    assert.equal(caught.message, "TonCenter HTTP 500");
    assert.equal(caught.status, 500);
    assert.match(caught.responseBody, /Failed to unpack Message/);
    assert.equal(
        caught.endpoint,
        "https://testnet.toncenter.com/api/v2/jsonRPC"
    );

    const debug = getTonDeployDebug();

    assert.equal(debug.tonCenterStatus, 500);
    assert.match(debug.tonCenterResponse, /Failed to unpack Message/);
    assert.equal(
        debug.tonCenterEndpoint,
        "https://testnet.toncenter.com/api/v2/jsonRPC"
    );
    assert.equal(debug.errorMessage, "TonCenter HTTP 500");

    console.log("  sendBoc HTTP 500 captures response body: OK");
}

{
    resetTonDeployDebugForTests();

    const transport = new TonCenterTransport({
        endpoint: "https://testnet.toncenter.com/api/v2/jsonRPC",
        fetchImpl: async () => ({
            ok: true,
            status: 200,
            statusText: "OK",
            headers: { forEach() {} },
            async json() {
                return { ok: true, result: { "@type": "ok" } };
            }
        })
    });

    const result = await transport.sendBoc("dGVzdGJvYw==");

    assert.deepEqual(result, { "@type": "ok" });
    console.log("  sendBoc success path unchanged: OK");
}

resetTonDeployDebugForTests();

console.log("tonCenterTransport.sendBoc R7.52: all passed");
