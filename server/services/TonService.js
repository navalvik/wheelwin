/**
 * T2.2 — Central TON communication layer.
 *
 * Owns a single TonClient + transport instance. Infrastructure only.
 * No business logic, EventBus emissions, signing, or persistence.
 */

import { Address, TonClient } from "@ton/ton";

import { TonCenterTransport } from "../payment/ton/TonCenterTransport.js";
import {
    BroadcastError,
    ConnectionError,
    InvalidResponseError,
    NetworkUnavailableError,
    RPCError,
    TimeoutError,
    TonServiceError,
    TonServiceNotConnectedError,
    TonServiceNotInitializedError,
    UnsupportedNetworkError
} from "./ton/TonServiceErrors.js";
import {
    DEFAULT_TON_RETRY_POLICY,
    executeWithRetry,
    isInfrastructureFailure,
    sleep
} from "./ton/TonServiceRetry.js";

const SUPPORTED_NETWORKS = Object.freeze(["mainnet", "testnet"]);

const DEFAULT_ENDPOINTS = Object.freeze({
    mainnet: "https://toncenter.com/api/v2/jsonRPC",
    testnet: "https://testnet.toncenter.com/api/v2/jsonRPC"
});

const CLIENT_VERSION = "ton-client@16";

function normalizeNetwork(network) {

    return String(network ?? "").trim().toLowerCase();

}

function resolveEndpoint(network, endpoint = null) {

    if (typeof endpoint === "string" && endpoint.trim()) {

        return endpoint.trim();

    }

    const normalized = normalizeNetwork(network);

    if (DEFAULT_ENDPOINTS[normalized]) {

        return DEFAULT_ENDPOINTS[normalized];

    }

    throw new UnsupportedNetworkError(network);

}

function assertSupportedNetwork(network) {

    const normalized = normalizeNetwork(network);

    if (!SUPPORTED_NETWORKS.includes(normalized)) {

        throw new UnsupportedNetworkError(network);

    }

    return normalized;

}

function toFriendlyAddress(address) {

    if (typeof address === "string") {

        return address.trim();

    }

    if (address && typeof address.toString === "function") {

        return address.toString({
            bounceable: true,
            urlSafe: true
        });

    }

    throw new InvalidResponseError("Invalid TON address");

}

export class TonService {

    constructor({
        logger = null,
        tonConfig,
        retryPolicy = null,
        transport = null,
        client = null,
        now = () => Date.now()
    } = {}) {

        if (!tonConfig) {

            throw new Error("TonService requires tonConfig");

        }

        this._logger = logger;

        this._baseConfig = Object.freeze({ ...tonConfig });

        this._activeConfig = { ...tonConfig };

        this._retryPolicy = {
            ...DEFAULT_TON_RETRY_POLICY,
            ...(retryPolicy ?? {})
        };

        this._transportOverride = transport;

        this._clientOverride = client;

        this._transport = null;

        this._client = null;

        this._initialized = false;

        this._connected = false;

        this._connectedAt = null;

        this._operationLock = Promise.resolve();

        this._now = now;

        this._health = {
            lastSuccessfulRPC: null,
            lastFailure: null,
            lastLatencyMs: null
        };

    }

    initialize() {

        if (this._initialized) {

            return;

        }

        this._initialized = true;

        this._createClients();

        this._connected = true;

        this._connectedAt = this._now();

        void this._probeConnection().catch((error) => {

            this._recordFailure("probe:getMasterchainInfo", error);

            this._logError(
                `TonService warmup probe failed | message=${error?.message ?? error}`
            );

        });

        this._logInfo(
            `TonService initialized | network=${this.getActiveNetwork()} | `
                + `endpoint=${this._activeConfig.endpoint}`
        );

    }

    async shutdown() {

        await this.disconnect();

        this._initialized = false;

    }

    async connect() {

        return this._withLock(async () => {

            if (!this._initialized) {

                this._initialized = true;

            }

            if (this._connected) {

                return true;

            }

            this._createClients();

            try {

                await this._probeConnection();

                this._connected = true;

                this._connectedAt = this._now();

            } catch (error) {

                this._destroyClients();

                throw error;

            }

            this._logInfo(
                `TonService connected | network=${this.getActiveNetwork()} | `
                    + `endpoint=${this._activeConfig.endpoint}`
            );

            return true;

        });

    }

    async disconnect() {

        return this._withLock(async () => {

            this._destroyClients();

            this._connected = false;

            this._connectedAt = null;

            return true;

        });

    }

    async reconnect() {

        await this.disconnect();

        return this.connect();

    }

