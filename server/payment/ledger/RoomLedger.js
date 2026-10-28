import { PayoutPlan } from './PayoutPlan.js';
/**
 * Phase 4 — Server-authoritative room ledger facade.
 *
 * `RoomLedger` sits on top of the durable `LedgerStore` and the explicit
 * `CurrencyMapping`. It records individually attributable player stakes and
 * sector purchases, confirmed incoming principal, and validated payout plans,
 * and it drives idempotent payout settlement / reconciliation.
 *
 * Authority boundaries enforced here:
 *   - incoming principal is confirmed ONLY by a persisted Phase-1 payment
 *     intent that the authoritative payment-intent store resolves as SETTLED
 *     and that matches the ledger entry EXACTLY (reference, transaction id,
 *     room, player, amount, network, asset); a confirmation label, a client
 *     event or an observation-only provider transaction is NEVER treated as
 *     confirmation;
 *   - the total settled principal used for a payout is DERIVED from the
 *     ledger, never trusted from a caller;
 *   - the winner's gross allocation is the FIXED, approved 95% rule applied to
 *     the total settled principal (floor(principal * 95 / 100)); the owner's
 *     gross allocation is the exact residual, and the Safety Margin is
 *     permanently zero (no reserve is created, reserved or booked);
 *   - a payout obligation cannot be settled without an execution result, and
 *     an actual-fee variance is settled only through an explicit idempotent
 *     reconciliation that never charges one recipient's fee to the other;
 *   - nothing here sends, broadcasts, signs, deploys, or queries a provider.
 */

import { LEDGER_ENTRY_KIND } from "./LedgerConstants.js";

import { RoomPayoutCalculator } from "./RoomPayoutCalculator.js";

import { CurrencyMapping } from "./CurrencyMapping.js";

import { PaymentIntent } from "../PaymentIntent.js";
import { isPaymentIntentStoreContract } from "../PaymentIntentStoreContract.js";
import { PAYMENT_INTENT_STATE } from "../PaymentIntentStatus.js";

import {
    LedgerEntryError,
    LedgerStorageError,
    PayoutSettlementError,
    PayoutValidationError
} from "./LedgerErrors.js";

/**
 * Caller-supplied confirmation label. It is a DECLARATION, never proof: it is
 * never sufficient on its own to authorize principal. Principal is authorized
 * only by a persisted, SETTLED `PaymentIntent` resolved from the authoritative
 * payment-intent store (see `RoomLedger._resolveSettledIntent`).
 */
export const INCOMING_PRINCIPAL_CONFIRMATION_SOURCE = "SETTLED_PAYMENT_INTENT";

/** Recipient roles for payout transfers. */
export const PAYOUT_RECIPIENT_ROLE = Object.freeze({
    WINNER: "WINNER",
    OWNER: "OWNER"
});

/**
 * @param {unknown} value
 * @returns {asserts value is string}
 */
function assertNonEmptyString(value, field) {

    if (typeof value !== "string" || value.trim() === "") {

        throw new LedgerEntryError(`${field} must be a non-empty string`, { field, value });

    }

}

export class RoomLedger {

    /**
     * @param {{ store: LedgerStore, currency: CurrencyMapping,
     *   intentStore: PaymentIntentStoreContract, logger?: object }} dependencies
     */
    constructor({ store, currency, intentStore, logger = null } = {}) {

        if (!store || typeof store.append !== "function"
            || typeof store.initialize !== "function") {

            throw new LedgerStorageError("store must be a durable ledger store");

        }

        if (!(currency instanceof CurrencyMapping)) {

            throw new LedgerStorageError("currency must be a CurrencyMapping instance");

        }

        // Incoming principal may ONLY be authorized by a persisted, SETTLED
        // payment intent resolved from the AUTHORITATIVE payment intent store.
        // Without that explicit dependency there is nothing that can ever prove
        // a settled payment, so the ledger refuses to exist rather than trusting
        // a confirmation label.
        if (!isPaymentIntentStoreContract(intentStore)) {

            throw new LedgerStorageError(
                "intentStore must implement the authoritative payment intent "
                    + "store contract used to confirm incoming principal",
                { intentStore: intentStore === undefined ? null : typeof intentStore }
            );

        }

        this._store = store;

        this._currency = currency;

        this._intentStore = intentStore;

        this._logger = logger;

        this._initialized = false;

    }

    get store() {

        return this._store;

    }

    get currency() {

        return this._currency;

    }

    /** The authoritative store incoming principal is verified against. */
    /** Canonical asset identifier for every amount in this ledger. */
    get asset() {

        return this._currency.asset;

    }

