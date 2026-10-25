/**
 * Independent source-head check for safe Room Wallet reallocation.
 *
 * Unlike scanning backwards to a session start, this also verifies that BOTH
 * indexers expose the same latest account transaction at the time of release.
 * Errors, unsupported API versions or lagged indexers fail closed.
 *
 * This does not sign, send or reallocate anything.
 */
import { Address } from "@ton/core";
import {
    normalizeTonTransactionHash,
    RoomWalletEvidenceUnavailable
} from "./RoomWalletDualSourceEvidence.js";

const PROVIDERS = [
    ["tonapi", "https://testnet.tonapi.io/v2/blockchain/accounts/"],
    ["toncenter-v3", "https://testnet.toncenter.com/api/v3/accountStates?address="]
];

function parseTip(response, provider, account) {
    const candidate = provider === "tonapi"
        ? response
        : response?.accounts?.find(item => {
            try { return Address.parse(item.address).toRawString().toLowerCase() === account; }
            catch { return false; }
        });
    if (!candidate || (provider === "toncenter-v3" && !Array.isArray(response.accounts))) {
        throw new RoomWalletEvidenceUnavailable("WALLET_HEAD_ACCOUNT_NOT_FOUND");
    }
    const rawLt = candidate.last_transaction_lt
        ?? candidate.lastTransactionLt
        ?? candidate.last_transaction?.lt;
    const hash = normalizeTonTransactionHash(
        candidate.last_transaction_hash
        ?? candidate.lastTransactionHash
        ?? candidate.last_transaction?.hash
    );
    if (!/^[1-9]\d*$/.test(String(rawLt ?? "")) || hash === null) {
        throw new RoomWalletEvidenceUnavailable("WALLET_HEAD_FIELDS_UNAVAILABLE");
    }
    return Object.freeze({ lt: BigInt(rawLt).toString(), hash });
}

export async function fetchDualSourceRoomWalletTip({
    roomWallet,
    requestBudget = null,
    fetchImpl = globalThis.fetch,
    timeoutMs = 10_000
} = {}) {
    let account;
    try {
        account = Address.parse(roomWallet).toRawString().toLowerCase();
        if (!account.startsWith("0:")) throw new Error("wrong workchain");
    } catch {
        throw new RoomWalletEvidenceUnavailable("WALLET_HEAD_IDENTITY_INVALID");
    }
    if (typeof fetchImpl !== "function"
        || !Number.isInteger(timeoutMs) || timeoutMs < 100
        || (requestBudget !== null && typeof requestBudget?.schedule !== "function")) {
        throw new RoomWalletEvidenceUnavailable("WALLET_HEAD_REQUEST_INVALID");
    }
    const results = await Promise.all(PROVIDERS.map(async ([provider, endpoint]) => {
        const fn = async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const response = await fetchImpl(
                    endpoint + encodeURIComponent(account),
                    { method: "GET", headers: { Accept: "application/json" },
                        signal: controller.signal }
                );
                if (!response?.ok) {
                    throw new RoomWalletEvidenceUnavailable(
                        "WALLET_HEAD_HTTP_FAILURE", String(response?.status ?? "unknown")
                    );
                }
                return parseTip(await response.json(), provider, account);
            } catch (error) {
                if (error instanceof RoomWalletEvidenceUnavailable) throw error;
                throw new RoomWalletEvidenceUnavailable(
                    "WALLET_HEAD_PROVIDER_UNAVAILABLE", error?.name ?? "unknown"
                );
            } finally {
                clearTimeout(timer);
            }
        };
        return requestBudget ? requestBudget.schedule(provider, fn) : fn();
    }));
    if (results[0].lt !== results[1].lt
        || results[0].hash !== results[1].hash) {
        throw new RoomWalletEvidenceUnavailable("WALLET_HEAD_PROVIDERS_DISAGREE");
    }
    return Object.freeze({
        roomWallet: account,
        headLt: results[0].lt,
        headHash: results[0].hash,
        providersAgree: true
    });
}
