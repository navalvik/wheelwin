/**
 * Strict handoff from historical payout/refund entry points to the durable
 * signed-intent executor. This module NEVER calls legacy sendTransfer.
 *
 * Winners and owner must already have a persisted authoritative
 * ContractSettlementManager payoutPlan. Before ANY transfer the winner and
 * owner intents are durably prepared; winner is chain-confirmed BEFORE an
 * owner transfer can be prepared for broadcast.
 *
 * Pre-Page5 refunds additionally require each player-specific obligationId
 * from the dual-provider, persistent refund ledger. If a historical caller
 * only supplies wallet + amount, this bridge FAILS CLOSED and cannot send.
 *
 * RPC responses and seqno are never accepted as payment confirmation here.
 * A separate read-only, two-indexer confirmation worker advances journal
 * states from CONFIRMATION_UNKNOWN to CHAIN_CONFIRMED.
 */
import { createHash } from "node:crypto";
import { Address } from "@ton/core";

function sameWallet(a, b) {
    try { return Address.parse(a).equals(Address.parse(b)); }
    catch { return false; }
}

export class RoomWalletGuardedPayoutCoordinator {
    constructor({ journal, executor, financialPersistence = null, refundRecoveryRepository = null,
        residualSweepRepository = null } = {}) {
        if (typeof journal?.createSettlementPlan !== "function"
            || typeof journal?.createRefundPlan !== "function"
            || typeof journal?.load !== "function"
            || typeof executor?.execute !== "function") {
            throw new TypeError("Guarded payout coordinator dependencies are required");
        }
        this._journal = journal;
        this._executor = executor;
        this._financialPersistence = financialPersistence;
        this._refundRepository = refundRecoveryRepository;
        this._residualSweepRepository = residualSweepRepository;
    }

    async settleContract(request = {}) {
        const gameId = request?.gameId;
        if (typeof gameId !== "string" || gameId.length === 0) {
            return this._block("GUARDED_SETTLEMENT_GAME_ID_REQUIRED");
        }
        let winner, owner;
        try {
            // Authorization for both roles must succeed BEFORE any send.
            winner = this._journal.createSettlementPlan({ gameId, role: "WINNER" });
            owner = this._journal.createSettlementPlan({ gameId, role: "OWNER" });
        } catch (error) {
            return this._block("GUARDED_SETTLEMENT_FROZEN_PLAN_UNAVAILABLE", error);
        }
        try {
            // Authoritative source journal is checked even if the caller
            // supplies arbitrary request amounts or beneficiary addresses.
            const w = await this._ensureConfirmed(winner.intentId);
            if (!w.confirmed) {
                return Object.freeze({
                    ok: false, retryable: true,
                    code: "GUARDED_WINNER_CONFIRMATION_PENDING",
                    gameId, winnerIntentId: winner.intentId,
                    ownerIntentId: owner.intentId,
                    winner: null, owner: null,
                    broadcastingPermitted: false
                });
            }
            const o = await this._ensureConfirmed(owner.intentId);
            if (!o.confirmed) {
                return Object.freeze({
                    ok: false, retryable: true, partial: true,
                    code: "GUARDED_OWNER_CONFIRMATION_PENDING",
                    gameId, winnerIntentId: winner.intentId,
                    ownerIntentId: owner.intentId,
                    winner: this._confirmed(winner.intentId),
                    owner: null, broadcastingPermitted: false
                });
            }
            // Only fully chain-confirmed intents are treated as settled.
            return Object.freeze({
                ok: true,
                code: "GUARDED_SETTLEMENT_CHAIN_CONFIRMED",
                gameId,
                winnerConfirmed: true, ownerConfirmed: true,
                winner: this._confirmed(winner.intentId),
                owner: this._confirmed(owner.intentId),
                winnerIntentId: winner.intentId,
                ownerIntentId: owner.intentId,
                broadcastingPermitted: false
            });
        } catch (error) {
            return this._block("GUARDED_SETTLEMENT_EXECUTION_PENDING", error, true);
        }
    }

