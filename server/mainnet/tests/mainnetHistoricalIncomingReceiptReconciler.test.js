import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MainnetFinancialLedger } from "../payment/MainnetFinancialLedger.js";
import { MainnetHistoricalIncomingReceiptReconciler } from "../payment/MainnetHistoricalIncomingReceiptReconciler.js";
import { createMainnetForensicFinancialSnapshot } from "../payment/MainnetForensicFinancialSnapshot.js";
import { evaluateFinalForensicArchive, FINAL_ARCHIVE_CHAIN_SETTLEMENT_GRACE_MS } from "../../forensic/FinalForensicArchiveGate.js";

const ROOM = "history-room";
const ROOM_WALLET = `0:${"1".repeat(64)}`;
const PAYER = `0:${"2".repeat(64)}`;
const NOW = 2_000_000;
const TRANSACTION_ID = "incoming-stable-id";
const PROVIDER_TX_ID = "a".repeat(64);
const SOURCE_TX_ID = "b".repeat(64);
const MESSAGE_HASH = "c".repeat(64);

function makeHarness(t, { batch = null, providerError = null, receiptStatus = "CONFIRMED",
    ownership = { status: "OWNED", roomId: ROOM, candidates: [ROOM] } } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "wheelwin-mainnet-history-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const config = { network: "mainnet", globalId: -239, dataDir: dir };
    const financialLedger = new MainnetFinancialLedger({ config, nowProvider: () => 10_000 }).initialize();
    financialLedger.recordClosedRoom({ roomId: ROOM, roomNumber: 7,
        closureReason: "setup_expired", prePage5: true });
    const intents = [
        { roomId: ROOM, playerId: "olga", paymentReference: "pay_olga", network: "mainnet", globalId: -239,
            destinationWalletId: "mainnet-wallet-7", destinationWalletAddress: ROOM_WALLET,
            expectedSender: PAYER, amountAtomic: "1000000000", asset: "TON", createdAt: 1_000,
            expiresAt: 2_000, state: "SETTLED", confirmedTransactionId: TRANSACTION_ID },
        { roomId: ROOM, playerId: "bob", paymentReference: "pay_bob", network: "mainnet", globalId: -239,
            destinationWalletId: "mainnet-wallet-7", destinationWalletAddress: ROOM_WALLET,
            expectedSender: `0:${"3".repeat(64)}`, amountAtomic: "1000000000", asset: "TON",
            createdAt: 1_000, expiresAt: 2_000, state: "PENDING", confirmedTransactionId: null },
        { roomId: ROOM, playerId: "lena", paymentReference: "pay_lena", network: "mainnet", globalId: -239,
            destinationWalletId: "mainnet-wallet-7", destinationWalletAddress: ROOM_WALLET,
            expectedSender: `0:${"4".repeat(64)}`, amountAtomic: "1000000000", asset: "TON",
            createdAt: 1_000, expiresAt: 2_000, state: "PENDING", confirmedTransactionId: null }
    ];
    const receipt = { roomId: ROOM, playerId: "olga", paymentReference: "pay_olga",
        transactionId: TRANSACTION_ID, providerTransactionId: PROVIDER_TX_ID,
        network: "mainnet", globalId: -239, asset: "TON", amountAtomic: "1000000000",
        sourceAddress: PAYER, destinationAddress: ROOM_WALLET, transactionTime: 1_500,
        status: receiptStatus, reason: receiptStatus === "CONFIRMED" ? null : "PAYMENT_ALREADY_SETTLED" };
    const record = { transactionId: TRANSACTION_ID, providerTransactionId: PROVIDER_TX_ID,
        network: "mainnet", globalId: -239, asset: "TON", amountAtomic: "1000000000",
        sourceAddress: PAYER, destinationAddress: ROOM_WALLET, transactionTime: 1_500,
        paymentReference: "pay_olga" };
    const incomingLedger = {
        network: "mainnet", globalId: -239,
        listRoomIntents: roomId => roomId === ROOM ? intents : [],
        listAllIntents: () => intents,
        listReceipts: roomId => roomId === ROOM ? [receipt] : [],
        listObservations: () => [],
        getReceipt: transactionId => transactionId === TRANSACTION_ID ? receipt : null
    };
    let historyQueries = 0;
    const client = { network: "mainnet", globalId: -239,
        async listIncomingTransactions(query) {
            historyQueries++;
            assert.equal(query.account, ROOM_WALLET);
            assert.equal(query.floorMs, 1_000);
            assert.equal(query.ceilingMs, NOW, "history extends past the payment intent expiry");
            assert.equal(query.limit, 1000);
            if (providerError) throw Object.assign(new Error("redacted"), { code: providerError });
            return batch ?? { records: [record], resultWindowComplete: true };
        }
    };
    const outgoingObserver = {
        async findOutgoingTransfer(input) {
            assert.equal(input.sourceWalletAddress, PAYER);
            assert.equal(input.destinationIdentity, ROOM_WALLET);
            assert.equal(input.amountAtomic, 1_000_000_000);
            return { transactionId: SOURCE_TX_ID };
        },
        async verifyIndexedRecipientCredit(input) {
            assert.equal(input.transactionId, SOURCE_TX_ID);
            return { status: "MASTERCHAIN_INDEXED_RECIPIENT_CREDIT_OBSERVED", globalId: -239,
                sourceTransactionId: SOURCE_TX_ID, recipientTransactionId: PROVIDER_TX_ID,
                messageHash: MESSAGE_HASH, sourceWalletAddress: PAYER,
                destinationAddress: ROOM_WALLET, amountAtomic: 1_000_000_000 };
        }
    };
    const independentVerifier = { async verifyTransfer(input) {
        return { status: "INDEPENDENT_INDEXED_CREDIT_OBSERVED", provider: "tonapi-mainnet",
            network: "mainnet", globalId: -239, ...input };
    } };
    const walletPool = { resolveReservationOwnerAt: () => ownership };
    const reconciler = new MainnetHistoricalIncomingReceiptReconciler({ incomingLedger, financialLedger,
        client, outgoingObserver, independentVerifier, walletPool, nowProvider: () => NOW,
        maxCandidatesPerPass: 3 });
    return { dir, config, financialLedger, incomingLedger, reconciler, historyQueries };
}

