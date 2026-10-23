import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlitePaymentIntentStore } from "../../payment/SqlitePaymentIntentStore.js";
import { PaymentIntent } from "../../payment/PaymentIntent.js";

function row(ref) {
    return new PaymentIntent({
        paymentReference: ref,
        roomId: "room-test",
        playerId: ref,
        network: "testnet",
        destinationWalletId: "room-wallet-1",
        destinationWalletAddress: "0:" + "c".repeat(64),
        expectedSender: "0:" + "b".repeat(64),
        amountAtomic: 1500000000,
        asset: "GRAM",
        createdAt: 1000,
        expiresAt: 5000,
        roomDeadlineMs: 7000,
        state: "PENDING"
    });
}
function fixture(t) {
    const dir = mkdtempSync(join(tmpdir(), "wheelwin-gram-sqlite-"));
    const path = join(dir, "payment.sqlite");
    const store = new SqlitePaymentIntentStore({ databasePath: path });
    store.initialize();
    t.after(() => {\n        store.close();\n        rmSync(dir, { recursive: true, force: true });\n    });
    return { store, path };
}

test("GRAM tx identity survives intent completion, close, and process restart", (t) => {
    const { store, path } = fixture(t);
    store.save(row("first"));
    store.save(row("second"));
    const matched = store.update(store.require("first").transition("MATCHED", {
        transactionId: "testnet:jetton-transfer:001", now: 2000
    }));
    assert.equal(matched.state, "MATCHED");
    store.update(matched.transition("SETTLED", { now: 2200 }));
    assert.throws(() => store.delete("first"), /cannot delete/);
    assert.equal(store.findByTransactionId("testnet:jetton-transfer:001").paymentReference, "first");
    store.close();

    const reopened = new SqlitePaymentIntentStore({ databasePath: path });
    reopened.initialize();
    try {
        assert.equal(reopened.findByTransactionId("testnet:jetton-transfer:001").paymentReference, "first");
        assert.throws(() => reopened.update(reopened.require("second").transition("MATCHED", {
            transactionId: "testnet:jetton-transfer:001", now: 2300
        })), /transaction/i);
        assert.equal(reopened.require("second").state, "PENDING");
    } finally {
        reopened.close();
    }
});

test("assigned transaction cannot be silently cleared or reassigned", (t) => {
    const { store } = fixture(t);
    store.save(row("owner"));
    const matched = store.update(store.require("owner").transition("MATCHED", {
        transactionId: "testnet:jetton-transfer:002", now: 2000
    }));
    assert.throws(() => store.update(PaymentIntent.fromStorageRecord({
        ...matched.toRecord(), transactionId: null
    }, matched.getExpectedStorageVersion())), /cannot be cleared or reassigned/);
    assert.throws(() => store.update(PaymentIntent.fromStorageRecord({
        ...matched.toRecord(), transactionId: "testnet:jetton-transfer:003"
    }, matched.getExpectedStorageVersion())), /cannot be cleared or reassigned/);
    assert.equal(store.require("owner").transactionId, "testnet:jetton-transfer:002");
});

test("unmatched intent can still be deleted and re-created under existing tombstone logic", (t) => {
    const { store } = fixture(t);
    store.save(row("abandoned"));
    assert.equal(store.delete("abandoned"), true);
    assert.equal(store.has("abandoned"), false);
    store.save(row("abandoned"));
    assert.equal(store.require("abandoned").state, "PENDING");
});
