import { MAINNET_GLOBAL_ID, MAINNET_TONCENTER_BASE_URL } from "../config/MainnetRuntimeConfig.js";
import { mapMainnetTransactionsResponse } from "./MainnetTransactionsMapper.js";

const TRANSACTIONS_PATH = "/api/v3/transactions";
const MASTERCHAIN_PATH = "/api/v3/masterchainInfo";
const MAX_LIMIT = 1000;

export class MainnetToncenterError extends Error {
    constructor(code, statusCode = null) {
        super(code);
        this.name = "MainnetToncenterError";
        this.code = code;
        this.statusCode = statusCode;
    }
}

/** Fixed-endpoint, Mainnet-only Toncenter transport. Its public surface is GET-only. */
export class MainnetToncenterReadClient {
    constructor({ config, fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
        if (config?.network !== "mainnet" || config?.globalId !== MAINNET_GLOBAL_ID
            || config?.toncenterBaseUrl !== MAINNET_TONCENTER_BASE_URL
            || typeof config.apiKeyProvider !== "function") {
            throw new MainnetToncenterError("MAINNET_TONCENTER_CONFIG_REQUIRED");
        }
        if (typeof fetchImpl !== "function" || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
            throw new MainnetToncenterError("MAINNET_TONCENTER_CLIENT_CONFIG_INVALID");
        }
        this._config = config;
        this._fetch = fetchImpl;
        this._timeoutMs = timeoutMs;
    }

    get network() { return "mainnet"; }
    get globalId() { return MAINNET_GLOBAL_ID; }
    get baseUrl() { return MAINNET_TONCENTER_BASE_URL; }

    async listIncomingTransactions({ account, floorMs, ceilingMs, limit = 100 } = {}) {
        if (typeof account !== "string" || !account.trim()
            || !Number.isSafeInteger(floorMs) || floorMs <= 0
            || !Number.isSafeInteger(ceilingMs) || ceilingMs < floorMs
            || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
            throw new MainnetToncenterError("MAINNET_TRANSACTION_QUERY_INVALID");
        }
        const url = new URL(TRANSACTIONS_PATH, MAINNET_TONCENTER_BASE_URL);
        url.searchParams.set("account", account.trim());
        url.searchParams.set("start_utime", String(Math.floor(floorMs / 1000)));
        url.searchParams.set("end_utime", String(Math.ceil(ceilingMs / 1000)));
        url.searchParams.set("limit", String(limit));
        url.searchParams.set("sort", "desc");
        const payload = await this._getJson(url);
        return mapMainnetTransactionsResponse(payload, {
            account: account.trim(), floorMs, ceilingMs, limit
        });
    }

    /** Bounded raw indexed history page, used only by Mainnet read-only reconciliation. */
    async getTransactions({ account, startUtime, endUtime, limit = 1000, offset = 0 } = {}) {
        if (typeof account !== "string" || !account.trim()
            || !Number.isSafeInteger(startUtime) || startUtime < 0
            || !Number.isSafeInteger(endUtime) || endUtime < startUtime
            || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT
            || !Number.isSafeInteger(offset) || offset < 0) {
            throw new MainnetToncenterError("MAINNET_TRANSACTION_QUERY_INVALID");
        }
        const url = new URL(TRANSACTIONS_PATH, MAINNET_TONCENTER_BASE_URL);
        url.searchParams.set("account", account.trim());
        url.searchParams.set("start_utime", String(startUtime));
        url.searchParams.set("end_utime", String(endUtime));
        url.searchParams.set("limit", String(limit));
        url.searchParams.set("offset", String(offset));
        url.searchParams.set("sort", "desc");
        const payload = await this._getJson(url);
        if (!Array.isArray(payload.transactions)) {
            throw new MainnetToncenterError("MAINNET_TONCENTER_TRANSACTIONS_ENVELOPE_INVALID");
        }
        return payload;
    }

    async getMasterchainInfo() {
        return this._getJson(new URL(MASTERCHAIN_PATH, MAINNET_TONCENTER_BASE_URL));
    }

    /** Read-only active-account lookup used by the existing NO_FRIENDS wallet precheck. */
    async getAddressInformation(address) {
        if (typeof address !== "string" || !address.trim()) {
            throw new MainnetToncenterError("MAINNET_ACCOUNT_QUERY_INVALID");
        }
        const url = new URL("/api/v2/getAddressInformation", MAINNET_TONCENTER_BASE_URL);
        url.searchParams.set("address", address.trim());
        return this._getJson(url);
    }

    async _getJson(url) {
        const apiKey = this._config.apiKeyProvider();
        if (typeof apiKey !== "string" || !apiKey.trim()) {
            throw new MainnetToncenterError("MAINNET_TONCENTER_API_KEY_REQUIRED");
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this._timeoutMs);
        let response;
        try {
            response = await this._fetch(url, {
                method: "GET",
                headers: { "X-API-Key": apiKey.trim(), Accept: "application/json" },
                signal: controller.signal
            });
        } catch {
            throw new MainnetToncenterError(
                controller.signal.aborted ? "MAINNET_TONCENTER_TIMEOUT" : "MAINNET_TONCENTER_NETWORK_ERROR"
            );
        } finally {
            clearTimeout(timer);
        }
        if (response?.status !== 200) {
            const status = Number.isInteger(response?.status) ? response.status : null;
            throw new MainnetToncenterError(
                status === 401 || status === 403 ? "MAINNET_TONCENTER_AUTH_ERROR"
                    : status === 429 ? "MAINNET_TONCENTER_RATE_LIMITED"
                        : status !== null && status >= 500 ? "MAINNET_TONCENTER_SERVICE_ERROR"
                            : "MAINNET_TONCENTER_HTTP_ERROR",
                status
            );
        }
        try {
            const payload = await response.json();
            if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("shape");
            return payload;
        } catch {
            throw new MainnetToncenterError("MAINNET_TONCENTER_RESPONSE_INVALID");
        }
    }
}
