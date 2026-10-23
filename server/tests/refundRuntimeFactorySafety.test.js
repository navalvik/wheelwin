import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTestnetOutgoingRefundProvider } from "../payment/runtime/PaymentRuntimeFactory.js";
import { WalletV4SignedNativeGramRefundInspector } from "../payment/refund/WalletV4SignedNativeGramRefundInspector.js";

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

test("production refund factory refuses missing broadcast and chain-verification dependencies", () => {
    const missing = [
        ["broadcaster", "broadcast"],
        ["finalityEvidenceProvider", "getSettlementEvidence"],
        ["outgoingTransferProvider", "getOutgoingTransfer"],
        ["outgoingTransferProvider", "findOutgoingTransfer"]
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

test("net-only Wallet V4 signer is sufficient; legacy gross signer is not required", () => {
    const bundle = completeBundle();
    delete bundle.signer.signTransfer;
    const provider = build(bundle);
    assert.ok(provider, "a dedicated net signer should be usable without the obsolete gross signer");
    assert.equal(provider.canExecute(), true);
});

test("actual Wallet V4R2 inspector implements both required production verification methods", () => {
    const inspector = new WalletV4SignedNativeGramRefundInspector({
        walletStateReader: {
            // No real network is queried here; inspection remains fail-closed
            // until authenticated on-chain wallet state is supplied.
            async getVerifiedWalletState() { return null; }
        }
    });
    assert.equal(typeof inspector.inspect, "function");
    assert.equal(typeof inspector.verifyWalletV4Signature, "function");
    const bundle = completeBundle();
    bundle.signedTransferInspector = inspector;
    const provider = build(bundle);
    assert.ok(provider, "factory accepts the actual trusted-state inspector API");
    assert.equal(provider.canExecute(), true,
        "readiness checks dependency presence, NOT live payment permission");
});
