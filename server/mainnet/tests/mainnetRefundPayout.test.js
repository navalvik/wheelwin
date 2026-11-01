import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadMainnetRuntimeConfig } from "../config/MainnetRuntimeConfig.js";
import { MainnetFinancialLedger } from "../payment/MainnetFinancialLedger.js";
import { MainnetRefundLifecycle } from "../payment/MainnetRefundLifecycle.js";
import { MainnetPayoutLifecycle } from "../payment/MainnetPayoutLifecycle.js";
import { MainnetTonapiPayoutVerifier } from "../payment/MainnetTonapiPayoutVerifier.js";
import { MainnetWalletPoolRegistry } from "../wallet/MainnetWalletPoolRegistry.js";

const ROOM = "mainnet-room-3b";
const SOURCE = `0:${"1".repeat(64)}`;
const PAYER = `0:${"2".repeat(64)}`;
const WINNER = `0:${"3".repeat(64)}`;
const OWNER = `0:${"4".repeat(64)}`;
const MESSAGE_HASH = "a".repeat(64);
function payoutEvidence({ transactionId, destinationIdentity, amountAtomic }) {
    return { status: "MASTERCHAIN_INDEXED_RECIPIENT_CREDIT_OBSERVED", globalId: -239,
        sourceTransactionId: transactionId, recipientTransactionId: "b".repeat(64),
        messageHash: MESSAGE_HASH, sourceWalletAddress: SOURCE,
        destinationAddress: destinationIdentity, amountAtomic };
}
const payoutVerifier = { verifyTransfer: async (input) => ({ status: "INDEPENDENT_INDEXED_CREDIT_OBSERVED",
    ...input, actualFeeAtomic: 1000, provider: "tonapi-mainnet", network: "mainnet", globalId: -239 }) };

function makeHarness(t) {
    const dir = mkdtempSync(join(tmpdir(), "wheelwin-mainnet-financial-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const catalog = JSON.stringify(Array.from({ length: 64 }, (_, i) => ({
        walletId: `mw-${i + 1}`, roomNumber: i + 1,
        address: `0:${String(i + 10).padStart(64, "0")}`, network: "mainnet"
    })));
    const config = loadMainnetRuntimeConfig({ TON_NETWORK: "mainnet",
        MAINNET_TONCENTER_API_KEY: "synthetic-offline-key", MAINNET_ROOM_WALLET_DATA_DIR: dir,
        MAINNET_ROOM_WALLETS_JSON: catalog });
    const ledger = new MainnetFinancialLedger({ config, nowProvider: () => 1_800_000_000_000 }).initialize();
    return { dir, config, ledger };
}

function incomingStub(count) {
    const intents = Array.from({ length: 3 }, (_, i) => ({
        paymentReference: `pay-${i + 1}`, roomId: ROOM, playerId: `player-${i + 1}`,
        network: "mainnet", globalId: -239, asset: "TON",
        state: i < count ? "SETTLED" : "PENDING",
        confirmedTransactionId: i < count ? `incoming-${i + 1}` : null,
        amountAtomic: "100000000", expectedSender: PAYER,
        destinationWalletAddress: SOURCE
    }));
    const receipts = intents.slice(0, count).map((intent, i) => ({
        network: "mainnet", globalId: -239, status: "CONFIRMED", reason: null, roomId: ROOM,
        transactionId: intent.confirmedTransactionId, asset: "TON",
        paymentReference: intent.paymentReference, playerId: intent.playerId,
        amountAtomic: intent.amountAtomic, sourceAddress: PAYER, destinationAddress: SOURCE,
        transactionTime: 1_800_000_000_000
    }));
    const observations = receipts.map(receipt => ({ network: "mainnet", globalId: -239,
        roomId: ROOM, transactionId: receipt.transactionId, payloadFingerprint: "a".repeat(64),
        sourceAddress: PAYER, destinationAddress: SOURCE, amountAtomic: receipt.amountAtomic,
        asset: "TON", transactionTime: 1_800_000_000_000, observedAt: 1_800_000_000_001 }));
    return { network: "mainnet", globalId: -239,
        listReceipts: (roomId) => roomId === ROOM ? receipts : [],
        listRoomIntents: (roomId) => roomId === ROOM ? intents : [],
        listObservations: (roomId) => roomId === ROOM ? observations : [] };
}