    async switchNetwork({
        network,
        endpoint = null,
        apiKey = null
    } = {}) {

        if (!network) {

            throw new UnsupportedNetworkError(network);

        }

        const normalized = assertSupportedNetwork(network);

        return this._withLock(async () => {

            this._destroyClients();

            this._connected = false;

            this._connectedAt = null;

            this._activeConfig = {
                ...this._activeConfig,
                network: normalized,
                endpoint: resolveEndpoint(normalized, endpoint),
                apiKey: apiKey ?? this._activeConfig.apiKey ?? null
            };

            this._createClients();

            try {

                await this._probeConnection();

                this._connected = true;

                this._connectedAt = this._now();

            } catch (error) {

                this._destroyClients();

                throw error;

            }

            this._logInfo(
                `TonService switched network | network=${normalized} | `
                    + `endpoint=${this._activeConfig.endpoint}`
            );

            return this.getActiveNetwork();

        });

    }

    getConfig() {

        return Object.freeze({ ...this._activeConfig });

    }

    getActiveNetwork() {

        return normalizeNetwork(this._activeConfig.network);

    }

    getTransport() {

        this._assertConnected();

        return this._transport;

    }

    getClient() {

        this._assertConnected();

        return this._client;

    }

    isConnected() {

        return this._initialized && this._connected && this._client != null;

    }

    health() {

        const now = this._now();

        return Object.freeze({
            connected: this.isConnected(),
            network: this.getActiveNetwork(),
            endpoint: this._activeConfig.endpoint,
            latency: this._health.lastLatencyMs,
            lastSuccessfulRPC: this._health.lastSuccessfulRPC,
            lastFailure: this._health.lastFailure
                ? Object.freeze({ ...this._health.lastFailure })
                : null,
            clientVersion: CLIENT_VERSION,
            uptime: this._connectedAt ? Math.max(0, now - this._connectedAt) : 0
        });

    }

    async rpcCall(method, params = {}, options = {}) {

        return this._executeRpc(
            () => this._transport.call(method, params),
            { operation: `rpc:${method}`, ...options }
        );

    }

    async broadcastTransaction(bocBase64, options = {}) {

        if (typeof bocBase64 !== "string" || !bocBase64.trim()) {

            throw new BroadcastError("broadcastTransaction requires bocBase64");

        }

        try {

            return await this._executeRpc(
                () => this._transport.sendBoc(bocBase64.trim()),
                {
                    operation: "broadcastTransaction",
                    retryPolicy: {
                        ...this._retryPolicy,
                        ...(options.retryPolicy ?? {})
                    },
                    signal: options.signal ?? null,
                    shouldRetry: isInfrastructureFailure
                }
            );

        } catch (error) {

            if (error instanceof TonServiceError) {

                throw error;

            }

            throw new BroadcastError(
                error?.message ?? "TON broadcast failed",
                { cause: error?.code ?? error?.name ?? null }
            );

        }

    }

    async runGetMethod(address, method, stack = [], options = {}) {

        const friendly = toFriendlyAddress(address);

        return this._executeRpc(
            () => this._client.runMethod(
                Address.parse(friendly),
                method,
                stack
            ),
            { operation: `runGetMethod:${method}`, ...options }
        );

    }

    async getAccount(address, options = {}) {

        const friendly = toFriendlyAddress(address);

        const result = await this._executeRpc(
            () => this._transport.getAddressInformation(friendly),
            { operation: "getAccount", ...options }
        );

        if (!result || typeof result !== "object") {

            throw new InvalidResponseError("getAccount returned invalid payload");

        }

        return Object.freeze({ ...result });

    }

    async getBalance(address, options = {}) {

        const friendly = toFriendlyAddress(address);

        const result = await this._executeRpc(
            () => this._client.getBalance(Address.parse(friendly)),
            { operation: "getBalance", ...options }
        );

        if (typeof result !== "bigint") {

            throw new InvalidResponseError("getBalance returned invalid payload");

        }

        return result;

    }

    async getSeqno(walletAddress, options = {}) {

        const result = await this.runGetMethod(
            walletAddress,
            "seqno",
            [],
            options
        );

        const stackItem = result?.stack?.[0];

        const value = stackItem?.value ?? stackItem;

        if (typeof value === "number") {

            return value;

        }

        if (typeof value === "bigint") {

            return Number(value);

        }

        throw new InvalidResponseError("getSeqno returned invalid stack value");

    }

    async getTransactions(address, query = {}, options = {}) {

        const friendly = toFriendlyAddress(address);

        const result = await this._executeRpc(
            () => this._transport.getTransactions(friendly, query),
            { operation: "getTransactions", ...options }
        );

        if (!Array.isArray(result)) {

            throw new InvalidResponseError("getTransactions returned invalid payload");

        }

        return Object.freeze([...result]);

    }

    async waitForTransaction({
        address,
        hash = null,
        timeoutMs = 60_000,
        pollIntervalMs = 2_000,
        signal = null
    } = {}) {

        const friendly = toFriendlyAddress(address);

        const deadline = this._now() + Math.max(1, Number(timeoutMs) || 60_000);

        const interval = Math.max(200, Number(pollIntervalMs) || 2_000);

        while (this._now() < deadline) {

            if (signal?.aborted) {

                throw new TimeoutError("waitForTransaction cancelled");

            }

            const transactions = await this.getTransactions(
                friendly,
                { limit: 20, archival: true },
                { signal }
            );

            if (hash) {

                const normalizedHash = String(hash).toLowerCase();

                const match = transactions.find((tx) => {
                    const txHash = String(
                        tx?.transaction_id?.hash
                        ?? tx?.hash
                        ?? ""
                    ).toLowerCase();

                    return txHash === normalizedHash;

                });

                if (match) {

                    return Object.freeze({ ...match });

                }

            } else if (transactions.length > 0) {

                return Object.freeze({ ...transactions[0] });

            }

            await sleep(interval, signal);

        }

        throw new TimeoutError("waitForTransaction timed out", {
            address: friendly,
            hash
        });

    }

