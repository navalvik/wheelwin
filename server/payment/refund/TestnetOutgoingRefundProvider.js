/**
 * Authorized TON Testnet outgoing-refund provider boundary.
 *
 * This is the ONLY place the outgoing refund path may sign or broadcast, and it
 * holds NO signing material itself. Every capability is injected:
 *
 *   - `signer.signTransfer(descriptor)` — turns an authorized refund into a
 *     signed, ready-to-broadcast message. It never returns or logs secret
 *     material and it is the thin seam an operator can satisfy with a secure,
 *     out-of-process signer (HSM/KMS/remote wallet).
 *   - `broadcaster.broadcast({ sourceWalletAddress, signedTransfer })` — sends
 *     the already-signed message to the network and reports a submission
 *     OUTCOME, never a finality claim.
 *   - `finalityEvidenceProvider.getSettlementEvidence(query)` — read-only
 *     finalized-inclusion evidence (the same policy used for incoming).
 *   - `outgoingTransferProvider` — read-only observation of the outgoing
 *     message's sender/destination/amount for the mirrored finality check.
 *
 * The provider is DISABLED unless a real signer + broadcaster are supplied:
 * `canExecute()` is the single readiness flag the runtime gates on. It refuses
 * to construct for any non-Testnet global ID and never falls back to Mainnet,
 * another network, another wallet, or a different destination.
 *
 * An API acknowledgement is never treated as finality. A broadcast whose
 * outcome is ambiguous is reported as UNKNOWN so the lifecycle never blindly
 * resubmits. Signing credentials never appear in obligation records, attempts,
 * evidence, metadata, or logs.
 */

import { REFUND_NETWORK, RefundObligationError } from "./RefundObligation.js";
import {
    deriveTonAddressIdentity,
    tonAddressIdentityOrNull,
    tonAddressIdentitiesEqual
} from "../incoming/TonAddressIdentity.js";
import {
    OUTGOING_FINALITY_REJECTION,
    verifyOutgoingRefundFinality
} from "./OutgoingRefundFinality.js";

export const TON_TESTNET_GLOBAL_ID = -3;

/** Precise, non-secret outcomes of a single sign+broadcast attempt. */
export const OUTGOING_SUBMISSION_OUTCOME = Object.freeze({
    SUBMITTED: "SUBMITTED",
    UNKNOWN: "UNKNOWN",
    FAILED: "FAILED"
});

export const OUTGOING_SUBMISSION_REASON = Object.freeze({
    SIGNER_UNAVAILABLE: "SIGNER_UNAVAILABLE",
    SIGNING_FAILED: "SIGNING_FAILED",
    BROADCAST_UNAVAILABLE: "BROADCAST_UNAVAILABLE",
    BROADCAST_REJECTED: "BROADCAST_REJECTED",
    BROADCAST_OUTCOME_AMBIGUOUS: "BROADCAST_OUTCOME_AMBIGUOUS",
    BROADCAST_RESULT_INVALID: "BROADCAST_RESULT_INVALID",
    ALREADY_HAS_OUTGOING_TRANSACTION: "ALREADY_HAS_OUTGOING_TRANSACTION"
});

export class OutgoingRefundError extends RefundObligationError {
    constructor(message, details = {}) {
        super(message, details);
        this.name = "OutgoingRefundError";
        this.code = "OUTGOING_REFUND_ERROR";
    }
}

function requireFunction(value, label) {
    if (typeof value !== "function") {
        throw new OutgoingRefundError(`${label} must be a function`);
    }
}

