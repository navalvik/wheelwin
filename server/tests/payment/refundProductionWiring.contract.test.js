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

test("complete signer bundle cannot be enabled without authoritative wallet catalog", () => {
    const submitter = {
        signer: { signTransfer() {} },
        broadcaster: { broadcast() {} },
        outgoingTransferProvider: { getOutgoingTransfer() {}, findOutgoingTransfer() {} },
        finalityEvidenceProvider: { getSettlementEvidence() {} }
    };
    assert.equal(buildTestnetOutgoingRefundProvider({
        submitter, globalId: -3, walletPool: null
    }), null);
    const catalog = {
        getWallet() { return null; },
        listWallets() { return []; }
    };
    const enabled = buildTestnetOutgoingRefundProvider({
        submitter, globalId: -3, walletPool: catalog
    });
    assert.ok(enabled?.canExecute(), "only explicit catalog-backed Testnet signer may be constructed");
});

test("outgoing HTTP transport is opt-in, never inferred from signer", () => {
    const walletPool = { getWallet() { return null; }, listWallets() { return []; } };
    const submitter = {
        signer: { signTransfer() {} },
        outgoingTransferProvider: { getOutgoingTransfer() {}, findOutgoingTransfer() {} },
        finalityEvidenceProvider: { getSettlementEvidence() {} }
    };
    assert.equal(buildTestnetOutgoingRefundProvider({
        submitter, globalId: -3, walletPool
    }), null);
    assert.equal(buildTestnetOutgoingRefundProvider({
        submitter: { ...submitter, enableToncenterBroadcast: true },
        globalId: -3, walletPool
    })?.canExecute(), true);
});
