import { hasTrustedRoomPaymentSettlementEvidence } from '../toncenter/RoomPaymentObservationService.js';
import { deriveTonAddressIdentity } from './TonAddressIdentity.js';
import { createRefundObligationId, refundIdempotencyKey } from '../refund/RefundObligation.js';

const address = deriveTonAddressIdentity;

/** Capture finalized money before stake matching, then refund uncredited receipts. */
export class IncomingReceiptAccounting {
    constructor({ store, intentStore, refundStore, nowProvider = Date.now }) {
        Object.assign(this, { store, intentStore, refundStore, nowProvider });
    }
    capture(observation) {
        if (observation.resultWindowComplete !== true) return;
        const intents = this.intentStore.listForRoom(observation.roomId);
        if (!intents.length) return;
        for (const transfer of observation.transfers) {
            if (!hasTrustedRoomPaymentSettlementEvidence(observation, transfer, this.nowProvider())) continue;
            if (transfer.network !== 'testnet' || transfer.asset !== 'TON'
                || address(transfer.destinationWalletAddress) !== address(intents[0].destinationWalletAddress)) continue;
            // Store every finalized credit to this room wallet, including late
            // and unmatched transfers. Eligibility is decided after capture;
            // an expired/malformed intent must never erase evidence of money
            // already received on chain.
            this.recordVerifiedTransfer(transfer, intents, observation.roomId);
        }
    }
    recordVerifiedTransfer(transfer, intents, roomId) {
            const owners = intents.filter(i => address(i.expectedSender) === address(transfer.senderAddress));
            this.store.record({
                schemaVersion: 1, network: 'testnet', asset: 'TON', roomId,
                transactionId: transfer.transactionId,
                providerTransactionId: transfer.providerTransactionIdentity.transactionId,
                providerAccountId: transfer.providerTransactionIdentity.accountId,
                transactionTime: transfer.transactionTime, amountAtomic: transfer.amountAtomic,
                senderAddress: address(transfer.senderAddress),
                destinationWalletAddress: address(transfer.destinationWalletAddress),
                playerId: owners.length === 1 ? owners[0].playerId : null,
                paymentIntentId: owners.length === 1 ? owners[0].paymentReference : null,
                paymentReference: transfer.paymentReference
            });
    }
    prepareClosedRoom(roomId) {
        const closed = this.refundStore.listClosedRooms().find(r => r.roomId === roomId);
        if (!closed) return [];
        const intents = this.intentStore.listForRoom(roomId);
        const results = [];
        for (const receipt of this.store.listForRoom(roomId)) {
            const intent = intents.find(i => i.paymentReference === receipt.paymentIntentId);
            // Credited receipts belong to the existing principal/payout/refund path.
            if (intents.some(i => i.transactionId === receipt.transactionId)) continue;
            // Unknown or ambiguous senders remain durably held for reconciliation.
            if (!intent || intent.playerId !== receipt.playerId
                || address(intent.expectedSender) !== receipt.senderAddress
                || address(intent.destinationWalletAddress) !== receipt.destinationWalletAddress) continue;
            const idempotencyKey = refundIdempotencyKey({ networkName: 'TESTNET',
                paymentIntentId: intent.paymentReference, incomingTransactionId: receipt.transactionId });
            results.push(this.refundStore.create({
                schemaVersion: 1, obligationId: createRefundObligationId(idempotencyKey), idempotencyKey,
                networkName: 'TESTNET', globalId: -3, roomNumber: closed.roomNumber, roomId,
                playerId: receipt.playerId, paymentIntentId: intent.paymentReference,
                incomingTransactionId: receipt.transactionId, amountAtomic: receipt.amountAtomic,
                denomination: 'TON', payerAddress: receipt.senderAddress,
                refundDestination: receipt.senderAddress, closureReason: closed.closureReason,
                createdAtMs: this.nowProvider(), state: 'PENDING', attempts: [],
                outgoingTransactionId: null, finalizedEvidence: null, lastError: null
            }));
        }
        return results;
    }
}
