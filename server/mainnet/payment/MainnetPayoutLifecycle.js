import { MAINNET_GLOBAL_ID } from "../config/MainnetRuntimeConfig.js";
import { mainnetAddressIdentity } from "./MainnetAddress.js";

/** Mainnet-only payout submission and indexed-recipient-credit reconciliation. */
export class MainnetPayoutLifecycle {
    constructor({ financialLedger, adapter, outgoingObserver, independentVerifier, nowProvider = Date.now } = {}) {
        if (financialLedger?.network !== "mainnet" || financialLedger?.globalId !== MAINNET_GLOBAL_ID
            || typeof financialLedger.createPayout !== "function" || typeof adapter?.sendTransfer !== "function"
            || typeof outgoingObserver?.findOutgoingTransfer !== "function"
            || typeof outgoingObserver?.verifyIndexedRecipientCredit !== "function"
            || typeof independentVerifier?.verifyTransfer !== "function"
            || typeof nowProvider !== "function") throw new Error("MAINNET_PAYOUT_LIFECYCLE_CONFIG_INVALID");
        this._ledger = financialLedger;
        this._adapter = adapter;
        this._observer = outgoingObserver;
        this._independentVerifier = independentVerifier;
        this._now = nowProvider;
    }

    createPayout(input) { return this._ledger.createPayout(input); }

    async submitPayout(payoutId) {
        let payout = this._ledger.getPayout(payoutId);
        if (!payout) throw new Error("MAINNET_PAYOUT_NOT_FOUND");
        if (payout.winner.state === "PENDING") {
            const sent = await this._submitLeg(payout, "winner");
            payout = this._ledger.getPayout(payoutId);
            if (sent === "INSUFFICIENT_GAS") return Object.freeze({ payoutId, status: "WINNER_SUBMISSION_FAILED_GAS" });
        }
        if (payout.winner.state !== "CONFIRMED") {
            const confirmed = await this._confirmLeg(payout, "winner");
            payout = this._ledger.getPayout(payoutId);
            if (!confirmed) return Object.freeze({ payoutId, status: "WINNER_CONFIRMATION_PENDING" });
        }
        payout = this._ledger.getPayout(payoutId);
        if (payout.owner.state === "CONFIRMED") return Object.freeze({ payoutId, status: "PAYOUT_COMPLETE" });
        if (payout.owner.state === "UNPAID_INSUFFICIENT_GAS") {
            return Object.freeze({ payoutId, status: "OWNER_COMMISSION_UNPAID_INSUFFICIENT_GAS" });
        }
        if (payout.owner.state === "PENDING") {
            const result = await this._submitLeg(payout, "owner");
            if (result === "INSUFFICIENT_GAS") return Object.freeze({ payoutId,
                status: "OWNER_COMMISSION_UNPAID_INSUFFICIENT_GAS" });
        }
        payout = this._ledger.getPayout(payoutId);
        if (payout.owner.state === "CONFIRMED") return Object.freeze({ payoutId, status: "PAYOUT_COMPLETE" });
        if (await this._confirmLeg(payout, "owner")) return Object.freeze({ payoutId, status: "PAYOUT_COMPLETE" });
        return Object.freeze({ payoutId, status: "OWNER_CONFIRMATION_PENDING" });
    }

    async _submitLeg(payout, role) {
        const leg = payout[role];
        const idempotencyKey = `${payout.payoutId}:${role.toUpperCase()}`;
        this._ledger.updatePayoutLeg(payout.payoutId, role, { state: "SUBMISSION_UNKNOWN", attemptedAtMs: this._now() });
        try {
            const result = await this._adapter.sendTransfer({
                roomNumber: payout.roomNumber, destination: leg.address,
                amountNano: BigInt(leg.amountAtomic), bounce: false,
                idempotencyKey
            });
            if (result?.ok === true && typeof result.txHash === "string" && result.txHash) {
                this._ledger.updatePayoutLeg(payout.payoutId, role, {
                    state: "SUBMITTED", transactionId: result.txHash, submittedAtMs: this._now()
                });
                return "SUBMITTED";
            }
            return "SUBMISSION_UNKNOWN";
        } catch (error) {
            if (role === "owner" && ["INSUFFICIENT_GAS", "INSUFFICIENT_FUNDS", "TON_INSUFFICIENT_BALANCE"].includes(error?.code)) {
                this._ledger.updatePayoutLeg(payout.payoutId, role, {
                    state: "UNPAID_INSUFFICIENT_GAS", lastError: "INSUFFICIENT_GAS", attemptedAtMs: this._now()
                });
                return "INSUFFICIENT_GAS";
            }
            return "SUBMISSION_UNKNOWN";
        }
    }

