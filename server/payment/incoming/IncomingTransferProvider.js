/**
 * Phase 2 — Read-only provider boundary.
 *
 * The adapter never talks to a blockchain, a node, or an HTTP endpoint. It
 * receives records from an injected provider client that satisfies the
 * declared read-only contract:
 *
 *   listIncomingTransactions(options) -> Array<provider transaction record>
 *
 * per `INCOMING_TRANSFER_PROVIDER_CONTRACT`. The client owns transport,
 * authentication and provider vocabulary; the adapter owns normalization and
 * match evaluation only.
 *
 * The current project configuration identifies no approved read-only TON
 * provider, so this boundary ships without a concrete implementation. Tests
 * inject synthetic clients. No endpoint schema is invented here, and nothing
 * in this module claims live TON compatibility.
 */

import { PaymentValidationError } from "../PaymentErrors.js";

import { INCOMING_TRANSFER_PROVIDER_CONTRACT } from "./IncomingTransferConstants.js";

import { ProviderContractError } from "./IncomingTransferErrors.js";

/**
 * Interface declaration for an injectable read-only provider client.
 *
 * A concrete provider client extends this class (or is duck-typed with the
 * same surface) and maps its provider's response onto
 * `INCOMING_TRANSFER_PROVIDER_CONTRACT`. It must expose exactly one read
 * operation and none of the forbidden write operations.
 */
export class IncomingTransferProviderClient {

    constructor() {

        if (new.target === IncomingTransferProviderClient) {

            throw new PaymentValidationError(
                "IncomingTransferProviderClient is an interface declaration"
                    + " and must be implemented by a concrete provider client"
            );

        }

    }

    /**
     * Read-only listing of incoming transactions for a provider account.
     *
     * @param {{ network: string, accountId?: string, limit?: number }} [options]
     * @returns {Promise<Array<object>>|Array<object>}
     */
    async listIncomingTransactions(_options = {}) {

        throw new PaymentValidationError(
            "listIncomingTransactions must be implemented by the provider client"
        );

    }

}

/**
 * Structural read-only assertion for an injected provider client.
 *
 * Rejects (fail closed) clients that:
 *   - are missing or not objects;
 *   - do not expose the single declared read-only operation;
 *   - expose ANY forbidden write operation (send / broadcast / sign / deploy
 *     / contract call / transfer / burn).
 *
 * The write-surface check is what makes "the adapter cannot send or broadcast
 * a transaction" a structural property rather than a promise: the adapter
 * refuses a client that could even theoretically be used for writes.
 *
 * @param {unknown} client
 * @returns {void}
 */
export function assertReadOnlyProviderClient(client) {

    if (!client || typeof client !== "object") {

        throw new ProviderContractError(
            "provider client must be an object exposing"
                + ` ${INCOMING_TRANSFER_PROVIDER_CONTRACT.operation}`,
            { operation: INCOMING_TRANSFER_PROVIDER_CONTRACT.operation }
        );

    }

    const operation = INCOMING_TRANSFER_PROVIDER_CONTRACT.operation;

    if (typeof client[operation] !== "function") {

        throw new ProviderContractError(
            `provider client must expose ${operation}() per the declared contract`,
            { operation }
        );

    }

    for (const forbidden of INCOMING_TRANSFER_PROVIDER_CONTRACT.forbiddenOperations) {

        if (typeof client[forbidden] === "function") {

            throw new ProviderContractError(
                `provider client exposes the forbidden write operation: ${forbidden}`,
                { forbiddenOperation: forbidden }
            );

        }

    }

}

/**
 * Structural proof helper: an object must expose none of the given
 * operation names as functions. Used by the adapter to prove it cannot
 * confirm a payment, and available to callers for the same check.
 *
 * @param {object} target
 * @param {readonly string[]} forbiddenOperations
 * @returns {void}
 */
export function assertNoOperations(target, forbiddenOperations) {

    if (!target || typeof target !== "object") {

        throw new PaymentValidationError(
            "assertNoOperations requires a target object"
        );

    }

    for (const forbidden of forbiddenOperations) {

        if (typeof target[forbidden] === "function") {

            throw new ProviderContractError(
                `forbidden operation exposed: ${forbidden}`,
                { forbiddenOperation: forbidden }
            );

        }

    }

}

/**
 * Method names that would constitute a payment confirmation, a wallet write,
 * or a blockchain broadcast. The Phase 2 adapter and its result objects must
 * never expose any of them.
 */
export const INCOMING_TRANSFER_ADAPTER_FORBIDDEN_OPERATIONS = Object.freeze([
    ...INCOMING_TRANSFER_PROVIDER_CONTRACT.forbiddenOperations,
    "confirmPayment",
    "markPaid",
    "markConfirmed",
    "settlePayment",
    "creditTransaction",
    "credit",
    "refundPayment"
]);
