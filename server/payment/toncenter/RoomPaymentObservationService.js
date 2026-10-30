/**
 * Phase 3 — Room payment observation service (Toncenter Testnet).
 *
 * The ONLY entry point for observing room wallet payments. It is explicitly
 * caller-driven: nothing here starts, schedules or repeats on its own.
 *
 *   - no setInterval, no cron, no background polling, no startup scanning,
 *     no recurring requests;
 *   - one `checkRoomPayments()` call = at most ONE provider request for that
 *     room's assigned wallet;
 *   - simultaneous checks for the same room/wallet are coalesced into ONE
 *     provider request that both callers share;
 *   - every Toncenter request passes through one shared rate limiter
 *     (configurable; default 8 requests/second);
 *   - HTTP 429 stops the call with `ToncenterRateLimitError` — never
 *     retried, never converted into a hidden polling loop;
 *   - results are observation-only: this service never reads or writes an
 *     intent store. Optional settlement evidence is separately validated and
 *     bound to the exact immutable observation; without a configured evidence
 *     provider, coordinator settlement remains blocked.
 *
 * Per-check flow: acquire a rate slot -> ONE bounded transaction query for
 * the room wallet -> Phase 2 normalization -> evaluate every payment intent
 * configured for the room against every observed transfer using the Phase 2
 * pure matcher.
 */

import {
    PAYMENT_CONFIRMATION_DISPOSITION,
    IncomingTransfer,
    matchIncomingTransferToIntent,
    normalizeIncomingTransferRecord
} from "../incoming/index.js";

import {
    INCOMING_TRANSFER_ADAPTER_FORBIDDEN_OPERATIONS,
    assertNoOperations
} from "../incoming/IncomingTransferProvider.js";

import {
    TONCENTER_DEFAULT_TRANSACTION_LIMIT,
    TONCENTER_MAX_TRANSACTION_LIMIT,
    TONCENTER_NETWORK,
    TONCENTER_PROVIDER_ID
} from "./ToncenterConstants.js";

import { ToncenterRateLimiter } from "./ToncenterRateLimiter.js";

import { ToncenterIncomingProvider } from "./ToncenterIncomingProvider.js";

import { PaymentConfigurationError, PaymentValidationError } from "../PaymentErrors.js";

import {
    TonPaymentSettlementEvidenceProvider,
    assessTonPaymentSettlementEvidence
} from "../incoming/TonPaymentSettlementEvidence.js";

/**
 * Module-private registry of the EXACT immutable observation result objects
 * this module returned after a successful provider observation, keyed by the
 * service instance that produced them.
 *
 * A `WeakMap`/`WeakSet` pair is the whole mechanism, and it is module-private
 * on purpose:
 *
 *   - a caller cannot register, mark, mint or copy an entry — there is no
 *     exported write operation anywhere in this module;
 *   - identity is object identity, so a copied, spread, serialized or
 *     re-frozen object is NEVER in the set;
 *   - the result is bound to the instance that actually performed the
 *     observation, so a result produced by a DIFFERENT
 *     `RoomPaymentObservationService` instance is never trusted by another one.
 *
 * Observation-only trust: this registry proves that the configured provider
 * returned the mapped transaction for the queried account and window. It does
 * not itself establish chain identity or finality; those are checked against
 * separately fetched evidence and stored in a distinct private registry.
 */
const trustedObservationResults = new WeakMap();
const trustedSettlementEvidence = new WeakMap();
const trustedSettlementWindows = new WeakMap();

/**
 * Mark one immutable observation result as produced by `service`. Private to
 * this module: nothing outside it can ever call this function.
 *
 * @param {RoomPaymentObservationService} service
 * @param {Readonly<object>} result
 * @returns {void}
 */
function markTrustedObservationResult(service, result) {

    let results = trustedObservationResults.get(service);

    if (results === undefined) {

        results = new WeakSet();

        trustedObservationResults.set(service, results);

    }

    results.add(result);

}

function snapshotSettlementEvidence(evidence) {
    const network = evidence.networkIdentity;
    const inclusion = evidence.transactionInclusion;
    const finality = evidence.finality;
    const block = inclusion.block;
    const finalizedBlock = finality.block;
    return Object.freeze({
        networkIdentity: Object.freeze({
            network: network.network,
            globalId: network.globalId,
            source: network.source,
            observedAtMs: network.observedAtMs
        }),
        transactionInclusion: Object.freeze({
            transactionId: inclusion.transactionId,
            accountId: inclusion.accountId,
            block: Object.freeze({
                workchain: block.workchain,
                shard: block.shard,
                seqno: block.seqno
            })
        }),
        finality: Object.freeze({
            status: finality.status,
            source: finality.source,
            transactionId: finality.transactionId,
            accountId: finality.accountId,
            block: Object.freeze({
                workchain: finalizedBlock.workchain,
                shard: finalizedBlock.shard,
                seqno: finalizedBlock.seqno
            }),
            masterchainSeqno: finality.masterchainSeqno,
            observedAtMs: finality.observedAtMs
        })
    });
}

