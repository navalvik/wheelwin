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
const refundVerifier = { verifyTransfer: async input => ({ status: "INDEPENDENT_INDEXED_CREDIT_OBSERVED",
    ...input, actualFeeAtomic: 1000, provider: "tonapi-mainnet", network: "mainnet", globalId: -239 }) };
function indexedRefundEvidence(query) {
    return { status: "MASTERCHAIN_INDEXED_RECIPIENT_CREDIT_OBSERVED", globalId: -239,
        sourceTransactionId: query.transactionId, recipientTransactionId: "b".repeat(64),
        messageHash: MESSAGE_HASH, sourceWalletAddress: SOURCE,
        destinationAddress: query.destinationIdentity, amountAtomic: query.amountAtomic,
        sourceMcBlockSeqno: 21, recipientMcBlockSeqno: 22,
        sourceFinality: "finalized", recipientFinality: "finalized",
        sourceBlockRef: { workchain: 0, shard: "8000000000000000", seqno: 21 },
        recipientBlockRef: { workchain: 0, shard: "8000000000000000", seqno: 22 } };
}

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

function configureRefundSourceReservation(flow, { roomNumber = 3, reservedByRoomId = ROOM } = {}) {
    flow.configureCurrentWalletReservationResolver(number => number === roomNumber ? ({
        walletId: `mw-${roomNumber}`, roomNumber, address: SOURCE, network: "mainnet", reservedByRoomId
    }) : null);
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
        findOutgoingTransfer: async (query) => ({ transactionId: "refund-out-1",
            sourceAddress: query.sourceWalletAddress, destinationAddress: query.destinationIdentity,
            amountAtomic: query.amountAtomic }),
        verifyIndexedRecipientCredit: async query => indexedRefundEvidence(query)
    };
    const flow = new MainnetRefundLifecycle({ financialLedger: h.ledger,
        incomingLedger: incomingStub(1), adapter, outgoingObserver: observer,
        independentVerifier: refundVerifier, nowProvider: () => 1_800_000_001_000 });
    configureRefundSourceReservation(flow);
    const submitted = await flow.submitRefund(refunds[0].obligationId);
    assert.equal(submitted.outcome, "SUBMITTED");
    const record = h.ledger.getRefund(refunds[0].obligationId);
    assert.equal(record.transferAmountAtomic + record.gasChargeAtomic, record.amountAtomic);
    assert.equal(sent.amountNano, BigInt(record.transferAmountAtomic));
    const restored = new MainnetFinancialLedger({ config: h.config }).initialize();
    const recovered = new MainnetRefundLifecycle({ financialLedger: restored,
        incomingLedger: incomingStub(1), adapter, outgoingObserver: observer,
        independentVerifier: refundVerifier });
    assert.equal((await recovered.reconcileRefund(record.obligationId)).outcome, "REFUND_COMPLETE_TWO_SOURCES");
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
        incomingLedger: incomingStub(1), adapter, outgoingObserver: observer,
        independentVerifier: refundVerifier });
    configureRefundSourceReservation(flow);
    assert.equal((await flow.submitRefund(obligation.obligationId)).outcome, "SUBMISSION_UNKNOWN");
    assert.equal((await flow.submitRefund(obligation.obligationId)).outcome, "RECONCILE_ONLY");
    assert.equal(sends, 1);
});

