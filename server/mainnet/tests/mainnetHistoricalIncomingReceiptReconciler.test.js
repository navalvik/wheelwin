import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MainnetFinancialLedger } from "../payment/MainnetFinancialLedger.js";
import { MainnetIncomingPaymentLedger } from "../payment/MainnetIncomingPaymentLedger.js";
import { MainnetHistoricalIncomingReceiptReconciler } from "../payment/MainnetHistoricalIncomingReceiptReconciler.js";
import { MainnetRefundLifecycle } from "../payment/MainnetRefundLifecycle.js";
import { MainnetWalletPoolRegistry } from "../wallet/MainnetWalletPoolRegistry.js";
import { loadMainnetRuntimeConfig } from "../config/MainnetRuntimeConfig.js";
import { createMainnetForensicFinancialSnapshot } from "../payment/MainnetForensicFinancialSnapshot.js";
import { evaluateFinalForensicArchive, FINAL_ARCHIVE_CHAIN_SETTLEMENT_GRACE_MS } from "../../forensic/FinalForensicArchiveGate.js";

const ROOM = "late-history-room";
const ROOM_WALLET = `0:${"1".repeat(64)}`;
const PAYERS = [2, 3, 4].map(index => `0:${String(index).repeat(64)}`);
const NOW = 2_000_000;
const SOURCE_TX_ID = "b".repeat(64);
const MESSAGE_HASH = "c".repeat(64);

function paymentRecord(index = 0, { reference = `late_ref_${index}`, transactionTime = 3_000 } = {}) {
    return { transactionId: `incoming-stable-${index}`, providerTransactionId: String(index + 10).padStart(64, "0"),
        network: "mainnet", globalId: -239, asset: "TON", amountAtomic: "1000000000",
        sourceAddress: PAYERS[index % 3], destinationAddress: ROOM_WALLET,
        accountId: ROOM_WALLET, transactionTime, paymentReference: reference,
        hasComment: reference !== null, malformedComment: false };
}

