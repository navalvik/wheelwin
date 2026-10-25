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
    constructor({ journal, executor } = {}) {
        if (typeof journal?.createSettlementPlan !== "function"
            || typeof journal?.createRefundPlan !== "function"
            || typeof journal?.load !== "function"
            || typeof executor?.execute !== "function") {
            throw new TypeError("Guarded payout coordinator dependencies are required");
        }
        this._journal = journal;
        this._executor = executor;
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

    async refundPayments({ roomNumber, refunds, refundPlan } = {}) {
        const targets = Array.isArray(refunds) ? refunds : [];
        const entries = refundPlan?.entries;
        // Historical callers without chain-backed refund IDs must not use
        // this guarded path for payment creation, even when the plan totals
        // look correct. There is no safe wallet+amount-only fallback.
        if (refundPlan?.mode !== "RECIPIENT_PAYS_GAS"
            || !Array.isArray(entries)
            || targets.length === 0
            || targets.length !== entries.length
            || !Number.isInteger(Number(roomNumber))) {
            return this._block("GUARDED_REFUND_FROZEN_PLAN_AND_EVIDENCE_REQUIRED");
        }

        let intents;
        try {
            // One canonical hash for the entire frozen plan. Individual
            // refund caller metadata cannot silently substitute a fee plan.
            const frozenGasPlanHash = createHash("sha256")
                .update(JSON.stringify(refundPlan)).digest("hex");
            intents = targets.map((target) => {
                const candidates = entries.filter(entry =>
                    entry.playerId === target?.playerId
                    && sameWallet(entry.wallet, target?.wallet)
                );
                if (candidates.length !== 1) {
                    throw new Error("GUARDED_REFUND_DUPLICATE_OR_MISSING_PLAYER");
                }
                const plan = candidates[0];
                const obligationId = target?.refundObligationId;
                if (typeof obligationId !== "string"
                    || !/^rwrefund_[0-9a-f]{64}$/.test(obligationId)
                    || !sameWallet(target.wallet, plan.wallet)
                    || target.playerId !== plan.playerId
                    || String(plan.grossRefundNano) !== String(target.amountNano)
                    || !/^[1-9]\d*$/.test(String(plan.recipientTransferAmountNano))
                    || !/^[1-9]\d*$/.test(String(plan.recipientGasChargeNano))
                ) {
                    throw new Error("GUARDED_REFUND_PLAYER_PROOF_MISMATCH");
                }
                const intent = this._journal.createRefundPlan({
                    obligationId,
                    netRefundNano: String(plan.recipientTransferAmountNano),
                    recipientGasChargeNano: String(plan.recipientGasChargeNano),
                    frozenGasPlanHash
                });
                const persisted = this._journal.load(intent.intentId)?.payload;
                if (persisted?.roomNumber !== Number(roomNumber)
                    || !sameWallet(persisted.destinationWallet, target.wallet)) {
                    throw new Error("GUARDED_REFUND_ROOM_IDENTITY_MISMATCH");
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
            return this._block("GUARDED_REFUND_PROOF_NOT_AUTHORIZED", error);
        }

        const results = [];
        // Within a Room Wallet the guarded executor's physical lease and
        // journal hold enforce serial sends. Never dispatch in Promise.all().
        for (const target of intents) {
            let outcome;
            try {
                outcome = await this._ensureConfirmed(target.intentId);
            } catch (error) {
                return Object.freeze({
                    ok: false, retryable: true,
                    code: "GUARDED_REFUND_EXECUTION_PENDING",
                    roomNumber, results: Object.freeze(results),
                    detail: error?.code ?? error?.message ?? "unknown"
                });
            }
            results.push(Object.freeze({
                playerId: target.playerId,
                wallet: target.wallet,
                intentId: target.intentId,
                confirmed: outcome.confirmed
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
