import assert from "node:assert/strict";
import { fork } from "node:child_process";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PaymentIntent } from "../../payment/PaymentIntent.js";
import {
    PaymentIntentStorageConflictError,
    SqlitePaymentIntentStore
} from "../../payment/SqlitePaymentIntentStore.js";
import {
    CorruptedPaymentRecordError,
    PaymentIntentNotFoundError,
    PaymentReferenceCollisionError,
    PaymentStorageError,
    PaymentValidationError,
    TransactionAlreadyCreditedError
} from "../../payment/PaymentErrors.js";
import { SQLITE_PAYMENT_INTENT_SCHEMA_VERSION } from "../../payment/SqlitePaymentIntentStore.js";

const THIS_FILE = fileURLToPath(import.meta.url);
let assertions = 0;
let sections = 0;

function check(value, message) { assert.equal(value, true, message); assertions += 1; }
function deepCheck(actual, expected, message) { assert.deepEqual(actual, expected, message); assertions += 1; }
function throwsAs(fn, type, message) {
    let error;
    try { fn(); } catch (caught) { error = caught; }
    check(error instanceof type, message);
    return error;
}
function recordFor(ref, overrides = {}) {
    return {
        schemaVersion: 1, paymentReference: ref, roomId: `room-${ref}`,
        playerId: `player-${ref}`, network: "testnet",
        destinationWalletId: `wallet-${ref}`,
        destinationWalletAddress: `synthetic-address-${ref}`,
        expectedSender: `synthetic-sender-${ref}`, amountAtomic: 1000,
        asset: "TON", createdAt: 1000, expiresAt: 5000,
        roomDeadlineMs: 7000, state: "PENDING", transactionId: null,
        updatedAt: null, ...overrides
    };
}
function makeTemp() {
    const directory = mkdtempSync(join(tmpdir(), "wheelwin-sqlite-intents-"));
    return { directory, databasePath: join(directory, "synthetic.sqlite") };
}
function makeStore(databasePath) {
    const store = new SqlitePaymentIntentStore({ databasePath });
    store.initialize();
    return store;
}
function databaseSnapshot(databasePath) {
    const db = new Database(databasePath);
    try {
        const schema = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
            WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all();
        const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
            AND name NOT LIKE 'sqlite_%' ORDER BY name`).all();
        const rows = tables.map(({ name }) => {
            const quoted = `"${name.replaceAll('"', '""')}"`;
            return [name, db.prepare(`SELECT * FROM ${quoted}`).all()]
                .map((entry) => entry);
        });
        return { schema, rows };
    } finally { db.close(); }
}
function expectInitializationRejectedUnchanged(databasePath, ErrorType, message) {
    const before = databaseSnapshot(databasePath);
    const store = new SqlitePaymentIntentStore({ databasePath });
    throwsAs(() => store.initialize(), ErrorType, `${message}: initialization rejects`);
    deepCheck(databaseSnapshot(databasePath), before, `${message}: schema and rows remain unchanged`);
}
async function section(name, fn) {
    await fn(); sections += 1; console.log(`[${sections}] ${name}: PASS`);
}
function worker(databasePath, mode, payload = {}) {
    return new Promise((resolve, reject) => {
        const child = fork(THIS_FILE, ["--worker", databasePath, mode, JSON.stringify(payload)], {
            stdio: ["ignore", "inherit", "inherit", "ipc"]
        });
        const messages = [];
        child.on("message", (message) => {
            messages.push(message);
            if (message.done) resolve({ child, messages, result: message });
        });
        child.on("error", reject);
        child.on("exit", (code) => {
            if (code !== 0) reject(new Error(`worker ${mode} exited ${code}: ${JSON.stringify(messages)}`));
        });
        child._messages = messages;
    });
}
function startWorker(databasePath, mode, payload = {}) {
    const child = fork(THIS_FILE, ["--worker", databasePath, mode, JSON.stringify(payload)], {
        stdio: ["ignore", "inherit", "inherit", "ipc"]
    });
    const queue = [];
    const waiters = [];
    let finish;
    const done = new Promise((resolve) => { finish = resolve; });
    child.on("message", (message) => {
        if (message.done) finish(message);
        const waiter = waiters.shift();
        if (waiter) waiter(message); else queue.push(message);
    });
    const next = () => queue.length ? Promise.resolve(queue.shift())
        : new Promise((resolve) => waiters.push(resolve));
    return { child, next, done };
}
function send(child, message) { child.send(message); }
function stopChild(child) { if (child.connected) child.disconnect(); }