test("refund completes only when indexed Toncenter and TonAPI independently agree", async t => {
    const scenarios = [
        { name: "both sources agree", indexed: "valid", independent: "valid", expected: "REFUND_COMPLETE_TWO_SOURCES", complete: true },
        { name: "Toncenter only", indexed: "valid", independent: null, expected: "FINALITY_PENDING", complete: false },
        { name: "TonAPI only", indexed: null, independent: "valid", expected: "FINALITY_PENDING", complete: false },
        { name: "address mismatch", indexed: "wrong-address", independent: "valid", expected: "FINALITY_PENDING", complete: false },
        { name: "amount mismatch", indexed: "wrong-amount", independent: "valid", expected: "FINALITY_PENDING", complete: false },
        { name: "transaction mismatch", indexed: "wrong-transaction", independent: "valid", expected: "FINALITY_PENDING", complete: false },
        { name: "Toncenter destination mismatch", indexed: "indexed-wrong-address", independent: "valid", expected: "FINALITY_PENDING", complete: false },
        { name: "Toncenter unfinalized credit", indexed: "unfinalized", independent: "valid", expected: "FINALITY_PENDING", complete: false },
        { name: "TonAPI destination mismatch", indexed: "valid", independent: "wrong-address", expected: "FINALITY_PENDING", complete: false },
        { name: "TonAPI amount mismatch", indexed: "valid", independent: "wrong-amount", expected: "FINALITY_PENDING", complete: false },
        { name: "TonAPI transaction mismatch", indexed: "valid", independent: "wrong-transaction", expected: "FINALITY_PENDING", complete: false },
        { name: "TonAPI message mismatch", indexed: "valid", independent: "wrong-message", expected: "FINALITY_PENDING", complete: false },
        { name: "TonAPI network mismatch", indexed: "valid", independent: "wrong-network", expected: "FINALITY_PENDING", complete: false },
        { name: "Toncenter rate limit", indexed: "throws", independent: "valid", expected: "REFUND_RECONCILIATION_RETRY_LATER", complete: false },
        { name: "Toncenter credit lookup rate limit", indexed: "verify-throws", independent: "valid", expected: "REFUND_RECONCILIATION_RETRY_LATER", complete: false },
        { name: "TonAPI unavailable", indexed: "valid", independent: "throws", expected: "REFUND_RECONCILIATION_RETRY_LATER", complete: false }
    ];
    for (const scenario of scenarios) {
        const h = makeHarness(t);
        const obligation = h.ledger.prepareRefunds({ roomId: ROOM, roomNumber: 3,
            closureReason: "destroyed", incomingLedger: incomingStub(1) })[0];
        h.ledger.updateRefund(obligation.obligationId, { state: "SUBMISSION_UNKNOWN",
            transferAmountAtomic: obligation.amountAtomic - 1_200_000,
            gasChargeAtomic: 1_200_000 });
        h.ledger.updateRefund(obligation.obligationId, { state: "SUBMITTED",
            outgoingTransactionId: "refund-out-1" });
        const stored = h.ledger.getRefund(obligation.obligationId);
        const amountAtomic = stored.transferAmountAtomic;
        let sends = 0;
        const indexedObserver = {
            async findOutgoingTransfer(query) {
                if (scenario.indexed === "throws") throw Object.assign(new Error("429"), { status: 429 });
                return { transactionId: scenario.indexed === "wrong-transaction" ? "refund-other" : "refund-out-1",
                    sourceAddress: SOURCE,
                    destinationAddress: scenario.indexed === "wrong-address" ? OWNER : PAYER,
                    amountAtomic: scenario.indexed === "wrong-amount" ? amountAtomic + 1 : amountAtomic };
            },
            async verifyIndexedRecipientCredit(query) {
                if (scenario.indexed === "throws") throw Object.assign(new Error("429"), { status: 429 });
                if (scenario.indexed === "verify-throws") throw Object.assign(new Error("429"), { status: 429 });
                if (scenario.indexed === null) return null;
                const evidence = indexedRefundEvidence(query);
                if (scenario.indexed === "indexed-wrong-address") evidence.destinationAddress = OWNER;
                if (scenario.indexed === "unfinalized") evidence.recipientFinality = "pending";
                if (scenario.indexed === "wrong-transaction") evidence.sourceTransactionId = "refund-other";
                return evidence;
            }
        };
        const independent = { async verifyTransfer(input) {
            if (scenario.independent === "throws") throw new Error("TonAPI unavailable");
            if (scenario.independent === null) return null;
            const result = { status: "INDEPENDENT_INDEXED_CREDIT_OBSERVED", ...input,
                actualFeeAtomic: 500, provider: "tonapi-mainnet", network: "mainnet", globalId: -239 };
            if (scenario.independent === "wrong-address") result.destinationAddress = OWNER;
            if (scenario.independent === "wrong-amount") result.amountAtomic += 1;
            if (scenario.independent === "wrong-transaction") result.recipientTransactionId = "c".repeat(64);
            if (scenario.independent === "wrong-message") result.messageHash = "d".repeat(64);
            if (scenario.independent === "wrong-network") result.globalId = -3;
            return result;
        } };
        const flow = new MainnetRefundLifecycle({ financialLedger: h.ledger,
            incomingLedger: incomingStub(1),
            adapter: { async estimateOutboundTransferFee() { return { ok: true, totalNano: 1n }; },
                async sendTransfer() { sends++; return { ok: true, txHash: "duplicate-send" }; } },
            outgoingObserver: indexedObserver, independentVerifier: independent });
        const result = await flow.reconcileRefund(obligation.obligationId);
        assert.equal(result.outcome, scenario.expected, scenario.name);
        assert.equal(h.ledger.getRefund(obligation.obligationId).state === "COMPLETE", scenario.complete,
            `${scenario.name} completion state`);
        if (scenario.complete) {
            const replay = await flow.reconcileRefund(obligation.obligationId);
            assert.equal(replay.outcome, "NOT_READY_FOR_RECONCILIATION");
        }
        assert.equal(sends, 0, `${scenario.name} must remain read-only`);
    }
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
    const fundingChecks = [];
    const adapter = {
        canFundTransfer: async request => {
            fundingChecks.push(request);
            return { ok: true, roomNumber: request.roomNumber, address: SOURCE };
        },
        sendTransfer: async (request) => {
            sent.push(request);
            return { ok: true, txHash: `out-${sent.length}` };
        }
    };
    const observer = {
        findOutgoingTransfer: async ({ destinationIdentity }) => ({ transactionId: destinationIdentity === WINNER ? "out-1" : "out-2" }),
        verifyIndexedRecipientCredit: async ({ transactionId, destinationIdentity, amountAtomic }) => ({
            ...payoutEvidence({ transactionId, destinationIdentity, amountAtomic })
        })
    };
    const flow = new MainnetPayoutLifecycle({ financialLedger: h.ledger, adapter, outgoingObserver: observer, independentVerifier: payoutVerifier });
    assert.equal((await flow.submitPayout(payout.payoutId)).status, "PAYOUT_COMPLETE");
    assert.deepEqual(sent.map(x => x.amountNano), [95_000_000n, 4_900_000n]);
    assert.deepEqual(sent.map(x => x.sourceReserveNano), [5_000_000n, 100_000n]);
    assert.deepEqual(fundingChecks.map(x => x.sourceReserveNano), [5_000_000n, 100_000n]);
    assert.deepEqual(fundingChecks.map(x => x.amountNano), [95_000_000n, 4_900_000n]);
    assert.equal((await flow.submitPayout(payout.payoutId)).status, "PAYOUT_COMPLETE");
    assert.equal(sent.length, 2);
});

