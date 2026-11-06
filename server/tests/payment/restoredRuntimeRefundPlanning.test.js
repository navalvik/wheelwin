import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildPaymentRuntime } from "../../payment/runtime/PaymentRuntimeFactory.js";
import { createRefundObligationId, RefundObligation } from "../../payment/refund/RefundObligation.js";
import { PaymentIntent } from "../../payment/PaymentIntent.js";
import { PAYMENT_INTENT_STATE } from "../../payment/PaymentIntentStatus.js";

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
        // A refund whose prior attempt was blocked must not be planned again.
        runtime.refundStore.markBlocked(obligation.obligationId, {
            lastError: "TEST_RECONCILIATION_HOLD"
        });
        await assert.rejects(
            runtime.planPendingRefund(obligation.obligationId),
            /not pending on TON Testnet/
        );
        assert.equal(seen.length, 1, "blocked refund never reaches planner");
        assert.equal(runtime.refundStore.get(obligation.obligationId).state, "BLOCKED");
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

test("pending refund retains its exact source wallet across restart even without a snapshot", () => {
    const f = fixture();
    try {
        const dataDir = join(f.root, "payment-data");
        const now = 1_800_000_000_000;
        const first = buildPaymentRuntime({
            dataDir, walletCatalogPath: f.catalogPath, nowProvider: () => now
        });
        first.initialize();
        first.paymentService.reserveWalletForRoom({
            roomId: "room-test", walletId: "room-wallet-2"
        });
        const payerAddress = `0:${"a".repeat(64)}`;
        const intent = new PaymentIntent({
            paymentReference: "payment-1", roomId: "room-test",
            playerId: "bob", network: "testnet",
            destinationWalletId: "room-wallet-2",
            destinationWalletAddress: `0:${"2".padStart(64, "0")}`,
            expectedSender: payerAddress, amountAtomic: 1_000_000_000,
            asset: "TON", createdAt: now - 1_000, expiresAt: now + 1_000,
            roomDeadlineMs: now + 2_000
        });
        first.intentStore.save(intent);
        const matched = intent.transition(PAYMENT_INTENT_STATE.MATCHED, {
            transactionId: "incoming-1", now
        });
        first.intentStore.update(matched);
        first.intentStore.update(matched.transition(PAYMENT_INTENT_STATE.SETTLED, { now }));
        first.refundStore.create(pendingObligation());
        first.shutdown();

        // Simulate loss of the public reservation snapshot, not of payment
        // intents or durable refunds. Rebuild must never recycle wallet #2.
        rmSync(join(dataDir, "testnet", "payment-core"), { recursive: true, force: true });
        const recovered = buildPaymentRuntime({
            dataDir, walletCatalogPath: f.catalogPath, nowProvider: () => now
        });
        recovered.initialize();
        assert.equal(recovered.walletPool.getReservationForRoom("room-test").walletId, "room-wallet-2");
        assert.equal(recovered.walletPool.getAvailableCount(), 63);
        assert.equal(recovered.paymentService.countOpenObligations("room-test"), 1);
        assert.throws(() => recovered.paymentService.releaseWalletForRoom("room-test"), /obligation|recycl/i);
        assert.equal(recovered.refundStore.listPending().length, 1);
    } finally {
        f.cleanup();
    }
});


test("read-only refund planner factory receives the exact authoritative 64-wallet pool", async () => {
    const f = fixture();
    try {
        const calls = [];
        const runtime = buildPaymentRuntime({
            dataDir: join(f.root, "payment-data"),
            walletCatalogPath: f.catalogPath,
            restoredSettlementFactory({ walletPool, network, globalId }) {
                calls.push({ walletPool, network, globalId });
                return {
                    async planDurableRefund(obligation) {
                        return { ok: true, obligationId: obligation.obligationId, mode: "READ_ONLY" };
                    }
                };
            }
        });
        assert.equal(calls.length, 0, "factory must wait for catalog initialization");
        runtime.initialize();
        assert.equal(calls.length, 1);
        assert.equal(calls[0].walletPool, runtime.walletPool);
        assert.equal(calls[0].network, "testnet");
        assert.equal(calls[0].globalId, -3);
        assert.equal(runtime.walletPool.size, 64);
        assert.equal(runtime.walletPool.listWallets().length, 64);
        runtime.initialize();
        assert.equal(calls.length, 1, "idempotent restart never rebuilds planner");
        const obligation = pendingObligation();
        runtime.refundStore.create(obligation);
        const result = await runtime.planPendingRefund(obligation.obligationId);
        assert.deepEqual(result, {
            ok: true, obligationId: obligation.obligationId, mode: "READ_ONLY"
        });
        assert.equal(runtime.refundStore.get(obligation.obligationId).state, "PENDING");
        assert.equal(runtime.getCapabilities().outgoingRefundTransfersEnabled, false);
        assert.equal(runtime.getCapabilities().livePaymentAcceptanceEnabled, false);
    } finally {
        f.cleanup();
    }
});
