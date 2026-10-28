/**
 * Phase 3D — Incoming payment settlement coordinator.
 *
 * This is the ONE explicit boundary between a genuine server-side incoming
 * payment observation and the Phase 1 `SETTLED` payment-intent transition.
 *
 * What it does, for one room, on ONE explicit call:
 *
 *   1. reads the authoritative payment intents of that room from the payment
 *      service (never from a caller-supplied intent object);
 *   2. takes the wallet actually reserved for that room — the only account that
 *      may be observed;
 *   3. triggers exactly ONE on-demand observation check through the existing
 *      `RoomPaymentObservationService`;
 *   4. requires a complete transaction result window
 *      (`resultWindowComplete === true`) and settles nothing from an incomplete
 *      window;
 *   5. rejects ambiguous observations, several transactions claiming the same
 *      payment reference, and one transaction credited to more than one intent;
 *   6. re-validates every observed normalized transfer field-by-field against
 *      the authoritative intent (network, destination wallet identity, sender
 *      identity, asset, exact integer amount, payment reference/comment and the
 *      derived transaction identity);
 *   7. binds the observed transaction id through the existing
 *      `matchTransaction()` transition and settles only through the protected
 *      `settlePayment(ref, observationResult, transactionId)` path;
 *   8. reports everything, mutating nothing before every candidate of the
 *      check has been validated.
 *
 * Trust boundary
 * --------------
 * The coordinator passes the exact observation result returned by its bound
 * observation service and the selected transaction id. The payment service
 * verifies result identity against its own bound service, then independently
 * validates the selected candidate and the authoritative intent:
 *
 *   - a direct `settlePayment(ref)` call fails closed;
 *   - `matchTransaction(ref, arbitraryTxId)` + `settlePayment(ref)` fails closed;
 *   - an object that merely carries the expected field names, or a caller-set
 *     confirmation flag, fails closed;
 *   - a result from another service instance, a copied object, or a Proxy
 *     wrapper cannot settle a payment;
 *   - the transaction id selects a candidate in the immutable batch result and
 *     is never treated as proof by itself.
 *
 * Scope limits (deliberate)
 * ------------------------
 *   - no timer, cron, interval, background polling or automatic retry: this
 *     coordinator does nothing unless a caller explicitly invokes it;
 *   - the observation API stays observation-only and is never asked to mutate an
 *     intent;
 *   - no outgoing transfer, signing, broadcast, payout execution or smart
 *     contract is implemented or reachable from here.
 *
 * What an observation proves
 * --------------------------
 * A Toncenter v3 `/transactions` row alone is never settlement evidence.
 * Settlement additionally requires an exact observation-service result with
 * fresh Testnet identity, inclusion and `finalized` evidence that passes the
 * explicit policy. The mapper's `confirmed` flag is ignored. The current
 * production observation service has no finality provider configured, so its
 * observations remain ineligible for settlement.
 */

import { PaymentValidationError } from "../PaymentErrors.js";

import { PaymentIntent } from "../PaymentIntent.js";

import {
    PAYMENT_INTENT_STATE,
    isTerminalPaymentIntentState
} from "../PaymentIntentStatus.js";

import {
    IncomingTransfer,
    deriveIncomingTransactionId,
    matchIncomingTransferToIntent,
    normalizeNetwork,
    tonAddressIdentitiesEqual
} from "./index.js";

import {
    RoomPaymentObservationService,
    hasTrustedRoomPaymentSettlementEvidence
} from "../toncenter/RoomPaymentObservationService.js";

/** Whole-pass refusals: nothing at all was settled by this call. */
export const INCOMING_SETTLEMENT_REFUSAL = Object.freeze({

    NO_PAYMENT_INTENTS: "NO_PAYMENT_INTENTS",
    NO_ROOM_WALLET_RESERVATION: "NO_ROOM_WALLET_RESERVATION",
    OBSERVATION_WINDOW_INCOMPLETE: "OBSERVATION_WINDOW_INCOMPLETE",
    AMBIGUOUS_OBSERVATION: "AMBIGUOUS_OBSERVATION"

});

