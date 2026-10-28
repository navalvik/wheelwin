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
        if (!refundStore.getClosedRoom(roomId)) return {roomId,status:'ROOM_NOT_CLOSED'};
        const intents=intentStore.listForRoom(roomId);
        if (!intents.length) return {roomId,status:'NO_INTENTS'};
        const floorMs=Math.min(...intents.map(i=>i.createdAt));
        const ceilingMs=Math.min(this.nowProvider(),Math.max(...intents.map(i=>i.expiresAt))-1);
        const observed=await this.incomingProvider.listIncomingTransactions({
            account:intents[0].destinationWalletAddress,floorMs,ceilingMs,limit:1000});
        if (!observed.resultWindowComplete) return {roomId,status:'HISTORY_INCOMPLETE'};
        let captured=0, checked=0;
        const pending=[];
        for (const record of observed.records) {
            const transfer=normalizeIncomingTransferRecord(record,{network:'testnet',providerId:'toncenter',now:this.nowProvider()});
            if (receiptStore.listForRoom(roomId).some(r=>r.transactionId===transfer.transactionId)) continue;
            const owners=intents.filter(i=>tonAddressIdentitiesEqual(i.expectedSender,transfer.senderAddress));
            if (owners.length!==1 || transfer.asset!=='TON' || transfer.network!=='testnet'
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