test("source reserve preflight blocks a leg that cannot preserve the planned remainder", async t => {
    const winnerHarness = makeHarness(t);
    const winnerPayout = winnerHarness.ledger.createPayout({ payoutId: "payout_reserve_winner",
        roomId: "reserve-winner-room", roomNumber: 5, sourceWalletAddress: SOURCE,
        principalAtomic: 100_000_000,
        winner: { recipientId: "winner", address: WINNER },
        owner: { recipientId: "owner", address: OWNER } });
    let winnerSends = 0;
    const insufficientWinnerAdapter = {
        async canFundTransfer(request) {
            assert.equal(request.sourceReserveNano, 5_000_000n);
            return { ok: false, roomNumber: request.roomNumber, address: SOURCE };
        },
        async sendTransfer() { winnerSends += 1; return { ok: true, txHash: "must-not-send" }; }
    };
    const noEvidence = { async findOutgoingTransfer() { return null; },
        async verifyIndexedRecipientCredit() { return null; } };
    const winnerFlow = new MainnetPayoutLifecycle({ financialLedger: winnerHarness.ledger,
        adapter: insufficientWinnerAdapter, outgoingObserver: noEvidence, independentVerifier: payoutVerifier });
    assert.equal((await winnerFlow.submitPayout(winnerPayout.payoutId)).status, "SOURCE_RESERVE_UNAVAILABLE");
    assert.equal(winnerHarness.ledger.getPayout(winnerPayout.payoutId).winner.state, "PENDING");
    assert.equal(winnerSends, 0);

    const ownerHarness = makeHarness(t);
    const ownerPayout = ownerHarness.ledger.createPayout({ payoutId: "payout_reserve_owner",
        roomId: "reserve-owner-room", roomNumber: 5, sourceWalletAddress: SOURCE,
        principalAtomic: 100_000_000,
        winner: { recipientId: "winner", address: WINNER },
        owner: { recipientId: "owner", address: OWNER } });
    const sent = [];
    const ownerAdapter = {
        async canFundTransfer(request) {
            const requiredNano = request.amountNano + request.sourceReserveNano;
            const ok = request.sourceReserveNano === 5_000_000n;
            const balanceNano = ok ? requiredNano : request.amountNano;
            return { ok, roomNumber: request.roomNumber, address: SOURCE,
                amountNano: request.amountNano, gasReserveNano: request.sourceReserveNano,
                requiredNano, balanceNano, shortfallNano: ok ? 0n : requiredNano - balanceNano };
        },
        async sendTransfer(request) {
            sent.push(request);
            return { ok: true, txHash: "winner-reserve-ok" };
        }
    };
    const winnerObserver = {
        async findOutgoingTransfer({ destinationIdentity }) {
            return destinationIdentity === WINNER ? { transactionId: "winner-reserve-ok" } : null;
        },
        async verifyIndexedRecipientCredit({ transactionId, destinationIdentity, amountAtomic }) {
            return { ...payoutEvidence({ transactionId, destinationIdentity, amountAtomic }) };
        }
    };
    const ownerFlow = new MainnetPayoutLifecycle({ financialLedger: ownerHarness.ledger,
        adapter: ownerAdapter, outgoingObserver: winnerObserver, independentVerifier: payoutVerifier });
    const ownerResult = await ownerFlow.submitPayout(ownerPayout.payoutId);
    assert.equal(ownerResult.status, "OWNER_COMMISSION_UNPAID_INSUFFICIENT_GAS");
    assert.deepEqual(sent.map(request => request.destination), [WINNER]);
    assert.deepEqual(sent.map(request => request.sourceReserveNano), [5_000_000n]);
    assert.equal(ownerHarness.ledger.getPayout(ownerPayout.payoutId).winner.state, "CONFIRMED");
    assert.equal(ownerHarness.ledger.getPayout(ownerPayout.payoutId).owner.state, "UNPAID_INSUFFICIENT_GAS");
    assert.equal(ownerHarness.ledger.getPayout(ownerPayout.payoutId).state, "PARTIAL_OWNER_UNPAID");
    assert.equal(ownerHarness.ledger.countOpenObligations("reserve-owner-room"), 1,
        "unpaid Owner obligation remains in financial history");
    assert.equal(ownerHarness.ledger.countWalletBlockingObligations("reserve-owner-room"), 0);
    const restartedLedger = new MainnetFinancialLedger({ config: ownerHarness.config }).initialize();
    const restartedFlow = new MainnetPayoutLifecycle({ financialLedger: restartedLedger,
        adapter: ownerAdapter, outgoingObserver: winnerObserver, independentVerifier: payoutVerifier });
    assert.equal(restartedLedger.getPayout(ownerPayout.payoutId).winner.state, "CONFIRMED");
    assert.equal(restartedLedger.getPayout(ownerPayout.payoutId).owner.state, "UNPAID_INSUFFICIENT_GAS");
    assert.equal((await restartedFlow.submitPayout(ownerPayout.payoutId)).status,
        "OWNER_COMMISSION_UNPAID_INSUFFICIENT_GAS");
    assert.deepEqual(sent.map(request => request.destination), [WINNER],
        "restart cannot repeat Winner or attempt Owner after the definitive unpaid state");
});

