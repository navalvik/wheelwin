import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildTestnetOutgoingRefundProvider } from "../../payment/runtime/PaymentRuntimeFactory.js";
import { LIVE_PAYMENT_ACCEPTANCE_ENABLED } from "../../payment/PaymentLifecycleAvailability.js";

test("production server does not silently inject a Testnet refund signer", () => {
    const source = readFileSync(new URL("../../app.js", import.meta.url), "utf8");
    const start = source.indexOf("const paymentRuntime = buildPaymentRuntime({");
    assert.ok(start >= 0);
    const end = source.indexOf("});", start);
    assert.ok(end > start);
    const call = source.slice(start, end + 3);
    assert.doesNotMatch(call, /refundSubmitter\s*:/);
    assert.equal(LIVE_PAYMENT_ACCEPTANCE_ENABLED, false);
});

test("without explicit signing bundle there is no outgoing refund execution", () => {
    assert.equal(buildTestnetOutgoingRefundProvider({
        submitter: null, globalId: -3, finalityEvidenceProvider: null
    }), null);
});
