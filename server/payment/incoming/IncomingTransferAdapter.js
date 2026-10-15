/**
 * Phase 2 — Read-only incoming TON transfer adapter.
 *
 * Responsibilities, and nothing else:
 *
 *   1. accept incoming transaction records from an injected, read-only
 *      provider client (`assertReadOnlyProviderClient` refuses any client
 *      exposing a write operation);
 *   2. normalize them into `IncomingTransfer` records
 *      (`normalizeIncomingTransferRecord`, fail-closed);
 *   3. preserve the raw provider transaction identity for later idempotency
 *      checks — without retaining credentials or full provider responses;
 *   4. detect replays and contradictions through an injectable observation
 *      ledger;
 *   5. evaluate possible matches against Phase 1 payment intents with a pure
 *      function.
 *
 * This adapter CANNOT:
 *   - send, broadcast, sign, or retry a transaction;
 *   - mutate, credit, confirm or settle a payment intent;
 *   - mark any payment as paid or confirmed.
 *
 * Observing a provider transaction is explicitly NOT a payment confirmation:
 * every result carries `disposition: "observation-only"`, and
 * `isPaymentConfirmationDisposition(...)` is structurally always false.
 *
 * The adapter is not wired into application startup, room state, or active
 * payment collection. It is an observation tool to be used by a later phase.
 */

import { PaymentConfigurationError, PaymentReferenceCollisionError } from "../PaymentErrors.js";

import {
    DEFAULT_INCOMING_TRANSFER_NETWORK,
    PAYMENT_CONFIRMATION_DISPOSITION
} from "./IncomingTransferConstants.js";

import {
    normalizeIncomingTransferRecord
} from "./IncomingTransferNormalizer.js";

import {
    IncomingTransferObservationLedger
} from "./IncomingTransferObservationLedger.js";

import {
    resolveIncomingTransferMatch,
    resolveIncomingTransferMatches
} from "./IncomingTransferMatcher.js";

import {
    INCOMING_TRANSFER_ADAPTER_FORBIDDEN_OPERATIONS,
    assertNoOperations,
    assertReadOnlyProviderClient
} from "./IncomingTransferProvider.js";

import { isSupportedNetwork, normalizeNetwork } from "./IncomingTransferIdentity.js";

import {
    ObservationConflictError,
    ProviderRequestError,
    ProviderResponseError
} from "./IncomingTransferErrors.js";

export class IncomingTransferAdapter {

    /**
     * @param {{
     *   providerClient: object,
     *   network?: string,
     *   providerId?: string,
     *   paymentReferenceExtractor?: (record: object) => string|null,
     *   observationLedger?: IncomingTransferObservationLedger,
     *   nowProvider?: () => number
     * }} options
     */
    constructor({
        providerClient,
        network = DEFAULT_INCOMING_TRANSFER_NETWORK,
        providerId = "provider",
        paymentReferenceExtractor = null,
        observationLedger = null,
        nowProvider = Date.now
    } = {}) {

        // Structural proof: the adapter must never expose a write or
        // confirmation operation — not now, not through any result object.
        assertNoOperations(
            IncomingTransferAdapter.prototype,
            INCOMING_TRANSFER_ADAPTER_FORBIDDEN_OPERATIONS
        );

        assertReadOnlyProviderClient(providerClient);

        if (paymentReferenceExtractor !== null
            && typeof paymentReferenceExtractor !== "function") {

            throw new PaymentConfigurationError(
                "paymentReferenceExtractor must be a function or null"
            );

        }

        if (observationLedger !== null
            && !(observationLedger instanceof IncomingTransferObservationLedger)) {

            throw new PaymentConfigurationError(
                "observationLedger must be an IncomingTransferObservationLedger"
                    + " instance or null"
            );

        }

        if (typeof nowProvider !== "function") {

            throw new PaymentConfigurationError(
                "nowProvider must be a function"
            );

        }

        const normalizedNetwork = normalizeNetwork(network);

        if (!isSupportedNetwork(normalizedNetwork)) {

            throw new PaymentConfigurationError(
                `adapter network is not supported: ${network}`,
                { network }
            );

        }

        this._providerClient = providerClient;

        this._network = normalizedNetwork;

        this._providerId = typeof providerId === "string" && providerId.trim() !== ""
            ? providerId.trim()
            : "provider";

        this._paymentReferenceExtractor = paymentReferenceExtractor;

        this._observationLedger = observationLedger
            ?? new IncomingTransferObservationLedger();

        this._nowProvider = nowProvider;

    }

