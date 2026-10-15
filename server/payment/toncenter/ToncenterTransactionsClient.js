/**
 * Phase 3 — Toncenter Testnet read-only HTTP transport.
 *
 * The only place in the codebase that opens a network connection to the
 * provider. It implements exactly one documented read-only operation:
 *
 *     GET {baseUrl}/api/v3/transactions
 *         ?account={wallet}
 *         &start_utime={seconds}
 *         &end_utime={seconds}
 *         &limit={1..1000}
 *         &sort=desc
 *
 * Rules enforced here:
 *   - authentication uses the single existing TON_API_KEY runtime variable,
 *     sent as the X-API-Key request header, and is never logged, copied or
 *     written anywhere;
 *   - when the key is absent NO request is sent
 *     (`ToncenterApiKeyMissingError` instead of an unauthenticated request);
 *   - there is no retry, no backoff and no polling — every call maps to at
 *     most one HTTP request;
 *   - HTTP 429 stops the call immediately with `ToncenterRateLimitError`;
 *   - every response is validated against the documented envelope before it
 *     is returned to the caller.
 *
 * The transport is injectable (baseUrl / fetch implementation / key provider
 * / timeout) so tests never touch the live provider.
 */

import {
    TONCENTER_API_KEY_ENV_VAR,
    TONCENTER_DEFAULT_TIMEOUT_MS,
    TONCENTER_MAX_TRANSACTION_LIMIT,
    TONCENTER_TESTNET_BASE_URL,
    TONCENTER_TRANSACTIONS_PATH
} from "./ToncenterConstants.js";

import {
    ToncenterApiKeyMissingError,
    ToncenterAuthenticationError,
    ToncenterRateLimitError,
    ToncenterRequestError,
    ToncenterResponseError,
    ToncenterServiceError
} from "./ToncenterErrors.js";

/** Reads the single existing API key from the runtime environment. */
export function defaultApiKeyProvider() {

    const key = process.env[TONCENTER_API_KEY_ENV_VAR];

    return typeof key === "string" ? key.trim() : "";

}

function assertNonEmptyString(value, field) {

    if (typeof value !== "string" || value.trim() === "") {

        throw new ToncenterRequestError(
            `${field} must be a non-empty string`,
            { field }
        );

    }

}

export class ToncenterTransactionsClient {

    /**
     * @param {{
     *   baseUrl?: string,
     *   apiKeyProvider?: () => string,
     *   fetchImpl?: typeof fetch,
     *   timeoutMs?: number
     * }} [options]
     */
    constructor({
        baseUrl = TONCENTER_TESTNET_BASE_URL,
        apiKeyProvider = defaultApiKeyProvider,
        fetchImpl = globalThis.fetch,
        timeoutMs = TONCENTER_DEFAULT_TIMEOUT_MS
    } = {}) {

        assertNonEmptyString(baseUrl, "baseUrl");

        if (typeof apiKeyProvider !== "function") {

            throw new ToncenterRequestError(
                "apiKeyProvider must be a function"
            );

        }

        if (typeof fetchImpl !== "function") {

            throw new ToncenterRequestError(
                "fetchImpl must be a function"
            );

        }

        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {

            throw new ToncenterRequestError(
                "timeoutMs must be a positive safe integer",
                { timeoutMs }
            );

        }

        this._baseUrl = baseUrl;

        this._apiKeyProvider = apiKeyProvider;

        this._fetch = fetchImpl;

        this._timeoutMs = timeoutMs;

    }

    /** The configured provider base URL (public metadata, no secrets). */
    get baseUrl() {

        return this._baseUrl;

    }

    /** The configured request timeout in milliseconds. */
    get timeoutMs() {

        return this._timeoutMs;

    }

