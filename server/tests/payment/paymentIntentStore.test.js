import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    CorruptedPaymentRecordError,
    PaymentIntent,
    PaymentIntentNotFoundError,
    PaymentIntentStore,
    PaymentReferenceCollisionError,
    PaymentValidationError
} from "../../payment/index.js";

const IMMUTABLE_FIELDS = Object.freeze([
    "schemaVersion",
    "paymentReference",
    "roomId",
    "playerId",
    "expectedSender",
    "amountAtomic",
    "asset",
    "network",
    "destinationWalletId",
    "destinationWalletAddress",
    "createdAt",
    "expiresAt",
    "roomDeadlineMs"
]);

let assertions = 0;
let sections = 0;

function check(condition, message) {

    assert.equal(condition, true, message);
    assertions += 1;

}

function deepCheck(actual, expected, message) {

    assert.deepEqual(actual, expected, message);
    assertions += 1;

}

function throwsAs(fn, ErrorType, message) {

    let thrown;

    try {

        fn();

    } catch (error) {

        thrown = error;

    }

    check(thrown instanceof ErrorType, message);
    return thrown;

}

function recordFor(paymentReference, overrides = {}) {

    return {
        schemaVersion: 1,
        paymentReference,
        roomId: `room-${paymentReference}`,
        playerId: `player-${paymentReference}`,
        network: "testnet",
        destinationWalletId: `wallet-${paymentReference}`,
        destinationWalletAddress: `synthetic-wallet-address-${paymentReference}`,
        expectedSender: `synthetic-sender-${paymentReference}`,
        amountAtomic: 1_000_000_000,
        asset: "TON",
        createdAt: 1_000,
        expiresAt: 5_000,
        roomDeadlineMs: 7_000,
        state: "PENDING",
        transactionId: null,
        updatedAt: null,
        ...overrides
    };

}

function createStore() {

    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-intent-store-"));
    const store = new PaymentIntentStore({ dataDir, nowProvider: () => 2_000 });

    store.initialize();

    return { dataDir, store };

}

function persistedBytes(store, paymentReference) {

    const filePath = join(store.intentsDir, `${paymentReference}.json`);

    return existsSync(filePath) ? readFileSync(filePath, "utf8") : null;

}

function indexSnapshot(store, references) {

    return {
        size: store.size,
        records: store.list().map((intent) => intent.toRecord()),
        byReference: references.map((reference) => [
            reference,
            store.get(reference)?.toRecord() ?? null
        ]),
        transactionIndex: [...store.listCreditedTransactions()],
        disk: references.map((reference) => [reference, persistedBytes(store, reference)])
    };

}

function runSection(name, fn) {

    fn();
    sections += 1;
    console.log(`[${sections}] ${name}: PASS`);

}

runSection("PaymentIntent opaque storage-version metadata preserves business serialization", () => {

    const record = recordFor("pay-storage-version-model");
    const legacyConstructed = new PaymentIntent(record);
    const legacyDeserialized = PaymentIntent.fromRecord(record);
    const storageVersionFour = PaymentIntent.fromStorageRecord(record, 4);
    const storageVersionSeven = PaymentIntent.fromStorageRecord(record, 7);

    check(legacyConstructed.getExpectedStorageVersion() === null,
        "legacy constructor uses null for an unpersisted expected version");
    check(legacyDeserialized.getExpectedStorageVersion() === null,
        "fromRecord keeps its legacy unversioned behavior");
    deepCheck(legacyConstructed.toRecord(), record,
        "legacy constructor retains the exact business record shape");
    deepCheck(legacyDeserialized.toRecord(), record,
        "fromRecord retains the exact business record shape");

    check(Object.isFrozen(storageVersionFour),
        "storage-aware intents remain immutable");
    check(storageVersionFour.getExpectedStorageVersion() === 4,
        "storage-aware construction exposes the expected generation");
    throwsAs(
        () => { storageVersionFour.getExpectedStorageVersion = () => 99; },
        TypeError,
        "callers cannot replace the read-only storage metadata API"
    );
    check(storageVersionFour.getExpectedStorageVersion() === 4,
        "a failed metadata mutation leaves the expected generation unchanged");

    const transitioned = storageVersionFour.transition("FAILED", { now: 2_000 });
    check(Object.isFrozen(transitioned),
        "transition returns another immutable intent");
    check(transitioned.getExpectedStorageVersion() === 4,
        "transition preserves the source generation without incrementing it");
    deepCheck(transitioned.toRecord(), {
        ...record,
        state: "FAILED",
        updatedAt: 2_000
    }, "transition changes business state without serializing storage metadata");

    for (const invalidVersion of [
        -1,
        0,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
        "4"
    ]) {

        throwsAs(
            () => PaymentIntent.fromStorageRecord(record, invalidVersion),
            PaymentValidationError,
            `invalid expected version ${String(invalidVersion)} is rejected`
        );

    }

    deepCheck(storageVersionFour.toRecord(), storageVersionSeven.toRecord(),
        "equal business intents with different versions serialize identically");
    deepCheck(storageVersionFour.toRecord(), legacyConstructed.toRecord(),
        "storage-aware and legacy intents have structurally identical records");
    deepCheck(Object.keys(storageVersionFour.toRecord()), Object.keys(record),
        "storage version is absent from the established record field set");

    const refreshedAfterCommit = PaymentIntent.fromStorageRecord(
        storageVersionFour.toRecord(),
        5
    );
    check(refreshedAfterCommit.getExpectedStorageVersion() === 5,
        "a store can construct a fresh object carrying its committed generation");

});