function finality(snapshot) {
    return evaluateFinalForensicArchive({ snapshot, nowMs: NOW });
}

test("complete post-window Mainnet history creates durable coverage accepted by the common final gate", async t => {
    const h = makeHarness(t);
    const result = await h.reconciler.recoverRoom(ROOM);
    const coverage = h.financialLedger.getHistoryCoverage(ROOM);
    assert.equal(result.status, "HISTORY_CHECKED");
    assert.equal(coverage.source, "FINAL_FORENSIC_HISTORY_COVERAGE");
    assert.equal(coverage.resultWindowComplete, true);
    assert.equal(coverage.providerError, null);
    assert.equal(coverage.candidateCount, 1);
    assert.equal(coverage.checkedCount, 1);
    assert.equal(coverage.pendingCount, 0);
    assert.deepEqual(coverage.verifiedTransactionIds, [TRANSACTION_ID]);
    const snapshot = createMainnetForensicFinancialSnapshot({ roomId: ROOM,
        incomingLedger: h.incomingLedger, financialLedger: h.financialLedger });
    assert.deepEqual(snapshot.paymentObservations.at(-1), coverage);
    assert.equal(finality(snapshot).ready, true);
});

test("incomplete Toncenter page and HTTP 429 replace any prior success with a fail-closed marker", async t => {
    const h = makeHarness(t, { batch: { records: [], resultWindowComplete: false } });
    await h.reconciler.recoverRoom(ROOM);
    let coverage = h.financialLedger.getHistoryCoverage(ROOM);
    assert.equal(coverage.resultWindowComplete, false);
    assert.equal(coverage.providerError, "INCOMPLETE_RESULT_WINDOW");
    assert.equal(finality(createMainnetForensicFinancialSnapshot({ roomId: ROOM,
        incomingLedger: h.incomingLedger, financialLedger: h.financialLedger })).ready, false);

    const rateLimited = makeHarness(t, { providerError: "MAINNET_TONCENTER_RATE_LIMITED" });
    await rateLimited.reconciler.recoverRoom(ROOM);
    coverage = rateLimited.financialLedger.getHistoryCoverage(ROOM);
    assert.equal(coverage.resultWindowComplete, false);
    assert.equal(coverage.providerError, "MAINNET_TONCENTER_RATE_LIMITED");
    assert.equal(finality(createMainnetForensicFinancialSnapshot({ roomId: ROOM,
        incomingLedger: rateLimited.incomingLedger, financialLedger: rateLimited.financialLedger })).ready, false);

    const malformed = makeHarness(t, { batch: { records: [], resultWindowComplete: true,
        malformedIncomingCandidateCount: 1 } });
    await malformed.reconciler.recoverRoom(ROOM);
    coverage = malformed.financialLedger.getHistoryCoverage(ROOM);
    assert.equal(coverage.resultWindowComplete, false);
    assert.equal(coverage.providerError, "MALFORMED_INCOMING_CANDIDATE");
});