/**
 * Read-only predicate: is `result` the EXACT immutable observation result that
 * `observationService` returned from a completed provider observation?
 *
 * This function can only ever answer that one question. It cannot register,
 * mark, mint or derive a trusted result, and it never inspects field values a
 * hand-made object could carry — only object identity against the
 * module-private registry of that one service instance.
 *
 * @param {unknown} result
 * @param {unknown} observationService
 * @returns {boolean}
 */
export function isTrustedRoomPaymentObservationResult(result, observationService) {

    if (result === null || typeof result !== "object") {

        return false;

    }

    if (observationService === null
        || typeof observationService !== "object") {

        return false;

    }

    const results = trustedObservationResults.get(observationService);

    return results === undefined ? false : results.has(result);

}

/**
 * Read-only coordinator predicate. Evidence is trusted only when the exact
 * observation service fetched it from its configured evidence provider and
 * validated it; normalized transfer flags are never consulted.
 */
export function hasTrustedRoomPaymentSettlementEvidence(result, transfer, nowMs) {
    if (result === null || typeof result !== "object"
        || transfer === null || typeof transfer !== "object") {
        return false;
    }
    const evidence = trustedSettlementEvidence.get(result)
        ?.get(transfer.transactionId);
    if (!evidence) return false;
    const window = trustedSettlementWindows.get(result);
    if (window && typeof window.provider.isObservationValid === "function"
        && !window.provider.isObservationValid(window.session)) return false;
    return assessTonPaymentSettlementEvidence(evidence, {
        transactionId: transfer.providerTransactionIdentity?.transactionId,
        accountId: transfer.providerTransactionIdentity?.accountId,
        nowMs
    }).authorized;
}

function assertNonEmptyString(value, field) {

    if (typeof value !== "string" || value.trim() === "") {

        throw new PaymentValidationError(
            `${field} must be a non-empty string`,
            { field }
        );

    }

}

export class RoomPaymentObservationService {

    /**
     * @param {{
     *   provider: ToncenterIncomingProvider,
     *   incomingProvider?: ToncenterIncomingProvider,
     *   settlementEvidenceProvider?: TonPaymentSettlementEvidenceProvider|null,
     *   rateLimiter?: ToncenterRateLimiter,
     *   requestsPerSecond?: number,
     *   limit?: number,
     *   nowProvider?: () => number
     * }} options
     */
    constructor({
        provider = null,
        incomingProvider = null,
        settlementEvidenceProvider = null,
        rateLimiter = null,
        requestsPerSecond,
        limit = TONCENTER_DEFAULT_TRANSACTION_LIMIT,
        nowProvider = Date.now
    } = {}) {

        // Structural proof: this service exposes no write or confirmation
        // operation, now or ever.
        assertNoOperations(
            RoomPaymentObservationService.prototype,
            INCOMING_TRANSFER_ADAPTER_FORBIDDEN_OPERATIONS
        );

        const effectiveProvider = provider ?? incomingProvider;

        if (!(effectiveProvider instanceof ToncenterIncomingProvider)) {

            throw new PaymentConfigurationError(
                "provider must be a ToncenterIncomingProvider instance"
            );

        }

        if (settlementEvidenceProvider !== null
            && !(settlementEvidenceProvider instanceof TonPaymentSettlementEvidenceProvider)) {
            throw new PaymentConfigurationError(
                "settlementEvidenceProvider must implement the trusted TON evidence capability"
            );
        }

        if (requestsPerSecond !== undefined && rateLimiter !== null) {

            throw new PaymentConfigurationError(
                "pass either requestsPerSecond (to build a limiter) or a"
                    + " rateLimiter instance, not both"
            );

        }

        this._provider = effectiveProvider;

        // No production Toncenter implementation is configured in this
        // milestone. Null therefore means observation is allowed but
        // settlement authorization remains unavailable.
        this._settlementEvidenceProvider = settlementEvidenceProvider;

        this._rateLimiter = rateLimiter ?? new ToncenterRateLimiter({

            requestsPerSecond: requestsPerSecond

        });

        if (!Number.isSafeInteger(limit)
            || limit < 1
            || limit > TONCENTER_MAX_TRANSACTION_LIMIT) {

            throw new PaymentConfigurationError(
                `limit must be an integer in`
                    + ` 1..${TONCENTER_MAX_TRANSACTION_LIMIT}`,
                { limit }
            );

        }

        if (typeof nowProvider !== "function") {

            throw new PaymentConfigurationError(
                "nowProvider must be a function"
            );

        }

        this._limit = limit;

        this._nowProvider = nowProvider;

        /** @type {Map<string, Promise<object>>} in-flight checks, keyed per room/wallet */
        this._inFlight = new Map();

    }

