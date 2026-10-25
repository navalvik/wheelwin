/**
 * Read-only historical scanner for expired Testnet Room Wallet payment sessions.
 *
 * Unlike live RoomWalletIncomingObserver, this scanner never depends on an
 * active room or session. It reads transaction history backwards to the
 * session start. Missing/truncated history is an error, never "no deposits".
 *
 * TonAPI cursor before_lt is exclusive; TonCenter v3 end_lt is inclusive.
 * The scanner cannot sign, send GRAM, or release a wallet quarantine.
 */
import { Address } from "@ton/core";
import {
    RoomWalletEvidenceUnavailable,
    normalizeTonTransactionHash,
    reconcileDualSourceTransactions
} from "./RoomWalletDualSourceEvidence.js";

const TONAPI = "https://testnet.tonapi.io";
const TONCENTER_V3 = "https://testnet.toncenter.com/api/v3";

function uintLt(value) {
    if ((typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint")
        || !/^\d+$/.test(String(value))) {
        throw new RoomWalletEvidenceUnavailable("HISTORY_LT_INVALID");
    }
    const lt = BigInt(value);
    if (lt < 1n) throw new RoomWalletEvidenceUnavailable("HISTORY_LT_INVALID");
    return lt;
}

function transactionUtime(tx) {
    const time = Number(tx.utime ?? tx.now);
    if (!Number.isSafeInteger(time) || time <= 0) {
        throw new RoomWalletEvidenceUnavailable("HISTORY_TIMESTAMP_INVALID");
    }
    return time;
}

function validatePage(transactions, { cursor, seen, pageSize }) {
    if (!Array.isArray(transactions) || transactions.length > pageSize) {
        throw new RoomWalletEvidenceUnavailable("HISTORY_RESPONSE_INVALID");
    }
    let previous = cursor ?? null;
    let oldestLt = null;
    let oldestUtime = null;
    for (const tx of transactions) {
        const lt = uintLt(tx?.lt ?? tx?.transaction_id?.lt);
        const hash = normalizeTonTransactionHash(tx?.hash ?? tx?.transaction_id?.hash);
        const time = transactionUtime(tx);
        if (!hash || (previous !== null && lt >= previous)) {
            throw new RoomWalletEvidenceUnavailable("HISTORY_ORDER_OR_HASH_INVALID");
        }
        if (seen.has(lt.toString())) {
            throw new RoomWalletEvidenceUnavailable("HISTORY_REPEAT_LT");
        }
        seen.add(lt.toString());
        previous = oldestLt = lt;
        oldestUtime = time;
    }
    return {
        oldestLt,
        oldestUtime,
        exhausted: transactions.length < pageSize
    };
}

async function readJson(fetchImpl, url, timeoutMs, requestBudget, provider) {
    const doRead = async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetchImpl(url, {
                method: "GET",
                headers: { Accept: "application/json" },
                signal: controller.signal
            });
            if (!response?.ok) {
                throw new RoomWalletEvidenceUnavailable(
                    "HISTORY_PROVIDER_HTTP_FAILURE", String(response?.status ?? "unknown")
                );
            }
            return await response.json();
        } catch (error) {
            if (error instanceof RoomWalletEvidenceUnavailable) throw error;
            throw new RoomWalletEvidenceUnavailable(
                "HISTORY_PROVIDER_UNAVAILABLE", error?.name ?? ""
            );
        } finally {
            clearTimeout(timer);
        }
    };
    return requestBudget ? requestBudget.schedule(provider, doRead) : doRead();
}

/**
 * Complete history means both providers reached the session start, NOT proof
 * that indexers caught up to current chain head. It never authorizes release.
 */