    async refundPayments({
        roomNumber, roomId, gameId, paymentSessionId,
        refunds, refundPlan
    } = {}) {
        const targets = Array.isArray(refunds) ? refunds : [];
        const entries = refundPlan?.entries;
        if (refundPlan?.mode !== "RECIPIENT_PAYS_GAS"
            || !Array.isArray(entries)
            || targets.length === 0
            || targets.length > entries.length
            || !Number.isInteger(Number(roomNumber))
            || typeof roomId !== "string" || !roomId
            || typeof gameId !== "string" || !gameId
            || typeof paymentSessionId !== "string" || !paymentSessionId
            || typeof this._financialPersistence?.loadPaymentSession !== "function"
            || typeof this._refundRepository?.listRefundObligations !== "function") {
            return this._block("GUARDED_REFUND_FROZEN_PLAN_AND_EVIDENCE_REQUIRED");
        }

        let intents;
        try {
            // A historical room number can be reused in later games.
            // Bind the entire refund plan to a specific persisted session,
            // rather than inferring a debt from a recurring player wallet.
            const persistedSession = this._financialPersistence
                .loadPaymentSession(paymentSessionId)?.payload;
            if (persistedSession?.network !== "testnet"
                || persistedSession.roomId !== roomId
                || persistedSession.gameId !== gameId
                || persistedSession.paymentSessionId !== paymentSessionId
                || Number(persistedSession.roomNumber) !== Number(roomNumber)
                || !persistedSession.roomWalletAddress
                || JSON.stringify(persistedSession.recoveryMetadata?.refundPlan)
                    !== JSON.stringify(refundPlan)) {
                throw new Error("GUARDED_REFUND_PERSISTED_PLAN_MISMATCH");
            }

            const receipts = this._refundRepository
                .listRefundObligations({ roomId });
            const frozenGasPlanHash = createHash("sha256")
                .update(JSON.stringify(refundPlan)).digest("hex");

            // Authorization for the entire requested batch must be prepared
            // before the first wallet signature. Each obligation was created
            // from independently confirmed on-chain incoming receipts.
            intents = targets.map(target => {
                const plans = entries.filter(entry =>
                    entry.playerId === target?.playerId
                    && sameWallet(entry.wallet, target?.wallet)
                );
                if (plans.length !== 1) {
                    throw new Error("GUARDED_REFUND_DUPLICATE_OR_MISSING_PLAYER");
                }
                const plan = plans[0];
                if (String(plan.grossRefundNano) !== String(target.amountNano)
                    || !/^[1-9]\d*$/.test(String(plan.recipientTransferAmountNano))
                    || !/^[1-9]\d*$/.test(String(plan.recipientGasChargeNano))) {
                    throw new Error("GUARDED_REFUND_AMOUNT_OR_GAS_MISMATCH");
                }
                const proofs = receipts.filter(item => {
                    const proof = item.payload;
                    return item.status === "ACTIVE"
                        && proof?.kind === "ROOM_WALLET_REFUND_OBLIGATION"
                        && proof.network === "testnet"
                        && proof.executionAllowed === true
                        && proof.state === "REFUND_RECONCILIATION_REQUIRED"
                        && proof.roomId === roomId && proof.gameId === gameId
                        && proof.paymentSessionId === paymentSessionId
                        && Number(proof.roomNumber) === Number(roomNumber)
                        && proof.playerId === target.playerId
                        && sameWallet(proof.recipientWallet, target.wallet)
                        && sameWallet(proof.fromRoomWallet, persistedSession.roomWalletAddress)
                        && String(proof.grossRefundNano) === String(plan.grossRefundNano);
                });
                if (proofs.length !== 1) {
                    throw new Error("GUARDED_REFUND_CHAIN_OBLIGATION_NOT_UNIQUE");
                }
                const obligationId = proofs[0].recordId;
                const intent = this._journal.createRefundPlan({
                    obligationId,
                    netRefundNano: String(plan.recipientTransferAmountNano),
                    recipientGasChargeNano: String(plan.recipientGasChargeNano),
                    frozenGasPlanHash
                });
                const saved = this._journal.load(intent.intentId)?.payload;
                if (saved?.roomNumber !== Number(roomNumber)
                    || saved?.roomId !== roomId
                    || saved?.gameId !== gameId
                    || saved?.paymentSessionId !== paymentSessionId
                    || !sameWallet(saved.roomWallet, persistedSession.roomWalletAddress)
                    || !sameWallet(saved.destinationWallet, target.wallet)) {
                    throw new Error("GUARDED_REFUND_INTENT_IDENTITY_MISMATCH");
                }
                return Object.freeze({
                    intentId: intent.intentId,
                    playerId: target.playerId,
                    wallet: target.wallet
                });
            });
            if (new Set(intents.map(x => x.intentId)).size !== intents.length) {
                throw new Error("GUARDED_REFUND_DUPLICATE_INTENT");
            }
        } catch (error) {
            return this._block("GUARDED_REFUND_PROOF_NOT_AUTHORIZED", error, true);
        }

        const results = [];
        // Never run multiple transfers from the same wallet concurrently.
        for (const item of intents) {
            let outcome;
            try {
                outcome = await this._ensureConfirmed(item.intentId);
            } catch (error) {
                return Object.freeze({
                    ok: false, retryable: true,
                    code: "GUARDED_REFUND_EXECUTION_PENDING",
                    roomNumber, results: Object.freeze(results),
                    detail: error?.code ?? error?.message ?? "unknown"
                });
            }
            const proven = outcome.confirmed
                ? this._confirmed(item.intentId)
                : null;
            results.push(Object.freeze({
                ok: outcome.confirmed,
                playerId: item.playerId,
                wallet: item.wallet,
                intentId: item.intentId,
                confirmed: outcome.confirmed,
                txHash: proven?.txHash ?? null
            }));
            if (!outcome.confirmed) {
                return Object.freeze({
                    ok: false, retryable: true,
                    code: "GUARDED_REFUND_CONFIRMATION_PENDING",
                    roomNumber, results: Object.freeze(results)
                });
            }
        }
        return Object.freeze({
            ok: true, code: "GUARDED_REFUNDS_CHAIN_CONFIRMED",
            roomNumber, results: Object.freeze(results)
        });
    }