    /** The shared rate limiter used by every Toncenter request. */
    get rateLimiter() {

        return this._rateLimiter;

    }

    /** Number of room checks currently in flight. */
    get inFlightCheckCount() {

        return this._inFlight.size;

    }

    /**
     * Always `"observation-only"`: observing a provider transaction is NOT a
     * payment confirmation.
     */
    get confirmationDisposition() {

        return PAYMENT_CONFIRMATION_DISPOSITION.OBSERVATION_ONLY;

    }

    /** Always false. */
    canConfirmPayments() {

        return false;

    }

    /**
     * Explicitly cancel nothing: there is nothing scheduled. This accessor
     * exists so callers can ASSERT the service holds no background work.
     *
     * @returns {boolean} always false
     */
    hasBackgroundWork() {

        return false;

    }

    /** Open a live Testnet evidence window before a manually initiated transfer. */
    async beginSettlementEvidenceWindow({ walletAddress } = {}) {
        assertNonEmptyString(walletAddress, "walletAddress");
        if (typeof this._settlementEvidenceProvider?.beginObservation !== "function") {
            throw new PaymentConfigurationError("configured evidence provider does not support live observation windows");
        }
        return this._settlementEvidenceProvider.beginObservation({ accountId: walletAddress.trim() });
    }

    /** Close an explicitly opened evidence window; it is never reconnected. */
    async endSettlementEvidenceWindow(session) {
        if (typeof this._settlementEvidenceProvider?.endObservation !== "function") {
            throw new PaymentConfigurationError("configured evidence provider does not support live observation windows");
        }
        return this._settlementEvidenceProvider.endObservation(session);
    }

    /**
     * Observe incoming transactions for one room's assigned wallet and
     * evaluate them against that room's payment intents.
     *
     * @param {{
     *   roomId: string,
     *   walletAddress: string,
     *   paymentIntents: Array<object>,
     *   floorMs: number,
     *   ceilingMs?: number,
     *   limit?: number,
     *   destinationWalletId?: string|null
     *   observationSession?: object|null
     * }} request
     * @returns {Promise<Readonly<object>>} observation-only result
     */
    checkRoomPayments({
        roomId,
        walletAddress,
        paymentIntents,
        floorMs,
        ceilingMs,
        limit = this._limit,
        destinationWalletId = null,
        observationSession = null
    }) {

        assertNonEmptyString(roomId, "roomId");
        assertNonEmptyString(walletAddress, "walletAddress");

        if (!Array.isArray(paymentIntents) || paymentIntents.length === 0) {

            throw new PaymentValidationError(
                "paymentIntents must be a non-empty array"
            );

        }

        if (!Number.isSafeInteger(floorMs) || floorMs <= 0) {

            throw new PaymentValidationError(
                "floorMs must be a positive integer epoch-milliseconds value",
                { floorMs }
            );

        }

        const effectiveCeiling = ceilingMs ?? this._nowProvider();

        if (!Number.isSafeInteger(effectiveCeiling)
            || effectiveCeiling <= 0) {

            throw new PaymentValidationError(
                "ceilingMs must be a positive integer epoch-milliseconds value",
                { ceilingMs: effectiveCeiling }
            );

        }

        if (floorMs > effectiveCeiling) {

            throw new PaymentValidationError(
                "floorMs must not be greater than ceilingMs",
                { floorMs, ceilingMs: effectiveCeiling }
            );

        }

        const walletKey = walletAddress.trim();

        // Coalescing key: one in-flight request per room AND wallet. The NUL
        // separator cannot occur inside the identifiers.
        const coalesceKey = `${roomId.trim()}\u0000${walletKey}`;

        const inFlight = this._inFlight.get(coalesceKey);

        if (inFlight) {

            // Simultaneous check for the same room/wallet: share the ONE
            // provider request instead of issuing a second one.
            return inFlight;

        }

        const pending = this._runCheck({

            roomId: roomId.trim(),
            walletAddress: walletKey,
            paymentIntents,
            floorMs,
            ceilingMs: effectiveCeiling,
            limit,
            destinationWalletId,
            observationSession

        });

        this._inFlight.set(coalesceKey, pending);

        const clear = () => {

            if (this._inFlight.get(coalesceKey) === pending) {

                this._inFlight.delete(coalesceKey);

            }

        };

        pending.then(clear, clear);

        return pending;

    }

