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
    constructor({ financialLedger, incomingLedger, adapter, outgoingObserver, nowProvider = Date.now } = {}) {
        if (financialLedger?.network !== "mainnet" || financialLedger?.globalId !== MAINNET_GLOBAL_ID
            || incomingLedger?.network !== "mainnet" || incomingLedger?.globalId !== MAINNET_GLOBAL_ID
            || typeof adapter?.sendTransfer !== "function" || typeof adapter?.estimateOutboundTransferFee !== "function"
            || typeof outgoingObserver?.findOutgoingTransfer !== "function"
            || typeof outgoingObserver?.verifyIndexedRecipientCredit !== "function"
            || typeof nowProvider !== "function") throw new Error("MAINNET_REFUND_LIFECYCLE_CONFIG_INVALID");
        this._ledger = financialLedger;
        this._incoming = incomingLedger;
        this._adapter = adapter;
        this._observer = outgoingObserver;
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
        const outgoing = await this._observer.findOutgoingTransfer({
            sourceWalletAddress: obligation.sourceWalletAddress,
            destinationIdentity: obligation.refundDestination,
            amountAtomic: amount,
            minCreatedAtMs: obligation.createdAtMs
        });
        if (!outgoing?.transactionId || outgoing.ambiguous) return Object.freeze({ obligationId, outcome: "FINALITY_PENDING" });
        const evidence = await this._observer.verifyIndexedRecipientCredit({
            sourceWalletAddress: obligation.sourceWalletAddress,
            destinationIdentity: obligation.refundDestination,
            transactionId: outgoing.transactionId, amountAtomic: amount,
            minCreatedAtMs: obligation.createdAtMs
        });
        if (evidence?.status !== "MASTERCHAIN_INDEXED_RECIPIENT_CREDIT_OBSERVED"
            || evidence.globalId !== MAINNET_GLOBAL_ID || evidence.amountAtomic !== amount
            || evidence.sourceTransactionId !== outgoing.transactionId
            || mainnetAddressIdentity(evidence.destinationAddress) !== mainnetAddressIdentity(obligation.refundDestination)) {
            return Object.freeze({ obligationId, outcome: "FINALITY_PENDING" });
        }
        const finalizedEvidence = { network: "mainnet", globalId: MAINNET_GLOBAL_ID,
            transactionId: outgoing.transactionId, amountAtomic: amount,
            destination: obligation.refundDestination, finalized: true, observedAtMs: this._now(),
            sourceMcBlockSeqno: evidence.sourceMcBlockSeqno,
            recipientMcBlockSeqno: evidence.recipientMcBlockSeqno };
        this._ledger.updateRefund(obligationId, { state: "COMPLETE",
            outgoingTransactionId: outgoing.transactionId, finalizedEvidence });
        return Object.freeze({ obligationId, outcome: "REFUND_COMPLETE", transactionId: outgoing.transactionId });
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