test("an additional receipt without its own confirmed payment ownership keeps coverage pending", async t => {
    const h = makeHarness(t, { receiptStatus: "EXTRA_PAYMENT" });
    const result = await h.reconciler.recoverRoom(ROOM);
    const coverage = h.financialLedger.getHistoryCoverage(ROOM);
    assert.equal(result.status, "HISTORY_PENDING");
    assert.equal(coverage.resultWindowComplete, true);
    assert.equal(coverage.checkedCount, 0);
    assert.ok(coverage.pendingCount > 0);
    assert.equal(finality(createMainnetForensicFinancialSnapshot({ roomId: ROOM,
        incomingLedger: h.incomingLedger, financialLedger: h.financialLedger })).ready, false);
});

test("ambiguous historical wallet ownership keeps coverage pending", async t => {
    const h = makeHarness(t, { ownership: { status: "AMBIGUOUS", roomId: null,
        candidates: [ROOM, "other-room"] } });
    const result = await h.reconciler.recoverRoom(ROOM);
    const coverage = h.financialLedger.getHistoryCoverage(ROOM);
    assert.equal(result.status, "HISTORY_PENDING");
    assert.equal(coverage.checkedCount, 0);
    assert.ok(coverage.pendingCount > 0);
});

test("coverage replaces its room checkpoint and survives ledger restart without financial mutations", async t => {
    const h = makeHarness(t);
    const before = { refunds: h.financialLedger.listRefunds(ROOM), payouts: h.financialLedger.listPayouts() };
    await h.reconciler.recoverRoom(ROOM);
    await h.reconciler.recoverRoom(ROOM);
    const persisted = JSON.parse(readFileSync(join(h.dir, "financial-lifecycle", "state.json"), "utf8"));
    assert.equal(persisted.historyCoverage.filter(item => item.roomId === ROOM).length, 1);
    const restarted = new MainnetFinancialLedger({ config: h.config, nowProvider: () => NOW }).initialize();
    assert.equal(restarted.getHistoryCoverage(ROOM).pendingCount, 0);
    assert.deepEqual(restarted.listRefunds(ROOM), before.refunds);
    assert.deepEqual(restarted.listPayouts(), before.payouts);
});

test("Testnet and Mainnet snapshots receive identical archive-finality decisions", () => {
    const check = { source: "FINAL_FORENSIC_HISTORY_COVERAGE", completedAt: NOW,
        resultWindowComplete: true, providerError: null, candidateCount: 0, checkedCount: 0, pendingCount: 0 };
    const common = { roomId: ROOM, closedRoom: { roomId: ROOM, closedAtMs: 1_000 },
        outcome: { kind: "REFUND" }, intents: [{ state: "PENDING" }], ledger: [], refunds: [],
        unresolvedReceipts: [], paymentObservations: [check], outstandingObligations: 0 };
    const testnet = { ...common, network: "testnet", globalId: -3 };
    const mainnet = { ...common, network: "mainnet", globalId: -239 };
    assert.deepEqual(finality(testnet), finality(mainnet));
    const incomplete = { ...check, resultWindowComplete: false, providerError: "HTTP_429", pendingCount: 1 };
    assert.deepEqual(finality({ ...testnet, paymentObservations: [incomplete] }),
        finality({ ...mainnet, paymentObservations: [incomplete] }));
    assert.equal(finality({ ...mainnet, paymentObservations: [incomplete] }).ready, false);
    assert.ok(NOW > 1_000 + FINAL_ARCHIVE_CHAIN_SETTLEMENT_GRACE_MS);
});