export class TestnetOutgoingRefundProvider {
    /**
     * @param {{
     *   globalId: number,
     *   signer: { signTransfer: Function },
     *   broadcaster: { broadcast: Function },
     *   finalityEvidenceProvider: { getSettlementEvidence: Function },
     *   outgoingTransferProvider: {
     *     getOutgoingTransfer: Function, findOutgoingTransfer: Function
     *   }
     * }} dependencies
     */
    constructor({ globalId, signer, broadcaster, finalityEvidenceProvider, outgoingTransferProvider, walletPool = null } = {}) {
        if (globalId !== TON_TESTNET_GLOBAL_ID) {
            throw new OutgoingRefundError("outgoing refund provider requires verified TON Testnet global ID -3");
        }
        this.networkName = REFUND_NETWORK.TESTNET;
        this.globalId = TON_TESTNET_GLOBAL_ID;
        this._signer = signer ?? null;
        this._broadcaster = broadcaster ?? null;
        this._finality = finalityEvidenceProvider ?? null;
        this._observation = outgoingTransferProvider ?? null;
        this._walletPool = walletPool;
    }

    /**
     * The ONE readiness flag. A provider with no injected signer and
     * broadcaster can only verify its own identity — it can never move funds.
     * @returns {boolean}
     */
    canExecute() {
        return typeof this._signer?.signTransfer === "function"
            && typeof this._broadcaster?.broadcast === "function"
            && typeof this._finality?.getSettlementEvidence === "function"
            && typeof this._observation?.getOutgoingTransfer === "function"
            && typeof this._observation?.findOutgoingTransfer === "function";
    }

    /** Public, non-secret identity check (no network access, no secrets). */
    async verifyNetwork() {
        return Object.freeze({ networkName: this.networkName, globalId: this.globalId });
    }

    /**
     * Verify every authoritative identity of a refund before a submission is
     * attempted. Returns an immutable, secret-free authorized submission
     * descriptor or throws a precise, non-secret error.
     */
    authorizeSubmission({ obligation, sourceWalletAddress }) {
        if (!obligation || obligation.networkName !== this.networkName) {
            throw new OutgoingRefundError("refund obligation does not belong to TON Testnet");
        }
        if (obligation.globalId !== this.globalId) {
            throw new OutgoingRefundError("refund obligation Testnet global ID is not -3");
        }
        if (typeof obligation.idempotencyKey !== "string" || obligation.idempotencyKey.trim() === "") {
            throw new OutgoingRefundError("refund obligation is missing its idempotency key");
        }
        if (!Number.isSafeInteger(obligation.amountAtomic) || obligation.amountAtomic <= 0) {
            throw new OutgoingRefundError("refund obligation amount is not a positive safe integer");
        }
        if (tonAddressIdentityOrNull(obligation.refundDestination) === null) {
            throw new OutgoingRefundError("refund destination is not a valid TON address");
        }
        const sourceIdentity = tonAddressIdentityOrNull(sourceWalletAddress);
        if (sourceIdentity === null) {
            throw new OutgoingRefundError("refund source wallet is not a valid TON address");
        }
        // Refunds must never send back to the same account that sent them.
        if (tonAddressIdentitiesEqual(sourceWalletAddress, obligation.refundDestination)) {
            throw new OutgoingRefundError("refund source wallet and refund destination must be distinct accounts");
        }
        return Object.freeze({
            networkName: this.networkName,
            globalId: this.globalId,
            obligationId: obligation.obligationId,
            idempotencyKey: obligation.idempotencyKey,
            sourceWalletAddress,
            sourceIdentity,
            sourceAccountId: sourceIdentity,
            refundDestination: obligation.refundDestination,
            amountAtomic: obligation.amountAtomic,
            denomination: obligation.denomination
        });
    }

