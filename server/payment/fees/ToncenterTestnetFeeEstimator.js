/**
 * Concrete TON Center Testnet fee estimator for already-prepared outgoing
 * wallet messages. This estimates only: it never signs or broadcasts.
 *
 * The caller must provide the serialized message body that corresponds to the
 * exact transfer being prepared. No generic/hard-coded fee is substituted.
 * The endpoint is fixed to TON Center Testnet and every request is bounded to
 * one HTTP call (no retry/polling).
 */
import { randomUUID } from "node:crypto";
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

const ESTIMATE_FEE_PATH = "/api/v3/estimateFee";
const FEE_COMPONENTS = Object.freeze(["fwd_fee", "gas_fee", "in_fwd_fee", "storage_fee"]);

function nonEmpty(value, field) {
    if (typeof value !== "string" || value.trim() === "") {
        throw new ToncenterRequestError(`${field} must be a non-empty string`, { field });
    }
    return value.trim();
}

function atomicFee(value, field) {
    const normalized = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
    if (!Number.isSafeInteger(normalized) || normalized < 0) {
        throw new ToncenterResponseError(`Toncenter returned invalid ${field}`);
    }
    return normalized;
}

function sumFeeObject(value, field) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new ToncenterResponseError(`Toncenter response is missing ${field}`);
    }
    return FEE_COMPONENTS.reduce((sum, key) => {
        const component = atomicFee(value[key], `${field}.${key}`);
        const next = sum + component;
        if (!Number.isSafeInteger(next)) {
            throw new ToncenterResponseError("Toncenter fee estimate exceeds safe integer range");
        }
        return next;
    }, 0);
}

function sumFeeResponse(body) {
    const sourceFeeAtomic = sumFeeObject(body.source_fees, "source_fees");
    if (!Array.isArray(body.destination_fees) || body.destination_fees.length === 0) {
        throw new ToncenterResponseError("Toncenter response is missing destination_fees");
    }
    const destinationFeeAtomic = body.destination_fees.reduce((sum, item, index) => {
        const next = sum + sumFeeObject(item, `destination_fees[${index}]`);
        if (!Number.isSafeInteger(next)) {
            throw new ToncenterResponseError("Toncenter fee estimate exceeds safe integer range");
        }
        return next;
    }, 0);
    const feeAtomic = sourceFeeAtomic + destinationFeeAtomic;
    if (!Number.isSafeInteger(feeAtomic)) {
        throw new ToncenterResponseError("Toncenter total fee estimate exceeds safe integer range");
    }
    return { feeAtomic, sourceFeeAtomic, destinationFeeAtomic };
}

export class ToncenterTestnetFeeEstimator {
    constructor({
        apiKeyProvider = () => {
            const value = process.env[TONCENTER_API_KEY_ENV_VAR];
            return typeof value === "string" ? value.trim() : "";
        },
        networkIdentityProvider,
        fetchImpl = globalThis.fetch,
        baseUrl = TONCENTER_TESTNET_BASE_URL,
        timeoutMs = TONCENTER_DEFAULT_TIMEOUT_MS,
        now = () => Date.now(),
        idFactory = randomUUID
    } = {}) {
        if (typeof apiKeyProvider !== "function" || typeof fetchImpl !== "function"
            || typeof networkIdentityProvider?.getNetworkIdentity !== "function"
            || typeof now !== "function" || typeof idFactory !== "function") {
            throw new ToncenterRequestError("fee estimator requires API-key, network identity, fetch, clock, and ID providers");
        }
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
            throw new ToncenterRequestError("timeoutMs must be a positive safe integer");
        }
        if (baseUrl !== TONCENTER_TESTNET_BASE_URL) {
            throw new ToncenterRequestError("fee estimator base URL is fixed to TON Center Testnet");
        }
        this._apiKeyProvider = apiKeyProvider;
        this._networkIdentityProvider = networkIdentityProvider;
        this._fetch = fetchImpl;
        this._timeoutMs = timeoutMs;
        this._now = now;
        this._idFactory = idFactory;
    }

    async estimateOutgoingFee({ operationId, sourceWalletAddress, destination, amountAtomic, purpose, body }) {
        nonEmpty(operationId, "operationId");
        const address = nonEmpty(sourceWalletAddress, "sourceWalletAddress");
        const normalizedDestination = nonEmpty(destination, "destination");
        nonEmpty(purpose, "purpose");
        const bocBody = nonEmpty(body, "body");
        if (!Number.isSafeInteger(amountAtomic) || amountAtomic <= 0) {
            throw new ToncenterRequestError("amountAtomic must be a positive safe integer");
        }
        // The caller's configured endpoint alone is not proof of network
        // identity; verify the Testnet global ID from the server-side provider.
        const identity = await this._networkIdentityProvider.getNetworkIdentity();
        if (identity?.networkName !== "TESTNET" || identity?.globalId !== -3) {
            throw new ToncenterRequestError("Toncenter fee estimate blocked: network identity is not verified Testnet");
        }
        const apiKey = this._apiKeyProvider();
        if (typeof apiKey !== "string" || apiKey.trim() === "") {
            throw new ToncenterApiKeyMissingError(TONCENTER_API_KEY_ENV_VAR);
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this._timeoutMs);
        let response;
        try {
            response = await this._fetch(`${TONCENTER_TESTNET_BASE_URL}${ESTIMATE_FEE_PATH}`, {
                method: "POST",
                headers: {
                    "X-API-Key": apiKey.trim(),
                    "Content-Type": "application/json",
                    Accept: "application/json"
                },
                body: JSON.stringify({
                    address,
                    body: bocBody,
                    ignore_chksig: false
                }),
                signal: controller.signal
            });
        } catch {
            throw new ToncenterRequestError("Toncenter fee-estimate request failed", {
                failure: controller.signal.aborted ? "timeout" : "network"
            });
        } finally {
            clearTimeout(timer);
        }

        if (response?.status !== 200) {
            const status = response?.status;
            if (status === 401 || status === 403) throw new ToncenterAuthenticationError(status);
            if (status === 429) throw new ToncenterRateLimitError(status);
            if (typeof status === "number" && status >= 500) throw new ToncenterServiceError(status);
            throw new ToncenterRequestError(`Toncenter rejected fee estimate (HTTP ${status})`, { statusCode: status });
        }

        let result;
        try {
            result = await response.json();
        } catch {
            throw new ToncenterResponseError("Toncenter fee-estimate response is not valid JSON");
        }
        if (!result || typeof result !== "object" || Array.isArray(result)
            || result.error || result.code) {
            throw new ToncenterResponseError("Toncenter fee-estimate response contains an error or invalid envelope");
        }
        const totals = sumFeeResponse(result);
        return Object.freeze({
            networkName: "TESTNET",
            globalId: -3,
            operationId,
            estimateId: nonEmpty(this._idFactory(), "estimateId"),
            sourceWalletAddress: address,
            destination: normalizedDestination,
            amountAtomic,
            purpose,
            source: "TONCENTER_FEE_ESTIMATE",
            quotedAtMs: this._now(),
            ...totals
        });
    }
}
