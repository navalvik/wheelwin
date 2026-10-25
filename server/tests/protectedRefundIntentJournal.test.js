import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Address, beginCell, external, internal, storeMessage, storeMessageRelaxed, SendMode } from "@ton/core";
import { PaymentIntent } from "../payment/PaymentIntent.js";
import { SqlitePaymentIntentStore } from "../payment/SqlitePaymentIntentStore.js";
import { RefundObligationStore } from "../payment/refund/RefundObligationStore.js";
import { ProtectedRefundIntentJournal } from "../payment/refund/ProtectedRefundIntentJournal.js";
import { assessProtectedRefundReceipt } from "../payment/refund/ProtectedRefundChainProof.js";

const ROOT = "0:" + "a".repeat(64);
const OLGA = "0:" + "b".repeat(64);
const LENA = "0:" + "c".repeat(64);
const NOW = 1_790_000_000_000;
const H = "e".repeat(64);
const VALID_UNTIL = Math.floor(Date.now() / 1000) + 120;
const THIS = fileURLToPath(import.meta.url);

function fakeWalletV4Boc({
    fromWallet = ROOT, toWallet = OLGA, amount = 999999877,
    seqno = 4, validUntil = VALID_UNTIL, sendMode = SendMode.PAY_GAS_SEPARATELY,
    action = 0, walletId = 698983191, secondMessage = false, payload = null
} = {}) {
    const message = internal({
        to: Address.parse(toWallet), value: BigInt(amount), bounce: true,
        ...(payload ? { body: payload } : {})
    });
    const builder = beginCell()
        .storeBuffer(Buffer.alloc(64, 7)) // fixture signature: NOT cryptographically valid
        .storeUint(walletId, 32).storeUint(validUntil, 32)
        .storeUint(seqno, 32).storeUint(action, 8)
        .storeUint(sendMode, 8)
        .storeRef(beginCell().store(storeMessageRelaxed(message)).endCell());
    if (secondMessage) {
        builder.storeUint(sendMode, 8).storeRef(
            beginCell().store(storeMessageRelaxed(message)).endCell());
    }
    const root = beginCell().store(storeMessage(external({
        to: Address.parse(fromWallet), body: builder.endCell()
    }))).endCell();
    return Object.freeze({ bocBase64: root.toBoc().toString("base64"),
        signedHash: root.hash().toString("hex") });
}


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
        refundStore() { return refunds; },
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

