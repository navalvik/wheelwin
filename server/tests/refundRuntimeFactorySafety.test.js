import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTestnetOutgoingRefundProvider } from "../payment/runtime/PaymentRuntimeFactory.js";

const noop = () => {};
function completeBundle() {
    return {
        signer: { signTransfer: noop, signPlannedRefund: noop },
        broadcaster: { broadcast: noop },
        finalityEvidenceProvider: { getSettlementEvidence: noop },
        outgoingTransferProvider: { getOutgoingTransfer: noop, findOutgoingTransfer: noop },
        feeEstimator: { estimateRefundFee: noop },
        refundPlanStore: { get: noop, reserve: noop },
        signedTransferInspector: { inspect: noop, verifyWalletV4Signature: noop }
    };
}
function build(submitter, globalId = -3) {
    return buildTestnetOutgoingRefundProvider({ submitter, globalId, finalityEvidenceProvider: null });
}

test("production refund factory refuses legacy full-principal signer", () => {
    const legacy = completeBundle();
    delete legacy.signer.signPlannedRefund;
    assert.equal(build(legacy), null);
});

test("production refund factory refuses each missing net-refund safety dependency", () => {
    const missing = [
        ["feeEstimator", "estimateRefundFee"],
        ["refundPlanStore", "get"],
        ["refundPlanStore", "reserve"],
        ["signedTransferInspector", "inspect"],
        ["signedTransferInspector", "verifyWalletV4Signature"],
        ["signer", "signPlannedRefund"]
    ];
    for (const [component, method] of missing) {
        const bundle = completeBundle();
        delete bundle[component][method];
        assert.equal(build(bundle), null, component + "." + method);
    }
});

test("production refund factory requires Testnet and a complete authorized bundle", () => {
    assert.equal(build(null), null);
    assert.equal(build(completeBundle(), -239), null);
    const bundle = completeBundle();
    const provider = build(bundle);
    assert.ok(provider);
    assert.equal(provider.canExecute(), true);
    assert.equal(provider._feeEstimator, bundle.feeEstimator);
    assert.equal(provider._refundPlanStore, bundle.refundPlanStore);
    assert.equal(provider._signedTransferInspector, bundle.signedTransferInspector);
    assert.equal(provider.globalId, -3);
});
