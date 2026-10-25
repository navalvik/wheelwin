import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PaymentIntent } from "../payment/PaymentIntent.js";
import { SqlitePaymentIntentStore } from "../payment/SqlitePaymentIntentStore.js";
import { RefundObligationStore } from "../payment/refund/RefundObligationStore.js";
import { ProtectedRefundIntentJournal } from "../payment/refund/ProtectedRefundIntentJournal.js";

const ROOT = "0:" + "a".repeat(64);
const OLGA = "0:" + "b".repeat(64);
const LENA = "0:" + "c".repeat(64);
const NOW = 1_790_000_000_000;
const H = "e".repeat(64);
const THIS = fileURLToPath(import.meta.url);

function harness(t) {
    const dir = mkdtempSync(join(tmpdir(), "wheelwin-protected-refund-"));
    const sqlite = join(dir, "payment.sqlite");
    const refundDir = join(dir, "refunds");
    const journalDir = join(dir, "journal");
    let intents, refunds;
    function open() {
        intents = new SqlitePaymentIntentStore({ databasePath: sqlite });
        intents.initialize();
        refunds = new RefundObligationStore({ dataDir: refundDir });
        refunds.initialize();
        return new ProtectedRefundIntentJournal({
            directory: journalDir, refundStore: refunds, intentStore: intents
        });
    }
    const journal = open();
    t.after(() => {
        intents?.close();
        rmSync(dir, { recursive: true, force: true });
    });
    function seed({ player = "Olga", address = OLGA, suffix = "1",
        closed = true, gross = 1_000_000_000, destination = ROOT,
        state = "SETTLED", asset = "GRAM" } = {}) {
        const paymentReference = "pay-" + suffix;
        const incomingTransactionId = "tx-" + suffix;
        intents.save(new PaymentIntent({
            paymentReference, roomId: "oj7v", playerId: player,
            network: "testnet", destinationWalletId: "room-wallet-1",
            destinationWalletAddress: destination, expectedSender: address,
            amountAtomic: gross, asset,
            createdAt: NOW, expiresAt: NOW + 300000,
            roomDeadlineMs: NOW + 300000,
            state, transactionId: state === "SETTLED" ? incomingTransactionId : null
        }));
        if (closed && !refunds.getClosedRoom("oj7v")) {
            refunds.recordClosedRoom({
                roomId: "oj7v", roomNumber: 1,
                closureReason: "setup_timeout", closedAtMs: NOW + 300001,
                networkName: "TESTNET", globalId: -3
            });
        }
        const obligationId = "rfd_" + suffix.repeat(32).slice(0,32);
        refunds.create({
            schemaVersion: 1, obligationId,
            idempotencyKey: "TESTNET:" + paymentReference + ":" + incomingTransactionId,
            networkName: "TESTNET", globalId: -3, roomNumber: 1,
            roomId: "oj7v", playerId: player, paymentIntentId: paymentReference,
            incomingTransactionId, amountAtomic: gross, denomination: asset,
            payerAddress: address, refundDestination: address,
            closureReason: "setup_timeout", createdAtMs: NOW + 300010,
            state: "PENDING", attempts: [], outgoingTransactionId: null,
            finalizedEvidence: null, lastError: null
        });
        return obligationId;
    }
    return { dir, sqlite, refundDir, journalDir, open, journal, seed,
        reopen() { intents.close(); return open(); } };
}

test("live SQLite settled evidence and durable closed-room debt produce one immutable recipient-pays-gas plan", t => {
    const h = harness(t), id = h.seed({});
    const one = h.journal.plan({ obligationId: id, feeAtomic: 1_388_278, feeQuoteHash: H });
    assert.equal(one.created, true);
    const plan = h.journal.load(one.intentId);
    assert.equal(plan.fromWallet, ROOT);
    assert.equal(plan.toWallet, OLGA);
    assert.equal(plan.grossAtomic, 1_000_000_000);
    assert.equal(plan.feeAtomic, 1_388_278);
    assert.equal(plan.netAtomic, 998_611_722);
    assert.equal(plan.state, "PLANNED");
    assert.equal(h.journal.plan({ obligationId: id, feeAtomic: 1_388_278, feeQuoteHash: H }).created, false);
    assert.throws(() => h.journal.plan({ obligationId: id, feeAtomic: 0, feeQuoteHash: H }),
        { code: "REFUND_IMMUTABLE_PLAN_CONFLICT" });
    assert.throws(() => h.journal.plan({ obligationId: id, feeAtomic: 1_000_000_000, feeQuoteHash: H }),
        { code: "REFUND_FEE_INVALID" });
    assert.throws(() => h.journal.plan({ obligationId: id, feeAtomic: 0 }),
        { code: "REFUND_FEE_PROVENANCE_REQUIRED" });
});