    /**
     * Execute ONE documented read-only transaction query.
     *
     * @param {{
     *   account: string,
     *   startUtime: number,
     *   endUtime: number,
     *   limit?: number
     * }} query
     * @returns {Promise<object>} the parsed, envelope-validated response body
     */
    async getTransactions({ account, startUtime, endUtime, limit = 50 }) {

        assertNonEmptyString(account, "account");

        if (!Number.isSafeInteger(startUtime) || startUtime < 0) {

            throw new ToncenterRequestError(
                "startUtime must be a non-negative integer epoch-seconds value",
                { startUtime }
            );

        }

        if (!Number.isSafeInteger(endUtime) || endUtime < 0) {

            throw new ToncenterRequestError(
                "endUtime must be a non-negative integer epoch-seconds value",
                { endUtime }
            );

        }

        if (startUtime > endUtime) {

            throw new ToncenterRequestError(
                "startUtime must not be greater than endUtime",
                { startUtime, endUtime }
            );

        }

        if (!Number.isSafeInteger(limit)
            || limit < 1
            || limit > TONCENTER_MAX_TRANSACTION_LIMIT) {

            throw new ToncenterRequestError(
                `limit must be an integer in 1..${TONCENTER_MAX_TRANSACTION_LIMIT}`,
                { limit }
            );

        }

        // Authentication. No key => no request at all.
        const apiKey = this._apiKeyProvider();

        if (typeof apiKey !== "string" || apiKey.trim() === "") {

            throw new ToncenterApiKeyMissingError(TONCENTER_API_KEY_ENV_VAR);

        }

        const url = new URL(
            `${this._baseUrl.replace(/\/+$/, "")}${TONCENTER_TRANSACTIONS_PATH}`
        );

        url.searchParams.set("account", account);
        url.searchParams.set("start_utime", String(startUtime));
        url.searchParams.set("end_utime", String(endUtime));
        url.searchParams.set("limit", String(limit));
        url.searchParams.set("sort", "desc");

        // Explicit controller + ref'd timer: `AbortSignal.timeout` relies on
        // an unref'd timer, which cannot keep an event loop alive while a
        // request is genuinely in flight.
        const controller = new AbortController();

        const timer = setTimeout(() => {

            controller.abort(
                new DOMException("The operation timed out.", "TimeoutError")
            );

        }, this._timeoutMs);

        let response;

        try {

            response = await this._fetch(url.toString(), {
                method: "GET",
                headers: { "X-API-Key": apiKey.trim() },
                signal: controller.signal
            });

        } catch (error) {

            const isTimeout = error?.name === "TimeoutError"
                || error?.name === "AbortError"
                || controller.signal.aborted === true;

            throw new ToncenterRequestError(
                isTimeout
                    ? `Toncenter request timed out after ${this._timeoutMs}ms`
                    : `Toncenter request failed: ${error?.message ?? String(error)}`,
                {
                    failure: isTimeout ? "timeout" : "network",
                    errorName: error?.name ?? "Error",
                    timeoutMs: this._timeoutMs
                }
            );

        } finally {

            clearTimeout(timer);

        }

        const status = response?.status;

        if (status === 200) {

            return this._parseBody(response);

        }

        if (status === 401 || status === 403) {

            throw new ToncenterAuthenticationError(status);

        }

        if (status === 429) {

            // Stop immediately. No retry, no polling loop.
            throw new ToncenterRateLimitError(status);

        }

        if (typeof status === "number" && status >= 500) {

            throw new ToncenterServiceError(status);

        }

        throw new ToncenterRequestError(
            `Toncenter rejected the transaction query (HTTP ${status})`,
            { statusCode: status }
        );

    }

    /**
     * Parse and envelope-validate the documented response body.
     *
     * @param {object} response
     * @returns {Promise<object>}
     */
    async _parseBody(response) {

        let payload;

        try {

            payload = await response.json();

        } catch (error) {

            throw new ToncenterResponseError(
                "Toncenter response body is not valid JSON",
                { errorName: error?.name ?? "Error" }
            );

        }

        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {

            throw new ToncenterResponseError(
                "Toncenter response must be a JSON object",
                { receivedType: typeof payload }
            );

        }

        if (!Array.isArray(payload.transactions)) {

            throw new ToncenterResponseError(
                "Toncenter response is missing the transactions array",
                { receivedType: typeof payload.transactions }
            );

        }

        return payload;

    }

}
