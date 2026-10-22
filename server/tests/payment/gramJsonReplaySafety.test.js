import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaymentIntentStore } from "../../payment/PaymentIntentStore.js";
import { PaymentIntent } from "../../payment/PaymentIntent.js";

function makeIntent(ref) {
    return new PaymentIntent({
        paymentReference: ref, roomId: "room-1", playerId: ref,
        network: "testnet", asset: "GRAM",
        destinationWalletId: "room-wallet-1",
        destinationWalletAddress: "0:" + "c".repeat(64),
        expectedSender: "0:" + "b".repeat(64),
        amountAtomic: 1500000000,
        createdAt: 1000, expiresAt: 5000, roomDeadlineMs: 7000,
        state: "PENDING"
    });
}

test("active JSON store retains GRAM transaction deduplication after restart", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "wheelwin-gram-json-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const store = new PaymentIntentStore({ dataDir: dir });
    store.initialize();
    store.save(makeIntent("payment_a"));
    store.save(makeIntent("payment_b"));

    store.update(store.require("payment_a").transition("MATCHED", {
        now: 2000, transactionId: "testnet:jetton:001"
    }));
    assert.throws(() => store.delete("payment_a"), /cannot delete/);
    assert.throws(() => store.update(store.require("payment_b").transition("MATCHED", {
        now: 2000, transactionId: "testnet:jetton:001"
    })), /payment reference already exists|transaction/i);

    const restored = new PaymentIntentStore({ dataDir: dir });
    restored.initialize();
    assert.equal(restored.findByTransactionId("testnet:jetton:001").paymentReference, "payment_a");
    assert.throws(() => restored.delete("payment_a"), /cannot delete/);
    assert.equal(restored.require("payment_b").state, "PENDING");

    const matched = restored.require("payment_a");
    const forged = PaymentIntent.fromRecord({
        ...matched.toRecord(), transactionId: "testnet:jetton:002"
    });
    assert.throws(() => restored.update(forged), /cannot be cleared or reassigned/);

    const cleared = PaymentIntent.fromRecord({
        ...matched.toRecord(), transactionId: null
    });
    assert.throws(() => restored.update(cleared), /cannot be cleared or reassigned/);

    assert.equal(restored.delete("payment_b"), true);
});