    /** Network identifier for every amount in this ledger. */
    get network() {

        return this._currency.network;

    }

    initialize() {

        this._store.initialize();

        this._initialized = true;
        // Complete idempotent recipient entries if a process stopped after the plan append.
        for (const entry of this._store.list().filter(x => x.kind === LEDGER_ENTRY_KIND.PAYOUT_PLAN)) {
            const plan = PayoutPlan.fromJSON(entry.metadata.plan);
            for (const transfer of plan.transfers) this._appendTransferEntries({roomId:plan.roomId, payoutId:plan.payoutId}, transfer);
        }

        this._logInfo(
            `RoomLedger ready | asset=${this._currency.asset}`
                + ` | network=${this._currency.network}`
                + ` | symbol=${this._currency.symbol}`
        );

    }

    // -------------------------------------------------------------------------
    // Attributable stakes, sector purchases, confirmed principal
    // -------------------------------------------------------------------------

    /**
     * Resolve a player stake to an exact atomic amount. Never invents a value:
     * an unknown label, or a label that contradicts an explicit amount, is
     * rejected.
     *
     * @param {{ stakeLabel?: string, amountAtomic?: number }} request
     * @returns {{ amountAtomic: number, displayUnit: number|null, stakeLabel: string|null }}
     */
    _resolveStake(request) {

        const stakeLabel = request.stakeLabel ?? null;

        if (stakeLabel !== null) {

            const tier = this._currency.resolveStakeTier(stakeLabel);

            if (!tier) {

                throw new LedgerEntryError(
                    "unknown base stake label: refusing to invent an amount",
                    { stakeLabel, knownLabels: ["1 Gram", "10 Gram"] }
                );

            }

            if (request.amountAtomic !== undefined
                && request.amountAtomic !== null
                && request.amountAtomic !== tier.atomicUnits) {

                throw new LedgerEntryError(
                    "stake label and explicit amount are contradictory",
                    { stakeLabel, amountAtomic: request.amountAtomic, expected: tier.atomicUnits }
                );

            }

            return Object.freeze({
                amountAtomic: tier.atomicUnits,
                displayUnit: tier.displayUnits,
                stakeLabel
            });

        }

        const amountAtomic = request.amountAtomic;

        if (typeof amountAtomic !== "number"
            || !Number.isSafeInteger(amountAtomic)
            || amountAtomic <= 0) {

            throw new LedgerEntryError(
                "a stake requires either a known stakeLabel or a positive "
                    + "integer amountAtomic",
                { amountAtomic }
            );

        }

        return Object.freeze({ amountAtomic, displayUnit: null, stakeLabel: null });

    }

    /**
     * Record an individually attributable player stake.
     *
     * @param {{ idempotencyKey: string, roomId: string, playerId: string,
     *   stakeLabel?: string, amountAtomic?: number, paymentReference?: string }} request
     * @returns {{ replay: boolean, entry: object }}
     */
    recordPlayerStake(request) {

        this._assertInitialized();

        assertNonEmptyString(request.idempotencyKey, "idempotencyKey");
        assertNonEmptyString(request.roomId, "roomId");
        assertNonEmptyString(request.playerId, "playerId");

        const stake = this._resolveStake(request);

        const paymentReference = request.paymentReference ?? null;
        if (typeof paymentReference === "string" && paymentReference.trim() !== "") {

            if (typeof this._store.list !== "function") {

                throw new LedgerStorageError(
                    "store must expose persisted ledger entries to protect payment references"
                );

            }

            const existingStakes = this._store.list().filter((entry) =>
                entry.kind === LEDGER_ENTRY_KIND.PLAYER_STAKE
                    && entry.metadata?.paymentReference === paymentReference
            );

            if (existingStakes.length > 1) {

                throw new LedgerEntryError(
                    "payment reference is already associated with multiple player stakes",
                    { paymentReference }
                );

            }

            const existingStake = existingStakes[0];
            if (existingStake) {

                const sameStake = existingStake.roomId === request.roomId
                    && existingStake.playerId === request.playerId
                    && existingStake.amountAtomic === stake.amountAtomic
                    && existingStake.asset === this._currency.asset
                    && existingStake.network === this._currency.network;

                if (!sameStake) {

                    throw new LedgerEntryError(
                        "payment reference is already associated with a conflicting player stake",
                        {
                            paymentReference,
                            existingEntryId: existingStake.entryId,
                            roomId: request.roomId,
                            playerId: request.playerId,
                            amountAtomic: stake.amountAtomic,
                            asset: this._currency.asset,
                            network: this._currency.network
                        }
                    );

                }

                return { replay: true, entry: existingStake };

            }

        }

        return this._store.append({
            idempotencyKey: request.idempotencyKey,
            roomId: request.roomId,
            kind: LEDGER_ENTRY_KIND.PLAYER_STAKE,
            amountAtomic: stake.amountAtomic,
            playerId: request.playerId,
            asset: this._currency.asset,
            network: this._currency.network,
            metadata: Object.freeze({
                stakeLabel: stake.stakeLabel,
                displayUnit: stake.displayUnit,
                paymentReference
            })
        });

    }