    /** The single network this adapter instance observes. */
    get network() {

        return this._network;

    }

    /** The injected provider identity tag. */
    get providerId() {

        return this._providerId;

    }

    /**
     * Always `"observation-only"`. An observation is not a payment
     * confirmation and can never become one in Phase 2.
     */
    get confirmationDisposition() {

        return PAYMENT_CONFIRMATION_DISPOSITION.OBSERVATION_ONLY;

    }

    /**
     * Always false: no code path in this adapter can confirm a payment.
     *
     * @returns {boolean}
     */
    canConfirmPayments() {

        return false;

    }

    /**
     * Number of distinct normalized transactions observed so far.
     *
     * @returns {number}
     */
    get observedTransactionCount() {

        return this._observationLedger.size;

    }

    /**
     * Normalize a single provider record without observing it (pure).
     *
     * @param {unknown} rawRecord
     * @returns {import("./IncomingTransfer.js").IncomingTransfer}
     */
    normalizeProviderRecord(rawRecord) {

        return normalizeIncomingTransferRecord(rawRecord, {
            network: this._network,
            providerId: this._providerId,
            paymentReferenceExtractor: this._paymentReferenceExtractor,
            now: this._nowProvider()
        });

    }

    /**
     * Read the provider once, normalize every record, and record the
     * observations in the ledger.
     *
     * Fail-closed semantics:
     *   - a provider that throws or rejects is wrapped in
     *     `ProviderRequestError`;
     *   - a non-array reply is a `ProviderResponseError`;
     *   - any malformed, incomplete, contradictory or unsupported record
     *     aborts the whole observation before the ledger is touched;
     *   - identical replays are idempotent and reported as `replays`;
     *   - replayed identities with different content are contradictions
     *     (`ObservationConflictError`);
     *   - two distinct transaction identities carrying the same payment
     *     reference are rejected (`PaymentReferenceCollisionError`).
     *
     * The returned result is observation-only. It never confirms a payment.
     *
     * @param {{ accountId?: string, limit?: number }} [options]
     * @returns {Readonly<{
     *   network: string,
     *   disposition: string,
     *   observed: ReadonlyArray<import("./IncomingTransfer.js").IncomingTransfer>,
     *   replays: ReadonlyArray<import("./IncomingTransfer.js").IncomingTransfer>
     * }>}
     */
    observeIncomingTransactions(options = {}) {

        let response;

        try {

            response = this._providerClient.listIncomingTransactions(options);

        } catch (error) {

            throw new ProviderRequestError(
                `provider read failed: ${error?.message ?? String(error)}`,
                {
                    operation: "listIncomingTransactions",
                    providerError: error?.name ?? "Error"
                }
            );

        }

        if (response && typeof response.then === "function") {

            throw new ProviderResponseError(
                "provider client must return a synchronous array; async"
                    + " providers must be awaited by their own client wrapper"
            );

        }

        if (!Array.isArray(response)) {

            throw new ProviderResponseError(
                "provider response must be an array of transaction records",
                { receivedType: typeof response }
            );

        }

        const now = this._nowProvider();

        // Normalize everything first: a single malformed record must abort
        // the whole observation before anything enters the ledger.
        const normalized = response.map((rawRecord) => (

            normalizeIncomingTransferRecord(rawRecord, {
                network: this._network,
                providerId: this._providerId,
                paymentReferenceExtractor: this._paymentReferenceExtractor,
                now
            })

        ));

        const observed = [];

        const replays = [];

        const pending = [];

        // Fail-closed replay/contradiction pass. Nothing is committed yet, so
        // a rejected observation leaves the ledger exactly as it was.
        for (const transfer of normalized) {

            const existing = this._observationLedger.get(transfer.transactionId);

            if (existing) {

                if (existing.payloadFingerprint() !== transfer.payloadFingerprint()) {

                    throw new ObservationConflictError(transfer.transactionId, {
                        observedAt: existing.observedAt,
                        conflictingObservedAt: transfer.observedAt,
                        paymentReference: transfer.paymentReference
                    });

                }

                replays.push(existing);

                continue;

            }

            pending.push(transfer);

        }

        // A payment reference may identify at most one transaction identity,
        // across the ledger and this observation together.
        const collision = this._findReferenceCollision(pending);

        if (collision) {

            throw new PaymentReferenceCollisionError(
                collision.paymentReference,
                {
                    transactionIds: collision.transactionIds,
                    network: this._network,
                    reason: "duplicate payment reference across transactions"
                }
            );

        }

        for (const transfer of pending) {

            this._observationLedger.register(transfer);

            observed.push(transfer);

        }

        return Object.freeze({
            network: this._network,
            disposition: PAYMENT_CONFIRMATION_DISPOSITION.OBSERVATION_ONLY,
            observed: Object.freeze([...observed]),
            replays: Object.freeze([...replays])
        });

    }

