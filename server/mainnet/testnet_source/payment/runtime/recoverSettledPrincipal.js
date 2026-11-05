/** Repair the receipt -> ledger append crash boundary without trusting a caller. */
export function recoverSettledPrincipal({ intentStore, ledgerStore, ledger }, roomId = null) {
    for (const intent of intentStore.list().filter(x => x.state === 'SETTLED' && (!roomId || x.roomId === roomId))) {
        const booked = ledgerStore.listForRoom(intent.roomId).some(e => e.kind === 'INCOMING_PRINCIPAL' && e.metadata?.paymentReference === intent.paymentReference);
        if (!booked) ledger.recordIncomingPrincipal({
            idempotencyKey: 'ww:incoming-principal:' + intent.paymentReference,
            roomId: intent.roomId, playerId: intent.playerId, amountAtomic: intent.amountAtomic,
            confirmation: {paymentReference: intent.paymentReference, transactionId: intent.transactionId, source: 'SETTLED_PAYMENT_INTENT'}
        });
    }
}
