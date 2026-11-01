import { MAINNET_GLOBAL_ID } from "../config/MainnetRuntimeConfig.js";
import { mainnetAddressIdentity } from "./MainnetAddress.js";

const MAINNET_TONAPI_BASE = "https://tonapi.io";
function validHash(hash) {
    return typeof hash === "string" && (/^[a-fA-F0-9]{64}$/.test(hash) || /^[A-Za-z0-9_+/-]{43}=?$/.test(hash));
}
function equalHash(a, b) {
    if (!validHash(a) || !validHash(b)) return false;
    const decode = (v) => /^[a-fA-F0-9]{64}$/.test(v)
        ? Buffer.from(v, "hex") : Buffer.from(v.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    return decode(a).equals(decode(b));
}
function amount(value) {
    if (Number.isSafeInteger(value) && value >= 0) return value;
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
    const parsed = BigInt(value);
    return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : null;
}
function address(value) { return typeof value === "string" ? value : value?.address; }
function successful(tx, hash, identity) {
    try { return tx && equalHash(tx.hash, hash) && mainnetAddressIdentity(address(tx.account)) === mainnetAddressIdentity(identity)
        && tx.success === true && tx.aborted === false; }
    catch { return false; }
}

/** Read-only independent Mainnet counterpart to TonapiTestnetPayoutVerifier. */
export class MainnetTonapiPayoutVerifier {
    constructor({ fetchImpl = globalThis.fetch, apiKeyProvider = () => "", timeoutMs = 7_000 } = {}) {
        if (typeof fetchImpl !== "function" || typeof apiKeyProvider !== "function"
            || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
            throw new TypeError("MAINNET_TONAPI_VERIFIER_CONFIG_INVALID");
        }
        this._fetch = fetchImpl;
        this._apiKey = apiKeyProvider;
        this._timeout = timeoutMs;
    }

    async _transaction(hash) {
        if (!validHash(hash)) return null;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this._timeout);
        try {
            const token = this._apiKey();
            const headers = { Accept: "application/json" };
            if (typeof token === "string" && token.trim()) headers.Authorization = `Bearer ${token.trim()}`;
            const url = `${MAINNET_TONAPI_BASE}/v2/blockchain/transactions/${encodeURIComponent(hash)}`;
            const response = await this._fetch(url, { method: "GET", headers, signal: controller.signal });
            if (response?.status !== 200) return null;
            const data = await response.json();
            return data && !Array.isArray(data) && typeof data === "object" ? data : null;
        } catch { return null; }
        finally { clearTimeout(timeout); }
    }

    async verifyTransfer({ sourceTransactionId, recipientTransactionId, messageHash,
        sourceWalletAddress, destinationAddress, amountAtomic } = {}) {
        if (!validHash(sourceTransactionId) || !validHash(recipientTransactionId) || !validHash(messageHash)
            || sourceTransactionId === recipientTransactionId || !Number.isSafeInteger(amountAtomic) || amountAtomic <= 0) return null;
        const [source, recipient] = await Promise.all([
            this._transaction(sourceTransactionId), this._transaction(recipientTransactionId)
        ]);
        if (!successful(source, sourceTransactionId, sourceWalletAddress)
            || !successful(recipient, recipientTransactionId, destinationAddress)
            || !Array.isArray(source.out_msgs) || source.out_msgs.length !== 1) return null;
        const outgoing = source.out_msgs[0], incoming = recipient.in_msg;
        try {
            if (!incoming || !equalHash(outgoing.hash, messageHash) || !equalHash(incoming.hash, messageHash)
                || mainnetAddressIdentity(address(outgoing.source)) !== mainnetAddressIdentity(sourceWalletAddress)
                || mainnetAddressIdentity(address(outgoing.destination)) !== mainnetAddressIdentity(destinationAddress)
                || mainnetAddressIdentity(address(incoming.source)) !== mainnetAddressIdentity(sourceWalletAddress)
                || mainnetAddressIdentity(address(incoming.destination)) !== mainnetAddressIdentity(destinationAddress)
                || amount(outgoing.value) !== amountAtomic || amount(incoming.value) !== amountAtomic
                || outgoing.bounced === true || incoming.bounced === true) return null;
        } catch { return null; }
        const actualFeeAtomic = amount(source.total_fees);
        if (actualFeeAtomic === null) return null;
        return Object.freeze({ status: "INDEPENDENT_INDEXED_CREDIT_OBSERVED",
            sourceTransactionId, recipientTransactionId, messageHash,
            sourceWalletAddress, destinationAddress, amountAtomic, actualFeeAtomic,
            provider: "tonapi-mainnet", network: "mainnet", globalId: MAINNET_GLOBAL_ID });
    }
}