    /**
     * Record an individually attributable sector purchase. The sector price is
     * supplied explicitly; it is never invented.
     *
     * @param {{ idempotencyKey: string, roomId: string, playerId: string,
     *   amountAtomic: number, sectorId?: string, paymentReference?: string }} request
     */
    recordSectorPurchase(request) {

        this._assertInitialized();

        assertNonEmptyString(request.idempotencyKey, "idempotencyKey");
        assertNonEmptyString(request.roomId, "roomId");
        assertNonEmptyString(request.playerId, "playerId");

        const amountAtomic = request.amountAtomic;

        if (typeof amountAtomic !== "number"
            || !Number.isSafeInteger(amountAtomic)
            || amountAtomic <= 0) {

            throw new LedgerEntryError(
                "a sector purchase requires a positive integer amountAtomic",
                { amountAtomic }
            );

        }

        return this._store.append({
            idempotencyKey: request.idempotencyKey,
            roomId: request.roomId,
            kind: LEDGER_ENTRY_KIND.SECTOR_PURCHASE,
            amountAtomic,
            playerId: request.playerId,
            asset: this._currency.asset,
            network: this._currency.network,
            metadata: Object.freeze({
                sectorId: request.sectorId ?? null,
                paymentReference: request.paymentReference ?? null
            })
        });

    }

    /**
     * Record confirmed incoming principal.
     *
     * FAIL CLOSED: the caller's confirmation `source` label is a DECLARATION and
     * is never proof. `confirmation.paymentReference` is resolved in the
     * authoritative payment-intent store and the persisted intent MUST be
     * SETTLED and MUST match this entry exactly (reference, transaction id,
     * room, player, amount, network, asset). An absent, unreadable, malformed,
     * mismatching, not-yet-settled or already-booked intent throws BEFORE
     * anything is appended, so a failed verification can never partially alter
     * the ledger.
     *
     * @param {{ idempotencyKey: string, roomId: string, amountAtomic: number,
     *   playerId?: string,
     *   confirmation: { paymentReference: string, transactionId: string,
     *                   source: string } }} request
     */
    recordIncomingPrincipal(request) {

        this._assertInitialized();

        assertNonEmptyString(request.idempotencyKey, "idempotencyKey");
        assertNonEmptyString(request.roomId, "roomId");

        const amountAtomic = request.amountAtomic;

        if (typeof amountAtomic !== "number"
            || !Number.isSafeInteger(amountAtomic)
            || amountAtomic <= 0) {

            throw new LedgerEntryError(
                "incoming principal requires a positive integer amountAtomic",
                { amountAtomic }
            );

        }

        const confirmation = request.confirmation ?? {};

        assertNonEmptyString(confirmation.paymentReference, "confirmation.paymentReference");
        assertNonEmptyString(confirmation.transactionId, "confirmation.transactionId");

        if (confirmation.source !== INCOMING_PRINCIPAL_CONFIRMATION_SOURCE) {

            throw new PayoutValidationError(
                "incoming principal requires confirmation by a settled payment "
                    + "intent; a client event or observation-only transaction is "
                    + "never proof of a confirmed payment",
                { source: confirmation.source ?? null }
            );

        }

        // Authoritative verification (fail closed) BEFORE any append.
        const settledIntent = this._resolveSettledIntent({
            idempotencyKey: request.idempotencyKey,
            confirmation,
            roomId: request.roomId,
            playerId: request.playerId ?? null,
            amountAtomic
        });

        return this._store.append({
            idempotencyKey: request.idempotencyKey,
            roomId: request.roomId,
            kind: LEDGER_ENTRY_KIND.INCOMING_PRINCIPAL,
            amountAtomic,
            playerId: request.playerId ?? null,
            asset: this._currency.asset,
            network: this._currency.network,
            metadata: Object.freeze({
                paymentReference: settledIntent.paymentReference,
                transactionId: settledIntent.transactionId,
                source: confirmation.source,
                intentState: settledIntent.state
            })
        });

    }

    // -------------------------------------------------------------------------
    // Authoritative settled-intent verification
    // -------------------------------------------------------------------------

