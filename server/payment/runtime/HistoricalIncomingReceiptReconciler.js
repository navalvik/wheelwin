import { normalizeIncomingTransferRecord } from '../incoming/index.js';
import { tonAddressIdentitiesEqual } from '../incoming/TonAddressIdentity.js';

/** Read-only historical recovery. Two independent providers, no SSE replay or signing. */
export class HistoricalIncomingReceiptReconciler {
    constructor({runtime, incomingProvider, chainObserver, independentVerifier, nowProvider=Date.now}) {
        Object.assign(this,{runtime,incomingProvider,chainObserver,independentVerifier,nowProvider});
        this.cursor=0; this.running=false;
    }
    async recoverRoom(roomId) {
        const {intentStore,refundStore,receiptStore,receiptAccounting}=this.runtime;
        const recordAudit=(method,payload)=>{try{this.runtime.paymentForensicJournal?.[method]?.(roomId,payload);}catch{}};
        if (!refundStore.getClosedRoom(roomId)) return {roomId,status:'ROOM_NOT_CLOSED'};
        const intents=intentStore.listForRoom(roomId);
        if (!intents.length) return {roomId,status:'NO_INTENTS'};
        const floorMs=Math.min(...intents.map(i=>i.createdAt));
        // Continue querying through the current chain head: funds can arrive
        // after the game deadline and still require durable accounting.
        const startedAt=this.nowProvider();
        const ceilingMs=startedAt;
        let observed;
        try {
            observed=await this.incomingProvider.listIncomingTransactions({
                account:intents[0].destinationWalletAddress,floorMs,ceilingMs,limit:1000});
        } catch (error) {
            recordAudit("recordObservation", {
                startedAt, completedAt:this.nowProvider(), source:"HISTORICAL_RECONCILIATION",
                walletAddress:intents[0].destinationWalletAddress, providerRequests:1,
                rowsReturned:0, transfersFound:0, resultWindowComplete:false,
                providerError:error?.code ?? error?.message ?? "PROVIDER_UNAVAILABLE"
            });
            throw error;
        }
        recordAudit("recordObservation", {
            startedAt, completedAt:this.nowProvider(), source:"HISTORICAL_RECONCILIATION",
            walletAddress:intents[0].destinationWalletAddress, providerRequests:1,
            rowsReturned:observed.rowsReturned ?? observed.records?.length ?? 0,
            transfersFound:observed.records?.length ?? 0,
            resultWindowComplete:observed.resultWindowComplete === true,
            providerError:observed.resultWindowComplete === true ? null : "INCOMPLETE_RESULT_WINDOW"
        });
        if (!observed.resultWindowComplete) return {roomId,status:'HISTORY_INCOMPLETE'};
        let captured=0, checked=0;
        const pending=[];
        for (const record of observed.records) {
            const transfer=normalizeIncomingTransferRecord(record,{network:'testnet',providerId:'toncenter',now:this.nowProvider()});
            if (receiptStore.listForRoom(roomId).some(r=>r.transactionId===transfer.transactionId)) continue;
            if (transfer.asset!=='TON' || transfer.network!=='testnet'
                || transfer.transactionTime<floorMs || transfer.transactionTime>ceilingMs
                || !tonAddressIdentitiesEqual(transfer.destinationWalletAddress,intents[0].destinationWalletAddress)) continue;
            if (checked++ >= 3) break;
            try {
            const source=await this.chainObserver.findOutgoingTransfer({
                sourceWalletAddress:transfer.senderAddress,destinationIdentity:transfer.destinationWalletAddress,
                amountAtomic:transfer.amountAtomic,minCreatedAtMs:floorMs});
            if (!source?.transactionId || source.ambiguous) { pending.push('SOURCE_UNVERIFIED'); continue; }
            const indexed=await this.chainObserver.verifyIndexedRecipientCredit({
                sourceWalletAddress:transfer.senderAddress,destinationIdentity:transfer.destinationWalletAddress,
                transactionId:source.transactionId,amountAtomic:transfer.amountAtomic,minCreatedAtMs:floorMs});
            if (indexed?.status!=='MASTERCHAIN_INDEXED_RECIPIENT_CREDIT_OBSERVED'
                || indexed.globalId!==-3 || indexed.sourceFinality!=='finalized' || indexed.recipientFinality!=='finalized'
                || indexed.recipientTransactionId!==transfer.providerTransactionIdentity.transactionId
                || indexed.sourceTransactionId!==source.transactionId || indexed.amountAtomic!==transfer.amountAtomic) { pending.push('INDEXED_FINALITY_PENDING'); continue; }
            const verified=await this.independentVerifier.verifyTransfer({
                sourceTransactionId:indexed.sourceTransactionId,recipientTransactionId:indexed.recipientTransactionId,
                messageHash:indexed.messageHash,sourceWalletAddress:transfer.senderAddress,
                destinationAddress:transfer.destinationWalletAddress,amountAtomic:transfer.amountAtomic});
            if (verified?.status!=='INDEPENDENT_INDEXED_CREDIT_OBSERVED' || verified.provider!=='tonapi-testnet'
                || verified.sourceTransactionId!==indexed.sourceTransactionId
                || verified.recipientTransactionId!==indexed.recipientTransactionId
                || verified.messageHash!==indexed.messageHash || verified.amountAtomic!==transfer.amountAtomic
                || !tonAddressIdentitiesEqual(verified.sourceWalletAddress,transfer.senderAddress)
                || !tonAddressIdentitiesEqual(verified.destinationAddress,transfer.destinationWalletAddress)) { pending.push('INDEPENDENT_CREDIT_PENDING'); continue; }
            receiptAccounting.recordVerifiedTransfer(transfer,intents,roomId);
            captured++;
            const exactIntent = intents.find(i => i.amountAtomic === transfer.amountAtomic
                && (i.paymentReference === transfer.paymentReference)
                && tonAddressIdentitiesEqual(i.expectedSender, transfer.senderAddress)
                && transfer.transactionTime >= i.createdAt && transfer.transactionTime < i.expiresAt);
            recordAudit("recordDecision", {
                at:this.nowProvider(), transactionId:transfer.transactionId,
                paymentReference:transfer.paymentReference ?? null,
                decision:exactIntent ? "PENDING_CONFIRMATION" : "LATE_PAYMENT",
                reason:exactIntent ? "HISTORICAL_RECEIPT_STORED_FOR_RECONCILIATION"
                    : "HISTORICAL_CREDIT_DOES_NOT_MATCH_AN_ACTIVE_INTENT",
                amountAtomic:transfer.amountAtomic, senderAddress:transfer.senderAddress,
                destinationWalletAddress:transfer.destinationWalletAddress,
                transactionTime:transfer.transactionTime
            });
            } catch { pending.push('PROVIDER_UNAVAILABLE'); }
        }
        receiptAccounting.prepareClosedRoom(roomId);
        return {roomId,status:'HISTORICAL_RECEIPTS_CHECKED',captured,pending};
    }
    async runPass() {
        if(this.running)return;
        this.running=true;
        try {
            const rooms=this.runtime.refundStore.listClosedRooms();
            if(!rooms.length)return;
            const room=rooms[this.cursor++ % rooms.length];
            return await this.recoverRoom(room.roomId);
        } finally {this.running=false;}
    }
}
