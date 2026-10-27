import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildPaymentRuntime } from "../../payment/runtime/PaymentRuntimeFactory.js";
import { createRefundObligationId, RefundObligation } from "../../payment/refund/RefundObligation.js";

function fixture() {
    const root = mkdtempSync(join(tmpdir(), "wheelwin-restored-refund-runtime-"));
    const catalogPath = join(root, "wallets.json");
    writeFileSync(catalogPath, JSON.stringify(Array.from({ length: 64 }, (_, index) => ({
        walletId: `room-wallet-${index + 1}`,
        roomNumber: index + 1,
        address: `0:${(index + 1).toString(16).padStart(64, "0")}`,
        network: "testnet",
        workchain: 0
    }))));
    return { root, catalogPath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function pendingObligation() {
    const idempotencyKey = "TESTNET:payment-1:incoming-1";
    const payerAddress = `0:${"a".repeat(64)}`;
    return RefundObligation.fromRecord({
        schemaVersion: 1,
        obligationId: createRefundObligationId(idempotencyKey),
        idempotencyKey,
        networkName: "TESTNET",
        globalId: -3,
        roomNumber: 2,
        roomId: "room-test",
        playerId: "bob",
        paymentIntentId: "payment-1",
        incomingTransactionId: "incoming-1",
        amountAtomic: 1_000_000_000,
        denomination: "TON",
        payerAddress,
        refundDestination: payerAddress,
        closureReason: "setup_expired",
        createdAtMs: 1_800_000_000_000,
        state: "PENDING",
        attempts: [],
        outgoingTransactionId: null,
        finalizedEvidence: null,
        lastError: null
    });
}

test("restored runtime plans a persisted pending refund without moving funds", async () => {
    const f = fixture();
    try {
        const seen = [];
        const runtime = buildPaymentRuntime({
            dataDir: join(f.root, "payment-data"),
            walletCatalogPath: f.catalogPath,
            restoredSettlement: {
                async planDurableRefund(obligation) {
                    seen.push(obligation);
                    return { ok: false, code: "OFFLINE_FEE_UNAVAILABLE" };
                }
            }
        });
        await assert.rejects(runtime.planPendingRefund("missing"), /not initialized/);
        runtime.initialize();
        const obligation = pendingObligation();
        runtime.refundStore.create(obligation);

        const result = await runtime.planPendingRefund(obligation.obligationId);
        assert.deepEqual(result, { ok: false, code: "OFFLINE_FEE_UNAVAILABLE" });
        assert.equal(seen.length, 1);
        assert.equal(seen[0].obligationId, obligation.obligationId);
        assert.equal(runtime.refundStore.get(obligation.obligationId).state, "PENDING");
        assert.equal(runtime.refundStore.get(obligation.obligationId).outgoingTransactionId, null);
        assert.equal(runtime.getCapabilities().livePaymentAcceptanceEnabled, false);
        assert.equal(runtime.getCapabilities().outgoingRefundTransfersEnabled, false);
        await assert.rejects(runtime.planPendingRefund("unknown"), /not found/);
    } finally {
        f.cleanup();
    }
});

test("restored runtime without a settlement planner fails closed", async () => {
    const f = fixture();
    try {
        const runtime = buildPaymentRuntime({
            dataDir: join(f.root, "payment-data"),
            walletCatalogPath: f.catalogPath
        });
        runtime.initialize();
        const obligation = pendingObligation();
        runtime.refundStore.create(obligation);
        await assert.rejects(runtime.planPendingRefund(obligation.obligationId), /not attached/);
        assert.equal(runtime.refundStore.get(obligation.obligationId).state, "PENDING");
    } finally {
        f.cleanup();
    }
});