/** Per-intent reasons an observed payment was refused. */
export const INCOMING_SETTLEMENT_REFUSAL_REASON = Object.freeze({

    NO_OBSERVED_MATCH: "NO_OBSERVED_MATCH",
    INTENT_NOT_MATCHABLE: "INTENT_NOT_MATCHABLE",
    INTENT_ALREADY_MATCHED: "INTENT_ALREADY_MATCHED",
    INTENT_EXPIRED: "INTENT_EXPIRED",
    OBSERVED_TRANSACTION_MISSING: "OBSERVED_TRANSACTION_MISSING",
    OBSERVATION_ENTRY_MISMATCH: "OBSERVATION_ENTRY_MISMATCH",
    TRANSACTION_IDENTITY_MISMATCH: "TRANSACTION_IDENTITY_MISMATCH",
    TRANSACTION_ALREADY_CREDITED: "TRANSACTION_ALREADY_CREDITED",
    INTENT_UNRELATED_TO_ROOM_WALLET: "INTENT_UNRELATED_TO_ROOM_WALLET",
    OBSERVATION_UNRELATED_TO_ROOM_WALLET: "OBSERVATION_UNRELATED_TO_ROOM_WALLET",
    PAYMENT_REFERENCE_MISMATCH: "PAYMENT_REFERENCE_MISMATCH",
    MATCH_VALIDATION_FAILED: "MATCH_VALIDATION_FAILED",
    TRANSACTION_OUTSIDE_WINDOW: "TRANSACTION_OUTSIDE_WINDOW",
    TRANSACTION_PREDATES_INTENT: "TRANSACTION_PREDATES_INTENT",
    SETTLEMENT_EVIDENCE_UNAVAILABLE: "SETTLEMENT_EVIDENCE_UNAVAILABLE",
    TRANSITION_REJECTED: "TRANSITION_REJECTED"

});

/** Per-intent dispositions of one observation-driven settlement call. */
export const INCOMING_SETTLEMENT_DISPOSITION = Object.freeze({

    SETTLED: "SETTLED",
    ALREADY_SETTLED: "ALREADY_SETTLED",
    UNMATCHED: "UNMATCHED",
    REFUSED: "REFUSED"

});

function assertNonEmptyString(value, field) {

    if (typeof value !== "string" || value.trim() === "") {

        throw new PaymentValidationError(`${field} must be a non-empty string`, {
            field
        });

    }

    return value.trim();

}

function assertWindowBoundary(value, field) {

    if (!Number.isSafeInteger(value) || value <= 0) {

        throw new PaymentValidationError(
            `${field} must be a positive safe integer epoch-milliseconds value`,
            { field, value }
        );

    }

    return value;

}

function errorCodeOf(error, fallback) {

    return typeof error?.code === "string" && error.code !== ""
        ? error.code
        : fallback;

}

function freezeReport(report) {

    report.settled = Object.freeze(report.settled.slice());
    report.alreadySettled = Object.freeze(report.alreadySettled.slice());
    report.unmatched = Object.freeze(report.unmatched.slice());
    report.refused = Object.freeze(report.refused.slice());
    report.details = Object.freeze(report.details.slice());

    return Object.freeze(report);

}

export class IncomingPaymentSettlementCoordinator {