function makeHarness(t, { records = [paymentRecord()], batchComplete = true,
    providerError = null, owner = { status: "OWNED", roomId: ROOM }, evidence = "good",
    duplicatePayer = false } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "wheelwin-mainnet-late-receipt-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const config = { network: "mainnet", globalId: -239, dataDir: dir };
    const financialLedger = new MainnetFinancialLedger({ config, nowProvider: () => NOW }).initialize();
    const incomingLedger = new MainnetIncomingPaymentLedger({ config, nowProvider: () => NOW }).initialize();
    financialLedger.recordClosedRoom({ roomId: ROOM, roomNumber: 7,
        closureReason: "setup_expired", prePage5: true });
    const expectedSenders = duplicatePayer ? [PAYERS[0], PAYERS[1], PAYERS[1]] : PAYERS;
    incomingLedger.createRoomPaymentIntents({ roomId: ROOM,
        wallet: { network: "mainnet", globalId: -239, walletId: "mainnet-wallet-7", address: ROOM_WALLET },
        players: expectedSenders.map((expectedSender, index) => ({ playerId: ["olga", "bob", "lena"][index],
            paymentReference: `late_ref_${index}`, expectedSender, amountAtomic: "1000000000" })),
        createdAt: 1_000, expiresAt: 2_000 });

    let currentRecords = records;
    let currentComplete = batchComplete;
    let currentProviderError = providerError;
    let verifyMode = evidence;
    let activeRecord = null;
    let recordCursor = 0;
    const client = { network: "mainnet", globalId: -239,
        async listIncomingTransactions(query) {
            assert.equal(query.account, ROOM_WALLET);
            assert.equal(query.floorMs, 1_000);
            assert.equal(query.ceilingMs, NOW, "history includes transfers after payment-intent expiry");
            assert.equal(query.limit, 1000);
            if (currentProviderError) throw Object.assign(new Error("mock provider failure"), { code: currentProviderError });
            return { records: currentRecords, resultWindowComplete: currentComplete };
        }
    };
    const outgoingObserver = {
        async findOutgoingTransfer(query) {
            if (verifyMode === "toncenter-missing") return null;
            activeRecord = currentRecords[recordCursor++ % currentRecords.length];
            assert.equal(query.sourceWalletAddress, activeRecord.sourceAddress);
            return { transactionId: SOURCE_TX_ID };
        },
        async verifyIndexedRecipientCredit(query) {
            if (verifyMode === "toncenter-missing") return null;
            const base = { status: "MASTERCHAIN_INDEXED_RECIPIENT_CREDIT_OBSERVED", globalId: -239,
                sourceFinality: "finalized", recipientFinality: "finalized",
                sourceTransactionId: SOURCE_TX_ID, recipientTransactionId: activeRecord.providerTransactionId,
                messageHash: MESSAGE_HASH, sourceWalletAddress: activeRecord.sourceAddress,
                destinationAddress: ROOM_WALLET, amountAtomic: 1_000_000_000 };
            return verifyMode === "index-not-final" ? { ...base, recipientFinality: "pending" } : base;
        }
    };
    const independentVerifier = { async verifyTransfer(input) {
        if (verifyMode === "tonapi-missing") return null;
        return { status: "INDEPENDENT_INDEXED_CREDIT_OBSERVED", provider: "tonapi-mainnet",
            network: "mainnet", globalId: -239, ...input };
    } };
    const refundLifecycle = new MainnetRefundLifecycle({ financialLedger, incomingLedger,
        adapter: { async sendTransfer() { throw new Error("live send forbidden in this test"); },
            async estimateOutboundTransferFee() { throw new Error("live fee quote forbidden in this test"); } },
        outgoingObserver, independentVerifier, nowProvider: () => NOW });
    refundLifecycle.configureReservedWalletRoomNumberResolver(() => 7);
    const walletPool = { resolveReservationOwnerAt: () => owner };
    const reconciler = new MainnetHistoricalIncomingReceiptReconciler({ incomingLedger, financialLedger,
        client, outgoingObserver, independentVerifier, walletPool, refundLifecycle,
        nowProvider: () => NOW, maxCandidatesPerPass: 3 });
    return { dir, config, financialLedger, incomingLedger, refundLifecycle, reconciler,
        setRecords(value) { currentRecords = value; },
        setBatchComplete(value) { currentComplete = value; },
        setProviderError(value) { currentProviderError = value; },
        setEvidence(value) { verifyMode = value; } };
}

function finality(snapshot) { return evaluateFinalForensicArchive({ snapshot, nowMs: NOW }); }

test("late confirmed incoming payment becomes durable receipt and closed-room refund", async t => {
    const h = makeHarness(t);
    assert.equal((await h.reconciler.recoverRoom(ROOM)).status, "HISTORY_CHECKED");
    const receipt = h.incomingLedger.getReceipt("incoming-stable-0");
    assert.equal(receipt.status, "CONFIRMED");
    assert.equal(receipt.paymentReference, "late_ref_0");
    assert.equal(h.incomingLedger.getIntent("late_ref_0").state, "SETTLED");
    const refunds = h.financialLedger.listRefunds(ROOM);
    assert.equal(refunds.length, 1);
    assert.equal(refunds[0].incomingTransactionId, receipt.transactionId);
    assert.equal(refunds[0].playerId, "olga");
    assert.equal(refunds[0].state, "PENDING");
    assert.equal(h.financialLedger.hasPage5Started(ROOM), false);
    const snapshot = createMainnetForensicFinancialSnapshot({ roomId: ROOM,
        incomingLedger: h.incomingLedger, financialLedger: h.financialLedger });
    assert.equal(snapshot.paymentObservations.at(-1).source, "FINAL_FORENSIC_HISTORY_COVERAGE");
    assert.equal(finality(snapshot).ready, false,
        "an unexecuted refund obligation cannot be treated as financially complete");
});