runSection("save, lookup, duplicate reference, and restart recovery", () => {

    const { dataDir, store } = createStore();

    try {

        const saved = store.save(new PaymentIntent(recordFor("pay-store-a")));

        check(store.has("pay-store-a"), "save indexes the canonical reference");
        check(store.get("pay-store-a") === saved, "get returns the saved intent");
        check(store.require("pay-store-a") === saved, "require returns the saved intent");
        check(store.get("missing") === null, "get returns null for an unknown reference");
        throwsAs(
            () => store.save(new PaymentIntent(recordFor("pay-store-a"))),
            PaymentReferenceCollisionError,
            "save rejects a duplicate canonical reference"
        );

        const restarted = new PaymentIntentStore({ dataDir, nowProvider: () => 2_000 });
        restarted.initialize();
        const recovered = restarted.require("pay-store-a");

        deepCheck(
            recovered.toRecord(),
            saved.toRecord(),
            "the canonical persisted intent survives store restart"
        );

    } finally {

        rmSync(dataDir, { recursive: true, force: true });

    }

});

runSection("allowed mutable state and transaction updates", () => {

    const { dataDir, store } = createStore();

    try {

        const original = store.save(new PaymentIntent(recordFor("pay-store-mutable")));
        const matched = original.transition("MATCHED", {
            transactionId: "tx-synthetic-store-1",
            now: 2_100
        });
        const updated = store.update(matched);

        check(updated.state === "MATCHED", "a legal state transition is persisted");
        check(updated.updatedAt === 2_100, "updatedAt remains mutable through transition");
        check(
            store.findByTransactionId("tx-synthetic-store-1") === updated,
            "the transaction index is updated after a valid write"
        );

        const restarted = new PaymentIntentStore({ dataDir, nowProvider: () => 2_200 });
        restarted.initialize();

        check(
            restarted.findByTransactionId("tx-synthetic-store-1")?.paymentReference
                === "pay-store-mutable",
            "the transaction index survives restart"
        );

    } finally {

        rmSync(dataDir, { recursive: true, force: true });

    }

});

runSection("each immutable identity and original term is rejected without writes", () => {

    const changedValues = {
        schemaVersion: 2,
        paymentReference: "pay-store-renamed",
        roomId: "room-changed",
        playerId: "player-changed",
        expectedSender: "synthetic-sender-changed",
        amountAtomic: 2_000_000_000,
        asset: "OTHER",
        network: "othernet",
        destinationWalletId: "wallet-changed",
        destinationWalletAddress: "synthetic-wallet-address-changed",
        createdAt: 1_100,
        expiresAt: 5_500,
        roomDeadlineMs: 8_000
    };

    for (const field of IMMUTABLE_FIELDS) {

        const { dataDir, store } = createStore();
        const reference = `pay-store-immutable-${field}`;

        try {

            const saved = store.save(new PaymentIntent(recordFor(reference)));
            const before = indexSnapshot(store, [reference]);
            const changed = new PaymentIntent({
                ...saved.toRecord(),
                [field]: changedValues[field]
            });

            throwsAs(
                () => store.update(changed),
                field === "paymentReference"
                    ? PaymentIntentNotFoundError
                    : PaymentValidationError,
                `${field} cannot be changed by update()`
            );
            deepCheck(
                indexSnapshot(store, [reference]),
                before,
                `rejected ${field} change leaves record and indexes unchanged`
            );

        } finally {

            rmSync(dataDir, { recursive: true, force: true });

        }

    }

});