    /**
     * @param {{
     *   paymentService: import("../RoomWalletPaymentService.js").RoomWalletPaymentService,
     *   observationService: RoomPaymentObservationService,
     *   logger?: { info?: Function, warn?: Function, error?: Function },
     *   nowProvider?: () => number
     * }} dependencies
     */
    constructor({ paymentService, observationService, logger = null, nowProvider = Date.now, receiptAccounting = null }) {

        if (!paymentService
            || typeof paymentService.settlePayment !== "function"
            || typeof paymentService.matchTransaction !== "function"
            || typeof paymentService.listPaymentIntentsForRoom !== "function"
            || typeof paymentService.getWalletForRoom !== "function"
            || paymentService.observationService !== observationService) {

            throw new PaymentValidationError(
                "paymentService must be authoritative and bound to this exact "
                    + "RoomPaymentObservationService instance"
            );

        }

        if (!(observationService instanceof RoomPaymentObservationService)) {

            throw new PaymentValidationError(
                "observationService must be the trusted RoomPaymentObservationService"
            );

        }

        if (typeof nowProvider !== "function") {

            throw new PaymentValidationError("nowProvider must be a function");

        }

        this._paymentService = paymentService;
        this._observationService = observationService;
        this._logger = logger;
        this._nowProvider = nowProvider;
        this._receiptAccounting = receiptAccounting;

    }

    /** The authoritative payment service this coordinator settles through. */
    get paymentService() {

        return this._paymentService;

    }

    /** The trusted observation service this coordinator observes through. */
    get observationService() {

        return this._observationService;

    }

    /**
     * Explicitly reports that this coordinator holds no background work: there
     * is no timer, cron, interval, poller or retry queue anywhere in it.
     *
     * @returns {boolean}
     */
    hasBackgroundWork() {

        return false;

    }

    /**
     * Settle every payment intent of one room that a genuine, complete,
     * unambiguous observation of that room's reserved wallet validates.
     *
     * This is the only entry point. Nothing is scheduled and nothing is
     * retried: each call performs at most one observation check.
     *
     * @param {{
     *   roomId: string,
     *   floorMs?: number,
     *   ceilingMs?: number,
     *   limit?: number,
     *   now?: number,
     *   observationSession?: object|null
     * }} options
     * @returns {Promise<Readonly<object>>} report (never carries the observation result)
     */
    async settleRoomPayments({
        roomId,
        floorMs = null,
        ceilingMs = null,
        limit = null,
        now = null,
        observationSession = null
    } = {}) {

        const room = assertNonEmptyString(roomId, "roomId");

        const authoritativeIntents =
            this._paymentService.listPaymentIntentsForRoom(room);

        if (authoritativeIntents.length === 0) {

            return this._report({
                room,
                refusal: INCOMING_SETTLEMENT_REFUSAL.NO_PAYMENT_INTENTS,
                window: null,
                observation: null
            });

        }

        // A restart can reconcile away a room's wallet reservation after all
        // obligations have settled. In that case the durable, validated
        // PaymentIntent bindings are sufficient to report settled state for
        // principal-ledger recovery; they are not a new provider observation.
        const persistedTransactionIds = new Set();
        const allPersistedSettled = authoritativeIntents.every((intent) => {
            if (!(intent instanceof PaymentIntent)
                || intent.roomId !== room
                || intent.state !== PAYMENT_INTENT_STATE.SETTLED
                || typeof intent.transactionId !== "string"
                || intent.transactionId.trim() === ""
                || persistedTransactionIds.has(intent.transactionId)) {
                return false;
            }
            persistedTransactionIds.add(intent.transactionId);
            return true;
        });

        if (allPersistedSettled) {
            return this._report({
                room,
                mode: "PERSISTED_SETTLEMENT_RECOVERY",
                refusal: null,
                window: null,
                observation: null,
                alreadySettled: authoritativeIntents.map((intent) => ({
                    paymentReference: intent.paymentReference,
                    roomId: intent.roomId,
                    playerId: intent.playerId,
                    transactionId: intent.transactionId,
                    amountAtomic: intent.amountAtomic,
                    asset: intent.asset,
                    network: intent.network
                }))
            });
        }

        const reservation = this._paymentService.getWalletForRoom(room);

        if (!reservation) {

            return this._report({
                room,
                refusal: INCOMING_SETTLEMENT_REFUSAL.NO_ROOM_WALLET_RESERVATION,
                window: null,
                observation: null
            });

        }

        const observation = await this._observeRoom({
            room,
            reservation,
            intents: authoritativeIntents,
            floorMs,
            ceilingMs,
            limit,
            now,
            observationSession
        });

        // `_report` already returns an immutable report without the observation.
        return observation;

    }

