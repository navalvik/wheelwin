import { hasTrustedRoomPaymentSettlementEvidence } from '../toncenter/RoomPaymentObservationService.js';
import { deriveTonAddressIdentity } from './TonAddressIdentity.js';
import { createRefundObligationId, refundIdempotencyKey } from '../refund/RefundObligation.js';
import { requireToncenterChainConfig } from '../toncenter/ToncenterConstants.js';

const address = deriveTonAddressIdentity;

// Legacy Testnet historical recovery used partial intent descriptors without
// network/asset fields. Preserve that working path. Mainnet requires explicit
// network identity and TON asset; never infer it from such a legacy descriptor.
function intentBelongsToNetwork(intent, network) {
    if (network === 'mainnet') return intent.network === 'mainnet' && intent.asset === 'TON';
    return (intent.network == null || intent.network === 'testnet')
        && (intent.asset == null || intent.asset === 'TON');
}

/** Capture finalized money before stake matching, then refund uncredited receipts. */
export class IncomingReceiptAccounting {
    constructor({ store, intentStore, refundStore, nowProvider = Date.now, network = 'testnet' }) {
        const chain = requireToncenterChainConfig(network);
        if (store?.network !== undefined && store.network !== chain.network)
            throw new Error('RECEIPT_ACCOUNTING_NETWORK_MISMATCH');
        Object.assign(this, { store, intentStore, refundStore, nowProvider, network, chain });
    }
    capture(observation) {
        if (observation.resultWindowComplete !== true) return;
        const intents = this.intentStore.listForRoom(observation.roomId);
        if (!intents.length) return;
        if (intents.some(i => !intentBelongsToNetwork(i, this.network)
            || address(i.destinationWalletAddress) !== address(intents[0].destinationWalletAddress)))
            throw new Error('RECEIPT_ACCOUNTING_INTENT_NETWORK_MISMATCH');
        for (const transfer of observation.transfers) {
            if (!hasTrustedRoomPaymentSettlementEvidence(observation, transfer, this.nowProvider())) continue;
            if (transfer.network !== this.network || transfer.asset !== 'TON'
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
                schemaVersion: 1, network: this.network, asset: 'TON', roomId,
                transactionId: transfer.transactionId,
                providerTransactionId: transfer.providerTransactionIdentity.transactionId,
                providerAccountId: transfer.providerTransactionIdentity.accountId,
                transactionTime: transfer.transactionTime, amountAtomic: transfer.amountAtomic,
                senderAddress: address(transfer.senderAddress),
                destinationWalletAddress: address(transfer.destinationWalletAddress),
                playerId: owners.length === 1 ? owners[0].playerId : null,
                paymentIntentId: owners.length === 1 ? owners[0].paymentReference : null,
                paymentReference: transfer.paymentReference,
                ownershipStatus: 'RESOLVED'
            });
    }
    recordUnresolvedTransfer(transfer, { candidateRoomIds = [], reason = 'OWNERSHIP_UNVERIFIED' } = {}) {
        this.store.recordUnresolved({
            schemaVersion: 1, network: this.network, asset: 'TON', roomId: null,
            transactionId: transfer.transactionId,
            providerTransactionId: transfer.providerTransactionIdentity.transactionId,
            providerAccountId: transfer.providerTransactionIdentity.accountId,
            transactionTime: transfer.transactionTime, amountAtomic: transfer.amountAtomic,
            senderAddress: address(transfer.senderAddress),
            destinationWalletAddress: address(transfer.destinationWalletAddress),
            playerId: null, paymentIntentId: null,
            paymentReference: transfer.paymentReference,
            candidateRoomIds: [...new Set(candidateRoomIds.filter(Boolean))],
            unresolvedReason: reason
        });
    }
    prepareClosedRoom(roomId) {
        const closed = this.refundStore.listClosedRooms().find(r => r.roomId === roomId);
        if (!closed) return [];
        if (closed.networkName !== this.network.toUpperCase()
            || closed.globalId !== this.chain.globalId)
            throw new Error('RECEIPT_ACCOUNTING_CLOSED_ROOM_NETWORK_MISMATCH');
        const intents = this.intentStore.listForRoom(roomId);
        if (intents.some(i => !intentBelongsToNetwork(i, this.network)))
            throw new Error('RECEIPT_ACCOUNTING_INTENT_NETWORK_MISMATCH');
        const results = [];
        for (const receipt of this.store.listForRoom(roomId)) {
            if (receipt.network !== this.network) throw new Error('RECEIPT_ACCOUNTING_RECEIPT_NETWORK_MISMATCH');
            const intent = intents.find(i => i.paymentReference === receipt.paymentIntentId);
            // Credited receipts belong to the existing principal/payout/refund path.
            if (intents.some(i => i.transactionId === receipt.transactionId)) continue;
            // Unknown or ambiguous senders remain durably held for reconciliation.
            if (!intent || intent.playerId !== receipt.playerId
                || address(intent.expectedSender) !== receipt.senderAddress
                || address(intent.destinationWalletAddress) !== receipt.destinationWalletAddress) continue;
            const idempotencyKey = refundIdempotencyKey({ networkName: this.network.toUpperCase(),
                paymentIntentId: intent.paymentReference, incomingTransactionId: receipt.transactionId });
            results.push(this.refundStore.create({
                schemaVersion: 1, obligationId: createRefundObligationId(idempotencyKey), idempotencyKey,
                networkName: this.network.toUpperCase(), globalId: this.chain.globalId, roomNumber: closed.roomNumber, roomId,
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