runSection("paymentReference cannot redirect an update to another stored intent", () => {

    const { dataDir, store } = createStore();

    try {

        const source = store.save(new PaymentIntent(recordFor("pay-store-source")));
        store.save(new PaymentIntent(recordFor("pay-store-target", {
            roomId: "room-target",
            playerId: "player-target"
        })));
        const before = indexSnapshot(store, ["pay-store-source", "pay-store-target"]);
        const redirected = new PaymentIntent({
            ...source.toRecord(),
            paymentReference: "pay-store-target"
        });

        throwsAs(
            () => store.update(redirected),
            PaymentValidationError,
            "a source intent cannot overwrite another reference's record"
        );
        deepCheck(
            indexSnapshot(store, ["pay-store-source", "pay-store-target"]),
            before,
            "redirect rejection preserves both persisted records and indexes"
        );

    } finally {

        rmSync(dataDir, { recursive: true, force: true });

    }

});

runSection("malformed persisted identity fails closed without changing indexes", () => {

    const { dataDir, store } = createStore();

    try {

        const original = store.save(new PaymentIntent(recordFor("pay-store-corrupt")));
        const filePath = join(store.intentsDir, "pay-store-corrupt.json");
        const malformedBytes = "{\"schemaVersion\":1,\"amountAtomic\":\"not-an-integer\"}\n";
        writeFileSync(filePath, malformedBytes, "utf8");
        const before = indexSnapshot(store, ["pay-store-corrupt"]);
        const next = original.transition("FAILED", { now: 2_100 });

        throwsAs(
            () => store.update(next),
            CorruptedPaymentRecordError,
            "an invalid persisted record prevents update()"
        );
        deepCheck(
            indexSnapshot(store, ["pay-store-corrupt"]),
            before,
            "malformed record bytes and all indexes remain unchanged"
        );

    } finally {

        rmSync(dataDir, { recursive: true, force: true });

    }

});

runSection("transaction uniqueness rejection preserves the original binding", () => {

    const { dataDir, store } = createStore();

    try {

        const first = store.save(new PaymentIntent(recordFor("pay-store-tx-a")));
        const second = store.save(new PaymentIntent(recordFor("pay-store-tx-b")));
        const credited = first.transition("MATCHED", {
            transactionId: "tx-synthetic-unique",
            now: 2_100
        });
        store.update(credited);
        const before = indexSnapshot(store, ["pay-store-tx-a", "pay-store-tx-b"]);
        const conflicting = second.transition("MATCHED", {
            transactionId: "tx-synthetic-unique",
            now: 2_200
        });

        throwsAs(
            () => store.update(conflicting),
            PaymentReferenceCollisionError,
            "a transaction cannot be rebound to a second intent"
        );
        deepCheck(
            indexSnapshot(store, ["pay-store-tx-a", "pay-store-tx-b"]),
            before,
            "transaction collision leaves both records and indexes unchanged"
        );

    } finally {

        rmSync(dataDir, { recursive: true, force: true });

    }

});