    /**
     * Resolve `confirmation.paymentReference` in the AUTHORITATIVE payment
     * intent store and verify that the persisted intent is SETTLED and that it
     * matches this ledger record EXACTLY.
     *
     * FAIL CLOSED: a missing, unreadable or malformed store response, a missing
     * intent, an intent that is not SETTLED (PENDING / MATCHED / REFUNDED /
     * EXPIRED / FAILED / CANCELLED), any field mismatch (reference, transaction
     * id, room, player, amount, network, asset), or a payment reference that was
     * already booked as principal is rejected. Nothing is appended and no
     * existing entry is altered on any rejection path.
     *
     * @returns {{ paymentReference: string, transactionId: string, roomId: string,
     *   playerId: string, network: string, asset: string, amountAtomic: number,
     *   state: string }}
     */
    _resolveSettledIntent({ idempotencyKey, confirmation, roomId, playerId, amountAtomic }) {

        const paymentReference = confirmation.paymentReference;

        let intent = null;

        try {

            intent = this._intentStore.get(paymentReference);

        } catch (error) {

            throw new PayoutValidationError(
                "the authoritative payment intent store could not be read; "
                    + "refusing to confirm incoming principal",
                {
                    paymentReference,
                    reason: error?.message ?? String(error)
                }
            );

        }

        if (!(intent instanceof PaymentIntent)) {

            throw new PayoutValidationError(
                "no persisted payment intent exists for this payment reference; "
                    + "a confirmation label alone is never proof of a settled "
                    + "payment",
                { paymentReference }
            );

        }

        if (intent.state !== PAYMENT_INTENT_STATE.SETTLED) {

            throw new PayoutValidationError(
                "incoming principal is confirmed only by a SETTLED payment "
                    + "intent; the persisted intent is not settled",
                { paymentReference, state: intent.state }
            );

        }

        if (intent.paymentReference !== paymentReference) {

            throw new PayoutValidationError(
                "the persisted payment intent reference does not match the "
                    + "confirmed payment reference",
                { paymentReference, persisted: intent.paymentReference }
            );

        }

        if (intent.transactionId !== confirmation.transactionId) {

            throw new PayoutValidationError(
                "the persisted payment intent is credited to a different "
                    + "transaction than the confirmed transaction id",
                {
                    paymentReference,
                    transactionId: confirmation.transactionId,
                    persistedTransactionId: intent.transactionId
                }
            );

        }

        if (intent.roomId !== roomId) {

            throw new PayoutValidationError(
                "the persisted payment intent belongs to a different room",
                { paymentReference, roomId, persistedRoomId: intent.roomId }
            );

        }

        if (intent.amountAtomic !== amountAtomic) {

            throw new PayoutValidationError(
                "the persisted payment intent amount does not match the "
                    + "confirmed principal amount",
                {
                    paymentReference,
                    amountAtomic,
                    persistedAmountAtomic: intent.amountAtomic
                }
            );

        }

        if (playerId !== null && intent.playerId !== playerId) {

            throw new PayoutValidationError(
                "the persisted payment intent belongs to a different player",
                { paymentReference, playerId, persistedPlayerId: intent.playerId }
            );

        }

        // Network and asset identity must match the currency this ledger
        // accounts in: a settled payment on another network or in another asset
        // is never principal of this ledger.
        if (intent.network !== this._currency.network) {

            throw new PayoutValidationError(
                "the persisted payment intent is settled on a different network",
                {
                    paymentReference,
                    network: this._currency.network,
                    persistedNetwork: intent.network
                }
            );

        }

        if (intent.asset !== this._currency.asset) {

            throw new PayoutValidationError(
                "the persisted payment intent is settled in a different asset",
                {
                    paymentReference,
                    asset: this._currency.asset,
                    persistedAsset: intent.asset
                }
            );

        }

        // A settled payment can only ever become ledger principal ONCE, under
        // any idempotency key. Derived from the ledger, never from the caller.
        // Replaying the SAME idempotency key is the ordinary idempotent no-op
        // below and is never a double booking.
        for (const entry of this._store.listForRoom(roomId)) {

            if (entry.kind === LEDGER_ENTRY_KIND.INCOMING_PRINCIPAL
                && entry.metadata.paymentReference === paymentReference
                && entry.idempotencyKey !== idempotencyKey) {

                throw new PayoutValidationError(
                    "this settled payment intent has already been recorded as "
                        + "incoming principal",
                    {
                        paymentReference,
                        bookedByEntryId: entry.entryId,
                        bookedUnderKey: entry.idempotencyKey
                    }
                );

            }

        }

        return Object.freeze({
            paymentReference: intent.paymentReference,
            transactionId: intent.transactionId,
            roomId: intent.roomId,
            playerId: intent.playerId,
            network: intent.network,
            asset: intent.asset,
            amountAtomic: intent.amountAtomic,
            state: intent.state
        });

    }

