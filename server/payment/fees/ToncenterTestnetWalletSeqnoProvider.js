/**
 * Read-only Testnet wallet seqno observer.
 *
 * Calls TON Center's documented /api/v2/runGetMethod endpoint with method
 * "seqno". It never signs or broadcasts a transaction. A returned seqno is
 * only a point-in-time observation; it does NOT by itself prove that a
 * particular outgoing transaction consumed that seqno. Callers must bind the
 * observation to a serialized wallet operation and independently verified,
 * finalized transaction evidence before reconciling money.
 */
import {
    TONCENTER_API_KEY_ENV_VAR,
    TONCENTER_DEFAULT_TIMEOUT_MS,
    TONCENTER_TESTNET_BASE_URL
} from "../toncenter/ToncenterConstants.js";
import {
    ToncenterApiKeyMissingError,
    ToncenterAuthenticationError,
    ToncenterRateLimitError,
    ToncenterRequestError,
    ToncenterResponseError,
    ToncenterServiceError
} from "../toncenter/ToncenterErrors.js";

function nonEmptyString(value, field) {
    if (typeof value !== "string" || value.trim() === "") {
        throw new ToncenterRequestError(`${field} must be a non-empty string`);
    }
    return value.trim();
}

function parseSeqnoStack(payload) {
    const stack = payload?.result?.stack;
    if (payload?.ok !== true || payload?.result?.exit_code !== 0
        || !Array.isArray(stack) || stack.length !== 1
        || !Array.isArray(stack[0]) || stack[0].length < 2
        || stack[0][0] !== "num" || typeof stack[0][1] !== "string") {
        throw new ToncenterResponseError("Toncenter seqno response has an unexpected runGetMethod result");
    }
    const encoded = stack[0][1];
    let value;
    if (/^(0|[1-9][0-9]*)$/.test(encoded)) value = BigInt(encoded);
    else if (/^0x[0-9a-f]+$/i.test(encoded)) value = BigInt(encoded);
    else throw new ToncenterResponseError("Toncenter seqno stack value is not a valid integer");
    if (value < 0n || value > 0xffffffffn) {
        throw new ToncenterResponseError("Toncenter seqno is outside the unsigned 32-bit wallet range");
    }
    return Number(value);
}

export class ToncenterTestnetWalletSeqnoProvider {
    constructor({
        apiKeyProvider = () => {
            const key = process.env[TONCENTER_API_KEY_ENV_VAR];
            return typeof key === "string" ? key.trim() : "";
        },
        fetchImpl = globalThis.fetch,
        networkIdentityProvider,
        baseUrl = TONCENTER_TESTNET_BASE_URL,
        timeoutMs = TONCENTER_DEFAULT_TIMEOUT_MS
    } = {}) {
        if (typeof apiKeyProvider !== "function" || typeof fetchImpl !== "function") {
            throw new ToncenterRequestError("seqno provider requires API-key and fetch functions");
        }
        if (typeof networkIdentityProvider?.getNetworkIdentity !== "function") {
            throw new ToncenterRequestError("an independent Testnet identity provider is required");
        }
        if (typeof baseUrl !== "string" || !/^https:\/\//i.test(baseUrl)) {
            throw new ToncenterRequestError("seqno provider baseUrl must use HTTPS");
        }
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
            throw new ToncenterRequestError("timeoutMs must be a positive safe integer");
        }
        this._apiKeyProvider = apiKeyProvider;
        this._fetch = fetchImpl;
        this._networkIdentityProvider = networkIdentityProvider;
        this._baseUrl = baseUrl.replace(/\/+$/, "");
        this._timeoutMs = timeoutMs;
    }

    async getWalletSeqno({ walletAddress }) {
        const address = nonEmptyString(walletAddress, "walletAddress");
        const identity = await this._networkIdentityProvider.getNetworkIdentity();
        if (identity?.networkName !== "TESTNET" || identity?.globalId !== -3) {
            throw new ToncenterRequestError("wallet seqno observation requires verified TON Testnet identity");
        }
        const apiKey = this._apiKeyProvider();
        if (typeof apiKey !== "string" || apiKey.trim() === "") {
            throw new ToncenterApiKeyMissingError(TONCENTER_API_KEY_ENV_VAR);
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this._timeoutMs);
        let response;
        try {
            response = await this._fetch(`${this._baseUrl}/api/v2/runGetMethod`, {
                method: "POST",
                headers: {
                    "X-API-Key": apiKey.trim(),
                    "Content-Type": "application/json",
                    Accept: "application/json"
                },
                body: JSON.stringify({ address, method: "seqno", stack: [] }),
                signal: controller.signal
            });
        } catch (error) {
            throw new ToncenterRequestError("Toncenter wallet seqno request failed", {
                failure: controller.signal.aborted ? "timeout" : "network"
            });
        } finally {
            clearTimeout(timer);
        }

        const status = response?.status;
        if (status !== 200) {
            if (status === 401 || status === 403) throw new ToncenterAuthenticationError(status);
            if (status === 429) throw new ToncenterRateLimitError(status);
            if (typeof status === "number" && status >= 500) throw new ToncenterServiceError(status);
            throw new ToncenterRequestError(`Toncenter rejected the wallet seqno request (HTTP ${status})`, {
                statusCode: status
            });
        }

        let payload;
        try {
            payload = await response.json();
        } catch {
            throw new ToncenterResponseError("Toncenter wallet seqno response is not valid JSON");
        }
        return Object.freeze({
            walletAddress: address,
            seqno: parseSeqnoStack(payload),
            networkName: "TESTNET",
            globalId: -3,
            observedAtMs: Date.now(),
            source: "toncenter-testnet-runGetMethod",
            authorization: "OBSERVATION_ONLY"
        });
    }
}