async function workerMain() {
    const [, , , databasePath, mode, serialized] = process.argv;
    const payload = JSON.parse(serialized);
    const store = makeStore(databasePath);
    const reply = (value) => { process.send({ ...value, done: true }); };
    if (mode === "race" || mode === "compete") {
        const original = store.require(payload.reference);
        process.send({ ready: true, version: original.getExpectedStorageVersion(), record: original.toRecord() });
        process.once("message", ({ go, state, transactionId }) => {
            try {
                const next = original.transition(state, { transactionId, now: 2000 });
                store.update(next);
                reply({ success: true, state, current: store.require(payload.reference).toRecord() });
            } catch (error) {
                reply({ success: false, error: error.name, code: error.code, message: error.message });
            } finally { store.close(); }
        });
        return;
    }
    if (mode === "save-race") {
        process.send({ ready: true });
        process.once("message", () => {
            try { store.save(new PaymentIntent(payload.record)); reply({ success: true }); }
            catch (error) { reply({ success: false, error: error.name, code: error.code }); }
            finally { store.close(); }
        });
        return;
    }
    if (mode === "snapshot") {
        const intent = store.get(payload.reference);
        const result = {
            has: store.has(payload.reference),
            record: intent?.toRecord() ?? null,
            version: intent?.getExpectedStorageVersion() ?? null,
            requiredVersion: store.require(payload.reference).getExpectedStorageVersion(),
            list: store.list().map((item) => item.paymentReference),
            roomList: store.listForRoom(payload.roomId).map((item) => item.paymentReference),
            size: store.size,
            transactionFound: store.findByTransactionId(payload.transactionId)?.paymentReference ?? null,
            credited: store.hasTransactionBeenCredited(payload.transactionId),
            creditedList: [...store.listCreditedTransactions()]
        };
        store.close(); reply({ success: true, result }); return;
    }
    if (mode === "inspect-many") {
        const records = store.list().map((intent) => intent.toRecord());
        const result = {
            size: store.size,
            records,
            selected: payload.references.map((reference) => store.get(reference)?.toRecord() ?? null),
            transactionOwner: payload.transactionId
                ? store.findByTransactionId(payload.transactionId)?.paymentReference ?? null
                : null,
            creditedTransactions: [...store.listCreditedTransactions()]
        };
        store.close(); reply({ success: true, result }); return;
    }
    if (mode === "tx-race") {
        const original = store.require(payload.reference);
        process.send({ ready: true, version: original.getExpectedStorageVersion() });
        process.once("message", () => {
            try {
                const matched = original.transition("MATCHED", {
                    transactionId: payload.transactionId, now: 2000
                });
                const committed = store.update(matched);
                reply({ success: true, version: committed.getExpectedStorageVersion() });
            } catch (error) {
                reply({ success: false, error: error.name, code: error.code, message: error.message });
            } finally { store.close(); }
        });
        return;
    }
    if (mode === "stale") {
        try { store.update(PaymentIntent.fromStorageRecord(payload.record, payload.version)); reply({ success: true }); }
        catch (error) { reply({ success: false, error: error.name, code: error.code }); }
        finally { store.close(); }
        return;
    }
    store.close(); reply({ success: false, error: `unknown mode ${mode}` });
}

if (process.argv[2] === "--worker") {
    workerMain().catch((error) => { process.send?.({ done: true, success: false, error: error.stack }); process.exitCode = 1; });
} else {
    run().catch((error) => { console.error(error); process.exitCode = 1; });
}