test("Mainnet refund preparation creates one, two, or three obligations and is idempotent", (t) => {
    for (const count of [1, 2, 3]) {
        const h = makeHarness(t);
        const created = h.ledger.prepareRefunds({ roomId: ROOM, roomNumber: 3,
            closureReason: "pre_page5_destroyed", incomingLedger: incomingStub(count) });
        assert.equal(created.length, count);
        assert.ok(created.every(x => x.state === "PENDING" && x.globalId === -239));
        const repeated = h.ledger.prepareRefunds({ roomId: ROOM, roomNumber: 3,
            closureReason: "pre_page5_destroyed", incomingLedger: incomingStub(count) });
        assert.equal(repeated.length, count);
        assert.ok(repeated.every(x => x.replay));
    }
});

test("Mainnet refund charges indexed network fee to payer's refund and recovers after restart", async (t) => {
    const h = makeHarness(t);
    const refunds = h.ledger.prepareRefunds({ roomId: ROOM, roomNumber: 3,
        closureReason: "destroyed", incomingLedger: incomingStub(1) });
    let sent;
    const adapter = {
        estimateOutboundTransferFee: async () => ({ ok: true, totalNano: 1_000_000n }),
        sendTransfer: async (request) => { sent = request; return { ok: true, txHash: "refund-out-1" }; }
    };
    const observer = {
        findOutgoingTransfer: async (query) => ({ transactionId: "refund-out-1", query }),
        verifyIndexedRecipientCredit: async (query) => ({
            status: "MASTERCHAIN_INDEXED_RECIPIENT_CREDIT_OBSERVED", globalId: -239,
            sourceTransactionId: query.transactionId, amountAtomic: query.amountAtomic,
            destinationAddress: query.destinationIdentity, sourceMcBlockSeqno: 21, recipientMcBlockSeqno: 22
        })
    };
    const flow = new MainnetRefundLifecycle({ financialLedger: h.ledger,
        incomingLedger: incomingStub(1), adapter, outgoingObserver: observer,
        nowProvider: () => 1_800_000_001_000 });
    const submitted = await flow.submitRefund(refunds[0].obligationId);
    assert.equal(submitted.outcome, "SUBMITTED");
    const record = h.ledger.getRefund(refunds[0].obligationId);
    assert.equal(record.transferAmountAtomic + record.gasChargeAtomic, record.amountAtomic);
    assert.equal(sent.amountNano, BigInt(record.transferAmountAtomic));
    const restored = new MainnetFinancialLedger({ config: h.config }).initialize();
    const recovered = new MainnetRefundLifecycle({ financialLedger: restored,
        incomingLedger: incomingStub(1), adapter, outgoingObserver: observer });
    assert.equal((await recovered.reconcileRefund(record.obligationId)).outcome, "REFUND_COMPLETE");
    assert.equal(restored.getRefund(record.obligationId).state, "COMPLETE");
});

test("Mainnet refund ambiguity is not resubmitted on recovery", async (t) => {
    const h = makeHarness(t);
    const obligation = h.ledger.prepareRefunds({ roomId: ROOM, roomNumber: 3,
        closureReason: "destroyed", incomingLedger: incomingStub(1) })[0];
    let sends = 0;
    const adapter = { estimateOutboundTransferFee: async () => ({ ok: true, totalNano: 1_000_000n }),
        sendTransfer: async () => { sends++; throw new Error("mock timeout"); } };
    const observer = { findOutgoingTransfer: async () => null, verifyIndexedRecipientCredit: async () => null };
    const flow = new MainnetRefundLifecycle({ financialLedger: h.ledger,
        incomingLedger: incomingStub(1), adapter, outgoingObserver: observer });
    assert.equal((await flow.submitRefund(obligation.obligationId)).outcome, "SUBMISSION_UNKNOWN");
    assert.equal((await flow.submitRefund(obligation.obligationId)).outcome, "RECONCILE_ONLY");
    assert.equal(sends, 1);
});