test("prepared V4 BOC is frozen and ambiguous after restart, never retried", t => {
    const h = harness(t), id = h.seed({});
    const { intentId } = h.journal.plan({ obligationId: id, feeAtomic: 123, feeQuoteHash: H });
    const lock = h.journal.claimWallet(intentId);
    assert.equal(lock.fromWallet, ROOT);
    assert.throws(() => h.journal.claimWallet(intentId), { code: "WALLET_ALREADY_LOCKED" });
    const prepared = fakeWalletV4Boc();
    assert.throws(() => h.journal.holdPreparedBoc({
        intentId, ownerToken: "forged", bocBase64: prepared.bocBase64
    }), { code: "REFUND_LOCK_OWNER_MISMATCH" });
    assert.throws(() => h.journal.holdSignedIdentity({
        intentId, ownerToken: lock.ownerToken, signedHash: prepared.signedHash
    }), { code: "REFUND_UNVERIFIED_SIGNED_IDENTITY_DISABLED" });
    assert.throws(() => h.journal.holdPreparedBoc({
        intentId, ownerToken: lock.ownerToken,
        bocBase64: fakeWalletV4Boc({validUntil: Math.floor(Date.now()/1000)-1}).bocBase64
    }), { code: "BOC_V4_EXPIRY_INVALID" });
    assert.throws(() => h.journal.holdPreparedBoc({
        intentId, ownerToken: lock.ownerToken,
        bocBase64: fakeWalletV4Boc({validUntil: Math.floor(Date.now()/1000)+301}).bocBase64
    }), { code: "BOC_V4_EXPIRY_INVALID" });
    const signed = h.journal.holdPreparedBoc({
        intentId, ownerToken: lock.ownerToken, bocBase64: prepared.bocBase64
    });
    assert.equal(signed.state, "SIGNED_HELD");
    assert.equal(signed.signedHash, prepared.signedHash);
    assert.equal(signed.seqno, 4);
    assert.throws(() => h.journal.holdPreparedBoc({
        intentId, ownerToken: lock.ownerToken,
        bocBase64: fakeWalletV4Boc({seqno:5}).bocBase64
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

test("a refund blocked after wallet claim cannot receive a signed-intent hold", t => {
    const h = harness(t), obligationId = h.seed({});
    const { intentId } = h.journal.plan({
        obligationId, feeAtomic: 1388278, feeQuoteHash: H
    });
    const owner = h.journal.claimWallet(intentId);
    h.refundStore().markBlocked(obligationId, { lastError: "SOURCE_RECONCILIATION_PENDING" });
    assert.throws(() => h.journal.holdPreparedBoc({
        intentId, ownerToken: owner.ownerToken,
        bocBase64: fakeWalletV4Boc({ amount: 998611722, seqno: 7 }).bocBase64
    }), { code: "REFUND_DEBT_NOT_PENDING" });
    assert.equal(h.journal.load(intentId).state, "PLANNED");
    assert.throws(() => h.journal.claimWallet(intentId), { code: "REFUND_DEBT_NOT_PENDING" });
});

test("wrong wallet, recipient, amount, mode, action and extra outputs fail closed", t => {
    const h = harness(t), id = h.seed({});
    const { intentId } = h.journal.plan({ obligationId: id, feeAtomic: 123, feeQuoteHash: H });
    const lock = h.journal.claimWallet(intentId);
    const malformed = [
        fakeWalletV4Boc({fromWallet: OLGA}),
        fakeWalletV4Boc({toWallet: LENA}),
        fakeWalletV4Boc({amount: 999999876}),
        fakeWalletV4Boc({sendMode: 128}),
        fakeWalletV4Boc({walletId: 123}),
        fakeWalletV4Boc({action: 1}),
        fakeWalletV4Boc({secondMessage: true}),
        fakeWalletV4Boc({payload: beginCell().storeUint(1, 8).endCell()})
    ];
    for (const invalid of malformed) {
        assert.throws(() => h.journal.holdPreparedBoc({
            intentId, ownerToken: lock.ownerToken, bocBase64: invalid.bocBase64
        }), { name: "ProtectedRefundBocError" });
        assert.equal(h.journal.load(intentId).state, "PLANNED");
    }
    assert.throws(() => h.journal.holdPreparedBoc({
        intentId, ownerToken: lock.ownerToken, bocBase64: "not-a-boc"
    }), { code: "BOC_PREPARED_INPUT_INVALID" });
    const approved = fakeWalletV4Boc();
    assert.equal(h.journal.holdPreparedBoc({
        intentId, ownerToken: lock.ownerToken, bocBase64: approved.bocBase64
    }).signedHash, approved.signedHash);
});

test("two independent outgoing receipts are only advisory until final seqno proof", t => {
    const h = harness(t), id = h.seed({});
    const { intentId } = h.journal.plan({ obligationId: id, feeAtomic: 123, feeQuoteHash: H });
    const lock = h.journal.claimWallet(intentId);
    const signed = fakeWalletV4Boc();
    h.journal.holdPreparedBoc({
        intentId, ownerToken: lock.ownerToken, bocBase64: signed.bocBase64
    });
    const one = {
        account: { address: ROOT }, lt: "105271924000001",
        hash: "f".repeat(64), success: true, utime: 1792892552,
        in_msg: { hash: signed.signedHash },
        out_msgs: [{ destination: OLGA, value: 999999877, hash: "d".repeat(64) }]
    };
    const other = {
        account: ROOT.toUpperCase(), lt: "105271924000001",
        hash: Buffer.from(one.hash, "hex").toString("base64"),
        success: true, now: 1792892552,
        in_msg: { hash: Buffer.from(signed.signedHash,"hex").toString("base64") },
        out_msgs: [{
            destination: OLGA.toUpperCase(), value: "999999877",
            hash: Buffer.from("d".repeat(64), "hex").toString("base64")
        }]
    };
    const observed = assessProtectedRefundReceipt({
        journal: h.journal, intentId, tonapiTransactions: [one],
        toncenterTransactions: [other]
    });
    assert.equal(observed.status, "RECEIPT_OBSERVED_PENDING_SEQNO_FINALITY");
    assert.equal(observed.receipt.signedExternalMessageHash, signed.signedHash);
    assert.equal(observed.receipt.roomWalletTxLt, "105271924000001");
    assert.equal(observed.refundCompleteAuthorized, false);
    assert.equal(observed.walletReleaseAuthorized, false);
    assert.equal(observed.broadcastAuthorized, false);
    assert.equal(h.journal.load(intentId).state, "SIGNED_HELD");

    const lagged = assessProtectedRefundReceipt({
        journal: h.journal, intentId, tonapiTransactions: [one], toncenterTransactions: []
    });
    assert.equal(lagged.status, "CONFIRMATION_UNKNOWN");
    assert.equal(lagged.walletReleaseAuthorized, false);

    assert.throws(() => assessProtectedRefundReceipt({
        journal: h.journal, intentId, tonapiTransactions: [one],
        toncenterTransactions: [{ ...other, out_msgs: [
            { ...other.out_msgs[0], value: "999999876" }
        ] }]
    }), { code: "OUTGOING_MESSAGES_DISAGREE" });

    const changedSender = assessProtectedRefundReceipt({
        journal: h.journal, intentId,
        tonapiTransactions: [{ ...one, in_msg: { hash: "c".repeat(64) } }],
        toncenterTransactions: [other]
    });
    assert.equal(changedSender.status, "CONFIRMATION_UNKNOWN");
    assert.equal(h.journal.load(intentId).state, "SIGNED_HELD");
});

test("unprepared refund plan never produces outgoing proof", t => {
    const h = harness(t), id = h.seed({});
    const { intentId } = h.journal.plan({ obligationId: id, feeAtomic: 123, feeQuoteHash: H });
    assert.throws(() => assessProtectedRefundReceipt({
        journal: h.journal, intentId, tonapiTransactions: [],
        toncenterTransactions: []
    }), { code: "REFUND_RECEIPT_NOT_SIGNED_HELD" });
});