    /**
     * Observe, validate and settle one room. Split out of `settleRoomPayments`
     * so the reporting call above stays the single public entry point.
     *
     * @returns {Promise<Readonly<object>>}
     */
    async _observeRoom({
        room,
        reservation,
        intents,
        floorMs,
        ceilingMs,
        limit,
        now,
        observationSession
    }) {

        const earliestIntentAt = intents.reduce(
            (earliest, intent) => Math.min(earliest, intent.createdAt),
            Number.POSITIVE_INFINITY
        );

        const observationFloor = floorMs === null
            ? earliestIntentAt
            : assertWindowBoundary(floorMs, "floorMs");

        const observationCeiling = ceilingMs === null
            ? (now === null ? this._nowProvider() : now)
            : assertWindowBoundary(ceilingMs, "ceilingMs");

        assertWindowBoundary(observationFloor, "floorMs");
        assertWindowBoundary(observationCeiling, "ceilingMs");

        if (observationFloor > observationCeiling) {

            throw new PaymentValidationError(
                "observation window must be ordered: floorMs <= ceilingMs",
                { floorMs: observationFloor, ceilingMs: observationCeiling }
            );

        }

        // A window that starts after a payment intent was created could miss
        // that payment. Refuse rather than observe a partial history.
        if (observationFloor > earliestIntentAt) {

            throw new PaymentValidationError(
                "observation window must start at or before every payment "
                    + "intent of the room, otherwise a payment could be missed",
                { floorMs: observationFloor, earliestIntentAt }
            );

        }

        const observation = await this._observationService.checkRoomPayments({

            roomId: room,
            walletAddress: reservation.address,
            paymentIntents: intents,
            floorMs: observationFloor,
            ceilingMs: observationCeiling,
            destinationWalletId: reservation.walletId,
            observationSession,
            ...(limit === null ? {} : { limit })

        });

        const window = Object.freeze({
            floorMs: observationFloor,
            ceilingMs: observationCeiling,
            limit: observation.window.limit,
            providerRequests: observation.providerRequests,
            rowsReturned: observation.window.rowsReturned,
            transfersObserved: observation.transfers.length
        });

        // (4) An incomplete window settles nothing from that window at all.
        if (observation.resultWindowComplete !== true) {

            return this._report({
                room,
                refusal: INCOMING_SETTLEMENT_REFUSAL.OBSERVATION_WINDOW_INCOMPLETE,
                window,
                observation,
                walletId: reservation.walletId,
                walletAddress: reservation.address
            });

        }

        // Persist finalized received funds even when they cannot qualify as stakes.
        // A persistence failure stops settlement; never acknowledge unrecorded money.
        this._receiptAccounting?.capture(observation);
        const entriesByReference = new Map();

        for (const entry of observation.observations) {

            const existing = entriesByReference.get(entry.paymentReference);

            entriesByReference.set(
                entry.paymentReference,
                existing === undefined ? [entry] : [...existing, entry]
            );

        }

        // (5) Ambiguity and collisions settle nothing from this check.
        const ambiguity = this._detectAmbiguity(observation);

        if (ambiguity !== null) {

            return this._report({
                room,
                refusal: INCOMING_SETTLEMENT_REFUSAL.AMBIGUOUS_OBSERVATION,
                window,
                observation,
                ambiguity,
                walletId: reservation.walletId,
                walletAddress: reservation.address
            });

        }

        const settled = [];
        const alreadySettled = [];
        const unmatched = [];
        const refused = [];

        const creditedTransactions = new Map(
            this._paymentService.listCreditedTransactions()
        );

        for (const intent of intents) {

            // Re-read every intent from the authoritative store: a caller can
            // never supply the object that gets settled.
            const authoritative = this._paymentService.getPaymentIntent(
                intent.paymentReference
            );

            const entries = entriesByReference.get(
                intent.paymentReference
            ) ?? [];

            if (entries.length === 0) {

                if (authoritative.state === PAYMENT_INTENT_STATE.SETTLED) {

                    alreadySettled.push({
                        paymentReference: authoritative.paymentReference,
                        playerId: authoritative.playerId,
                        transactionId: authoritative.transactionId
                    });

                    continue;

                }

                unmatched.push({
                    paymentReference: authoritative.paymentReference,
                    reason: INCOMING_SETTLEMENT_REFUSAL_REASON.NO_OBSERVED_MATCH
                });

                continue;

            }

            if (authoritative.state === PAYMENT_INTENT_STATE.SETTLED) {

                alreadySettled.push({
                    paymentReference: authoritative.paymentReference,
                    playerId: authoritative.playerId,
                    transactionId: authoritative.transactionId
                });

                continue;

            }

            const entry = entries[0];

            const transfer = observation.transfers.find(
                (candidate) => candidate.transactionId === entry.transactionId
            ) ?? null;

            // Independent final authorization check precedes candidate
            // matching and every state transition. It is bound to the exact
            // observation result and ignores transfer.confirmed entirely.
            if (!hasTrustedRoomPaymentSettlementEvidence(
                observation,
                transfer,
                this._nowProvider()
            )) {
                refused.push({
                    paymentReference: authoritative.paymentReference,
                    reason: INCOMING_SETTLEMENT_REFUSAL_REASON
                        .SETTLEMENT_EVIDENCE_UNAVAILABLE,
                    details: { policy: "ton-testnet-masterchain-finalized-v1" }
                });
                continue;
            }

            const validation = this._validateCandidate({
                intent: authoritative,
                entry,
                transfer,
                window,
                reservation,
                room
            });

            if (validation.ok === false) {

                refused.push({
                    paymentReference: authoritative.paymentReference,
                    reason: validation.reason,
                    details: validation.details
                });

                continue;

            }

            const alreadyCreditedTo = creditedTransactions.get(
                transfer.transactionId
            );

            if (alreadyCreditedTo !== undefined
                && alreadyCreditedTo !== authoritative.paymentReference) {

                refused.push({
                    paymentReference: authoritative.paymentReference,
                    reason: INCOMING_SETTLEMENT_REFUSAL_REASON
                        .TRANSACTION_ALREADY_CREDITED,
                    details: { creditedTo: alreadyCreditedTo }
                });

                continue;

            }

            const transition = this.#settleValidatedCandidate({
                intent: authoritative,
                transfer,
                observation
            });

