import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaymentIntentStore } from "../../payment/PaymentIntentStore.js";
import { PaymentIntent } from "../../payment/PaymentIntent.js";
import { SqlitePaymentIntentStore } from "../../payment/SqlitePaymentIntentStore.js";
import { stageJsonPaymentIntentsToSqlite } from "../../payment/migration/StageJsonPaymentIntentsToSqlite.js";

function record(ref) {
    return new PaymentIntent({
        paymentReference: ref,
        roomId: "room-A",
        playerId: ref,
        asset: "GRAM",
        network: "testnet",
        destinationWalletId: "room-wallet-1",
        destinationWalletAddress: "0:" + "a".repeat(64),
        expectedSender: "0:" + "b".repeat(64),
        amountAtomic: 1500000000,
        createdAt: 1000,
        expiresAt: 5000,
        roomDeadlineMs: 7000
    });
}

test("staging copies matching and pending GRAM intents without changing JSON source", (t) => {
    const root = mkdtempSync(join(tmpdir(), "wheelwin-gram-stage-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const source = join(root, "active");
    const target = join(root, "isolated-copy");
    const store = new PaymentIntentStore({ dataDir: source });
    store.initialize();
    store.save(record("player-A"));
    store.save(record("player-B"));
    store.update(store.require("player-A").transition("MATCHED", {
        transactionId: "testnet-gram-tx-A", now: 2000
    }));
    const first = readFileSync(join(source, "payment-intents", "player-A.json"));
    const second = readFileSync(join(source, "payment-intents", "player-B.json"));

    const result = stageJsonPaymentIntentsToSqlite({
        sourceDataDir: source, stagingDir: target
    });
    assert.equal(result.recordCount, 2);
    assert.equal(result.staged, true);
    assert.equal(result.cutoverAuthorized, false);
    assert.equal(result.paymentAcceptanceEnabled, false);
    assert.equal(result.sourceDigest, result.stagedDigest);
    assert.deepEqual(readFileSync(join(source, "payment-intents", "player-A.json")), first);
    assert.deepEqual(readFileSync(join(source, "payment-intents", "player-B.json")), second);

    const migrated = new SqlitePaymentIntentStore({
        databasePath: join(target, "payment-intents.sqlite")
    });
    migrated.initialize();
    assert.equal(migrated.require("player-A").transactionId, "testnet-gram-tx-A");
    assert.equal(migrated.require("player-B").state, "PENDING");
    migrated.close();
    assert.throws(() => stageJsonPaymentIntentsToSqlite({
        sourceDataDir: source, stagingDir: target
    }), /already exists/);
});

test("staging never writes inside source tree or overwrites an existing destination", (t) => {
    const root = mkdtempSync(join(tmpdir(), "wheelwin-gram-stage-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const source = join(root, "active");
    const store = new PaymentIntentStore({ dataDir: source });
    store.initialize();
    store.save(record("player-A"));
    assert.throws(() => stageJsonPaymentIntentsToSqlite({
        sourceDataDir: source, stagingDir: join(source, "staged")
    }), /must not overlap/);
    assert.throws(() => stageJsonPaymentIntentsToSqlite({
        sourceDataDir: source, stagingDir: root
    }), /must not overlap/);
    assert.throws(() => stageJsonPaymentIntentsToSqlite({
        sourceDataDir: source, stagingDir: source
    }), /must not overlap/);
    assert.equal(existsSync(join(source, "payment-intents", "player-A.json")), true);
});

test("missing JSON source fails without creating a staging SQLite database", (t) => {
    const root = mkdtempSync(join(tmpdir(), "wheelwin-gram-stage-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const target = join(root, "staged");
    assert.throws(() => stageJsonPaymentIntentsToSqlite({
        sourceDataDir: join(root, "absent"), stagingDir: target
    }), /No source JSON/);
    assert.equal(existsSync(target), false);
});
