import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPaymentRuntime } from "../../payment/runtime/PaymentRuntimeFactory.js";
import { PaymentIntent } from "../../payment/PaymentIntent.js";
import { SqlitePaymentIntentStore } from "../../payment/SqlitePaymentIntentStore.js";
import { PaymentIntentStore } from "../../payment/PaymentIntentStore.js";

function fixture(t) {
    const dir = mkdtempSync(join(tmpdir(), "ww-payment-backend-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return {
        dataDir: dir,
        network: "testnet",
        // No network calls or wallet catalog are read by buildPaymentRuntime.
        fetchImpl: async () => { throw Error("unexpected network access"); }
    };
}
function intent() {
    return new PaymentIntent({
        paymentReference: "test-intent",
        roomId: "test-room", playerId: "player-1",
        network: "testnet", asset: "TON",
        destinationWalletId: "wallet-1",
        destinationWalletAddress: "0:" + "b".repeat(64),
        expectedSender: "0:" + "a".repeat(64),
        amountAtomic: 1000000000,
        createdAt: 1000, expiresAt: 5000, roomDeadlineMs: 7000
    });
}

test("default payment runtime backend remains JSON; no active payment acceptance", (t) => {
    const options = fixture(t);
    const runtime = buildPaymentRuntime(options);
    assert.equal(runtime.intentStorageBackend, "json");
    assert.ok(runtime.intentStore instanceof PaymentIntentStore);
    assert.equal(runtime.getCapabilities().livePaymentAcceptanceEnabled, false);
    assert.equal(runtime.getCapabilities().gramJettonSettlementEnabled, false);
});

test("explicit SQLite backend creates one persistent, versioned intent store", (t) => {
    const options = fixture(t);
    const sqlite = buildPaymentRuntime({ ...options, intentStorageBackend: "sqlite" });
    assert.ok(sqlite.intentStore instanceof SqlitePaymentIntentStore);
    assert.equal(sqlite.intentStorageBackend, "sqlite");
    sqlite.intentStore.initialize();
    sqlite.intentStore.save(intent());
    sqlite.intentStore.close();

    assert.throws(() => buildPaymentRuntime(options), /Cannot select JSON while a SQLite/);
    const resumed = buildPaymentRuntime({ ...options, intentStorageBackend: "sqlite" });
    resumed.intentStore.initialize();
    try {
        assert.equal(resumed.intentStore.require("test-intent").amountAtomic, 1000000000);
    } finally {
        resumed.intentStore.close();
    }
});

test("existing JSON intents block SQLite backend and preserve all prior files", (t) => {
    const options = fixture(t);
    const json = buildPaymentRuntime(options);
    json.intentStore.initialize();
    json.intentStore.save(intent());
    assert.throws(() => buildPaymentRuntime({ ...options, intentStorageBackend: "sqlite" }),
        /Cannot select SQLite while JSON payment intents exist/);
    assert.equal(json.intentStore.require("test-intent").paymentReference, "test-intent");
});

test("unknown backend rejected instead of silent fallback", (t) => {
    const options = fixture(t);
    assert.throws(() => buildPaymentRuntime({
        ...options, intentStorageBackend: "legacy"
    }), /Unknown payment intent storage backend/);
});
