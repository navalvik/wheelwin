import { MAINNET_GLOBAL_ID } from "../config/MainnetRuntimeConfig.js";
import { mainnetAddressIdentity } from "./MainnetAddress.js";

const gasCharge = (fee) => {
    if (typeof fee !== "bigint" || fee <= 0n) throw new Error("MAINNET_REFUND_FEE_QUOTE_UNAVAILABLE");
    const margin = fee * 2_000n / 10_000n;
    return fee + (margin > 1_000_000n ? margin : 1_000_000n);
};
const safeNumber = (value) => {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error("MAINNET_REFUND_AMOUNT_OVERFLOW");
    return number;
};

/** Mainnet counterpart of the Testnet refund lifecycle; submit/finality are explicit calls. */
export class MainnetRefundLifecycle {
    constructor({ financialLedger, incomingLedger, adapter, outgoingObserver,
        independentVerifier, nowProvider = Date.now } = {}) {
        if (financialLedger?.network !== "mainnet" || financialLedger?.globalId !== MAINNET_GLOBAL_ID
            || incomingLedger?.network !== "mainnet" || incomingLedger?.globalId !== MAINNET_GLOBAL_ID
            || typeof adapter?.sendTransfer !== "function" || typeof adapter?.estimateOutboundTransferFee !== "function"
            || typeof outgoingObserver?.findOutgoingTransfer !== "function"
            || typeof outgoingObserver?.verifyIndexedRecipientCredit !== "function"
            || typeof independentVerifier?.verifyTransfer !== "function"
            || typeof nowProvider !== "function") throw new Error("MAINNET_REFUND_LIFECYCLE_CONFIG_INVALID");
        this._ledger = financialLedger;
        this._incoming = incomingLedger;
        this._adapter = adapter;
        this._observer = outgoingObserver;
        this._independentVerifier = independentVerifier;
        this._now = nowProvider;
        this._hasReachedPage5 = null;
        this._resolveReservedWalletRoomNumber = null;
    }

    /** Connect the server-owned gameplay lifecycle without depending on client state. */
    configurePage5StateResolver(resolver) {
        if (typeof resolver !== "function") throw new TypeError("Page5 state resolver must be a function");
        this._hasReachedPage5 = resolver;
    }

    configureReservedWalletRoomNumberResolver(resolver) {
        if (typeof resolver !== "function") throw new TypeError("Reserved wallet resolver must be a function");
        this._resolveReservedWalletRoomNumber = resolver;
    }

    prepareClosedRoom({ roomId, roomNumber, closureReason, status, prePage5 = true } = {}) {
        if (status !== "DESTROYED") throw new Error("MAINNET_REFUND_REQUIRES_DESTROYED_ROOM");
        if (this._ledger.hasPayoutOutcome?.(roomId) === true) return Object.freeze([]);
        if (this._ledger.hasPage5Started?.(roomId) === true) return Object.freeze([]);
        if (this._hasReachedPage5) {
            const reachedPage5 = this._hasReachedPage5(roomId);
            if (typeof reachedPage5 !== "boolean") throw new Error("MAINNET_PAGE5_STATE_UNAVAILABLE");
            if (reachedPage5) return Object.freeze([]);
        }
        if (prePage5 !== true) return Object.freeze([]);
        const completedGameClosures = new Set([
            "session_ended", "result_session_expired", "result_session_finished"
        ]);
        if (completedGameClosures.has(closureReason)) return Object.freeze([]);
        let refundRoomNumber = roomNumber;
        if (this._resolveReservedWalletRoomNumber) {
            const reservedRoomNumber = this._resolveReservedWalletRoomNumber(roomId);
            const hasConfirmedReceipts = this._incoming.listReceipts(roomId)
                .some(receipt => receipt.status === "CONFIRMED" || receipt.status === "EXTRA_PAYMENT");
            if (reservedRoomNumber !== null && reservedRoomNumber !== undefined) {
                if (!Number.isSafeInteger(reservedRoomNumber) || reservedRoomNumber < 1) {
                    throw new Error("MAINNET_REFUND_RESERVED_WALLET_IDENTITY_INVALID");
                }
                refundRoomNumber = reservedRoomNumber;
            } else if (hasConfirmedReceipts) {
                throw new Error("MAINNET_REFUND_RESERVED_WALLET_UNAVAILABLE");
            }
        }
        return this._ledger.prepareRefunds({ roomId, roomNumber: refundRoomNumber, closureReason,
            incomingLedger: this._incoming, prePage5: true });
    }