test("Mainnet payout policy preserves Testnet shares of 95%, 4.9%, and 0.1%", (t) => {
    const h = makeHarness(t);
    const payout = h.ledger.createPayout({ payoutId: "payout_block3b", roomId: "payout-room",
        roomNumber: 5, sourceWalletAddress: SOURCE, principalAtomic: 100_000_000,
        winner: { recipientId: "winner", address: WINNER }, owner: { recipientId: "owner", address: OWNER } });
    assert.equal(payout.allocation.winnerAtomic, 95_000_000);
    assert.equal(payout.allocation.ownerAtomic, 4_900_000);
    assert.equal(payout.allocation.reserveAtomic, 100_000);
    assert.equal(payout.allocation.winnerAtomic + payout.allocation.ownerAtomic
        + payout.allocation.reserveAtomic, payout.principalAtomic);
});

test("winner is sent and confirmed before owner; both credits settle once", async (t) => {
    const h = makeHarness(t);
    const payout = h.ledger.createPayout({ payoutId: "payout_paid_both", roomId: "paid-room",
        roomNumber: 5, sourceWalletAddress: SOURCE, principalAtomic: 100_000_000,
        winner: { recipientId: "winner", address: WINNER }, owner: { recipientId: "owner", address: OWNER } });
    const sent = [];
    const adapter = { sendTransfer: async (request) => {
        sent.push(request);
        return { ok: true, txHash: `out-${sent.length}` };
    } };
    const observer = {
        findOutgoingTransfer: async ({ destinationIdentity }) => ({ transactionId: destinationIdentity === WINNER ? "out-1" : "out-2" }),
        verifyIndexedRecipientCredit: async ({ transactionId, destinationIdentity, amountAtomic }) => ({
            ...payoutEvidence({ transactionId, destinationIdentity, amountAtomic })
        })
    };
    const flow = new MainnetPayoutLifecycle({ financialLedger: h.ledger, adapter, outgoingObserver: observer, independentVerifier: payoutVerifier });
    assert.equal((await flow.submitPayout(payout.payoutId)).status, "PAYOUT_COMPLETE");
    assert.deepEqual(sent.map(x => x.amountNano), [95_000_000n, 4_900_000n]);
    assert.equal((await flow.submitPayout(payout.payoutId)).status, "PAYOUT_COMPLETE");
    assert.equal(sent.length, 2);
});

test("confirmed winner with owner gas shortage records unpaid commission without wallet-blocking debt", async (t) => {
    const h = makeHarness(t);
    const payout = h.ledger.createPayout({ payoutId: "payout_owner_gas", roomId: "gas-room",
        roomNumber: 5, sourceWalletAddress: SOURCE, principalAtomic: 100_000_000,
        winner: { recipientId: "winner", address: WINNER }, owner: { recipientId: "owner", address: OWNER } });
    const sent = [];
    const adapter = { sendTransfer: async (request) => {
        sent.push(request);
        if (request.destination === OWNER) { const error = new Error("insufficient gas"); error.code = "INSUFFICIENT_GAS"; throw error; }
        return { ok: true, txHash: "winner-tx" };
    } };
    const observer = { findOutgoingTransfer: async () => ({ transactionId: "winner-tx" }),
        verifyIndexedRecipientCredit: async ({ transactionId, destinationIdentity, amountAtomic }) => ({
            ...payoutEvidence({ transactionId, destinationIdentity, amountAtomic })
        }) };
    const flow = new MainnetPayoutLifecycle({ financialLedger: h.ledger, adapter, outgoingObserver: observer, independentVerifier: payoutVerifier });
    assert.equal((await flow.submitPayout(payout.payoutId)).status, "OWNER_COMMISSION_UNPAID_INSUFFICIENT_GAS");
    assert.equal(h.ledger.getPayout(payout.payoutId).winner.state, "CONFIRMED");
    assert.equal(h.ledger.getPayout(payout.payoutId).owner.state, "UNPAID_INSUFFICIENT_GAS");
    assert.equal(h.ledger.countOpenObligations("gas-room"), 1);
    assert.equal(h.ledger.countWalletBlockingObligations("gas-room"), 0);
    assert.equal(sent.length, 2);
});