            if (transition.ok === false) {
                refused.push({
                    paymentReference: authoritative.paymentReference,
                    reason: transition.reason,
                    details: transition.details
                });

                continue;
            }


            settled.push({
                paymentReference: authoritative.paymentReference,
                playerId: authoritative.playerId,
                transactionId: transfer.transactionId,
                amountAtomic: transfer.amountAtomic,
                asset: transfer.asset,
                network: transfer.network
            });

        }

        return this._report({
            room,
            window,
            observation,
            settled,
            alreadySettled,
            unmatched,
            refused,
            walletId: reservation.walletId,
            walletAddress: reservation.address
        });

    }

    /**
     * Reject an observation that is not attributable with certainty.
     *
     * @param {Readonly<object>} observation
     * @returns {Readonly<{ reason: string, transactions: string[], references: string[] }>|null}
     */
    _detectAmbiguity(observation) {

        const ambiguous = observation.observations.filter(
            (entry) => entry.status === "ambiguous"
        );

        if (ambiguous.length > 0) {

            return Object.freeze({
                reason: INCOMING_SETTLEMENT_REFUSAL.AMBIGUOUS_OBSERVATION,
                transactions: ambiguous.map((entry) => entry.transactionId),
                references: ambiguous.map(
                    (entry) => entry.candidatePaymentReferences
                )
            });

        }

        const transactionsByReference = new Map();
        const referencesByTransaction = new Map();

        for (const entry of observation.observations) {

            if (entry.status !== "matched" || entry.paymentReference === null) {

                continue;

            }

            const transactions = transactionsByReference.get(
                entry.paymentReference
            ) ?? new Set();

            transactions.add(entry.transactionId);

            transactionsByReference.set(entry.paymentReference, transactions);

            const references = referencesByTransaction.get(entry.transactionId)
                ?? new Set();

            references.add(entry.paymentReference);

            referencesByTransaction.set(entry.transactionId, references);

        }

        for (const [paymentReference, transactions] of transactionsByReference) {

            if (transactions.size > 1) {

                return Object.freeze({
                    reason: INCOMING_SETTLEMENT_REFUSAL.AMBIGUOUS_OBSERVATION,
                    transactions: [...transactions],
                    references: [paymentReference]
                });

            }

        }

        for (const [transactionId, references] of referencesByTransaction) {

            if (references.size > 1) {

                return Object.freeze({
                    reason: INCOMING_SETTLEMENT_REFUSAL.AMBIGUOUS_OBSERVATION,
                    transactions: [transactionId],
                    references: [...references]
                });

            }

        }

        return null;

    }

    /**
     * Validate one observed transfer against one authoritative payment intent.
     * Nothing here mutates anything.
     *
     * @returns {{ ok: true }|{ ok: false, reason: string, details: object }}
     */
    _validateCandidate({ intent, entry, transfer, window, reservation, room }) {

        if (!(intent instanceof PaymentIntent)) {

            return {
                ok: false,
                reason: INCOMING_SETTLEMENT_REFUSAL_REASON.INTENT_NOT_MATCHABLE,
                details: { reason: "authoritative payment intent is unavailable" }
            };

        }

        if (intent.roomId !== room) {

            return {
                ok: false,
                reason: INCOMING_SETTLEMENT_REFUSAL_REASON
                    .INTENT_UNRELATED_TO_ROOM_WALLET,
                details: { roomId: intent.roomId, requestedRoomId: room }
            };

        }

        if (!(transfer instanceof IncomingTransfer)) {

            return {
                ok: false,
                reason: INCOMING_SETTLEMENT_REFUSAL_REASON
                    .OBSERVED_TRANSACTION_MISSING,
                details: { transactionId: entry.transactionId }
            };

        }

        if (transfer.transactionId !== entry.transactionId
            || entry.paymentReference !== intent.paymentReference) {

            return {
                ok: false,
                reason: INCOMING_SETTLEMENT_REFUSAL_REASON
                    .OBSERVATION_ENTRY_MISMATCH,
                details: {
                    observedTransactionId: entry.transactionId,
                    normalizedTransactionId: transfer.transactionId,
                    observedPaymentReference: entry.paymentReference,
                    intentPaymentReference: intent.paymentReference
                }
            };

        }

        // Re-derive the deterministic transaction identity from the provider
        // identity the observation carries: the id that will be credited must
        // be the id that follows from the provider transaction itself.
        const derivedTransactionId = deriveIncomingTransactionId({

            network: transfer.network,
            providerId: transfer.providerTransactionIdentity.providerId,
            accountId: transfer.providerTransactionIdentity.accountId,
            transactionId: transfer.providerTransactionIdentity.transactionId

        });

        if (derivedTransactionId !== transfer.transactionId) {

            return {
                ok: false,
                reason: INCOMING_SETTLEMENT_REFUSAL_REASON
                    .TRANSACTION_IDENTITY_MISMATCH,
                details: { transactionId: transfer.transactionId }
            };

        }

        // The observation must be an incoming transfer to the account that is
        // actually reserved for this room, and the authoritative intent must
        // name exactly that wallet.
        if (intent.destinationWalletId !== reservation.walletId
            || !tonAddressIdentitiesEqual(
                intent.destinationWalletAddress,
                reservation.address
            )) {

            return {
                ok: false,
                reason: INCOMING_SETTLEMENT_REFUSAL_REASON
                    .INTENT_UNRELATED_TO_ROOM_WALLET,
                details: {
                    walletId: reservation.walletId,
                    intentWalletId: intent.destinationWalletId
                }
            };

        }

        if (!tonAddressIdentitiesEqual(
            transfer.destinationWalletAddress,
            reservation.address
        ) || (transfer.destinationWalletId !== null
            && transfer.destinationWalletId !== reservation.walletId)) {

            return {
                ok: false,
                reason: INCOMING_SETTLEMENT_REFUSAL_REASON
                    .OBSERVATION_UNRELATED_TO_ROOM_WALLET,
                details: {
                    observedDestinationWalletAddress:
                        transfer.destinationWalletAddress,
                    walletId: reservation.walletId
                }
            };

        }

        if (isTerminalPaymentIntentState(intent.state)) {

            return {
                ok: false,
                reason: INCOMING_SETTLEMENT_REFUSAL_REASON.INTENT_NOT_MATCHABLE,
                details: { state: intent.state }
            };

        }

        if (intent.state === PAYMENT_INTENT_STATE.MATCHED
            && intent.transactionId !== null
            && intent.transactionId !== transfer.transactionId) {

            return {
                ok: false,
                reason: INCOMING_SETTLEMENT_REFUSAL_REASON
                    .INTENT_ALREADY_MATCHED,
                details: { transactionId: intent.transactionId }
            };

        }

        if (intent.isExpired(window.ceilingMs)
            && transfer.transactionTime >= intent.expiresAt) {

            return {
                ok: false,
                reason: INCOMING_SETTLEMENT_REFUSAL_REASON.INTENT_EXPIRED,
                details: {
                    expiresAt: intent.expiresAt,
                    ceilingMs: window.ceilingMs
                }
            };

        }

        // A transfer that predates the payment intent cannot be that payment.
        if (transfer.transactionTime < intent.createdAt) {

            return {
                ok: false,
                reason: INCOMING_SETTLEMENT_REFUSAL_REASON
                    .TRANSACTION_PREDATES_INTENT,
                details: {
                    transactionTime: transfer.transactionTime,
                    createdAt: intent.createdAt
                }
            };

        }

        if (transfer.transactionTime < window.floorMs
            || transfer.transactionTime > window.ceilingMs) {

            return {
                ok: false,
                reason: INCOMING_SETTLEMENT_REFUSAL_REASON
                    .TRANSACTION_OUTSIDE_WINDOW,
                details: {
                    transactionTime: transfer.transactionTime,
                    floorMs: window.floorMs,
                    ceilingMs: window.ceilingMs
                }
            };

        }

        const normalizedIntentNetwork = normalizeNetwork(intent.network);

        if (transfer.network !== normalizedIntentNetwork
            || transfer.asset !== intent.asset
            || transfer.amountAtomic !== intent.amountAtomic
            || !Number.isSafeInteger(transfer.amountAtomic)
            || transfer.paymentReference !== intent.paymentReference
            || !tonAddressIdentitiesEqual(
                transfer.senderAddress,
                intent.expectedSender
            )
            || !tonAddressIdentitiesEqual(
                transfer.destinationWalletAddress,
                intent.destinationWalletAddress
            )) {

            return {
                ok: false,
                reason: INCOMING_SETTLEMENT_REFUSAL_REASON
                    .MATCH_VALIDATION_FAILED,
                details: {
                    mismatches: Object.freeze({
                        network: transfer.network !== normalizedIntentNetwork,
                        asset: transfer.asset !== intent.asset,
                        amount: transfer.amountAtomic !== intent.amountAtomic,
                        sender: !tonAddressIdentitiesEqual(
                            transfer.senderAddress,
                            intent.expectedSender
                        ),
                        destination: !tonAddressIdentitiesEqual(
                            transfer.destinationWalletAddress,
                            intent.destinationWalletAddress
                        ),
                        paymentReference:
                            transfer.paymentReference !== intent.paymentReference
                    })
                }
            };

        }

        // Authoritative re-validation through the shared matcher: the same
        // rules the observation layer applies, applied again here against the
        // authoritative intent.
        const match = matchIncomingTransferToIntent(transfer, intent);

        if (match.matched !== true) {

            return {
                ok: false,
                reason: INCOMING_SETTLEMENT_REFUSAL_REASON
                    .MATCH_VALIDATION_FAILED,
                details: {
                    mismatches: match.mismatches,
                    matchReason: match.reason
                }
            };

        }

        return { ok: true };

    }

    /**
     * Bind the observed transaction and settle through the protected path.
     * The exact immutable observation result and selected transaction id are
     * passed to the payment service for independent candidate validation.
     *
     * @returns {{ ok: true }|{ ok: false, reason: string, details: object }}
     */
    #settleValidatedCandidate({ intent, transfer, observation }) {

        let matched = null;

        try {

            matched = this._paymentService.matchTransaction(
                intent.paymentReference,
                transfer.transactionId,
                observation
            );

        } catch (error) {

            return {
                ok: false,
                reason: errorCodeOf(error, "TRANSITION_REJECTED"),
                details: { stage: "matchTransaction" }
            };

        }

        try {

            this._paymentService.settlePayment(
                intent.paymentReference,
                observation,
                transfer.transactionId
            );

        } catch (error) {

            return {
                ok: false,
                reason: errorCodeOf(error, "TRANSITION_REJECTED"),
                details: { stage: "settlePayment" }
            };

        }

        this._logInfo(
            `Incoming payment settled from observation | room=${intent.roomId}`
                + ` | ref=${intent.paymentReference}`
                + ` | transaction=${matched.transactionId}`
        );

        return { ok: true };

    }

    /**
     * Shape one immutable report. It deliberately never carries a settlement
     * authority, a provider payload or any secret material.
     *
     * @returns {Readonly<object>}
     */
    _report({
        room,
        mode = null,
        refusal = null,
        window = null,
        observation = null,
        ambiguity = null,
        settled = [],
        alreadySettled = [],
        unmatched = [],
        refused = [],
        walletId = null,
        walletAddress = null
    }) {

        return freezeReport({

            roomId: room,
            mode: mode ?? (window === null ? "REFUSED" : "FRESH_OBSERVATION"),
            refusal,
            ambiguity,
            observation: window === null
                ? null
                : Object.freeze({
                    walletId,
                    walletAddress,
                    floorMs: window.floorMs,
                    ceilingMs: window.ceilingMs,
                    limit: window.limit,
                    providerRequests: window.providerRequests,
                    rowsReturned: window.rowsReturned,
                    transfersObserved: window.transfersObserved,
                    resultWindowComplete: observation?.resultWindowComplete === true,
                    disposition: observation?.disposition ?? null,
                    paymentConfirmation: observation?.paymentConfirmation ?? false
                }),
            resultWindowComplete: observation?.resultWindowComplete === true,
            settled,
            alreadySettled,
            unmatched,
            refused,
            counts: Object.freeze({
                settled: settled.length,
                alreadySettled: alreadySettled.length,
                unmatched: unmatched.length,
                refused: refused.length
            }),
            details: refusal === null
                ? []
                : [Object.freeze({ reason: refusal })]

        });

    }

    _logInfo(message) {

        if (typeof this._logger?.info === "function") {

            this._logger.info(message);

        }

    }

}

export default IncomingPaymentSettlementCoordinator;