    async submitRefund(obligationId) {
        const obligation = this._ledger.getRefund(obligationId);
        if (!obligation) throw new Error("MAINNET_REFUND_NOT_FOUND");
        if (obligation.state !== "PENDING") return Object.freeze({ obligationId, outcome: "RECONCILE_ONLY", state: obligation.state });
        const estimate = await this._adapter.estimateOutboundTransferFee({
            roomNumber: obligation.roomNumber, destination: obligation.refundDestination,
            amountNano: BigInt(obligation.amountAtomic), bounce: false
        });
        if (estimate?.ok !== true || typeof estimate.totalNano !== "bigint") {
            return Object.freeze({ obligationId, outcome: "FEE_QUOTE_UNAVAILABLE" });
        }
        const charge = gasCharge(estimate.totalNano);
        const transferAmountAtomic = safeNumber(BigInt(obligation.amountAtomic) - charge);
        const gasChargeAtomic = safeNumber(charge);
        this._ledger.updateRefund(obligationId, { state: "SUBMISSION_UNKNOWN",
            transferAmountAtomic, gasChargeAtomic, attemptedAtMs: this._now() });
        try {
            const result = await this._adapter.sendTransfer({
                roomNumber: obligation.roomNumber, destination: obligation.refundDestination,
                amountNano: BigInt(transferAmountAtomic), bounce: false, sourceReserveNano: 0n,
                idempotencyKey: obligation.idempotencyKey
            });
            if (result?.ok === true) {
                const state = result.txHash ? "SUBMITTED" : "SUBMISSION_UNKNOWN";
                this._ledger.updateRefund(obligationId, { state, outgoingTransactionId: result.txHash ?? null });
                return Object.freeze({ obligationId, outcome: state, outgoingTransactionId: result.txHash ?? null });
            }
        } catch { /* A broadcast error is ambiguous; persist the hold and reconcile by history. */ }
        return Object.freeze({ obligationId, outcome: "SUBMISSION_UNKNOWN" });
    }