    /**
     * SOURCE_PAYS_GAS operational sweep, authorized only by the original
     * durable rwsweep record, a completed settlement and both confirmed
     * beneficiary intents. Never uses the historical direct sendTransfer().
     */
    async sweepResidual({ sweepRecordId } = {}) {
        if (typeof this._journal.createResidualSweepPlan !== "function"
            || typeof this._residualSweepRepository?.findById !== "function") {
            return this._block("GUARDED_SWEEP_AUTHORITY_UNAVAILABLE");
        }
        let plan;
        try {
            plan = this._journal.createResidualSweepPlan({ sweepRecordId });
        } catch (error) {
            return this._block("GUARDED_SWEEP_PROOF_NOT_AUTHORIZED", error);
        }
        try {
            const state = await this._ensureConfirmed(plan.intentId);
            const saved = this._journal.load(plan.intentId);
            if (!state.confirmed) {
                // Once a signed attempt is UNKNOWN, the old residual worker
                // cannot auto-retry it. Only the two-provider outgoing worker
                // may later finalize the persisted intent.
                if (saved.payload.state !== "PLANNED") {
                    const existing = this._residualSweepRepository.findById(sweepRecordId);
                    if (existing?.payload?.status === "PENDING") {
                        this._residualSweepRepository.markAwaitingTransactionHash(
                            sweepRecordId, { seqno: saved.payload.seqno }
                        );
                    }
                }
                return Object.freeze({
                    ok: false, retryable: true,
                    code: "GUARDED_SWEEP_CONFIRMATION_PENDING",
                    sweepRecordId, intentId: plan.intentId,
                    broadcastingPermitted: false
                });
            }
            const proof = this._confirmed(plan.intentId);
            const record = this._residualSweepRepository.findById(sweepRecordId);
            if (record?.payload?.status === "CONFIRMED") {
                return Object.freeze({
                    ok: true, code: "GUARDED_SWEEP_CHAIN_CONFIRMED",
                    sweepRecordId, intentId: plan.intentId,
                    txHash: proof.txHash, repeated: true
                });
            }
            this._residualSweepRepository.markConfirmed(sweepRecordId, {
                txHash: proof.txHash
            });
            return Object.freeze({
                ok: true, code: "GUARDED_SWEEP_CHAIN_CONFIRMED",
                sweepRecordId, intentId: plan.intentId, txHash: proof.txHash
            });
        } catch (error) {
            return this._block("GUARDED_SWEEP_EXECUTION_PENDING", error, true);
        }
    }

    async _ensureConfirmed(intentId) {
        const saved = this._journal.load(intentId);
        if (saved.status === "SETTLED" && saved.payload?.state === "CHAIN_CONFIRMED") {
            return Object.freeze({ confirmed: true });
        }
        if (saved.status !== "ACTIVE") {
            throw new Error("GUARDED_INTENT_STATE_INVALID");
        }
        // A PLANNED entry may be submitted once; SIGNED_HELD and UNKNOWN
        // executor.execute() must NOT rebroadcast. Confirmation is deferred
        // until both independent blockchain sources establish finality.
        await this._executor.execute({ intentId });
        const updated = this._journal.load(intentId);
        return Object.freeze({
            confirmed: updated.status === "SETTLED"
                && updated.payload?.state === "CHAIN_CONFIRMED"
        });
    }

    _confirmed(intentId) {
        const record = this._journal.load(intentId);
        if (record.status !== "SETTLED" || record.payload?.state !== "CHAIN_CONFIRMED"
            || !record.payload?.chainReceipt?.walletTxHash) {
            throw new Error("GUARDED_CHAIN_CONFIRMATION_REQUIRED");
        }
        return Object.freeze({
            ok: true,
            confirmed: true,
            txHash: record.payload.chainReceipt.walletTxHash,
            intentId,
            destination: record.payload.destinationWallet,
            amountNano: record.payload.transferNano
        });
    }

    _block(code, error = null, retryable = false) {
        return Object.freeze({
            ok: false, code, retryable,
            detail: error?.code ?? error?.message ?? null,
            broadcastingPermitted: false
        });
    }
}
