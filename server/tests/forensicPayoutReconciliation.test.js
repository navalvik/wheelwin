import test from "node:test";
import assert from "node:assert/strict";
import {
    buildFinancialRecovery,
    buildFinalFinancialReport,
    buildPaymentDecisions
} from "../forensic/ForensicArchiveCollector.js";

const payoutId = "payout-QfDS-regression";
const transfers = [
    { recipientId:"player-olga", recipientRole:"WINNER" },
    { recipientId:"owner", recipientRole:"OWNER" }
];
const plan = { entryId:"entry-not-payout-id", kind:"PAYOUT_PLAN",
    metadata:{ payoutId, plan:{ payoutId, transfers } } };
const obligations = transfers.map(transfer => ({
    kind:"NET_PAYOUT", metadata:{ payoutId, recipientId:transfer.recipientId, role:transfer.recipientRole }
}));
const settlements = transfers.map(transfer => ({
    kind:"PAYOUT_SETTLEMENT",
    metadata:{ payoutId, recipientId:transfer.recipientId, role:transfer.recipientRole,
        transactionId:`onchain-${transfer.recipientRole}` }
}));

function financeWith(ledger) {
    const players=["olga","bob","lena"];
    return { roomId:"QfDS-regression", gameId:"game-QfDS-regression", network:"testnet",
        intents:players.map(p=>({
            playerId:`player-${p}`, paymentReference:`ref-${p}`,
            transactionId:`tx-${p}`, state:"SETTLED", amountAtomic:1_000_000_000
        })),
        receipts:players.map(p=>({
            playerId:`player-${p}`, paymentIntentId:`ref-${p}`,
            paymentReference:`ref-${p}`, transactionId:`tx-${p}`,
            transactionTime:1000, amountAtomic:1_000_000_000
        })),
        unresolvedReceipts:[], refunds:[], ledger, outstandingObligations:0
    };
}

function reportFor(finance) {
    const recovery=buildFinancialRecovery(finance);
    const decisions=buildPaymentDecisions(finance);
    return { recovery, decisions, report:buildFinalFinancialReport(finance,decisions,recovery) };
}

test("final game: two settled payouts linked by payoutId are not an investigation", () => {
    const {recovery,decisions,report}=reportFor(financeWith([plan,...obligations,...settlements]));
    assert.deepEqual(decisions.map(d=>d.decision),["SETTLED","SETTLED","SETTLED"]);
    assert.equal(recovery.requiresReconciliation,false);
    assert.equal(report.requiresInvestigation,false);
    assert.equal(report.paymentCounts.settled,3);
});

test("winner settled while owner remains unpaid still requires reconciliation", () => {
    const {recovery,report}=reportFor(financeWith([plan,...obligations,settlements[0]]));
    assert.equal(recovery.requiresReconciliation,true);
    assert.equal(report.requiresInvestigation,true);
});

test("unrelated payout settlement cannot close a plan", () => {
    const wrong={...settlements[1],metadata:{...settlements[1].metadata,payoutId:"other-payout"}};
    const {recovery,report}=reportFor(financeWith([plan,...obligations,settlements[0],wrong]));
    assert.equal(recovery.requiresReconciliation,true);
    assert.equal(report.requiresInvestigation,true);
});

test("payout plan with incomplete recipient list remains under investigation", () => {
    const broken={...plan,metadata:{...plan.metadata,plan:{payoutId,transfers:[transfers[0]]}}};
    const {recovery}=reportFor(financeWith([broken,...obligations,...settlements]));
    assert.equal(recovery.requiresReconciliation,true);
});

test("unresolved incoming transfer still requires investigation after both payouts settle", () => {
    const finance=financeWith([plan,...obligations,...settlements]);
    finance.unresolvedReceipts.push({ transactionId:"unresolved", ownershipStatus:"UNRESOLVED",
        playerId:null, paymentIntentId:null });
    const {recovery,report}=reportFor(finance);
    assert.equal(recovery.requiresReconciliation,true);
    assert.equal(report.requiresInvestigation,true);
});