    async _confirmLeg(payout, role) {
        const leg = payout[role];
        if (["PENDING", "UNPAID_INSUFFICIENT_GAS"].includes(leg.state)) return false;
        const query = { sourceWalletAddress: payout.sourceWalletAddress,
            destinationIdentity: leg.address, amountAtomic: leg.amountAtomic,
            minCreatedAtMs: payout.createdAtMs };
        const outgoing = leg.transactionId
            ? { transactionId: leg.transactionId }
            : await this._observer.findOutgoingTransfer(query);
        if (!outgoing?.transactionId || outgoing.ambiguous) return false;
        const evidence = await this._observer.verifyIndexedRecipientCredit({
            ...query, transactionId: outgoing.transactionId
        });
        if (evidence?.status !== "MASTERCHAIN_INDEXED_RECIPIENT_CREDIT_OBSERVED"
            || evidence.globalId !== MAINNET_GLOBAL_ID || evidence.sourceTransactionId !== outgoing.transactionId
            || evidence.amountAtomic !== leg.amountAtomic
            || mainnetAddressIdentity(evidence.destinationAddress) !== mainnetAddressIdentity(leg.address)) return false;
        const independent = await this._independentVerifier.verifyTransfer({
            sourceTransactionId: evidence.sourceTransactionId,
            recipientTransactionId: evidence.recipientTransactionId,
            messageHash: evidence.messageHash,
            sourceWalletAddress: evidence.sourceWalletAddress,
            destinationAddress: evidence.destinationAddress,
            amountAtomic: evidence.amountAtomic
        });
        if (independent?.status !== "INDEPENDENT_INDEXED_CREDIT_OBSERVED"
            || independent.provider !== "tonapi-mainnet" || independent.network !== "mainnet"
            || independent.globalId !== MAINNET_GLOBAL_ID
            || independent.sourceTransactionId !== evidence.sourceTransactionId
            || independent.recipientTransactionId !== evidence.recipientTransactionId
            || independent.messageHash !== evidence.messageHash
            || independent.amountAtomic !== leg.amountAtomic
            || mainnetAddressIdentity(independent.sourceWalletAddress) !== mainnetAddressIdentity(payout.sourceWalletAddress)
            || mainnetAddressIdentity(independent.destinationAddress) !== mainnetAddressIdentity(leg.address)
            || !Number.isSafeInteger(independent.actualFeeAtomic) || independent.actualFeeAtomic < 0) return false;
        this._ledger.updatePayoutLeg(payout.payoutId, role, {
            state: "CONFIRMED", transactionId: outgoing.transactionId,
            finalizedEvidence: { network: "mainnet", globalId: MAINNET_GLOBAL_ID,
                transactionId: outgoing.transactionId, amountAtomic: leg.amountAtomic,
                destination: leg.address, finalized: true, observedAtMs: this._now(),
                independentProvider: "tonapi-mainnet", actualFeeAtomic: independent.actualFeeAtomic,
                recipientTransactionId: evidence.recipientTransactionId, messageHash: evidence.messageHash }
        });
        return true;
    }

    /** Read-only restart recovery. It never broadcasts. */
    async reconcilePayout(payoutId) {
        let payout = this._ledger.getPayout(payoutId);
        if (!payout) throw new Error("MAINNET_PAYOUT_NOT_FOUND");
        if (payout.winner.state !== "CONFIRMED") await this._confirmLeg(payout, "winner");
        payout = this._ledger.getPayout(payoutId);
        if (payout.winner.state === "CONFIRMED" && payout.owner.state !== "CONFIRMED") {
            await this._confirmLeg(payout, "owner");
        }
        payout = this._ledger.getPayout(payoutId);
        return Object.freeze({ payoutId, status: payout.state,
            winnerState: payout.winner.state, ownerState: payout.owner.state });
    }

    /** Explicit retry after a definitive insufficient-gas outcome. */
    async retryUnpaidOwnerCommission(payoutId) {
        const payout = this._ledger.getPayout(payoutId);
        if (!payout || payout.winner.state !== "CONFIRMED" || payout.owner.state !== "UNPAID_INSUFFICIENT_GAS") {
            throw new Error("MAINNET_OWNER_COMMISSION_NOT_RETRYABLE");
        }
        this._ledger.updatePayoutLeg(payoutId, "owner", { state: "PENDING", lastError: null });
        return this.submitPayout(payoutId);
    }
}
