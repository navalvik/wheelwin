/**
 * Phase 2 — In-memory observation ledger.
 *
 * Tracks which normalized incoming transfers have already been observed, so
 * that:
 *
 *   - replaying the exact same provider transaction is idempotent
 *     (identical derived identity AND identical payload fingerprint);
 *   - replaying the same provider transaction identity with different
 *     content is a contradiction and is rejected;
 *   - a payment reference claimed by two different transaction identities is
 *     rejected instead of being silently resolved.
 *
 * The ledger stores normalized observations only — never raw provider
 * responses, never credentials. It is injectable and in-memory: Phase 2 does
 * not persist anything.
 */

import { PaymentValidationError } from "../PaymentErrors.js";

import { IncomingTransfer } from "./IncomingTransfer.js";

import { ObservationConflictError } from "./IncomingTransferErrors.js";

export class IncomingTransferObservationLedger {

    constructor() {

        /** @type {Map<string, IncomingTransfer>} key = transfer.transactionId */
        this._byTransactionId = new Map();

    }

    /** @returns {number} */
    get size() {

        return this._byTransactionId.size;

    }

    /**
     * @param {string} transactionId
     * @returns {boolean}
     */
    has(transactionId) {

        return this._byTransactionId.has(transactionId);

    }

    /**
     * @param {string} transactionId
     * @returns {IncomingTransfer|null}
     */
    get(transactionId) {

        return this._byTransactionId.get(transactionId) ?? null;

    }

    /**
     * Register one observation.
     *
     * @param {IncomingTransfer} transfer
     * @returns {{ replay: boolean, transfer: IncomingTransfer }}
     */
    register(transfer) {

        if (!(transfer instanceof IncomingTransfer)) {

            throw new PaymentValidationError(
                "ledger entries must be IncomingTransfer instances"
            );

        }

        const existing = this._byTransactionId.get(transfer.transactionId);

        if (existing) {

            if (existing.payloadFingerprint() !== transfer.payloadFingerprint()) {

                throw new ObservationConflictError(transfer.transactionId, {
                    observedAt: existing.observedAt,
                    conflictingObservedAt: transfer.observedAt,
                    paymentReference: transfer.paymentReference
                });

            }

            return { replay: true, transfer: existing };

        }

        this._byTransactionId.set(transfer.transactionId, transfer);

        return { replay: false, transfer };

    }

    /**
     * @returns {IncomingTransfer[]}
     */
    list() {

        return Object.freeze([...this._byTransactionId.values()]);

    }

}