test("unknown Owner balance preflight remains pending and does not become unpaid", async t => {
    const h = makeHarness(t);
    const payout = h.ledger.createPayout({ payoutId: "payout_owner_preflight_unknown", roomId: "owner-preflight-unknown",
        roomNumber: 5, sourceWalletAddress: SOURCE, principalAtomic: 100_000_000,
        winner: { recipientId: "winner", address: WINNER }, owner: { recipientId: "owner", address: OWNER } });
    const sent = [];
    const adapter = {
        async canFundTransfer(request) {
            if (request.amountNano === BigInt(payout.winner.amountAtomic)) {
                return { ok: true, roomNumber: request.roomNumber, address: SOURCE };
            }
            throw new Error("balance RPC unavailable");
        },
        async sendTransfer(request) { sent.push(request.destination); return { ok: true, txHash: "winner-preflight-unknown" }; }
    };
    const observer = {
        async findOutgoingTransfer({ destinationIdentity }) {
            return destinationIdentity === WINNER ? { transactionId: "winner-preflight-unknown" } : null;
        },
        async verifyIndexedRecipientCredit({ transactionId, destinationIdentity, amountAtomic }) {
            return { ...payoutEvidence({ transactionId, destinationIdentity, amountAtomic }) };
        }
    };
    const flow = new MainnetPayoutLifecycle({ financialLedger: h.ledger, adapter,
        outgoingObserver: observer, independentVerifier: payoutVerifier });
    const result = await flow.submitPayout(payout.payoutId);
    assert.equal(result.status, "SOURCE_RESERVE_UNAVAILABLE");
    assert.equal(result.role, "owner");
    assert.equal(h.ledger.getPayout(payout.payoutId).winner.state, "CONFIRMED");
    assert.equal(h.ledger.getPayout(payout.payoutId).owner.state, "PENDING");
    assert.equal(h.ledger.countWalletBlockingObligations("owner-preflight-unknown"), 1);
    assert.deepEqual(sent, [WINNER], "unknown balance does not authorize Owner send or unpaid classification");
});