    async reconcileRefund(obligationId) {
        const obligation = this._ledger.getRefund(obligationId);
        if (!obligation || !["SUBMISSION_UNKNOWN", "SUBMITTED"].includes(obligation.state)) {
            return Object.freeze({ obligationId, outcome: "NOT_READY_FOR_RECONCILIATION" });
        }
        const amount = obligation.transferAmountAtomic ?? obligation.amountAtomic;
        try {
            const intents = this._incoming.listRoomIntents(obligation.roomId);
            const intent = intents.find(item => item.paymentReference === obligation.paymentIntentId);
            const receipt = this._incoming.listReceipts(obligation.roomId).find(item =>
                item.transactionId === obligation.incomingTransactionId
                && item.paymentReference === obligation.paymentIntentId
                && item.amountAtomic === String(obligation.amountAtomic)
                && sameAddress(item.sourceAddress, obligation.refundDestination)
                && sameAddress(item.destinationAddress, obligation.sourceWalletAddress));
            const observation = this._incoming.listObservations(obligation.roomId).find(item =>
                item.transactionId === obligation.incomingTransactionId);
            const principalReceipt = receipt?.status === "CONFIRMED"
                && intent?.confirmedTransactionId === obligation.incomingTransactionId;
            const additionalReceipt = receipt?.status === "EXTRA_PAYMENT"
                && receipt.reason === "PAYMENT_ALREADY_SETTLED"
                && intent?.state === "SETTLED"
                && intent.confirmedTransactionId !== obligation.incomingTransactionId;
            const duplicateTransactionBinding = intents.some(item =>
                item.confirmedTransactionId === obligation.incomingTransactionId
                && item.paymentReference !== obligation.paymentIntentId);
            if (obligation.network !== "mainnet" || obligation.globalId !== MAINNET_GLOBAL_ID
                || !intent || !receipt || !observation || duplicateTransactionBinding
                || receipt.network !== "mainnet" || receipt.globalId !== MAINNET_GLOBAL_ID
                || receipt.roomId !== obligation.roomId || receipt.playerId !== obligation.playerId
                || receipt.asset !== "TON"
                || !((receipt.status === "CONFIRMED" && receipt.reason === null)
                    || (receipt.status === "EXTRA_PAYMENT" && receipt.reason === "PAYMENT_ALREADY_SETTLED"))
                || intent.state !== "SETTLED"
                || intent.network !== "mainnet" || intent.globalId !== MAINNET_GLOBAL_ID
                || intent.roomId !== obligation.roomId
                || (!principalReceipt && !additionalReceipt)
                || intent.playerId !== obligation.playerId
                || intent.asset !== "TON"
                || intent.amountAtomic !== String(obligation.amountAtomic)
                || !sameAddress(intent.expectedSender, obligation.refundDestination)
                || !sameAddress(intent.destinationWalletAddress, obligation.sourceWalletAddress)
                || observation.network !== "mainnet" || observation.globalId !== MAINNET_GLOBAL_ID
                || observation.roomId !== obligation.roomId || observation.asset !== "TON"
                || observation.transactionId !== obligation.incomingTransactionId
                || observation.amountAtomic !== String(obligation.amountAtomic)
                || !sameAddress(observation.sourceAddress, obligation.refundDestination)
                || !sameAddress(observation.destinationAddress, obligation.sourceWalletAddress)) {
                return Object.freeze({ obligationId, outcome: "REFUND_SOURCE_UNVERIFIED" });
            }

            const query = { sourceWalletAddress: obligation.sourceWalletAddress,
                destinationIdentity: obligation.refundDestination, amountAtomic: amount,
                minCreatedAtMs: obligation.createdAtMs };
            const outgoing = await this._observer.findOutgoingTransfer(query);
            if (outgoing?.ambiguous === true) {
                return Object.freeze({ obligationId, outcome: "REFUND_AMBIGUOUS_OUTGOING_HOLD" });
            }
            if (!outgoing?.transactionId
                || (obligation.outgoingTransactionId
                    && outgoing.transactionId !== obligation.outgoingTransactionId)
                || outgoing.amountAtomic !== amount
                || !sameAddress(outgoing.sourceAddress, obligation.sourceWalletAddress)
                || !sameAddress(outgoing.destinationAddress, obligation.refundDestination)) {
                return Object.freeze({ obligationId, outcome: "FINALITY_PENDING" });
            }

            const indexed = await this._observer.verifyIndexedRecipientCredit({
                ...query, transactionId: outgoing.transactionId
            });
            if (indexed?.status !== "MASTERCHAIN_INDEXED_RECIPIENT_CREDIT_OBSERVED"
                || indexed.globalId !== MAINNET_GLOBAL_ID
                || indexed.sourceFinality !== "finalized" || indexed.recipientFinality !== "finalized"
                || indexed.sourceTransactionId !== outgoing.transactionId
                || typeof indexed.recipientTransactionId !== "string" || !indexed.recipientTransactionId
                || typeof indexed.messageHash !== "string" || !indexed.messageHash
                || indexed.amountAtomic !== amount
                || !sameAddress(indexed.sourceWalletAddress, obligation.sourceWalletAddress)
                || !sameAddress(indexed.destinationAddress, obligation.refundDestination)
                || !validBlockRef(indexed.sourceBlockRef) || !validBlockRef(indexed.recipientBlockRef)) {
                return Object.freeze({ obligationId, outcome: "FINALITY_PENDING" });
            }

            const verified = await this._independentVerifier.verifyTransfer({
                sourceTransactionId: indexed.sourceTransactionId,
                recipientTransactionId: indexed.recipientTransactionId,
                messageHash: indexed.messageHash,
                sourceWalletAddress: obligation.sourceWalletAddress,
                destinationAddress: obligation.refundDestination,
                amountAtomic: amount
            });
            if (verified?.status !== "INDEPENDENT_INDEXED_CREDIT_OBSERVED"
                || verified.provider !== "tonapi-mainnet" || verified.network !== "mainnet"
                || verified.globalId !== MAINNET_GLOBAL_ID
                || verified.sourceTransactionId !== indexed.sourceTransactionId
                || verified.recipientTransactionId !== indexed.recipientTransactionId
                || verified.messageHash !== indexed.messageHash
                || verified.amountAtomic !== amount
                || !sameAddress(verified.sourceWalletAddress, obligation.sourceWalletAddress)
                || !sameAddress(verified.destinationAddress, obligation.refundDestination)) {
                return Object.freeze({ obligationId, outcome: "FINALITY_PENDING" });
            }

            const finalizedEvidence = { network: "mainnet", globalId: MAINNET_GLOBAL_ID,
                transactionId: outgoing.transactionId, amountAtomic: amount,
                destination: obligation.refundDestination, finalized: true, observedAtMs: this._now(),
                independentProvider: "tonapi-mainnet", recipientTransactionId: indexed.recipientTransactionId,
                messageHash: indexed.messageHash, sourceMcBlockSeqno: indexed.sourceMcBlockSeqno,
                recipientMcBlockSeqno: indexed.recipientMcBlockSeqno,
                sourceBlockRef: { ...indexed.sourceBlockRef }, recipientBlockRef: { ...indexed.recipientBlockRef } };
            this._ledger.updateRefund(obligationId, { state: "COMPLETE",
                outgoingTransactionId: outgoing.transactionId, finalizedEvidence });
            return Object.freeze({ obligationId, outcome: "REFUND_COMPLETE_TWO_SOURCES",
                transactionId: outgoing.transactionId });
        } catch {
            // Provider outages and malformed evidence leave the durable obligation pending.
            return Object.freeze({ obligationId, outcome: "REFUND_RECONCILIATION_RETRY_LATER" });
        }
    }

    recover() {
        for (const closed of this._ledger.listClosedRooms()) {
            this.prepareClosedRoom({
                roomId: closed.roomId,
                roomNumber: closed.roomNumber,
                closureReason: closed.closureReason,
                status: "DESTROYED",
                prePage5: true
            });
        }
        return Object.freeze(this._ledger.listRefunds().filter(x => x.state !== "COMPLETE")
            .map(x => Object.freeze({ obligationId: x.obligationId, state: x.state, outcome: "OBSERVATION_REQUIRED" })));
    }
}

function sameAddress(left, right) {
    try { return mainnetAddressIdentity(left) === mainnetAddressIdentity(right); }
    catch { return false; }
}

function validBlockRef(block) {
    return block?.workchain === 0 && typeof block.shard === "string" && block.shard.length > 0
        && Number.isSafeInteger(block.seqno) && block.seqno > 0;
}