    // -------------------------------------------------------------------------
    // Payout planning (server-authoritative principal; pure calculator)
    // -------------------------------------------------------------------------

    /**
     * Compute AND record a validated payout plan for a room. Idempotent by
     * `payoutId`.
     *
     * The total settled principal is DERIVED from the ledger (never taken from
     * the caller). The winner's gross allocation is computed from that
     * principal by the FIXED, approved 95% rule and the per-transfer fee
     * quotes are validated by the pure calculator, which fails closed on any
     * invalid fee. The owner's gross allocation is the calculator's exact
     * residual. No percentage, owner-commission, reserve or winner-gross input
     * is required from the caller.
     *
     * @param {{ payoutId: string, roomId: string,
     *   winner: { recipientId: string, address: string },
     *   owner: { recipientId: string, address: string },
     *   allocation?: { allocationSource?: string|null },
     *   networkFees: object,
     *   maxQuoteAgeMs?: number|null,
     *   nowMs: number }} request
     * @returns {{ replay: boolean, payoutId: string, plan: object, principalAtomic: number }}
     */
    planPayout(request) {

        this._assertInitialized();

        assertNonEmptyString(request.payoutId, "payoutId");
        assertNonEmptyString(request.roomId, "roomId");

        const principalAtomic = this.getConfirmedPrincipalAtomic(request.roomId);

        if (principalAtomic <= 0) {

            throw new PayoutValidationError(
                "cannot plan a payout with no confirmed incoming principal",
                { roomId: request.roomId, principalAtomic }
            );

        }

        const planKey = `${request.payoutId}:plan`;

        // Idempotent replay: return the already-planned plan unchanged.
        const existing = this._store.findByIdempotencyKey(planKey);

        if (existing) {

            const plan = existing.metadata?.plan ?? null;
            const restored = PayoutPlan.fromJSON(plan);
            for (const transfer of restored.transfers) this._appendTransferEntries(request, transfer);

            return {
                replay: true,
                payoutId: request.payoutId,
                plan,
                principalAtomic
            };

        }

        const plan = RoomPayoutCalculator.computePlan({
            payoutId: request.payoutId,
            roomId: request.roomId,
            asset: this._currency.asset,
            network: this._currency.network,
            principalAtomic,
            safetyMarginAtomic: request.safetyMarginAtomic ?? 0,
            allocation: request.allocation,
            winner: request.winner,
            owner: request.owner,
            networkFees: request.networkFees,
            maxQuoteAgeMs: request.maxQuoteAgeMs ?? null,
            nowMs: request.nowMs
        });

        // Every entry below is idempotent under `${payoutId}:...`, so a crash
        // between appends can never duplicate or corrupt the recorded plan.
        this._store.append({
            idempotencyKey: planKey,
            roomId: request.roomId,
            kind: LEDGER_ENTRY_KIND.PAYOUT_PLAN,
            amountAtomic: principalAtomic,
            asset: this._currency.asset,
            network: this._currency.network,
            metadata: Object.freeze({
                payoutId: request.payoutId,
                plan: plan.toJSON()
            })
        });

        const winner = plan.transferFor(PAYOUT_RECIPIENT_ROLE.WINNER);

        const owner = plan.transferFor(PAYOUT_RECIPIENT_ROLE.OWNER);

        if (winner) {

            this._appendTransferEntries(request, winner);

        }

        if (owner) {

            this._appendTransferEntries(request, owner);

        }

        this._logInfo(
            `Payout planned | payoutId=${request.payoutId}`
                + ` | principal=${principalAtomic}`
                + ` | winnerGross=${winner ? winner.grossAtomic : 0}`
                + ` | ownerGross=${owner ? owner.grossAtomic : 0}`
                + ` | winnerNet=${winner ? winner.netAtomic : 0}`
                + ` | ownerNet=${owner ? owner.netAtomic : 0}`
                + ` | safetyMargin=${plan.safetyMarginAtomic}`
        );

        return {
            replay: false,
            payoutId: request.payoutId,
            plan: plan.toJSON(),
            principalAtomic
        };

    }