test("signed identity is frozen and unknown after crash, with no automatic retry or unlock", t => {
    const h = harness(t), id = h.seed({});
    const { intentId } = h.journal.plan({ obligationId: id, feeAtomic: 123, feeQuoteHash: H });
    const lock = h.journal.claimWallet(intentId);
    assert.equal(lock.fromWallet, ROOT);
    assert.throws(() => h.journal.claimWallet(intentId),
        { code: "WALLET_ALREADY_LOCKED" });
    assert.throws(() => h.journal.holdSignedIdentity({
        intentId, ownerToken: "forged", signedHash: H, seqno: 4, validUntil: 1790000100
    }), { code: "REFUND_LOCK_OWNER_MISMATCH" });
    const signed = h.journal.holdSignedIdentity({
        intentId, ownerToken: lock.ownerToken,
        signedHash: H, seqno: 4, validUntil: 1790000100
    });
    assert.equal(signed.state, "SIGNED_HELD");
    assert.equal(signed.signedHash, H);
    assert.throws(() => h.journal.holdSignedIdentity({
        intentId, ownerToken: lock.ownerToken, signedHash: "a".repeat(64),
        seqno: 5, validUntil: 1790000200
    }), { code: "REFUND_ALREADY_SIGNED" });
    const unknown = h.journal.markUnknown({ intentId, ownerToken: lock.ownerToken });
    assert.equal(unknown.state, "CONFIRMATION_UNKNOWN");
    const second = h.reopen();
    assert.equal(second.load(intentId).seqno, 4);
    assert.equal(second.load(intentId).state, "CONFIRMATION_UNKNOWN");
    assert.throws(() => second.claimWallet(intentId), { code: "REFUND_ALREADY_HELD" });
    assert.equal(typeof second.broadcast, "undefined");
    assert.equal(typeof second.releaseWallet, "undefined");
    assert.equal(typeof second.signTransfer, "undefined");
});

test("different refund debts from the same wallet are serialized until chain-proof release exists", t => {
    const h = harness(t);
    const a = h.seed({ player: "Olga", suffix: "1" });
    const b = h.seed({ player: "Lena", address: LENA, suffix: "2" });
    const first = h.journal.plan({ obligationId: a, feeAtomic: 100, feeQuoteHash: H }).intentId;
    const second = h.journal.plan({ obligationId: b, feeAtomic: 100, feeQuoteHash: H }).intentId;
    h.journal.claimWallet(first);
    assert.throws(() => h.journal.claimWallet(second),
        { code: "WALLET_ALREADY_LOCKED" });
});

test("identity conflicts and missing closed-room evidence always fail closed", t => {
    const h = harness(t);
    const missing = h.seed({ suffix: "1", closed: false });
    assert.throws(() => h.journal.plan({ obligationId: missing, feeAtomic: 0, feeQuoteHash: H }),
        { code: "REFUND_ROOM_NOT_DURABLY_CLOSED" });
});
test("non-settled and non-native payment sources never authorize a refund plan", t => {
    const h = harness(t);
    const bad = h.seed({ suffix: "1", asset: "TON" });
    assert.throws(() => h.journal.plan({ obligationId: bad, feeAtomic: 0, feeQuoteHash: H }),
        { code: "REFUND_PAYMENT_INTENT_MISMATCH" });
});
test("tampered disk plan rejects read and replay rather than resetting it", t => {
    const h = harness(t), id = h.seed({});
    const intentId = h.journal.plan({ obligationId: id, feeAtomic: 1, feeQuoteHash: H }).intentId;
    const path = join(h.journalDir, "refund-intents", intentId + ".json");
    const raw = JSON.parse(readFileSync(path,"utf8"));
    raw.netAtomic = 999999998;
    writeFileSync(path, JSON.stringify(raw));
    assert.throws(() => h.journal.load(intentId), { code: "REFUND_JOURNAL_CORRUPT" });
});

test("two independent OS processes cannot claim the same wallet simultaneously", async t => {
    const h = harness(t), id = h.seed({});
    const intentId = h.journal.plan({ obligationId: id, feeAtomic: 1, feeQuoteHash: H }).intentId;
    const worker = fileURLToPath(new URL("./fixtures/protectedRefundAcquireWorker.mjs", import.meta.url));
    function launch() {
        return new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [worker, h.sqlite, h.refundDir, h.journalDir, intentId], {
                stdio: ["ignore", "pipe", "pipe"]
            });
            let stdout = "", stderr = "";
            child.stdout.on("data", b => stdout += b.toString());
            child.stderr.on("data", b => stderr += b.toString());
            child.on("error", reject);
            child.on("close", code => resolve({ code, stdout: stdout.trim(), stderr }));
        });
    }
    const pair = await Promise.all([launch(), launch()]);
    assert.equal(pair.filter(result => result.code === 0 && result.stdout === "CLAIMED").length, 1,
        JSON.stringify(pair));
    assert.equal(pair.filter(result => result.code === 2 && result.stdout === "WALLET_ALREADY_LOCKED").length, 1,
        JSON.stringify(pair));
    assert.throws(() => h.journal.claimWallet(intentId), { code: "WALLET_ALREADY_LOCKED" });
});