    // -------------------------------------------------------------------------
    // Internal
    // -------------------------------------------------------------------------

    _createClients() {

        if (this._transportOverride) {

            this._transport = this._transportOverride;

        } else {

            this._transport = new TonCenterTransport({
                endpoint: this._activeConfig.endpoint,
                apiKey: this._activeConfig.apiKey
            });

        }

        if (this._clientOverride) {

            this._client = this._clientOverride;

            return;

        }

        this._client = new TonClient({
            endpoint: this._activeConfig.endpoint,
            apiKey: this._activeConfig.apiKey || undefined
        });

    }

    _destroyClients() {

        this._transport = null;

        this._client = null;

    }

    async _probeConnection() {

        await this._executeRpc(
            () => this._client.getMasterchainInfo(),
            {
                operation: "probe:getMasterchainInfo",
                retryPolicy: this._retryPolicy,
                requireConnected: false
            }
        );

    }

    async _executeRpc(rpcOperation, {
        operation = "rpc",
        retryPolicy = null,
        signal = null,
        shouldRetry = isInfrastructureFailure,
        requireConnected = true
    } = {}) {

        if (requireConnected) {

            this._assertConnected();

        } else {

            this._assertClientsPresent();

        }

        const started = this._now();

        try {

            const result = await executeWithRetry({
                operation: rpcOperation,
                retryPolicy: {
                    ...this._retryPolicy,
                    ...(retryPolicy ?? {})
                },
                signal,
                shouldRetry
            });

            const latencyMs = this._now() - started;

            this._health.lastLatencyMs = latencyMs;

            this._health.lastSuccessfulRPC = this._now();

            this._health.lastFailure = null;

            return result;

        } catch (error) {

            this._recordFailure(operation, error);

            if (
                isInfrastructureFailure(error)
                && !(error instanceof RPCError)
            ) {

                this._logError(
                    `TonService RPC failed | operation=${operation} | `
                        + `message=${this._health.lastFailure.message}`
                );

            }

            throw this._normalizeRpcError(error, operation);

        }

    }

    _recordFailure(operation, error) {

        this._health.lastFailure = Object.freeze({
            at: this._now(),
            operation,
            message: error?.message ?? String(error),
            code: error?.code ?? error?.name ?? "TON_ERROR"
        });

    }

    _normalizeRpcError(error, operation) {

        if (error instanceof TimeoutError) {

            return error;

        }

        if (error instanceof RPCError) {

            return error;

        }

        if (error instanceof ConnectionError) {

            return error;

        }

        const message = String(error?.message ?? error);

        if (message.toLowerCase().includes("timed out")) {

            return new TimeoutError(message, { operation });

        }

        if (
            message.includes("TonCenter HTTP 5")
            || message.includes("fetch failed")
            || message.toLowerCase().includes("network")
        ) {

            return new NetworkUnavailableError(message, { operation });

        }

        if (message.includes("TonCenter HTTP")) {

            return new RPCError(message, { operation }, {
                retryable: message.includes("HTTP 429")
            });

        }

        if (message.includes("TonCenter error")) {

            return new RPCError(message, { operation }, { retryable: false });

        }

        return error;

    }

    _withLock(operation) {

        const next = this._operationLock
            .then(() => operation())
            .catch((error) => {

                throw error;

            });

        this._operationLock = next.catch(() => {});

        return next;

    }

    _assertInitialized() {

        if (!this._initialized) {

            throw new TonServiceNotInitializedError();

        }

    }

    _assertClientsPresent() {

        if (!this._client || !this._transport) {

            throw new TonServiceNotConnectedError();

        }

    }

    _assertConnected() {

        this._assertInitialized();

        if (!this._connected || !this._client || !this._transport) {

            throw new TonServiceNotConnectedError();

        }

    }

    _logInfo(message) {

        this._logger?.info?.(message);

    }

    _logError(message) {

        this._logger?.error?.(message);

    }

}

export {
    BroadcastError,
    ConnectionError,
    InvalidResponseError,
    NetworkUnavailableError,
    RPCError,
    TimeoutError,
    TonServiceError,
    TonServiceNotConnectedError,
    TonServiceNotInitializedError,
    UnsupportedNetworkError
} from "./ton/TonServiceErrors.js";

export {
    DEFAULT_TON_RETRY_POLICY,
    executeWithRetry,
    isInfrastructureFailure
} from "./ton/TonServiceRetry.js";