test("owner commission may be retried explicitly after gas returns", async (t) => {
    const h = makeHarness(t);
    const payout = h.ledger.createPayout({ payoutId: "payout_retry_owner", roomId: "retry-room",
        roomNumber: 5, sourceWalletAddress: SOURCE, principalAtomic: 100_000_000,
        winner: { recipientId: "winner", address: WINNER }, owner: { recipientId: "owner", address: OWNER } });
    let ownerFails = true;
    const adapter = { sendTransfer: async ({ destination }) => {
        if (destination === OWNER && ownerFails) { const error = new Error(); error.code = "INSUFFICIENT_GAS"; throw error; }
        return { ok: true, txHash: destination === WINNER ? "winner-tx" : "owner-tx" };
    } };
    const observer = { findOutgoingTransfer: async ({ destinationIdentity }) => ({ transactionId: destinationIdentity === WINNER ? "winner-tx" : "owner-tx" }),
        verifyIndexedRecipientCredit: async ({ transactionId, destinationIdentity, amountAtomic }) => ({
            ...payoutEvidence({ transactionId, destinationIdentity, amountAtomic })
        }) };
    const flow = new MainnetPayoutLifecycle({ financialLedger: h.ledger, adapter, outgoingObserver: observer, independentVerifier: payoutVerifier });
    await flow.submitPayout(payout.payoutId);
    ownerFails = false;
    assert.equal((await flow.retryUnpaidOwnerCommission(payout.payoutId)).status, "PAYOUT_COMPLETE");
});

test("restart reconciliation confirms persisted payout legs without another broadcast", async (t) => {
    const h = makeHarness(t);
    const payout = h.ledger.createPayout({ payoutId: "payout_restart", roomId: "restart-room",
        roomNumber: 5, sourceWalletAddress: SOURCE, principalAtomic: 100_000_000,
        winner: { recipientId: "winner", address: WINNER }, owner: { recipientId: "owner", address: OWNER } });
    let sends = 0;
    const adapter = { sendTransfer: async () => { sends++; return { ok: true, txHash: "restart-winner" }; } };
    const pendingObserver = { findOutgoingTransfer: async () => null, verifyIndexedRecipientCredit: async () => null };
    const flow = new MainnetPayoutLifecycle({ financialLedger: h.ledger, adapter, outgoingObserver: pendingObserver, independentVerifier: payoutVerifier });
    assert.equal((await flow.submitPayout(payout.payoutId)).status, "WINNER_CONFIRMATION_PENDING");
    const restarted = new MainnetFinancialLedger({ config: h.config }).initialize();
    const observer = { findOutgoingTransfer: async ({ destinationIdentity }) => ({ transactionId: destinationIdentity === WINNER ? "restart-winner" : "restart-owner" }),
        verifyIndexedRecipientCredit: async ({ transactionId, destinationIdentity, amountAtomic }) => ({
            ...payoutEvidence({ transactionId, destinationIdentity, amountAtomic })
        }) };
    const recovered = new MainnetPayoutLifecycle({ financialLedger: restarted,
        adapter: { sendTransfer: async () => { sends++; throw new Error("must not broadcast during recovery"); } },
        outgoingObserver: observer, independentVerifier: payoutVerifier });
    const result = await recovered.reconcilePayout(payout.payoutId);
    assert.equal(result.winnerState, "CONFIRMED");
    assert.equal(sends, 1);
});