async function run() {

    await section("save and update return fresh committed storage versions", () => {
        const { directory, databasePath } = makeTemp();
        try {
            const store = makeStore(databasePath);
            const original = new PaymentIntent(recordFor("version-lifecycle"));
            const saved = store.save(original);
            check(saved !== original, "save returns a fresh committed PaymentIntent");
            check(original.getExpectedStorageVersion() === null, "save does not mutate the original object's metadata");
            check(saved.getExpectedStorageVersion() === 1, "save result carries storage version one");
            deepCheck(saved.toRecord(), recordFor("version-lifecycle"), "save result preserves exact business serialization");
            check(!Object.keys(saved.toRecord()).includes("storage_version"), "business serialization omits storage metadata");

            const matchedInput = saved.transition("MATCHED", {
                transactionId: "tx-version-lifecycle", now: 2000
            });
            const matched = store.update(matchedInput);
            check(matched !== matchedInput, "update returns a fresh committed PaymentIntent");
            check(matchedInput.getExpectedStorageVersion() === 1, "successful update leaves its input object stale");
            check(matched.getExpectedStorageVersion() === 2, "update result carries the committed next version");
            deepCheck(matched.toRecord(), {
                ...recordFor("version-lifecycle"), state: "MATCHED",
                transactionId: "tx-version-lifecycle", updatedAt: 2000
            }, "updated result retains the expected business record shape");

            throwsAs(() => store.update(matchedInput), PaymentIntentStorageConflictError,
                "retrying an already-used update object is a typed stale conflict");
            const afterRetry = store.require("version-lifecycle");
            check(afterRetry.state === "MATCHED" && afterRetry.transactionId === "tx-version-lifecycle",
                "stale retry leaves the committed authoritative row unchanged");
            check(afterRetry.getExpectedStorageVersion() === 2, "fresh read retains the committed version after retry");

            const settled = store.update(matched.transition("SETTLED", { now: 3000 }));
            check(settled.state === "SETTLED", "returned versioned instance supports the next transition");
            check(settled.getExpectedStorageVersion() === 3, "next transition returns its new committed version");
            check(store.require("version-lifecycle").getExpectedStorageVersion() === 3,
                "fresh read agrees with update return version");
            store.close();
        } finally { rmSync(directory, { recursive: true, force: true }); }
    });

    await section("empty database creates the complete verified schema", () => {
        const { directory, databasePath } = makeTemp();
        try {
            const store = makeStore(databasePath);
            const db = new Database(databasePath);
            const schemaVersion = db.prepare(
                "SELECT value FROM payment_intent_metadata WHERE key = 'schema_version'"
            ).get().value;
            const names = db.prepare(`SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'
                ORDER BY name`).all().map((row) => row.name);
            const intentColumns = db.pragma('table_info("payment_intent")');
            const txUnique = db.pragma("index_list('payment_intent')").some((index) => (
                index.unique === 1 && db.pragma(`index_info("${index.name}")`)
                    .map((column) => column.name).join("\0") === "transactionId"
            ));
            check(schemaVersion === SQLITE_PAYMENT_INTENT_SCHEMA_VERSION,
                "physical schema version is stored independently");
            deepCheck(names, ["payment_intent", "payment_intent_metadata", "payment_intent_room_idx", "payment_intent_tombstone"],
                "empty database receives exactly the expected schema objects");
            check(intentColumns.find((column) => column.name === "paymentReference")?.pk === 1
                && intentColumns.find((column) => column.name === "paymentReference")?.notnull === 1,
            "paymentReference is a non-null primary key");
            check(txUnique, "SQLite has a unique index for transactionId");
            db.close(); store.close();
        } finally { rmSync(directory, { recursive: true, force: true }); }
    });

    await section("unsupported and partial physical schemas fail without changes", () => {
        const unsupported = makeTemp();
        try {
            makeStore(unsupported.databasePath).close();
            const db = new Database(unsupported.databasePath);
            db.prepare("UPDATE payment_intent_metadata SET value = 999 WHERE key = 'schema_version'").run();
            db.close();
            expectInitializationRejectedUnchanged(unsupported.databasePath, PaymentStorageError,
                "unsupported physical schema version");
        } finally { rmSync(unsupported.directory, { recursive: true, force: true }); }

        const partial = makeTemp();
        try {
            const db = new Database(partial.databasePath);
            db.exec("CREATE TABLE payment_intent (paymentReference TEXT PRIMARY KEY, roomId TEXT);");
            db.prepare("INSERT INTO payment_intent VALUES (?, ?)").run("partial-ref", "synthetic-room");
            db.close();
            expectInitializationRejectedUnchanged(partial.databasePath, PaymentStorageError,
                "partial schema without metadata");
        } finally { rmSync(partial.directory, { recursive: true, force: true }); }

        const missingIndex = makeTemp();
        try {
            makeStore(missingIndex.databasePath).close();
            const db = new Database(missingIndex.databasePath);
            db.exec("DROP INDEX payment_intent_room_idx");
            db.close();
            expectInitializationRejectedUnchanged(missingIndex.databasePath, PaymentStorageError,
                "supported metadata with a missing room index");
        } finally { rmSync(missingIndex.directory, { recursive: true, force: true }); }

        const missingTable = makeTemp();
        try {
            makeStore(missingTable.databasePath).close();
            const db = new Database(missingTable.databasePath);
            db.exec("DROP TABLE payment_intent_tombstone");
            db.close();
            expectInitializationRejectedUnchanged(missingTable.databasePath, PaymentStorageError,
                "supported metadata with a missing tombstone table");
        } finally { rmSync(missingTable.directory, { recursive: true, force: true }); }

        const missingUnique = makeTemp();
        try {
            makeStore(missingUnique.databasePath).close();
            const db = new Database(missingUnique.databasePath);
            db.exec(`BEGIN;
                CREATE TABLE payment_intent_rebuilt (
                    paymentReference TEXT NOT NULL PRIMARY KEY,
                    schemaVersion INTEGER NOT NULL, roomId TEXT NOT NULL, playerId TEXT NOT NULL,
                    network TEXT NOT NULL, destinationWalletId TEXT NOT NULL,
                    destinationWalletAddress TEXT NOT NULL, expectedSender TEXT NOT NULL,
                    amountAtomic INTEGER NOT NULL, asset TEXT NOT NULL, createdAt INTEGER NOT NULL,
                    expiresAt INTEGER NOT NULL, roomDeadlineMs INTEGER NOT NULL, state TEXT NOT NULL,
                    transactionId TEXT, updatedAt INTEGER,
                    storage_version INTEGER NOT NULL CHECK (storage_version >= 1)
                );
                INSERT INTO payment_intent_rebuilt SELECT * FROM payment_intent;
                DROP TABLE payment_intent;
                ALTER TABLE payment_intent_rebuilt RENAME TO payment_intent;
                CREATE INDEX payment_intent_room_idx ON payment_intent(roomId, paymentReference);
                COMMIT;`);
            db.close();
            expectInitializationRejectedUnchanged(missingUnique.databasePath, PaymentStorageError,
                "supported metadata with a missing transaction uniqueness constraint");
        } finally { rmSync(missingUnique.directory, { recursive: true, force: true }); }
    });

    await section("business record schema version is enforced on writes, reads, and initialization", () => {
        const { directory, databasePath } = makeTemp();
        try {
            const store = makeStore(databasePath);
            const invalidRecord = recordFor("unsupported-business-save", { schemaVersion: 999 });
            throwsAs(() => store.save(new PaymentIntent(invalidRecord)), PaymentValidationError,
                "save rejects an unsupported business schema version");
            check(store.size === 0, "rejected business schema save creates no row");

            const valid = store.save(new PaymentIntent(recordFor("business-update")));
            const invalidUpdate = PaymentIntent.fromStorageRecord({
                ...valid.toRecord(), schemaVersion: 999, state: "FAILED", updatedAt: 2000
            }, valid.getExpectedStorageVersion());
            throwsAs(() => store.update(invalidUpdate), PaymentValidationError,
                "update rejects an unsupported business schema version");
            check(store.require("business-update").state === "PENDING",
                "rejected business schema update leaves row unchanged");

            const beforeRead = databaseSnapshot(databasePath);
            const admin = new Database(databasePath);
            admin.prepare("UPDATE payment_intent SET schemaVersion = 999 WHERE paymentReference = ?")
                .run("business-update");
            admin.close();
            throwsAs(() => store.get("business-update"), CorruptedPaymentRecordError,
                "ordinary reads reject an unsupported stored business schema version");
            check(databaseSnapshot(databasePath).rows[0][1][0].schemaVersion === 999,
                "failed read does not rewrite an unsupported business record");
            store.close();

            const beforeInit = databaseSnapshot(databasePath);
            expectInitializationRejectedUnchanged(databasePath, CorruptedPaymentRecordError,
                "initialization with an unsupported stored business schema version");
            deepCheck(databaseSnapshot(databasePath), beforeInit,
                "rejected initialization preserves unsupported row contents");
        } finally { rmSync(directory, { recursive: true, force: true }); }
    });

    await section("absolute database path and SQLite initialization", () => {
        throwsAs(() => new SqlitePaymentIntentStore(), PaymentValidationError, "missing path is rejected");
        throwsAs(() => new SqlitePaymentIntentStore({ databasePath: "relative.sqlite" }), PaymentValidationError,
            "relative path is rejected");
        const { directory, databasePath } = makeTemp();
        try {
            const store = makeStore(databasePath);
            check(store.dataDir === dirname(databasePath), "dataDir is the database parent directory");
            check(store.intentsDir === databasePath, "intentsDir identifies the SQLite file");
            store.close();
        } finally { rmSync(directory, { recursive: true, force: true }); }
    });

    await section("stale cross-process writer cannot replace MATCHED", async () => {
        const { directory, databasePath } = makeTemp();
        try {
            const store = makeStore(databasePath);
            store.save(new PaymentIntent(recordFor("stale-race")));
            store.close();
            const newer = startWorker(databasePath, "race", { reference: "stale-race" });
            const stale = startWorker(databasePath, "race", { reference: "stale-race" });
            const newerReady = await newer.next();
            const staleReady = await stale.next();
            check(newerReady.version === staleReady.version, "separate processes read the same generation");
            send(newer.child, { go: true, state: "MATCHED", transactionId: "tx-newer" });
            const newerResult = await newer.done;
            check(newerResult.success, "newer MATCHED writer commits");
            send(stale.child, { go: true, state: "FAILED", transactionId: null });
            const staleResult = await stale.done;
            check(!staleResult.success && staleResult.error === "PaymentIntentStorageConflictError",
                "stale FAILED writer receives typed conflict");
            const fresh = await worker(databasePath, "snapshot", {
                reference: "stale-race", roomId: "room-stale-race", transactionId: "tx-newer"
            });
            check(fresh.result.result.record.state === "MATCHED", "fresh process observes MATCHED");
            check(fresh.result.result.record.transactionId === "tx-newer", "fresh process observes tx-newer");
            stopChild(newer.child); stopChild(stale.child);
        } finally { rmSync(directory, { recursive: true, force: true }); }
    });

    await section("competing valid cross-process transitions use one CAS winner", async () => {
        const { directory, databasePath } = makeTemp();
        try {
            const store = makeStore(databasePath); store.save(new PaymentIntent(recordFor("competing"))); store.close();
            const a = startWorker(databasePath, "compete", { reference: "competing" });
            const b = startWorker(databasePath, "compete", { reference: "competing" });
            const ar = await a.next(); const br = await b.next();
            check(ar.version === br.version, "competing processes share one expected generation");
            send(a.child, { go: true, state: "MATCHED", transactionId: "tx-a" });
            send(b.child, { go: true, state: "FAILED", transactionId: null });
            const [ra, rb] = await Promise.all([a.done, b.done]);
            check(Number(ra.success) + Number(rb.success) === 1, "exactly one competing update succeeds");
            const loser = ra.success ? rb : ra;
            check(loser.error === "PaymentIntentStorageConflictError", "loser fails with stale version conflict");
            const fresh = await worker(databasePath, "inspect-many", {
                references: ["competing"], transactionId: null
            });
            const persisted = fresh.result.result;
            check(persisted.size === 1 && persisted.records.length === 1,
                "fresh process sees exactly one authoritative competing row");
            check(persisted.records[0].state === (ra.success ? "MATCHED" : "FAILED"),
                "fresh process sees the winning competing state");
            check(persisted.records[0].transactionId === (ra.success ? "tx-a" : null),
                "fresh process sees the winning transaction binding");
            stopChild(a.child); stopChild(b.child);
        } finally { rmSync(directory, { recursive: true, force: true }); }
    });

    await section("concurrent duplicate reference save has one winner", async () => {
        const { directory, databasePath } = makeTemp();
        try {
            makeStore(databasePath).close();
            const a = startWorker(databasePath, "save-race", { record: recordFor("same-ref", { playerId: "player-a" }) });
            const b = startWorker(databasePath, "save-race", { record: recordFor("same-ref", { playerId: "player-b" }) });
            await a.next(); await b.next();
            send(a.child, { go: true }); send(b.child, { go: true });
            const [ra, rb] = await Promise.all([a.done, b.done]);
            check(Number(ra.success) + Number(rb.success) === 1, "only one process creates payment reference");
            const collision = ra.success ? rb : ra;
            check(collision.error === "PaymentReferenceCollisionError", "losing save receives reference collision");
            const fresh = await worker(databasePath, "inspect-many", {
                references: ["same-ref"], transactionId: null
            });
            const persisted = fresh.result.result;
            check(persisted.size === 1 && persisted.records.length === 1,
                "fresh process sees exactly one row after duplicate save race");
            check(persisted.records[0].playerId === (ra.success ? "player-a" : "player-b"),
                "fresh process sees the record belonging to the winning save");
            stopChild(a.child); stopChild(b.child);
        } finally { rmSync(directory, { recursive: true, force: true }); }
    });

    await section("cross-process transaction-ID uniqueness has one durable owner", async () => {
        const { directory, databasePath } = makeTemp();
        try {
            const store = makeStore(databasePath);
            store.save(new PaymentIntent(recordFor("tx-race-a")));
            store.save(new PaymentIntent(recordFor("tx-race-b")));
            store.close();
            const a = startWorker(databasePath, "tx-race", {
                reference: "tx-race-a", transactionId: "tx-competing-binding"
            });
            const b = startWorker(databasePath, "tx-race", {
                reference: "tx-race-b", transactionId: "tx-competing-binding"
            });
            const ar = await a.next(); const br = await b.next();
            check(ar.version === br.version && ar.version === 1,
                "both processes load their own expected storage versions before release");
            send(a.child, { go: true }); send(b.child, { go: true });
            const [ra, rb] = await Promise.all([a.done, b.done]);
            check(Number(ra.success) + Number(rb.success) === 1,
                "exactly one competing transaction binding commits");
            const loser = ra.success ? rb : ra;
            check(loser.error === "TransactionAlreadyCreditedError",
                "losing transaction binding receives the typed uniqueness error");

            const fresh = await worker(databasePath, "inspect-many", {
                references: ["tx-race-a", "tx-race-b"], transactionId: "tx-competing-binding"
            });
            const persisted = fresh.result.result;
            const [first, second] = persisted.selected;
            const owner = ra.success ? "tx-race-a" : "tx-race-b";
            const nonOwner = ra.success ? "tx-race-b" : "tx-race-a";
            check(persisted.size === 2 && persisted.records.length === 2,
                "fresh process sees both intents after the competing updates");
            check(persisted.transactionOwner === owner,
                "fresh process finds the transaction bound to exactly the winner");
            check([...persisted.creditedTransactions].filter(([tx]) => tx === "tx-competing-binding").length === 1,
                "fresh credited-transaction index has one binding");
            check(persisted.records.find((record) => record.paymentReference === owner)?.state === "MATCHED",
                "winning intent has a complete MATCHED record");
            check(persisted.records.find((record) => record.paymentReference === owner)?.transactionId
                === "tx-competing-binding", "winning record contains the complete transaction ID");
            check(persisted.records.find((record) => record.paymentReference === nonOwner)?.state === "PENDING"
                && persisted.records.find((record) => record.paymentReference === nonOwner)?.transactionId === null,
            "losing intent remains unchanged without a partial binding");
            stopChild(a.child); stopChild(b.child);
        } finally { rmSync(directory, { recursive: true, force: true }); }
    });

    await section("all immutable identity and timing fields are rejected", () => {
        const { directory, databasePath } = makeTemp();
        try {
            const store = makeStore(databasePath);
            store.save(new PaymentIntent(recordFor("immutable")));
            const baseline = store.require("immutable").toRecord();
            const changes = {
                schemaVersion: 2, paymentReference: "other-reference", roomId: "other-room",
                playerId: "other-player", network: "mainnet", destinationWalletId: "other-wallet",
                destinationWalletAddress: "other-address", expectedSender: "other-sender",
                amountAtomic: 1001, asset: "OTHER", createdAt: 1001, expiresAt: 5001,
                roomDeadlineMs: 7001
            };
            for (const [field, value] of Object.entries(changes)) {
                const changed = PaymentIntent.fromStorageRecord({ ...baseline, [field]: value }, 1);
                let failed = false;
                try { store.update(changed); } catch { failed = true; }
                check(failed, `${field} mutation is rejected`);
                deepCheck(store.require("immutable").toRecord(), baseline, `${field} rejection leaves row unchanged`);
            }
            store.close();
        } finally { rmSync(directory, { recursive: true, force: true }); }
    });

    await section("transaction binding, stale clearing, and rollback", () => {
        const { directory, databasePath } = makeTemp();
        try {
            const store = makeStore(databasePath);
            store.save(new PaymentIntent(recordFor("tx-one")));
            store.save(new PaymentIntent(recordFor("tx-two")));
            const firstPending = store.require("tx-one");
            const staleNext = firstPending.transition("FAILED", { now: 2100 });
            const matched = firstPending.transition("MATCHED", { transactionId: "tx-bound", now: 2000 });
            store.update(matched);
            throwsAs(() => store.update(staleNext), PaymentIntentStorageConflictError,
                "stale update cannot erase committed transaction ID");
            const second = store.require("tx-two");
            throwsAs(() => store.update(second.transition("MATCHED", { transactionId: "tx-bound", now: 2000 })),
                TransactionAlreadyCreditedError, "transaction ID cannot bind to two intents");
            check(store.require("tx-one").transactionId === "tx-bound", "first binding remains intact");
            check(store.require("tx-two").state === "PENDING" && store.require("tx-two").transactionId === null,
                "failed duplicate binding leaves second record unchanged");
            store.close();
        } finally { rmSync(directory, { recursive: true, force: true }); }
    });

    await section("restart in a new process preserves read contracts and version", async () => {
        const { directory, databasePath } = makeTemp();
        try {
            const store = makeStore(databasePath);
            store.save(new PaymentIntent(recordFor("restart-a", { roomId: "room-shared" })));
            store.save(new PaymentIntent(recordFor("restart-b", { roomId: "room-shared" })));
            store.update(store.require("restart-a").transition("MATCHED", { transactionId: "tx-restart", now: 2000 }));
            const version = store.require("restart-a").getExpectedStorageVersion();
            store.close();
            const fresh = await worker(databasePath, "snapshot", {
                reference: "restart-a", roomId: "room-shared", transactionId: "tx-restart"
            });
            const result = fresh.result.result;
            check(result.has && result.record.state === "MATCHED", "get returns authoritative persisted state");
            check(result.requiredVersion === version && result.version === version, "get and require carry expected storage version");
            deepCheck(result.list, ["restart-a", "restart-b"], "list returns all authoritative rows");
            deepCheck(result.roomList, ["restart-a", "restart-b"], "listForRoom returns matching room rows");
            check(result.size === 2, "size reads authoritative row count");
            check(result.transactionFound === "restart-a" && result.credited, "transaction lookup and credited check work");
            deepCheck(result.creditedList, [["tx-restart", "restart-a"]], "credited transactions map is authoritative");
        } finally { rmSync(directory, { recursive: true, force: true }); }
    });

    await section("delete and recreate advance tombstone version against old writers", async () => {
        const { directory, databasePath } = makeTemp();
        try {
            const store = makeStore(databasePath);
            store.save(new PaymentIntent(recordFor("recreated")));
            const old = store.require("recreated");
            const oldVersion = old.getExpectedStorageVersion();
            check(store.delete("recreated"), "active row is deleted");
            check(!store.has("recreated"), "deleted row is no longer active");
            store.save(new PaymentIntent(recordFor("recreated", { playerId: "new-player" })));
            const freshVersion = store.require("recreated").getExpectedStorageVersion();
            check(freshVersion > oldVersion, "recreation advances beyond tombstone version");
            throwsAs(() => store.update(old.transition("FAILED", { now: 2100 })), PaymentIntentStorageConflictError,
                "pre-delete object cannot update recreated row");
            const expectedAfterClose = store.require("recreated").toRecord();
            store.close();
            const verify = await worker(databasePath, "snapshot", {
                reference: "recreated", roomId: "room-recreated", transactionId: "none"
            });
            deepCheck(verify.result.result.record, expectedAfterClose, "fresh process sees recreated durable record");
            check(verify.result.result.version === freshVersion, "fresh process sees advanced version");
        } finally { rmSync(directory, { recursive: true, force: true }); }
    });

    await section("unversioned updates and missing records fail closed", () => {
        const { directory, databasePath } = makeTemp();
        try {
            const store = makeStore(databasePath);
            const unversioned = new PaymentIntent(recordFor("unversioned"));
            store.save(unversioned);
            throwsAs(() => store.update(unversioned.transition("FAILED", { now: 2000 })), PaymentValidationError,
                "unversioned update is rejected");
            throwsAs(() => store.require("missing"), PaymentIntentNotFoundError, "require rejects missing intent");
            check(!store.delete("missing"), "deleting missing intent returns false");
            store.close();
        } finally { rmSync(directory, { recursive: true, force: true }); }
    });

    console.log(`PASS: ${sections} sections, ${assertions} assertions`);
}