    /**
     * The actual single-flight check. One rate slot, one provider request.
     *
     * @returns {Promise<Readonly<object>>}
     */
    async _runCheck({
        roomId,
        walletAddress,
        paymentIntents,
        floorMs,
        ceilingMs,
        limit,
        destinationWalletId,
        observationSession = null
    }) {

        let session = observationSession;
        let ownsSession = false;
        if (this._settlementEvidenceProvider !== null
            && typeof this._settlementEvidenceProvider.beginObservation === "function"
            && session === null) {
            session = await this._settlementEvidenceProvider.beginObservation({ accountId: walletAddress });
            ownsSession = true;
        }
        try {
            return await this._runCheckWithSession({
                roomId, walletAddress, paymentIntents, floorMs, ceilingMs,
                limit, destinationWalletId, observationSession: session
            });
        } finally {
            if (ownsSession) {
                await this._settlementEvidenceProvider.endObservation(session);
            }
        }

    }

    async _runCheckWithSession({
        roomId,
        walletAddress,
        paymentIntents,
        floorMs,
        ceilingMs,
        limit,
        destinationWalletId,
        observationSession = null
    }) {

        await this._rateLimiter.acquire();

        const observation = await this._provider.listIncomingTransactions({
            account: walletAddress,
            floorMs,
            ceilingMs,
            limit,
            destinationWalletId,
            priority: "page4"
        });

        const now = this._nowProvider();

        const transfers = [];

        const evidenceByTransactionId = new Map();

        const observations = [];

        // Keep all observed transfers for receipt accounting, but only one
        // eligible payment per payer/intent. Other transfers are excess funds.
        const matchingTransfersByReference = new Map();

        for (const record of observation.records) {

            const transfer = normalizeIncomingTransferRecord(record, {
                network: TONCENTER_NETWORK,
                providerId: TONCENTER_PROVIDER_ID,
                now
            });

            transfers.push(transfer);

            if (this._settlementEvidenceProvider !== null) {
                let evidence = null;
                try {
                    evidence = await this._settlementEvidenceProvider
                        .getSettlementEvidence({
                            accountId: walletAddress,
                            providerTransactionId:
                                transfer.providerTransactionIdentity.transactionId,
                            transactionTime: transfer.transactionTime,
                            observationSession,
                            indexedTransaction: record.indexedTransaction ?? null
                        });
                } catch {
                    // Evidence provider errors fail closed for this transfer.
                }
                try {
                    const snapshot = snapshotSettlementEvidence(evidence);
                    const decision = assessTonPaymentSettlementEvidence(snapshot, {
                        transactionId: transfer.providerTransactionIdentity.transactionId,
                        accountId: transfer.providerTransactionIdentity.accountId,
                        // Evidence is obtained AFTER the transfer snapshot.
                        // Assess at verification time, never the earlier
                        // observation start (which made fresh proof look future-dated).
                        nowMs: this._nowProvider()
                    });
                    if (decision.authorized) {
                        evidenceByTransactionId.set(transfer.transactionId, snapshot);
                    }
                } catch {
                    // Malformed and accessor-backed evidence is never retained.
                }
            }

            const entry = this._evaluateTransfer(transfer, paymentIntents);
            observations.push(entry);

            if (entry.status === "matched") {

                const group = matchingTransfersByReference
                    .get(entry.paymentReference) ?? [];

                group.push({ transactionId: entry.transactionId,
                    transactionTime: transfer.transactionTime });

                matchingTransfersByReference.set(entry.paymentReference, group);

            }

        }

        // The earliest valid, uniquely attributable transaction is the
        // player's stake. Later transfers must remain visible to the receipt
        // reconciler for refunds, but cannot invalidate that first payment.
        // Toncenter may return newest-first; choose by chain time, not API
        // ordering. A hash tie-breaker gives deterministic behavior for
        // transactions in the same block second.
        const primaryByReference = new Map();
        for (const [reference, group] of matchingTransfersByReference) {
            const first = [...group].sort((a, b) =>
                a.transactionTime - b.transactionTime
                || a.transactionId.localeCompare(b.transactionId)
            )[0];
            primaryByReference.set(reference, first.transactionId);
        }
        const finalObservations = observations.map(entry => {
            if (entry.status !== "matched"
                || primaryByReference.get(entry.paymentReference) === entry.transactionId) {
                return entry;
            }
            // A surplus receipt has no claim on the stake intent. The
            // immutable transfer is still in result.transfers and captured
            // by financial receipt accounting, including refund obligations.
            return Object.freeze({
                ...entry,
                status: "excess-payment",
                excessForPaymentReference: entry.paymentReference,
                paymentReference: null,
                excessReason: "ADDITIONAL_PAYMENT_FOR_PLAYER"
            });
        });

        const result = Object.freeze({
            roomId,
            walletAddress,
            disposition: PAYMENT_CONFIRMATION_DISPOSITION.OBSERVATION_ONLY,
            paymentConfirmation: false,
            canConfirmPayments: false,
            settlementEvidenceAvailable: evidenceByTransactionId.size > 0,
            providerRequests: 1,
            resultWindowComplete: observation.resultWindowComplete === true,
            window: Object.freeze({
                floorMs,
                ceilingMs,
                limit,
                rowsReturned: observation.rowsReturned
            }),
            transfers: Object.freeze([...transfers]),
            observations: Object.freeze([...finalObservations])
        });

        // The ONE thing that makes this result usable as settlement evidence:
        // it is registered in the module-private registry of THIS instance.
        // Nothing a caller supplies afterwards can enter that registry.
        markTrustedObservationResult(this, result);

        trustedSettlementEvidence.set(result, evidenceByTransactionId);
        if (observationSession !== null && this._settlementEvidenceProvider !== null) {
            trustedSettlementWindows.set(result, {
                provider: this._settlementEvidenceProvider,
                session: observationSession
            });
        }

        return result;

    }