    /**
     * Resolve the authoritative source (room) wallet of an obligation from its
     * durable settled payment intent. Fail closed when it cannot be resolved.
     */
    resolveSourceWallet({ obligation, intentStore }) {
        if (!intentStore || typeof intentStore.require !== "function") {
            throw new OutgoingRefundError("payment intent store is required to resolve the refund source wallet");
        }
        let intent;
        try {
            intent = intentStore.require(obligation.paymentIntentId);
        } catch {
            throw new OutgoingRefundError("settled payment intent is unavailable; cannot resolve the refund source wallet");
        }
        if (!intent || intent.paymentReference !== obligation.paymentIntentId
            || intent.roomId !== obligation.roomId
            || intent.playerId !== obligation.playerId
            || intent.network !== "testnet"
            || intent.asset !== obligation.denomination
            || !tonAddressIdentitiesEqual(intent.expectedSender, obligation.refundDestination)
            || tonAddressIdentityOrNull(intent.destinationWalletAddress) === null) {
            throw new OutgoingRefundError("durable payment intent does not identify a valid source wallet");
        }
        if (this._walletPool) {
            const wallet = this._walletPool.getWallet?.(intent.destinationWalletId);
            if (!wallet
                || wallet.network !== "testnet"
                || wallet.roomNumber !== obligation.roomNumber
                || !tonAddressIdentitiesEqual(wallet.address, intent.destinationWalletAddress)) {
                throw new OutgoingRefundError("refund source wallet does not match authoritative Testnet pool");
            }
        }
        return intent.destinationWalletAddress;
    }

    /**
     * Sign and broadcast ONE authorized refund. Returns a precise outcome and
     * NEVER a finality claim. Callers must still independently observe and
     * verify finality before completing the obligation.
     *
     * @returns {Promise<{ outcome: string, outgoingTransactionId: string|null, reason: string|null }>}
     */
    async signAndBroadcast({ obligation, sourceWalletAddress, nowMs }) {
        const authorized = this.authorizeSubmission({ obligation, sourceWalletAddress });
        if (!this.canExecute()) {
            return Object.freeze({
                outcome: OUTGOING_SUBMISSION_OUTCOME.FAILED,
                outgoingTransactionId: null,
                reason: OUTGOING_SUBMISSION_REASON.SIGNER_UNAVAILABLE
            });
        }
        if (obligation.outgoingTransactionId) {
            return Object.freeze({
                outcome: OUTGOING_SUBMISSION_OUTCOME.FAILED,
                outgoingTransactionId: obligation.outgoingTransactionId,
                reason: OUTGOING_SUBMISSION_REASON.ALREADY_HAS_OUTGOING_TRANSACTION
            });
        }

        let signedTransfer;
        try {
            signedTransfer = await this._signer.signTransfer({
                networkName: authorized.networkName,
                globalId: authorized.globalId,
                from: authorized.sourceWalletAddress,
                to: authorized.refundDestination,
                amountAtomic: authorized.amountAtomic,
                denomination: authorized.denomination,
                idempotencyKey: authorized.idempotencyKey,
                obligationId: authorized.obligationId,
                now: nowMs
            });
        } catch {
            // A signing failure never reaches the network.
            return Object.freeze({
                outcome: OUTGOING_SUBMISSION_OUTCOME.FAILED,
                outgoingTransactionId: null,
                reason: OUTGOING_SUBMISSION_REASON.SIGNING_FAILED
            });
        }

        let result;
        try {
            result = await this._broadcaster.broadcast({
                sourceWalletAddress: authorized.sourceWalletAddress,
                signedTransfer
            });
        } catch {
            // A thrown broadcast may already be on the wire: ambiguous, never
            // a clean failure, so the lifecycle must not blindly resubmit.
            return Object.freeze({
                outcome: OUTGOING_SUBMISSION_OUTCOME.UNKNOWN,
                outgoingTransactionId: null,
                reason: OUTGOING_SUBMISSION_REASON.BROADCAST_OUTCOME_AMBIGUOUS
            });
        }

        const status = result?.status;
        if (status === "SUBMITTED" && typeof result.transactionId === "string"
            && result.transactionId.trim() !== "") {
            return Object.freeze({
                outcome: OUTGOING_SUBMISSION_OUTCOME.SUBMITTED,
                outgoingTransactionId: result.transactionId.trim(),
                reason: null
            });
        }
        if (status === "REJECTED") {
            // Definitively not accepted for broadcast: nothing was sent.
            return Object.freeze({
                outcome: OUTGOING_SUBMISSION_OUTCOME.FAILED,
                outgoingTransactionId: null,
                reason: OUTGOING_SUBMISSION_REASON.BROADCAST_REJECTED
            });
        }
        if (status === "UNKNOWN") {
            return Object.freeze({
                outcome: OUTGOING_SUBMISSION_OUTCOME.UNKNOWN,
                outgoingTransactionId: null,
                reason: result?.reason === undefined
                    ? OUTGOING_SUBMISSION_REASON.BROADCAST_OUTCOME_AMBIGUOUS
                    : (typeof result.reason === "string" && /secret|mnemonic|private.?key|api.?key/i.test(result.reason)
                        ? OUTGOING_SUBMISSION_REASON.BROADCAST_OUTCOME_AMBIGUOUS
                        : result.reason)
            });
        }
        return Object.freeze({
            outcome: OUTGOING_SUBMISSION_OUTCOME.UNKNOWN,
            outgoingTransactionId: null,
            reason: OUTGOING_SUBMISSION_REASON.BROADCAST_RESULT_INVALID
        });
    }