    /**
     * Book the gross allocation, the reserved network fee and the net payout
     * obligation for one recipient. Append-only and idempotent by
     * `${payoutId}:${role}:...`.
     *
     * A zero fee books no reservation entry: there is no fee to reserve, and
     * the ledger's positive-atomic-amount rule is never weakened to
     * accommodate it.
     *
     * @param {{ payoutId: string, roomId: string }} request
     * @param {import("./PayoutPlan.js").PayoutTransfer} transfer
     */
    _appendTransferEntries(request, transfer) {

        const role = transfer.recipientRole;

        this._store.append({
            idempotencyKey: `${request.payoutId}:${role.toLowerCase()}-gross`,
            roomId: request.roomId,
            kind: role === PAYOUT_RECIPIENT_ROLE.WINNER
                ? LEDGER_ENTRY_KIND.WINNER_GROSS_ALLOCATION
                : LEDGER_ENTRY_KIND.OWNER_GROSS_ALLOCATION,
            amountAtomic: transfer.grossAtomic,
            playerId: transfer.recipientId,
            asset: this._currency.asset,
            network: this._currency.network,
            metadata: Object.freeze({
                payoutId: request.payoutId,
                recipientId: transfer.recipientId,
                role
            })
        });

        if (transfer.reservedFeeAtomic > 0) {

            this._store.append({
                idempotencyKey: `${request.payoutId}:${role.toLowerCase()}-fee`,
                roomId: request.roomId,
                kind: LEDGER_ENTRY_KIND.NETWORK_FEE_RESERVATION,
                amountAtomic: transfer.reservedFeeAtomic,
                asset: this._currency.asset,
                network: this._currency.network,
                metadata: Object.freeze({
                    payoutId: request.payoutId,
                    recipientId: transfer.recipientId,
                    role,
                    quotedAtMs: transfer.feeQuote?.quotedAtMs ?? null
                })
            });

        }

        this._store.append({
            idempotencyKey: `${request.payoutId}:${role.toLowerCase()}-net`,
            roomId: request.roomId,
            kind: LEDGER_ENTRY_KIND.NET_PAYOUT,
            amountAtomic: transfer.netAtomic,
            playerId: transfer.recipientId,
            asset: this._currency.asset,
            network: this._currency.network,
            metadata: Object.freeze({
                payoutId: request.payoutId,
                recipientId: transfer.recipientId,
                role,
                grossAtomic: transfer.grossAtomic,
                reservedFeeAtomic: transfer.reservedFeeAtomic
            })
        });

    }

    /**
     * Settle a single payout transfer with an execution result. Idempotent by
     * (`payoutId`, `recipientId`).
     *
     * FAIL CLOSED: without an execution result (`transactionId` +
     * `actualFeeAtomic`) nothing is settled. When the actual network fee
     * differs from the reserved fee this explicit, idempotent call is the
     * reconciliation. Each actual fee is validated independently: it must be a
     * non-negative integer. The variance is recorded for accounting but is
     * never charged to the OTHER recipient, and the Safety Margin is
     * permanently zero — there is no reserve to consume.
     *
     * @param {{ payoutId: string, recipientId: string,
     *   executionResult: { transactionId: string, actualFeeAtomic: number,
     *                      settledAtMs?: number } }} request
     */
    settlePayout(request) {

        this._assertInitialized();

        assertNonEmptyString(request.payoutId, "payoutId");
        assertNonEmptyString(request.recipientId, "recipientId");

        const settleKey = `${request.payoutId}:${request.recipientId}:settle`;

        const alreadySettled = this._store.findByIdempotencyKey(settleKey);

        if (alreadySettled) {

            return {
                replay: true,
                settled: true,
                payoutId: request.payoutId,
                recipientId: request.recipientId,
                varianceAtomic: alreadySettled.metadata?.varianceAtomic ?? 0
            };

        }

        const obligation = this._findNetPayout(request.payoutId, request.recipientId);

        if (!obligation) {

            throw new PayoutSettlementError(
                "no planned payout obligation exists for recipient",
                { payoutId: request.payoutId, recipientId: request.recipientId }
            );

        }

        const executionResult = request.executionResult;

        // CANNOT settle without an execution result.
        if (!executionResult || typeof executionResult !== "object") {

            throw new PayoutSettlementError(
                "cannot settle a payout without an execution result",
                { payoutId: request.payoutId, recipientId: request.recipientId }
            );

        }

        if (typeof executionResult.transactionId !== "string"
            || executionResult.transactionId.trim() === "") {

            throw new PayoutSettlementError(
                "execution result requires a transaction id",
                { transactionId: executionResult.transactionId ?? null }
            );

        }

        const actualFeeAtomic = executionResult.actualFeeAtomic;

        if (typeof actualFeeAtomic !== "number"
            || !Number.isSafeInteger(actualFeeAtomic)
            || actualFeeAtomic < 0) {

            throw new PayoutSettlementError(
                "execution result requires a non-negative integer actualFeeAtomic",
                { actualFeeAtomic }
            );

        }

        const reservedFeeAtomic = obligation.reservedFeeAtomic;

        const varianceAtomic = actualFeeAtomic - reservedFeeAtomic;

        // Record the actual network fee (separate from the reservation). A zero
        // actual fee books no fee entry — there is no fee to record — but it is
        // still carried by the settlement entry below.
        if (actualFeeAtomic > 0) {

            this._store.append({
                idempotencyKey: `${request.payoutId}:${request.recipientId}:actual-fee`,
                roomId: obligation.roomId,
                kind: LEDGER_ENTRY_KIND.NETWORK_FEE_ACTUAL,
                amountAtomic: actualFeeAtomic,
                asset: this._currency.asset,
                network: this._currency.network,
                metadata: Object.freeze({
                    payoutId: request.payoutId,
                    recipientId: request.recipientId,
                    role: obligation.role,
                    transactionId: executionResult.transactionId,
                    reservedFeeAtomic,
                    actualFeeAtomic,
                    varianceAtomic
                })
            });

        }

        // The settlement. Neither recipient's fee is ever charged to the other
        // recipient, and no reserve / safety margin exists to be consumed — the
        // variance is recorded for explicit, idempotent reconciliation only.
        this._store.append({
            idempotencyKey: settleKey,
            roomId: obligation.roomId,
            kind: LEDGER_ENTRY_KIND.PAYOUT_SETTLEMENT,
            amountAtomic: obligation.netAtomic,
            playerId: request.recipientId,
            asset: this._currency.asset,
            network: this._currency.network,
            metadata: Object.freeze({
                payoutId: request.payoutId,
                recipientId: request.recipientId,
                role: obligation.role,
                transactionId: executionResult.transactionId,
                reservedFeeAtomic,
                actualFeeAtomic,
                varianceAtomic,
                settledAtMs: executionResult.settledAtMs ?? null
            })
        });

        this._logInfo(
            `Payout settled | payoutId=${request.payoutId}`
                + ` | recipient=${request.recipientId}`
                + ` | net=${obligation.netAtomic}`
                + ` | actualFee=${actualFeeAtomic}`
                + ` | variance=${varianceAtomic}`
        );

        return {
            replay: false,
            settled: true,
            payoutId: request.payoutId,
            recipientId: request.recipientId,
            varianceAtomic,
            netAtomic: obligation.netAtomic
        };

    }