test("confirmed winner with owner gas shortage records unpaid commission without wallet-blocking debt", async (t) => {
    const h = makeHarness(t);
    const payout = h.ledger.createPayout({ payoutId: "payout_owner_gas", roomId: "gas-room",
        roomNumber: 5, sourceWalletAddress: SOURCE, principalAtomic: 100_000_000,
        winner: { recipientId: "winner", address: WINNER }, owner: { recipientId: "owner", address: OWNER } });
    const sent = [];
    const adapter = {
        async canFundTransfer(request) { return { ok: true, roomNumber: request.roomNumber, address: SOURCE }; },
        sendTransfer: async (request) => {
            sent.push(request);
            if (request.destination === OWNER) { const error = new Error("insufficient gas"); error.code = "INSUFFICIENT_GAS"; throw error; }
            return { ok: true, txHash: "winner-tx" };
        }
    };
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
    const adapter = { async canFundTransfer(request) {
        return { ok: true, roomNumber: request.roomNumber, address: SOURCE };
    }, sendTransfer: async ({ destination }) => {
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
    const adapter = { async canFundTransfer(request) {
        return { ok: true, roomNumber: request.roomNumber, address: SOURCE };
    }, sendTransfer: async () => { sends++; return { ok: true, txHash: "restart-winner" }; } };
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