test("late payment after release and wallet reassignment uses persisted historical identity after restart", async t => {
    const root = mkdtempSync(join(tmpdir(), "wheelwin-mainnet-released-late-payment-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const reservedAt = NOW - 10_000;
    const intentAt = NOW - 9_000;
    const closedAt = NOW - 8_000;
    const transactionTime = NOW - 6_000;
    const releasedAt = NOW - 4_000;
    const reassignedAt = NOW - 3_000;
    const walletCatalog = JSON.stringify(Array.from({ length: 64 }, (_, index) => ({
        walletId: `wallet-${index + 1}`, roomNumber: index + 1,
        address: `0:${String(index + 1).padStart(64, "0")}`, network: "mainnet"
    })));
    const config = loadMainnetRuntimeConfig({ TON_NETWORK: "mainnet",
        MAINNET_TONCENTER_API_KEY: "offline-synthetic-key",
        MAINNET_ROOM_WALLET_DATA_DIR: root, MAINNET_ROOM_WALLETS_JSON: walletCatalog });
    const snapshotDir = join(root, "wallet-registry");
    const originalPool = new MainnetWalletPoolRegistry({ config });
    originalPool.initialize({ snapshotDir });
    const wallet = originalPool.getWalletByRoomNumber(1);
    originalPool.reserve({ roomId: ROOM, network: "mainnet", walletId: wallet.walletId, now: reservedAt });

    const incomingLedger = new MainnetIncomingPaymentLedger({ config, nowProvider: () => NOW }).initialize();
    incomingLedger.createRoomPaymentIntents({ roomId: ROOM,
        wallet: { network: "mainnet", globalId: -239, walletId: wallet.walletId, address: wallet.address },
        players: [{ playerId: "olga", paymentReference: "late_release_ref", expectedSender: PAYERS[0],
            amountAtomic: "1000000000" },
        { playerId: "bob", paymentReference: "late_release_bob", expectedSender: PAYERS[1], amountAtomic: "1000000000" },
        { playerId: "lena", paymentReference: "late_release_lena", expectedSender: PAYERS[2], amountAtomic: "1000000000" }],
        createdAt: intentAt, expiresAt: intentAt + 5_000 });
    const financialLedger = new MainnetFinancialLedger({ config, nowProvider: () => closedAt }).initialize();
    financialLedger.recordClosedRoom({ roomId: ROOM, roomNumber: wallet.roomNumber,
        closureReason: "setup_expired", prePage5: true });

    originalPool.persistSnapshot(snapshotDir);
    const released = originalPool.releaseForMainnetOutcome({ roomId: ROOM,
        financialLedger, now: releasedAt });
    assert.equal(released.released, true);
    originalPool.persistSnapshot(snapshotDir);
    assert.equal(originalPool.getReservationForRoom(ROOM), null);

    originalPool.reserve({ roomId: "new-room", network: "mainnet", walletId: wallet.walletId, now: reassignedAt });
    originalPool.persistSnapshot(snapshotDir);
    const restartedPool = new MainnetWalletPoolRegistry({ config });
    restartedPool.initialize({ snapshotDir });
    const recoveredIncomingLedger = new MainnetIncomingPaymentLedger({ config, nowProvider: () => NOW }).initialize();
    const recoveredFinancialLedger = new MainnetFinancialLedger({ config, nowProvider: () => NOW }).initialize();
    assert.equal(restartedPool.getReservationForRoom(ROOM), null);
    assert.equal(restartedPool.getReservationForRoom("new-room").walletId, wallet.walletId);
    assert.equal(restartedPool.resolveReservationOwnerAt({ walletId: wallet.walletId,
        transactionTime }).roomId, ROOM);
    assert.equal(restartedPool.getReservationForRoomHistory(ROOM).roomNumber, wallet.roomNumber);
    assert.equal(restartedPool.getReservationForRoomHistory("unknown-room"), null,
        "room identity is never inferred from a room number");

    const incomingRecord = { transactionId: "late-after-release", providerTransactionId: "d".repeat(64),
        network: "mainnet", globalId: -239, asset: "TON", amountAtomic: "1000000000",
        sourceAddress: PAYERS[0], destinationAddress: wallet.address, accountId: wallet.address,
        transactionTime, paymentReference: "late_release_ref", hasComment: true, malformedComment: false };
    const client = { network: "mainnet", globalId: -239,
        async listIncomingTransactions(query) {
            assert.equal(query.account, wallet.address);
            assert.equal(query.floorMs, intentAt);
            return { records: [incomingRecord], resultWindowComplete: true };
        } };
    const outgoingObserver = {
        async findOutgoingTransfer() { return { transactionId: SOURCE_TX_ID }; },
        async verifyIndexedRecipientCredit(query) { return {
            status: "MASTERCHAIN_INDEXED_RECIPIENT_CREDIT_OBSERVED", globalId: -239,
            sourceFinality: "finalized", recipientFinality: "finalized",
            sourceTransactionId: SOURCE_TX_ID, recipientTransactionId: incomingRecord.providerTransactionId,
            messageHash: MESSAGE_HASH, sourceWalletAddress: query.sourceWalletAddress,
            destinationAddress: query.destinationIdentity, amountAtomic: query.amountAtomic
        }; }
    };
    const independentVerifier = { async verifyTransfer(input) { return {
        status: "INDEPENDENT_INDEXED_CREDIT_OBSERVED", provider: "tonapi-mainnet",
        network: "mainnet", globalId: -239, ...input
    }; } };
    let feeQuotes = 0;
    let outboundSends = 0;
    const refundLifecycle = new MainnetRefundLifecycle({ financialLedger: recoveredFinancialLedger,
        incomingLedger: recoveredIncomingLedger,
        adapter: { async sendTransfer() { outboundSends++; return { ok: true, txHash: "must-not-send" }; },
            async estimateOutboundTransferFee() { feeQuotes++; return { ok: true, totalNano: 1n }; } },
        outgoingObserver, independentVerifier, nowProvider: () => NOW });
    refundLifecycle.configureReservedWalletRoomNumberResolver(roomId =>
        restartedPool.getReservationForRoomHistory(roomId)?.roomNumber ?? null);
    refundLifecycle.configureCurrentWalletReservationResolver(roomNumber =>
        restartedPool.getWalletByRoomNumber(roomNumber));
    const reconciler = new MainnetHistoricalIncomingReceiptReconciler({
        incomingLedger: recoveredIncomingLedger, financialLedger: recoveredFinancialLedger,
        client, outgoingObserver, independentVerifier, walletPool: restartedPool, refundLifecycle,
        nowProvider: () => NOW, maxCandidatesPerPass: 3 });

    assert.equal((await reconciler.recoverRoom(ROOM)).status, "HISTORY_CHECKED");
    const [receipt] = recoveredIncomingLedger.listReceipts(ROOM);
    assert.equal(receipt.status, "CONFIRMED");
    const [refund] = recoveredFinancialLedger.listRefunds(ROOM);
    assert.equal(refund.state, "PENDING", "late refund is recorded but no transfer is sent");
    assert.equal(refund.roomNumber, wallet.roomNumber);
    assert.equal(refund.sourceWalletAddress, wallet.address);
    assert.equal(refund.playerId, "olga");
    assert.equal((await refundLifecycle.submitRefund(refund.obligationId)).outcome,
        "WALLET_RESERVED_FOR_OTHER_ROOM");
    assert.equal((await refundLifecycle.submitRefund(refund.obligationId)).outcome,
        "WALLET_RESERVED_FOR_OTHER_ROOM", "retry remains blocked while the new room owns the wallet");
    assert.equal(recoveredFinancialLedger.getRefund(refund.obligationId).state, "PENDING");
    assert.equal(feeQuotes, 0);
    assert.equal(outboundSends, 0);
    assert.equal(restartedPool.getReservationForRoom("new-room").walletId, wallet.walletId,
        "late recovery does not release or redirect the newer room reservation");
    restartedPool.release({ roomId: "new-room", unresolvedObligations: 0, now: NOW + 1 });
    assert.equal((await refundLifecycle.submitRefund(refund.obligationId)).outcome,
        "WALLET_RESERVATION_RELEASED", "a released wallet is not treated as owned by the old room");
    assert.equal(recoveredFinancialLedger.getRefund(refund.obligationId).state, "PENDING");
    assert.equal(feeQuotes, 0);
    assert.equal(outboundSends, 0);
    assert.equal((await reconciler.recoverRoom(ROOM)).status, "HISTORY_CHECKED");
    assert.equal(recoveredFinancialLedger.listRefunds(ROOM).length, 1, "replay creates no duplicate obligation");
    assert.equal(restartedPool.getReservationForRoom("new-room"), null);
});

test("two late transactions are independently recorded/refunded and replay is idempotent after restart", async t => {
    const records = [paymentRecord(0), paymentRecord(0, { reference: "late_ref_0", transactionTime: 3_100 })];
    records[1] = { ...records[1], transactionId: "incoming-stable-extra", providerTransactionId: "e".repeat(64) };
    const h = makeHarness(t, { records });
    await h.reconciler.recoverRoom(ROOM);
    assert.deepEqual(h.incomingLedger.listReceipts(ROOM).map(x => x.status), ["CONFIRMED", "EXTRA_PAYMENT"]);
    assert.equal(h.financialLedger.listRefunds(ROOM).length, 2);
    const before = h.financialLedger.listRefunds(ROOM).map(x => x.obligationId);
    await h.reconciler.recoverRoom(ROOM);
    const incomingAfterRestart = new MainnetIncomingPaymentLedger({ config: h.config, nowProvider: () => NOW }).initialize();
    const financialAfterRestart = new MainnetFinancialLedger({ config: h.config, nowProvider: () => NOW }).initialize();
    const restartedRefundLifecycle = new MainnetRefundLifecycle({ financialLedger: financialAfterRestart,
        incomingLedger: incomingAfterRestart,
        adapter: { async sendTransfer() { throw new Error("send forbidden"); },
            async estimateOutboundTransferFee() { throw new Error("fee quote forbidden"); } },
        outgoingObserver: { async findOutgoingTransfer() {}, async verifyIndexedRecipientCredit() {} },
        independentVerifier: { async verifyTransfer() {} }, nowProvider: () => NOW });
    restartedRefundLifecycle.configureReservedWalletRoomNumberResolver(() => 7);
    const restarted = new MainnetHistoricalIncomingReceiptReconciler({ incomingLedger: incomingAfterRestart,
        financialLedger: financialAfterRestart, client: { network: "mainnet", globalId: -239,
            async listIncomingTransactions() { return { records, resultWindowComplete: true }; } },
        outgoingObserver: h.reconciler.outgoingObserver, independentVerifier: h.reconciler.independentVerifier,
        walletPool: { resolveReservationOwnerAt: () => ({ status: "OWNED", roomId: ROOM }) },
        refundLifecycle: restartedRefundLifecycle, nowProvider: () => NOW });
    await restarted.recoverRoom(ROOM);
    assert.deepEqual(financialAfterRestart.listRefunds(ROOM).map(x => x.obligationId), before);
    assert.equal(incomingAfterRestart.listReceipts(ROOM).length, 2);
    assert.equal(financialAfterRestart.hasPage5Started(ROOM), false);
});

test("incomplete history, HTTP 429, and missing provider evidence remain retryable", async t => {
    const h = makeHarness(t, { batchComplete: false });
    assert.equal((await h.reconciler.recoverRoom(ROOM)).status, "HISTORY_INCOMPLETE");
    assert.equal(h.incomingLedger.listReceipts(ROOM).length, 0);
    h.setBatchComplete(true);
    h.setProviderError("MAINNET_TONCENTER_RATE_LIMITED");
    assert.equal((await h.reconciler.recoverRoom(ROOM)).status, "HISTORY_PROVIDER_UNAVAILABLE");
    h.setProviderError(null);
    h.setEvidence("tonapi-missing");
    assert.equal((await h.reconciler.recoverRoom(ROOM)).status, "HISTORY_PENDING");
    assert.equal(h.incomingLedger.listReceipts(ROOM).length, 0);
    assert.equal(h.financialLedger.listRefunds(ROOM).length, 0);
    h.setEvidence("index-not-final");
    assert.equal((await h.reconciler.recoverRoom(ROOM)).status, "HISTORY_PENDING");
    assert.equal(h.incomingLedger.listReceipts(ROOM).length, 0);
    h.setEvidence("good");
    assert.equal((await h.reconciler.recoverRoom(ROOM)).status, "HISTORY_CHECKED");
    assert.equal(h.financialLedger.listRefunds(ROOM).length, 1);
});

test("a late payment first visible after server restart is recovered from durable room state", async t => {
    const h = makeHarness(t);
    const incomingLedger = new MainnetIncomingPaymentLedger({ config: h.config, nowProvider: () => NOW }).initialize();
    const financialLedger = new MainnetFinancialLedger({ config: h.config, nowProvider: () => NOW }).initialize();
    const lifecycle = new MainnetRefundLifecycle({ financialLedger, incomingLedger,
        adapter: { async sendTransfer() { throw new Error("send forbidden"); },
            async estimateOutboundTransferFee() { throw new Error("fee quote forbidden"); } },
        outgoingObserver: h.reconciler.outgoingObserver,
        independentVerifier: h.reconciler.independentVerifier, nowProvider: () => NOW });
    lifecycle.configureReservedWalletRoomNumberResolver(() => 7);
    const restarted = new MainnetHistoricalIncomingReceiptReconciler({ incomingLedger, financialLedger,
        client: h.reconciler.client, outgoingObserver: h.reconciler.outgoingObserver,
        independentVerifier: h.reconciler.independentVerifier,
        walletPool: { resolveReservationOwnerAt: () => ({ status: "OWNED", roomId: ROOM }) },
        refundLifecycle: lifecycle, nowProvider: () => NOW });
    assert.equal(incomingLedger.listReceipts(ROOM).length, 0);
    assert.equal((await restarted.recoverRoom(ROOM)).status, "HISTORY_CHECKED");
    assert.equal(incomingLedger.getReceipt("incoming-stable-0").status, "CONFIRMED");
    assert.equal(financialLedger.listRefunds(ROOM).length, 1);
});

test("ambiguous ownership and mismatched payer never choose a refund receiver", async t => {
    const ambiguous = makeHarness(t, { owner: { status: "AMBIGUOUS", roomId: null,
        candidates: [ROOM, "other-room"] } });
    assert.equal((await ambiguous.reconciler.recoverRoom(ROOM)).status, "HISTORY_PENDING");
    assert.equal(ambiguous.incomingLedger.listReceipts(ROOM).length, 0);
    assert.equal(ambiguous.financialLedger.listRefunds(ROOM).length, 0);

    const wrongPayer = makeHarness(t, { records: [{ ...paymentRecord(), sourceAddress: `0:${"9".repeat(64)}` }] });
    assert.equal((await wrongPayer.reconciler.recoverRoom(ROOM)).status, "HISTORY_PENDING");
    assert.equal(wrongPayer.incomingLedger.listReceipts(ROOM).length, 0);
});

test("a persisted Page5 boundary prevents late-payment recovery for the destroyed room", async t => {
    const h = makeHarness(t);
    h.financialLedger.recordPage5Started(ROOM);
    assert.equal((await h.reconciler.recoverRoom(ROOM)).status, "PAGE5_ALREADY_STARTED");
    assert.equal(h.incomingLedger.listReceipts(ROOM).length, 0);
    assert.equal(h.financialLedger.listRefunds(ROOM).length, 0);
});

test("overlapping history passes are coalesced", async t => {
    const h = makeHarness(t);
    const client = h.reconciler.client;
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const original = client.listIncomingTransactions.bind(client);
    client.listIncomingTransactions = async query => {
        await pending;
        return original(query);
    };
    const first = h.reconciler.runPass();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(await h.reconciler.runPass(), { status: "ALREADY_RUNNING" });
    release();
    assert.equal((await first).status, "HISTORY_CHECKED");
});

test("memo-less late payment is accepted only when one intent matches exactly", async t => {
    const record = { ...paymentRecord(1, { reference: null }), hasComment: false, paymentReference: null };
    const h = makeHarness(t, { records: [record] });
    assert.equal((await h.reconciler.recoverRoom(ROOM)).status, "HISTORY_CHECKED");
    assert.equal(h.incomingLedger.getReceipt(record.transactionId).playerId, "bob");
    assert.equal(h.financialLedger.listRefunds(ROOM)[0].playerId, "bob");

    const ambiguous = makeHarness(t, { records: [record], duplicatePayer: true });
    assert.equal((await ambiguous.reconciler.recoverRoom(ROOM)).status, "HISTORY_PENDING");
    assert.equal(ambiguous.incomingLedger.listReceipts(ROOM).length, 0);
    assert.equal(ambiguous.financialLedger.listRefunds(ROOM).length, 0);
});

test("at most three candidates are processed per pass and later candidates are reached", async t => {
    const records = Array.from({ length: 4 }, (_, index) => {
        const record = paymentRecord(0);
        return { ...record, transactionId: `bounded-${index}`,
            providerTransactionId: String(index + 30).padStart(64, "0") };
    });
    const h = makeHarness(t, { records });
    const first = await h.reconciler.recoverRoom(ROOM);
    assert.equal(first.checkedCount, 3);
    assert.equal(h.incomingLedger.listReceipts(ROOM).length, 3);
    const second = await h.reconciler.recoverRoom(ROOM);
    assert.equal(second.checkedCount, 1);
    assert.equal(h.incomingLedger.listReceipts(ROOM).length, 4);
    assert.equal(h.financialLedger.listRefunds(ROOM).length, 4);
});

test("Testnet and Mainnet archive finality rules remain identical", () => {
    const check = { source: "FINAL_FORENSIC_HISTORY_COVERAGE", completedAt: NOW,
        resultWindowComplete: true, providerError: null, candidateCount: 0, checkedCount: 0, pendingCount: 0 };
    const common = { roomId: ROOM, closedRoom: { roomId: ROOM, closedAtMs: 1_000 },
        outcome: { kind: "REFUND" }, intents: [{ state: "PENDING" }], ledger: [], refunds: [],
        unresolvedReceipts: [], paymentObservations: [check], outstandingObligations: 0 };
    const testnet = { ...common, network: "testnet", globalId: -3 };
    const mainnet = { ...common, network: "mainnet", globalId: -239 };
    assert.deepEqual(finality(mainnet), finality(testnet));
    const incomplete = { ...check, resultWindowComplete: false, providerError: "HTTP_429", pendingCount: 1 };
    assert.deepEqual(finality({ ...mainnet, paymentObservations: [incomplete] }),
        finality({ ...testnet, paymentObservations: [incomplete] }));
    assert.equal(finality({ ...mainnet, paymentObservations: [incomplete] }).ready, false);
    assert.ok(NOW > 1_000 + FINAL_ARCHIVE_CHAIN_SETTLEMENT_GRACE_MS);
});

test("Testnet source files and financial operations remain untouched", t => {
    const baseline = "643050aad9f48ebf16993f2bf99cbff4edc85a0b";
    const files = ["server/payment/runtime/HistoricalIncomingReceiptReconciler.js",
        "server/payment/incoming/IncomingReceiptAccounting.js",
        "server/payment/runtime/TestnetPendingRefundExecutor.js"];
    for (const file of files) {
        execFileSync("git", ["diff", "--quiet", baseline, "--", file]);
    }
});
