/**
 * Phase 3 — Toncenter Testnet read-only incoming-transfer provider.
 *
 * Implements the Phase 2 read-only provider contract
 * (`INCOMING_TRANSFER_PROVIDER_CONTRACT`) for the official Testnet API v3:
 *
 *     listIncomingTransactions({ account, floorMs, ceilingMs, limit })
 *         -> Array<Phase 2 provider record>
 *
 * It performs exactly ONE documented, authenticated, read-only GET per call
 * and maps the response through `mapToncenterTransactionsResponse`.
 *
 * Deliberately absent: transaction sending, broadcasting, signing, retries,
 * balance reads and contract calls. Wallet balances are never queried as a
 * substitute for incoming transaction observations.
 *
 * This class satisfies `assertReadOnlyProviderClient` from Phase 2: it
 * exposes only `listIncomingTransactions` and no write operation.
 */

import {
    TONCENTER_DEFAULT_TRANSACTION_LIMIT,
    TONCENTER_MAX_TRANSACTION_LIMIT
} from "./ToncenterConstants.js";

import { ToncenterTransactionsClient } from "./ToncenterTransactionsClient.js";

import { mapToncenterTransactionsResponse } from "./ToncenterTransactionsMapper.js";

import { IncomingTransferProviderClient } from "../incoming/IncomingTransferProvider.js";

import { assertReadOnlyProviderClient } from "../incoming/IncomingTransferProvider.js";

import { PaymentConfigurationError } from "../PaymentErrors.js";

export class ToncenterIncomingProvider extends IncomingTransferProviderClient {

    /**
     * @param {{
     *   client?: ToncenterTransactionsClient,
     *   transactionsClient?: ToncenterTransactionsClient,
     *   mapper?: (payload: object, window: object) => object
     * }} [options]
     */
    constructor({
        client = null,
        transactionsClient = null,
        mapper = mapToncenterTransactionsResponse
    } = {}) {

        super();

        const effectiveClient = client ?? transactionsClient;

        if (!(effectiveClient instanceof ToncenterTransactionsClient)) {

            throw new PaymentConfigurationError(
                "client must be a ToncenterTransactionsClient instance"
            );

        }

        if (typeof mapper !== "function") {

            throw new PaymentConfigurationError(
                "mapper must be a function"
            );

        }

        // Structural read-only proof at construction time.
        assertReadOnlyProviderClient(this);

        this._client = effectiveClient;

        this._mapper = mapper;

    }

    /** The configured provider base URL (public metadata, no secrets). */
    get baseUrl() {

        return this._client.baseUrl;

    }

    /**
     * Query incoming transactions for ONE wallet within a bounded window.
     *
     * @param {{
     *   account: string,
     *   floorMs: number,
     *   ceilingMs: number,
     *   limit?: number,
     *   destinationWalletId?: string|null
     * }} options
     * @returns {Promise<{
     *   records: ReadonlyArray<object>,
     *   rowsReturned: number,
     *   resultWindowComplete: boolean
     * }>}
     */
    async listIncomingTransactions({
        account,
        floorMs,
        ceilingMs,
        limit = TONCENTER_DEFAULT_TRANSACTION_LIMIT,
        destinationWalletId = null
    }) {

        if (typeof account !== "string" || account.trim() === "") {

            throw new PaymentConfigurationError(
                "account (room wallet address) must be a non-empty string"
            );

        }

        if (!Number.isSafeInteger(floorMs) || floorMs <= 0) {

            throw new PaymentConfigurationError(
                "floorMs must be a positive integer epoch-milliseconds value",
                { floorMs }
            );

        }

        if (!Number.isSafeInteger(ceilingMs) || ceilingMs <= 0) {

            throw new PaymentConfigurationError(
                "ceilingMs must be a positive integer epoch-milliseconds value",
                { ceilingMs }
            );

        }

        if (floorMs > ceilingMs) {

            throw new PaymentConfigurationError(
                "floorMs must not be greater than ceilingMs",
                { floorMs, ceilingMs }
            );

        }

        if (!Number.isSafeInteger(limit)
            || limit < 1
            || limit > TONCENTER_MAX_TRANSACTION_LIMIT) {

            throw new PaymentConfigurationError(
                `limit must be an integer in`
                    + ` 1..${TONCENTER_MAX_TRANSACTION_LIMIT}`,
                { limit }
            );

        }

        // The documented utime bounds are UTC seconds. The window is widened
        // by one second on the floor side because `start_utime` filters
        // transactions generated STRICTLY AFTER the given timestamp; the
        // exact millisecond window is applied while mapping, so no in-window
        // transaction can be missed by the server-side filter.
        const startUtime = Math.max(0, Math.floor(floorMs / 1000) - 1);

        // `end_utime` filters transactions generated STRICTLY BEFORE the given
        // timestamp, so the ceiling is widened by one second as well.
        const endUtime = Math.ceil(ceilingMs / 1000) + 1;

        const payload = await this._client.getTransactions({
            account: account.trim(),
            startUtime,
            endUtime,
            limit
        });

        return this._mapper(payload, {
            walletAddress: account.trim(),
            destinationWalletId,
            floorMs,
            ceilingMs,
            limit
        });

    }

}
