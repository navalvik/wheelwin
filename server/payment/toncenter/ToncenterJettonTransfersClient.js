/**
 * Read-only Toncenter v3 GRAM Jetton transfer discovery (Testnet only).
 *
 * The /jetton/transfers endpoint is indexed transfer data, NOT finality
 * evidence. Results must NEVER be credited without separate chain-finality
 * verification and an atomic durable transaction-identity claim.
 *
 * No background polling, retries, payment execution or wallet secrets.
 * Source: https://docs.ton.org/ecosystem/api/toncenter/v3/jettons/get-jetton-transfers
 */
import { tonAddressIdentityOrNull } from "../incoming/TonAddressIdentity.js";
import { TONCENTER_TESTNET_BASE_URL } from "./ToncenterConstants.js";
import { defaultApiKeyProvider } from "./ToncenterTransactionsClient.js";

export class ToncenterJettonTransferQueryError extends Error {
    constructor(message) {
        super(message);
        this.name = "ToncenterJettonTransferQueryError";
    }
}

function requireAddress(address, label) {
    if (tonAddressIdentityOrNull(address) === null) {
        throw new ToncenterJettonTransferQueryError(`Invalid ${label} TON address`);
    }
    return address;
}

function requireTimestamp(value, label) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0x7fffffff) {
        throw new ToncenterJettonTransferQueryError(`${label} must be a nonnegative int32 Unix timestamp`);
    }
    return value;
}

export class ToncenterJettonTransfersClient {
    #fetch;
    #apiKeyProvider;
    #baseUrl;
    #timeoutMs;

    constructor({
        baseUrl = TONCENTER_TESTNET_BASE_URL,
        fetchImpl = globalThis.fetch,
        apiKeyProvider = defaultApiKeyProvider,
        timeoutMs = 15000
    } = {}) {
        // Fix the origin rather than accepting a caller-controlled URL.
        // This avoids sending TON_API_KEY to an arbitrary path or hostname.
        if (baseUrl !== TONCENTER_TESTNET_BASE_URL
            || typeof fetchImpl !== "function"
            || typeof apiKeyProvider !== "function"
            || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
            throw new ToncenterJettonTransferQueryError("Only authenticated Testnet Toncenter discovery is supported");
        }
        this.#baseUrl = TONCENTER_TESTNET_BASE_URL;
        this.#fetch = fetchImpl;
        this.#apiKeyProvider = apiKeyProvider;
        this.#timeoutMs = timeoutMs;
    }

    /**
     * One bounded query for incoming transfers into a room wallet.
     * A full page is not proof that every transfer was observed.
     */
    async listIncoming({ roomWallet, jettonMaster, startUtime, endUtime, limit = 50 } = {}) {
        requireAddress(roomWallet, "roomWallet");
        requireAddress(jettonMaster, "jettonMaster");
        requireTimestamp(startUtime, "startUtime");
        requireTimestamp(endUtime, "endUtime");
        if (endUtime < startUtime || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
            throw new ToncenterJettonTransferQueryError("Invalid transfer query range or limit");
        }

        const key = this.#apiKeyProvider();
        if (typeof key !== "string" || !key.trim()) {
            throw new ToncenterJettonTransferQueryError("TON_API_KEY required; no unauthenticated request attempted");
        }
        const url = new URL(`${this.#baseUrl}/api/v3/jetton/transfers`);
        url.searchParams.set("owner_address", roomWallet);
        url.searchParams.set("direction", "in");
        url.searchParams.set("jetton_master", jettonMaster);
        url.searchParams.set("start_utime", String(startUtime));
        url.searchParams.set("end_utime", String(endUtime));
        url.searchParams.set("sort", "desc");
        url.searchParams.set("limit", String(limit));
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
        let response;
        try {
            response = await this.#fetch(url.toString(), {
                method: "GET",
                headers: { "X-API-Key": key.trim() },
                signal: controller.signal
            });
        } catch {
            throw new ToncenterJettonTransferQueryError("Toncenter Jetton transfer query failed or timed out");
        } finally {
            clearTimeout(timeout);
        }
        if (response?.status !== 200) {
            throw new ToncenterJettonTransferQueryError(`Toncenter Jetton transfer request rejected (HTTP ${response?.status})`);
        }
        let payload;
        try {
            payload = await response.json();
        } catch {
            throw new ToncenterJettonTransferQueryError("Toncenter returned invalid JSON");
        }
        if (!payload || !Array.isArray(payload.jetton_transfers)
            || payload.jetton_transfers.length > limit) {
            throw new ToncenterJettonTransferQueryError("Malformed or overflowing Jetton transfers response");
        }
        // The indexer filters are not trusted: preserve raw records so that a
        // separate mapper can validate each sender, recipient, master, amount.
        return Object.freeze({
            transfers: Object.freeze([...payload.jetton_transfers]),
            truncated: payload.jetton_transfers.length === limit,
            finalized: false,
            verifiedForSettlement: false
        });
    }
}
