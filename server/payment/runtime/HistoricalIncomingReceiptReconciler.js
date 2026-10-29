import { normalizeIncomingTransferRecord } from '../incoming/index.js';
import { tonAddressIdentitiesEqual } from '../incoming/TonAddressIdentity.js';

/** Read-only historical recovery. Two independent providers, no SSE replay or signing. */
export class HistoricalIncomingReceiptReconciler {
    constructor({runtime, incomingProvider, chainObserver, independentVerifier, nowProvider=Date.now}) {
        Object.assign(this,{runtime,incomingProvider,chainObserver,independentVerifier,nowProvider});
        this.cursor=0; this.running=false;
        // Rotate per-room history candidates so an unresolved leading record
        // cannot starve later credits when checks are bounded to three/pass.
        this.historyCandidateCursors = new Map();
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
        // Build the bounded, local candidate list before choosing where to
        // resume. Unrelated/previously settled transactions never consume an
        // expensive verification slot. Do not broaden the provider request.
        const candidates=[];
        for (const record of observed.records) {
            const transfer=normalizeIncomingTransferRecord(record,{network:'testnet',providerId:'toncenter',now:this.nowProvider()});
            const priorReceipt=receiptStore.get?.(transfer.transactionId);
            if (priorReceipt && priorReceipt.ownershipStatus !== 'UNRESOLVED') continue;
            if (transfer.asset!=='TON' || transfer.network!=='testnet'
                || transfer.transactionTime<floorMs || transfer.transactionTime>ceilingMs
                || !tonAddressIdentitiesEqual(transfer.destinationWalletAddress,intents[0].destinationWalletAddress)) continue;
            candidates.push(transfer);
        }
        const start=candidates.length
            ? (this.historyCandidateCursors.get(roomId) ?? 0) % candidates.length : 0;
        for (let offset=0; offset<candidates.length && checked<3; offset++) {
            const transfer=candidates[(start+offset)%candidates.length];
            checked++;
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

            const ownership=this.runtime.walletPool?.resolveReservationOwnerAt?.({
                walletId:intents[0].destinationWalletId,
                transactionTime:transfer.transactionTime
            }) ?? {status:'UNKNOWN',roomId:null,candidates:[]};
            const allIntents=this.runtime.intentStore.list?.() ?? intents;
            const referenceOwners=transfer.paymentReference
                ? allIntents.filter(intent => intent.destinationWalletId === intents[0].destinationWalletId
                    && intent.paymentReference === transfer.paymentReference
                    && intent.createdAt <= transfer.transactionTime
                    && tonAddressIdentitiesEqual(intent.destinationWalletAddress,transfer.destinationWalletAddress)
                    && tonAddressIdentitiesEqual(intent.expectedSender,transfer.senderAddress))
                : [];
            const referenceRoomIds=[...new Set(referenceOwners.map(intent=>intent.roomId))];
            if (ownership.status === 'OWNED' && ownership.roomId !== roomId
                && !referenceRoomIds.includes(roomId)) {
                recordAudit("recordDecision", {
                    at:this.nowProvider(), transactionId:transfer.transactionId,
                    paymentReference:transfer.paymentReference ?? null,
                    decision:"UNATTRIBUTED_TRANSFER",
                    reason:"WALLET_OWNED_BY_DIFFERENT_ROOM_AT_TRANSACTION_TIME",
                    ownerRoomId:ownership.roomId, amountAtomic:transfer.amountAtomic,
                    senderAddress:transfer.senderAddress,
                    destinationWalletAddress:transfer.destinationWalletAddress,
                    transactionTime:transfer.transactionTime
                });
                continue;
            }
            const exactReferenceRoom=referenceRoomIds.length === 1 ? referenceRoomIds[0] : null;
            const ownerConflict = ownership.status === 'OWNED'
                && exactReferenceRoom && exactReferenceRoom !== ownership.roomId;
            const ambiguousOwnership = ownership.status === 'AMBIGUOUS'
                || (ownership.status === 'OWNED' && ownership.roomId !== roomId)
                || ownerConflict
                || (ownership.status === 'UNKNOWN' && exactReferenceRoom !== roomId);
            if (ambiguousOwnership) {
                receiptAccounting.recordUnresolvedTransfer(transfer, {
                    candidateRoomIds:[roomId, ...(ownership.candidates ?? []), ...referenceRoomIds],
                    reason:ownership.status === 'AMBIGUOUS' || ownerConflict
                        ? 'OVERLAPPING_WALLET_OWNERSHIP_INTERVALS'
                        : 'WALLET_OWNERSHIP_HISTORY_UNAVAILABLE'
                });
                recordAudit("recordDecision", {
                    at:this.nowProvider(), transactionId:transfer.transactionId,
                    paymentReference:transfer.paymentReference ?? null,
                    decision:ownership.status === 'AMBIGUOUS' || ownerConflict ? 'AMBIGUOUS' : 'UNATTRIBUTED_TRANSFER',
                    reason:ownership.status === 'AMBIGUOUS' || ownerConflict
                        ? 'OVERLAPPING_WALLET_OWNERSHIP_INTERVALS'
                        : 'WALLET_OWNERSHIP_HISTORY_UNAVAILABLE',
                    amountAtomic:transfer.amountAtomic, senderAddress:transfer.senderAddress,
                    destinationWalletAddress:transfer.destinationWalletAddress,
                    transactionTime:transfer.transactionTime
                });
                pending.push(ownership.status === 'AMBIGUOUS' || ownerConflict ? 'OWNERSHIP_AMBIGUOUS' : 'OWNERSHIP_UNKNOWN');
                continue;
            }
            if (ownership.status === 'UNKNOWN' && exactReferenceRoom === roomId) {
                // Exact unique payment reference + expected sender + wallet
                // preserves recovery after release, while a current/newer
                // reservation above always takes precedence.
            } else if (ownership.status !== 'OWNED' || ownership.roomId !== roomId) {
                receiptAccounting.recordUnresolvedTransfer(transfer, {
                    candidateRoomIds:[roomId, ...(ownership.candidates ?? []), ...referenceRoomIds],
                    reason:'WALLET_OWNERSHIP_HISTORY_UNAVAILABLE'
                });
                pending.push('OWNERSHIP_UNKNOWN');
                continue;
            }
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
        // Advance even when the provider evidence remains unverified. The
        // next pass covers different candidates instead of repeating the same
        // first three forever. No payment state is advanced by this cursor.
        if (candidates.length) {
            this.historyCandidateCursors.set(roomId,(start+checked)%candidates.length);
        } else {
            this.historyCandidateCursors.delete(roomId);
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