    /**
     * Independently observe and verify finality of a known outgoing transaction
     * against the obligation. Returns the validated evidence or a rejection;
     * never mutates and never fabricates.
     */
    async observeAndVerifyFinality({ obligation, sourceWalletAddress, outgoingTransactionId, nowMs }) {
        const authorized = this.authorizeSubmission({ obligation, sourceWalletAddress });
        let evidence = null;
        let outgoingTransfer = null;
        try {
            evidence = await this._finality.getSettlementEvidence({
                accountId: authorized.sourceAccountId,
                providerTransactionId: outgoingTransactionId
            });
        } catch {
            evidence = null;
        }
        try {
            outgoingTransfer = await this._observation.getOutgoingTransfer({
                sourceWalletAddress: authorized.sourceAccountId,
                transactionId: outgoingTransactionId
            });
        } catch {
            outgoingTransfer = null;
        }
        return verifyOutgoingRefundFinality({
            obligation,
            sourceWalletAddress: authorized.sourceWalletAddress,
            outgoingTransactionId,
            evidence,
            outgoingTransfer,
            nowMs
        });
    }

    /**
     * Resolve an AMBIGUOUS submission: search the source wallet for the single
     * outgoing transfer that matches the refund destination and amount, then
     * verify its finality. This never re-signs or re-broadcasts; it only
     * observes what may already be on chain.
     */
    async reconcileAmbiguousSubmission({ obligation, sourceWalletAddress, nowMs }) {
        if (!this.canExecute()) {
            return Object.freeze({ verified: false, reason: OUTGOING_FINALITY_REJECTION.OUTGOING_TRANSFER_NOT_OBSERVED });
        }
        const authorized = this.authorizeSubmission({ obligation, sourceWalletAddress });
        let match = null;
        try {
            match = await this._observation.findOutgoingTransfer({
                sourceWalletAddress: authorized.sourceAccountId,
                destinationIdentity: deriveTonAddressIdentity(authorized.refundDestination),
                amountAtomic: authorized.amountAtomic
            });
        } catch {
            match = null;
        }
        if (!match || typeof match.transactionId !== "string" || match.transactionId.trim() === "") {
            return Object.freeze({ verified: false, reason: OUTGOING_FINALITY_REJECTION.OUTGOING_TRANSFER_NOT_OBSERVED });
        }
        if (match.ambiguous === true) {
            return Object.freeze({ verified: false, reason: OUTGOING_FINALITY_REJECTION.UNRELATED_TRANSACTION });
        }
        return this.observeAndVerifyFinality({
            obligation,
            sourceWalletAddress,
            outgoingTransactionId: match.transactionId.trim(),
            nowMs
        });
    }
}

export default TestnetOutgoingRefundProvider;