export async function fetchExpiredRoomWalletHistory({
    address,
    sessionStartMs,
    startMarginMs = 15_000,
    fetchImpl = globalThis.fetch,
    requestBudget = null,
    pageSize = 50,
    maxPagesPerProvider = 12,
    timeoutMs = 10_000
} = {}) {
    if (typeof address !== "string"
        || !Number.isSafeInteger(sessionStartMs) || sessionStartMs < 1
        || !Number.isInteger(startMarginMs) || startMarginMs < 0 || startMarginMs > 120_000
        || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100
        || !Number.isInteger(maxPagesPerProvider)
        || maxPagesPerProvider < 1 || maxPagesPerProvider > 40
        || !Number.isInteger(timeoutMs) || timeoutMs < 100
        || typeof fetchImpl !== "function"
        || (requestBudget !== null && typeof requestBudget?.schedule !== "function")) {
        throw new RoomWalletEvidenceUnavailable("HISTORY_REQUEST_INVALID");
    }
    let rawAddress;
    try {
        rawAddress = Address.parse(address).toRawString().toLowerCase();
    } catch {
        throw new RoomWalletEvidenceUnavailable("HISTORY_WALLET_INVALID");
    }
    const cutoffSeconds = Math.floor((sessionStartMs - startMarginMs) / 1000);
    if (cutoffSeconds <= 0) {
        throw new RoomWalletEvidenceUnavailable("HISTORY_CUTOFF_INVALID");
    }

    async function providerHistory(provider) {
        const transactions = [];
        const seen = new Set();
        let cursor = null;
        let completed = false;
        let pages = 0;

        for (; pages < maxPagesPerProvider; pages++) {
            let url;
            if (provider === "tonapi") {
                url = TONAPI + "/v2/blockchain/accounts/"
                    + encodeURIComponent(rawAddress) + "/transactions"
                    + "?limit=" + pageSize + "&sort_order=desc";
                if (cursor !== null) url += "&before_lt=" + cursor.toString();
            } else {
                url = TONCENTER_V3 + "/transactions?account="
                    + encodeURIComponent(rawAddress)
                    + "&limit=" + pageSize + "&sort=desc";
                if (cursor !== null) {
                    if (cursor <= 1n) {
                        completed = true;
                        break;
                    }
                    url += "&end_lt=" + (cursor - 1n).toString();
                }
            }

            const response = await readJson(fetchImpl, url, timeoutMs, requestBudget, provider);
            const page = response?.transactions;
            const state = validatePage(page, { cursor, seen, pageSize });
            transactions.push(...page);
            if (state.exhausted || state.oldestUtime <= cutoffSeconds) {
                completed = true;
                pages++;
                break;
            }
            cursor = state.oldestLt;
        }
        return { provider, transactions, pages, completed };
    }

    const [a, b] = await Promise.all([
        providerHistory("tonapi"),
        providerHistory("toncenter-v3")
    ]);
    if (!a.completed || !b.completed) {
        throw new RoomWalletEvidenceUnavailable(
            "HISTORY_INCOMPLETE_PAGE_BUDGET",
            "tonapi=" + a.pages + ",toncenter=" + b.pages
        );
    }
    const matching = reconcileDualSourceTransactions({
        tonapiTransactions: a.transactions,
        toncenterTransactions: b.transactions,
        expectedRoomWalletRaw: rawAddress
    });
    // Keep the actual account-history tip independent of the session window.
    // A room with ZERO deposits may have an older wallet transaction; it
    // still needs a two-provider head witness before being released.
    const tipA = a.transactions[0] ?? null;
    const tipB = b.transactions[0] ?? null;
    const tipIdentity = tx => tx ? Object.freeze({
        lt: String(tx.lt ?? tx.transaction_id?.lt),
        hash: normalizeTonTransactionHash(tx.hash ?? tx.transaction_id?.hash)
    }) : null;
    const currentA = tipIdentity(tipA);
    const currentB = tipIdentity(tipB);
    if ((currentA === null) !== (currentB === null)
        || (currentA && (currentA.lt !== currentB.lt
            || currentA.hash !== currentB.hash))) {
        throw new RoomWalletEvidenceUnavailable("HISTORY_PROVIDER_HEADS_DISAGREE");
    }
    return Object.freeze({
        accountTip: currentA,
        source: matching.source,
        transactions: Object.freeze(
            matching.transactions.filter(tx => tx.utime >= cutoffSeconds)
        ),
        awaitingSecondProvider: matching.awaitingSecondProvider,
        historyComplete: true,
        rawAddress,
        scannedTransactions: Object.freeze({
            tonapi: a.transactions.length,
            toncenterV3: b.transactions.length,
            tonapiPages: a.pages,
            toncenterV3Pages: b.pages
        }),
        walletReleaseAuthorized: false
    });
}