runSection("concurrent processes cannot replace a paymentReference winner", () => {

    const concurrencyScript = String.raw`
const fs = await import("node:fs");
const fsDefault = fs.default;
const fsp = await import("node:fs/promises");
const os = await import("node:os");
const path = await import("node:path");
const { spawn } = await import("node:child_process");

const worker = async function () {
    const fsDefault = (await import("node:fs")).default;
    const args = process.argv.slice(1);
    const mode = args[0];
    const dataDir = args[1];
    const readyPath = args[2];
    const gatePath = args[3];
    const resultPath = args[4];
    const wait = () => {
        const end = Date.now() + 15000;
        while (!fsDefault.existsSync(gatePath)) {
            if (Date.now() > end) throw new Error("worker gate timed out");
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
    };
    const report = (value) => fsDefault.writeFileSync(resultPath, JSON.stringify(value));
    try {
        const { PaymentIntentStore } = await import(process.env.PAYMENT_INTENT_STORE_URL);
        const { PaymentIntent } = await import(process.env.PAYMENT_INTENT_MODEL_URL);
        const store = new PaymentIntentStore({ dataDir });
        store.initialize();
        const intent = new PaymentIntent({
            schemaVersion: 1,
            paymentReference: "pay-concurrent-shared",
            roomId: mode === "paused" ? "room-paused" : "room-first",
            playerId: mode === "paused" ? "player-paused" : "player-first",
            network: "testnet",
            destinationWalletId: "synthetic-wallet",
            destinationWalletAddress: "synthetic-address",
            expectedSender: "synthetic-sender",
            amountAtomic: 1000000000,
            asset: "TON",
            createdAt: 1000,
            expiresAt: 5000,
            roomDeadlineMs: 7000,
            state: "PENDING",
            transactionId: null,
            updatedAt: null
        });
        if (mode === "paused") {
            const persist = store._writeNewToDisk.bind(store);
            store._writeNewToDisk = (value) => {
                fsDefault.writeFileSync(readyPath, "ready");
                wait();
                return persist(value);
            };
        }
        store.save(intent);
        report({ ok: true });
    } catch (error) {
        report({ ok: false, name: error?.name, code: error?.code });
    }
};

const workspace = fsDefault.mkdtempSync(path.join(os.tmpdir(), "wheelwin-save-race-"));
const dataDir = path.join(workspace, "data");
fsDefault.mkdirSync(dataDir, { recursive: true });
const readyPath = path.join(workspace, "paused-ready");
const gatePath = path.join(workspace, "release-paused");
const firstResultPath = path.join(workspace, "first-result.json");
const pausedResultPath = path.join(workspace, "paused-result.json");
const launch = (mode, resultPath) => {
    const child = spawn(process.execPath, [
        "--input-type=module", "-e", "(" + worker.toString() + ")()",
        mode, dataDir, readyPath, gatePath, resultPath
    ], { windowsHide: true, stdio: "inherit" });
    return new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", (status) => resolve(status));
    });
};
const waitForReady = async () => {
    const end = Date.now() + 15000;
    while (!fsDefault.existsSync(readyPath)) {
        if (Date.now() > end) throw new Error("parent timed out waiting for save barrier");
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
};

try {
    const paused = launch("paused", pausedResultPath);
    await waitForReady();
    const firstExit = await launch("first", firstResultPath);
    fsDefault.writeFileSync(gatePath, "go");
    const pausedExit = await paused;
    const first = JSON.parse(fsDefault.readFileSync(firstResultPath, "utf8"));
    const second = JSON.parse(fsDefault.readFileSync(pausedResultPath, "utf8"));
    const { PaymentIntentStore } = await import(process.env.PAYMENT_INTENT_STORE_URL);
    const fresh = new PaymentIntentStore({ dataDir });
    fresh.initialize();
    process.stdout.write("CONCURRENCY_RESULT:" + JSON.stringify({
        firstExit, pausedExit, first, second, size: fresh.size,
        finalRoomId: fresh.require("pay-concurrent-shared").roomId
    }) + "\n");
} finally {
    fsDefault.rmSync(workspace, { recursive: true, force: true });
}
`;

    const result = spawnSync(process.execPath, ["--input-type=module", "-e", concurrencyScript], {
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
        env: {
            ...process.env,
            PAYMENT_INTENT_STORE_URL: new URL("../../payment/PaymentIntentStore.js", import.meta.url).href,
            PAYMENT_INTENT_MODEL_URL: new URL("../../payment/PaymentIntent.js", import.meta.url).href
        }
    });

    check(result.error === undefined && result.status === 0,
        `cross-process workers complete successfully: ${result.stderr}`);

    const marker = result.stdout.split(/\r?\n/)
        .find((line) => line.startsWith("CONCURRENCY_RESULT:"));

    check(Boolean(marker), "a separate inspector process reports final persisted state");

    const outcome = JSON.parse(marker.slice("CONCURRENCY_RESULT:".length));

    check(outcome.first.ok, "the first process saves the reference");
    check(!outcome.second.ok && outcome.second.name === "PaymentReferenceCollisionError",
        "the competing process sees the persisted reference collision");
    check(outcome.size === 1, "the fresh process indexes one persisted intent");
    check(outcome.finalRoomId === "room-first", "the first persisted identity is immutable");

});

console.log(`PASS: ${sections} sections, ${assertions} assertions`);