    // -------------------------------------------------------------------------
    // Obligations + derived views
    // -------------------------------------------------------------------------

    /**
     * Every NET_PAYOUT obligation for a room with its settlement state.
     *
     * @param {string} roomId
     * @returns {Array<{ payoutId: string, recipientId: string, role: string,
     *   grossAtomic: number, reservedFeeAtomic: number, netAtomic: number,
     *   settled: boolean, roomId: string }>}
     */
    listPayoutObligations(roomId) {

        const settlements = new Set();

        for (const entry of this._store.listForRoom(roomId)) {

            if (entry.kind === LEDGER_ENTRY_KIND.PAYOUT_SETTLEMENT) {

                settlements.add(
                    `${entry.metadata.payoutId}:${entry.metadata.recipientId}`);

            }

        }

        const obligations = [];

        for (const entry of this._store.listForRoom(roomId)) {

            if (entry.kind !== LEDGER_ENTRY_KIND.NET_PAYOUT) {

                continue;

            }

            const key = `${entry.metadata.payoutId}:${entry.metadata.recipientId}`;

            obligations.push(Object.freeze({
                payoutId: entry.metadata.payoutId,
                recipientId: entry.metadata.recipientId,
                role: entry.metadata.role,
                grossAtomic: entry.metadata.grossAtomic,
                reservedFeeAtomic: entry.metadata.reservedFeeAtomic,
                netAtomic: entry.amountAtomic,
                settled: settlements.has(key),
                roomId: entry.roomId
            }));

        }

        return obligations;

    }

    /**
     * Number of unsettled payout obligations that block wallet recycling.
     *
     * @param {string} roomId
     * @returns {number}
     */
    countOpenObligations(roomId) {

        return this.listPayoutObligations(roomId)
            .filter((obligation) => !obligation.settled)
            .length;

    }

    /**
     * True only when the room has no unresolved payout obligations and its
     * wallet may be recycled.
     *
     * @param {string} roomId
     * @returns {boolean}
     */
    canRecycleWallet(roomId) {

        return this.countOpenObligations(roomId) === 0;

    }

