import { recoverSettledPrincipal } from './recoverSettledPrincipal.js';
/** Send only debts never attempted; ambiguous attempts belong to reconciliation. */
export class TestnetPendingRefundExecutor {
    constructor({ runtime, maxPerPass = 3 }) {
        this.runtime = runtime;
        this.max = maxPerPass;
        this.running = false;
        this.cursor = 0;
        this.roomCursor = 0;
    }
    async runPass() {
        if (this.running || !this.runtime.outgoingRefundProvider?.canExecute()) return [];
        this.running = true;
        try {
            // Also reconstruct debts for confirmations arriving after closure.
            const closed = this.runtime.refundStore.listClosedRooms();
            for (let i = 0; i < Math.min(this.max, closed.length); i++) {
                const room = closed[(this.roomCursor + i) % closed.length];
                try {
                    const intents = this.runtime.intentStore.listForRoom(room.roomId);
                    if (intents.some(x => ['PENDING','MATCHED'].includes(x.state))) {
                        // Recheck the original payment window after finality arrives.
                        // This never extends a room deadline or reopens gameplay.
                        const ceilingMs = Math.min(Date.now(), Math.max(...intents.map(x => x.expiresAt - 1)));
                        await this.runtime.coordinator.settleRoomPayments({roomId:room.roomId, ceilingMs});
                    }
                    recoverSettledPrincipal(this.runtime, room.roomId);
                    this.runtime.refundLifecycle.prepareLateConfirmedPayments(room.roomId);
                    this.runtime.receiptAccounting?.prepareClosedRoom(room.roomId);
                    this.runtime.paymentService.releaseWalletForRoom(room.roomId);
                } catch { /* Keep the reservation and debt; next bounded pass retries. */ }
            }
            this.roomCursor = closed.length ? (this.roomCursor + this.max) % closed.length : 0;
            const pending = this.runtime.refundStore.listPending().filter(x => x.state === 'PENDING');
            const results = [];
            for (let i = 0; i < Math.min(this.max, pending.length); i++) {
                const debt = pending[(this.cursor + i) % pending.length];
                try { results.push(await this.runtime.refundLifecycle.submitRefund(debt.obligationId)); }
                catch { results.push({obligationId:debt.obligationId, outcome:'RETRY_LATER'}); }
            }
            this.cursor = pending.length ? (this.cursor + results.length) % pending.length : 0;
            return results;
        } finally { this.running = false; }
    }
}