    /**
     * First payment reference claimed by two distinct transaction identities
     * when `pending` is considered together with the ledger, or null.
     *
     * @param {ReadonlyArray<import("./IncomingTransfer.js").IncomingTransfer>} pending
     * @returns {{ paymentReference: string, transactionIds: string[] }|null}
     */
    _findReferenceCollision(pending) {

        const byReference = new Map();

        for (const transfer of this._observationLedger.list()) {

            if (transfer.paymentReference === null) {

                continue;

            }

            const ids = byReference.get(transfer.paymentReference) ?? new Set();

            ids.add(transfer.transactionId);

            byReference.set(transfer.paymentReference, ids);

        }

        for (const transfer of pending) {

            if (transfer.paymentReference === null) {

                continue;

            }

            const ids = byReference.get(transfer.paymentReference) ?? new Set();

            ids.add(transfer.transactionId);

            byReference.set(transfer.paymentReference, ids);

        }

        for (const [paymentReference, transactionIds] of byReference) {

            if (transactionIds.size > 1) {

                return {
                    paymentReference,
                    transactionIds: [...transactionIds]
                };

            }

        }

        return null;

    }

    /**
     * All transactions observed so far (normalized records only).
     *
     * @returns {ReadonlyArray<import("./IncomingTransfer.js").IncomingTransfer>}
     */
    listObservedTransfers() {

        return this._observationLedger.list();

    }

    /**
     * Evaluate possible matches of the given transfers against the given
     * payment intents. Pure: no intent is read from or written to any store,
     * and no state transition is performed.
     *
     * @param {ReadonlyArray<import("./IncomingTransfer.js").IncomingTransfer>} transfers
     * @param {Array<object>} intents
     * @returns {ReadonlyArray<object>} one resolution result per transfer
     */
    evaluateMatches(transfers, intents) {

        return resolveIncomingTransferMatches(transfers, intents);

    }

    /**
     * Evaluate possible matches of one transfer. Pure.
     *
     * @param {import("./IncomingTransfer.js").IncomingTransfer} transfer
     * @param {Array<object>} intents
     * @returns {object}
     */
    evaluateMatch(transfer, intents) {

        return resolveIncomingTransferMatch(transfer, intents);

    }

}