test("Testnet config is rejected and Testnet baseline files remain unchanged", (t) => {
    const h = makeHarness(t);
    assert.throws(() => new MainnetFinancialLedger({ config: {
        network: "testnet", globalId: -3, dataDir: h.dir
    } }), /MAINNET_FINANCIAL_LEDGER_CONFIG_INVALID/);
});

test("Mainnet pool releases only when the Mainnet ledger says no wallet-blocking obligations remain", (t) => {
    const h = makeHarness(t);
    const pool = new MainnetWalletPoolRegistry({ config: h.config });
    pool.initialize();
    pool.reserve({ roomId: "gas-room", walletId: "mw-5", network: "mainnet" });
    const payout = h.ledger.createPayout({ payoutId: "payout_release", roomId: "gas-room",
        roomNumber: 5, sourceWalletAddress: SOURCE, principalAtomic: 100_000_000,
        winner: { recipientId: "winner", address: WINNER }, owner: { recipientId: "owner", address: OWNER } });
    h.ledger.updatePayoutLeg(payout.payoutId, "winner", { state: "SUBMISSION_UNKNOWN" });
    h.ledger.updatePayoutLeg(payout.payoutId, "winner", { state: "CONFIRMED", transactionId: "winner" });
    h.ledger.updatePayoutLeg(payout.payoutId, "owner", { state: "SUBMISSION_UNKNOWN" });
    h.ledger.updatePayoutLeg(payout.payoutId, "owner", { state: "UNPAID_INSUFFICIENT_GAS" });
    assert.equal(pool.releaseForMainnetOutcome({ roomId: "gas-room", financialLedger: h.ledger }).released, true);
});

test("independent TonAPI verification is Mainnet-only and uses mocked GET requests", async () => {
    const sourceTx = "1".repeat(64), recipientTx = "2".repeat(64), messageHash = "3".repeat(64);
    const seen = [];
    const transactions = new Map([
        [sourceTx, { hash: sourceTx, account: SOURCE, success: true, aborted: false,
            out_msgs: [{ hash: messageHash, source: SOURCE, destination: WINNER,
                value: "95000000", bounced: false }], total_fees: "1234" }],
        [recipientTx, { hash: recipientTx, account: WINNER, success: true, aborted: false,
            in_msg: { hash: messageHash, source: SOURCE, destination: WINNER,
                value: "95000000", bounced: false } }]
    ]);
    const verifier = new MainnetTonapiPayoutVerifier({ fetchImpl: async (url, options) => {
        seen.push({ url: String(url), method: options.method });
        return { status: 200, json: async () => transactions.get(String(url).split("/").at(-1)) };
    } });
    const result = await verifier.verifyTransfer({ sourceTransactionId: sourceTx,
        recipientTransactionId: recipientTx, messageHash, sourceWalletAddress: SOURCE,
        destinationAddress: WINNER, amountAtomic: 95_000_000 });
    assert.equal(result.provider, "tonapi-mainnet");
    assert.equal(result.globalId, -239);
    assert.equal(result.actualFeeAtomic, 1234);
    assert.equal(seen.length, 2);
    assert.ok(seen.every(x => x.method === "GET" && x.url.startsWith("https://tonapi.io/")));
    transactions.set(recipientTx, { ...transactions.get(recipientTx), account: OWNER });
    assert.equal(await verifier.verifyTransfer({ sourceTransactionId: sourceTx,
        recipientTransactionId: recipientTx, messageHash, sourceWalletAddress: SOURCE,
        destinationAddress: WINNER, amountAtomic: 95_000_000 }), null);
});
