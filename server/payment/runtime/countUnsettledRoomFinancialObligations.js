/**
 * Cross-ledger wallet hold. The incoming intent's SETTLED state only proves
 * collection of player funds; it does NOT mean that the room wallet is free.
 * Keep it reserved until confirmed principal has either been refunded or
 * covered by a payout plan whose two obligations are fully settled.
 *
 * Called after the durable stores have loaded, at startup and on explicit
 * room-wallet release. No network access and no signing keys.
 */
import { LEDGER_ENTRY_KIND } from "../ledger/LedgerConstants.js";

export function countUnsettledRoomFinancialObligations({
    roomId, ledger, refundStore, receiptStore = null
}) {
    if (typeof roomId !== "string" || !roomId
        || typeof ledger?.store?.listForRoom !== "function"
        || typeof ledger.listPayoutObligations !== "function"
        || typeof refundStore?.list !== "function") {
        throw new Error("ROOM_FINANCIAL_HOLD_STORE_UNAVAILABLE");
    }
    const entries = ledger.store.listForRoom(roomId);
    const principal = entries.filter(entry =>
        entry.kind === LEDGER_ENTRY_KIND.INCOMING_PRINCIPAL);
    const refunds = refundStore.list().filter(item => item.roomId === roomId);
    const credited = new Set(principal.map(entry => entry.metadata?.transactionId));
    const unreturnedReceipts = (receiptStore?.listForRoom(roomId) ?? []).filter(receipt =>
        !credited.has(receipt.transactionId) && !refunds.some(refund =>
            refund.incomingTransactionId === receipt.transactionId && refund.state === 'COMPLETE'));
    if (unreturnedReceipts.length) return unreturnedReceipts.length;
    const pendingRefunds = refunds.filter(item => item.state !== "COMPLETE");
    const openPayouts = ledger.listPayoutObligations(roomId)
        .filter(item => !item.settled);
    if (openPayouts.length || pendingRefunds.length) {
        return openPayouts.length + pendingRefunds.length;
    }

    // Successful payout plans can release their wallet only when every
    // recipient has a durable settlement. Missing recipient obligations,
    // contradictory plans or missing confirmations leave a hold.
    const plans = entries.filter(entry =>
        entry.kind === LEDGER_ENTRY_KIND.PAYOUT_PLAN);
    if (plans.length) {
        const planned = ledger.listPayoutObligations(roomId);
        if (plans.length === 1
            && planned.length === 2
            && planned.every(item => item.settled)) return 0;
        return 1;
    }

    // No payout plan: each collected payment must have a COMPLETE refund
    // bound to exactly that payment reference and incoming transaction.
    const returned = new Set(refunds.filter(item => item.state === "COMPLETE")
        .map(item => `${item.paymentIntentId}:${item.incomingTransactionId}`));
    return principal.filter(entry => {
        const ref = entry.metadata?.paymentReference;
        const tx = entry.metadata?.transactionId;
        return !ref || !tx || !returned.has(`${ref}:${tx}`);
    }).length;
}