    /**
     * Evaluate one observed transfer against the room's payment intents using
     * the Phase 2 pure matcher. Pure: nothing is mutated anywhere.
     *
     * A transfer matching more than one intent is reported as ambiguous and
     * is never attributed to a single intent by guessing. The caller applies
     * the mirror rule (several transfers matching one intent), because that
     * decision needs the whole observation set.
     *
     * @param {IncomingTransfer} transfer
     * @param {Array<object>} paymentIntents
     * @returns {Readonly<object>}
     */
    _evaluateTransfer(transfer, paymentIntents) {

        const candidates = [];
        const mismatchReasons = [];

        for (const intent of paymentIntents) {

            const result = matchIncomingTransferToIntent(transfer, intent);

            if (result.matched) {

                candidates.push(result);

            } else {

                mismatchReasons.push(Object.freeze({
                    paymentReference: intent.paymentReference ?? null,
                    reason: result.reason ?? "UNMATCHED",
                    mismatches: result.mismatches
                }));

            }

        }

        if (candidates.length > 1) {

            return Object.freeze({
                status: "ambiguous",
                transactionId: transfer.transactionId,
                paymentReference: null,
                candidatePaymentReferences: Object.freeze(
                    candidates.map((candidate) => candidate.paymentReference)
                ),
                candidateTransactionIds: null,
                amountAtomic: transfer.amountAtomic,
                senderAddress: transfer.senderAddress,
                transactionTime: transfer.transactionTime,
                mismatchReasons: Object.freeze(mismatchReasons),
                paymentConfirmed: false
            });

        }

        if (candidates.length === 1) {

            return Object.freeze({
                status: "matched",
                transactionId: transfer.transactionId,
                paymentReference: candidates[0].paymentReference,
                candidatePaymentReferences: null,
                candidateTransactionIds: null,
                amountAtomic: transfer.amountAtomic,
                senderAddress: transfer.senderAddress,
                transactionTime: transfer.transactionTime,
                paymentConfirmed: false
            });

        }

        // "no-match-observed" means exactly that: no matching transaction was
        // observed inside this (possibly incomplete) window. It is NOT a
        // statement that the payment does not exist.
        return Object.freeze({
            status: "no-match-observed",
            transactionId: transfer.transactionId,
            paymentReference: null,
            candidatePaymentReferences: null,
            candidateTransactionIds: null,
            amountAtomic: transfer.amountAtomic,
            senderAddress: transfer.senderAddress,
            transactionTime: transfer.transactionTime,
            mismatchReasons: Object.freeze(mismatchReasons),
            paymentConfirmed: false
        });

    }

}