    /**
     * Confirmed incoming principal for a room (sum of INCOMING_PRINCIPAL).
     * Derived from the ledger — never taken from a caller.
     *
     * @param {string} roomId
     * @returns {number}
     */
    getConfirmedPrincipalAtomic(roomId) {

        return this._sumKind(roomId, LEDGER_ENTRY_KIND.INCOMING_PRINCIPAL);

    }

    getTotalStakesAtomic(roomId) {

        return this._sumKind(roomId, LEDGER_ENTRY_KIND.PLAYER_STAKE);

    }

    /**
     * @param {string} roomId
     * @returns {number}
     */
    getTotalSectorPurchasesAtomic(roomId) {

        return this._sumKind(roomId, LEDGER_ENTRY_KIND.SECTOR_PURCHASE);

    }

    /**
     * @param {string} roomId
     * @param {string} playerId
     * @returns {number}
     */
    getPlayerStakeAtomic(roomId, playerId) {

        let total = 0;

        for (const entry of this._store.listForRoom(roomId)) {

            if (entry.kind === LEDGER_ENTRY_KIND.PLAYER_STAKE
                && entry.playerId === playerId) {

                total += entry.amountAtomic;

            }

        }

        return total;

    }

    /**
     * A safe, aggregated, secret-free snapshot for a room.
     *
     * `totalSettledPrincipalAtomic` is the same authoritative, derived value as
     * `confirmedPrincipalAtomic`; it is the total settled principal the payout
     * reconciliation is exact against. `safetyMarginAtomic` is permanently 0.
     *
     * @param {string} roomId
     */
    getRoomLedgerView(roomId) {

        const obligations = this.listPayoutObligations(roomId);

        return Object.freeze({
            roomId,
            asset: this._currency.asset,
            network: this._currency.network,
            symbol: this._currency.symbol,
            totalSettledPrincipalAtomic: this.getConfirmedPrincipalAtomic(roomId),
            confirmedPrincipalAtomic: this.getConfirmedPrincipalAtomic(roomId),
            totalStakesAtomic: this.getTotalStakesAtomic(roomId),
            totalSectorPurchasesAtomic: this.getTotalSectorPurchasesAtomic(roomId),
            winnerGrossAtomic: this._sumKind(roomId, LEDGER_ENTRY_KIND.WINNER_GROSS_ALLOCATION),
            ownerGrossAtomic: this._sumKind(roomId, LEDGER_ENTRY_KIND.OWNER_GROSS_ALLOCATION),
            networkFeesReservedAtomic: this._sumKind(roomId, LEDGER_ENTRY_KIND.NETWORK_FEE_RESERVATION),
            netPayoutsAtomic: this._sumKind(roomId, LEDGER_ENTRY_KIND.NET_PAYOUT),
            safetyMarginAtomic: this._store.listForRoom(roomId)
                .filter(entry => entry.kind === LEDGER_ENTRY_KIND.PAYOUT_PLAN)
                .reduce((sum, entry) => sum
                    + (entry.metadata?.plan?.safetyMarginAtomic ?? 0), 0),
            openObligations: obligations.filter((o) => !o.settled).length,
            settledObligations: obligations.filter((o) => o.settled).length,
            canRecycleWallet: this.canRecycleWallet(roomId)
        });

    }

    /**
     * The total settled principal for a room: the sum of every INCOMING
     * PRINCIPAL entry confirmed by a settled payment intent. Derived from the
     * ledger — never taken from a caller, never derived from an observation,
     * a client event, or an unconfirmed payment intent.
     *
     * @param {string} roomId
     * @returns {number}
     */
    getTotalSettledPrincipalAtomic(roomId) {

        return this.getConfirmedPrincipalAtomic(roomId);

    }

    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------

    _findNetPayout(payoutId, recipientId) {

        for (const entry of this._store.list()) {

            if (entry.kind === LEDGER_ENTRY_KIND.NET_PAYOUT
                && entry.metadata.payoutId === payoutId
                && entry.metadata.recipientId === recipientId) {

                return {
                    roomId: entry.roomId,
                    role: entry.metadata.role,
                    grossAtomic: entry.metadata.grossAtomic,
                    reservedFeeAtomic: entry.metadata.reservedFeeAtomic,
                    netAtomic: entry.amountAtomic
                };

            }

        }

        return null;

    }

    _sumKind(roomId, kind) {

        let total = 0;

        for (const entry of this._store.listForRoom(roomId)) {

            if (entry.kind === kind) {

                total += entry.amountAtomic;

            }

        }

        return total;

    }

    _assertInitialized() {

        if (!this._initialized) {

            throw new LedgerStorageError("RoomLedger is not initialized");

        }

    }

    _logInfo(message) {

        this._logger?.info?.(message);

    }

}
