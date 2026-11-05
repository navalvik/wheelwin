/**
 * A single forensic ZIP may be published only after the room's recorded
 * financial outcome is final. Missing evidence = hold, never pre-archive.
 * No TON operations, network requests, timers or state mutations here.
 */
export const FINAL_ARCHIVE_CHAIN_SETTLEMENT_GRACE_MS = 90_000;

export function evaluateFinalForensicArchive({
    snapshot,
    sessionRecord = null,
    nowMs = Date.now()
} = {}) {
    const hold = reason => Object.freeze({ready:false,reason});
    if (!snapshot || typeof snapshot !== "object")
        return hold("FINANCIAL_SNAPSHOT_UNAVAILABLE");
    if (!Number.isSafeInteger(snapshot.outstandingObligations)
        || snapshot.outstandingObligations !== 0)
        return hold("FINANCIAL_OBLIGATIONS_OPEN_OR_UNKNOWN");
    if (!Array.isArray(snapshot.intents) || !Array.isArray(snapshot.refunds)
        || !Array.isArray(snapshot.ledger) || !Array.isArray(snapshot.unresolvedReceipts))
        return hold("FINANCIAL_RECORDS_INCOMPLETE");
    if (snapshot.unresolvedReceipts.length > 0)
        return hold("UNRESOLVED_INCOMING_RECEIPTS");
    if (snapshot.refunds.some(refund => refund.state !== "COMPLETE"
        || !refund.finalizedEvidence))
        return hold("REFUND_FINALITY_PENDING");

    const payout = snapshot.outcome?.kind === "PAYOUT";
    const refund = snapshot.outcome?.kind === "REFUND" || Boolean(snapshot.closedRoom);
    if (payout) {
        // Prize transfers can finish while Page5/Page6 is still active.
        // Wait for the durable terminal game report, not just money finality.
        if (!sessionRecord || !Number.isSafeInteger(sessionRecord.finishedAt)
            || !["GAME_COMPLETED","COMPLETED","RESULT_SESSION_FINISHED",
                "SESSION_ENDED"].includes(sessionRecord.lifecycleResult))
            return hold("FINAL_GAME_SESSION_NOT_ARCHIVED");
        if (snapshot.intents.length !== 3
            || snapshot.intents.some(x => x.state !== "SETTLED"))
            return hold("PAYOUT_PAYMENT_FINALITY_PENDING");
        if (snapshot.refunds.length !== 0) return hold("PAYOUT_REFUND_CONFLICT");
        if (!snapshot.ledger.some(x => x.kind === "PAYOUT_PLAN"))
            return hold("PAYOUT_PLAN_NOT_READY");
        const receipts = snapshot.ledger.filter(x => x.kind === "PAYOUT_SETTLEMENT");
        if (receipts.length !== 2)
            return hold("WINNER_OR_OWNER_PAYOUT_UNCONFIRMED");
        return Object.freeze({ready:true,reason:"FINAL_WINNER_AND_OWNER_PAYOUTS"});
    }
    if (refund) {
        const closedAt = snapshot.closedRoom?.closedAtMs;
        if (!Number.isSafeInteger(closedAt) || closedAt <= 0)
            return hold("ROOM_CLOSURE_NOT_DURABLE");
        if (nowMs < closedAt + FINAL_ARCHIVE_CHAIN_SETTLEMENT_GRACE_MS)
            return hold("ONCHAIN_HISTORY_GRACE_PERIOD");
        if (snapshot.intents.length > 0) {
            const checks = (snapshot.paymentObservations ?? [])
                .filter(x => x.source === "FINAL_FORENSIC_HISTORY_COVERAGE"
                    && x.resultWindowComplete === true && x.providerError == null);
            const last = checks.at(-1);
            if (!last || !Number.isSafeInteger(last.completedAt)
                || last.completedAt < closedAt + FINAL_ARCHIVE_CHAIN_SETTLEMENT_GRACE_MS
                || last.pendingCount !== 0
                || !Number.isSafeInteger(last.candidateCount)
                || last.candidateCount !== last.checkedCount)
                return hold("ONCHAIN_HISTORY_RECONCILIATION_PENDING");
        }
        if (snapshot.outcome?.kind === "PAYOUT")
            return hold("FINANCIAL_OUTCOME_CONFLICT");
        return Object.freeze({ready:true,reason:"FINAL_REFUNDS_AND_HISTORY"});
    }
    if (snapshot.intents.length === 0
        && snapshot.ledger.every(x => x.kind !== "INCOMING_PRINCIPAL"))
        return Object.freeze({ready:true,reason:"NO_FINANCIAL_ACTIVITY"});
    return hold("ROOM_FINANCIAL_OUTCOME_PENDING");
}
