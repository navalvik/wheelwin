/**
 * Read-only, bounded dual-provider scan of a Room Wallet's *outgoing* TON
 * transactions after a previously signed V4 intent.
 *
 * This deliberately returns each provider's RAW transactions: the separate
 * outgoing receipt verifier must match the exact signed external message,
 * source wallet transaction LT/hash, recipient, value and outgoing msg hash.
 *
 * A missing/lagging/failed provider never permits retransmission.
 * No blockchain signing, private keys, broadcasting or quarantine release.
 */
import { Address } from "@ton/core";
import {
    normalizeTonTransactionHash,
    RoomWalletEvidenceUnavailable
} from "./RoomWalletDualSourceEvidence.js";

const TONAPI = "https://testnet.tonapi.io";
const TONCENTER = "https://testnet.toncenter.com/api/v3";

function integerLt(value) {
    if (!/^[0-9]+$/.test(String(value ?? ""))) {
        throw new RoomWalletEvidenceUnavailable("OUTGOING_SCAN_LT_INVALID");
    }
    const lt = BigInt(value);
    if (lt < 1n) {
        throw new RoomWalletEvidenceUnavailable("OUTGOING_SCAN_LT_INVALID");
    }
    return lt;
}

function pageInfo(items, { cursor, seen, limit }) {
    if (!Array.isArray(items) || items.length > limit) {
        throw new RoomWalletEvidenceUnavailable("OUTGOING_SCAN_PAGE_INVALID");
    }
    let previousLt = cursor;
    let oldestLt = null;
    let oldestTime = null;
    for (const item of items) {
        const lt = integerLt(item?.lt ?? item?.transaction_id?.lt);
        const hash = normalizeTonTransactionHash(
            item?.hash ?? item?.transaction_id?.hash
        );
        const utime = Number(item?.utime ?? item?.now);
        if (!hash || !Number.isSafeInteger(utime) || utime < 1
            || (previousLt != null && lt >= previousLt)
            || seen.has(lt.toString())) {
            throw new RoomWalletEvidenceUnavailable("OUTGOING_SCAN_ORDER_OR_HASH_INVALID");
        }
        seen.add(lt.toString());
        previousLt = oldestLt = lt;
        oldestTime = utime;
    }
    return Object.freeze({
        oldestLt,
        oldestTime,
        exhausted: items.length < limit
    });
}

async function readPage({ fetchImpl, url, timeoutMs, budget, provider }) {
    const request = async () => {
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
                    "OUTGOING_SCAN_HTTP_FAILURE", String(response?.status ?? "unknown")
                );
            }
            const body = await response.json();
            if (!Array.isArray(body?.transactions)) {
                throw new RoomWalletEvidenceUnavailable("OUTGOING_SCAN_PROVIDER_RESPONSE_INVALID");
            }
            return body.transactions;
        } catch (error) {
            if (error instanceof RoomWalletEvidenceUnavailable) throw error;
            throw new RoomWalletEvidenceUnavailable(
                "OUTGOING_SCAN_PROVIDER_UNAVAILABLE", error?.name ?? "unknown"
            );
        } finally {
            clearTimeout(timer);
        }
    };
    return budget ? budget.schedule(provider, request) : request();
}

export async function fetchOutgoingConfirmationHistory({
    roomWallet,
    cutoffUnixSeconds,
    fetchImpl = globalThis.fetch,
    requestBudget = null,
    limit = 50,
    maxPagesPerProvider = 12,
    timeoutMs = 10_000
} = {}) {
    if (typeof roomWallet !== "string"
        || !Number.isSafeInteger(cutoffUnixSeconds) || cutoffUnixSeconds < 1
        || typeof fetchImpl !== "function"
        || (requestBudget !== null && typeof requestBudget?.schedule !== "function")
        || !Number.isInteger(limit) || limit < 1 || limit > 100
        || !Number.isInteger(maxPagesPerProvider)
        || maxPagesPerProvider < 1 || maxPagesPerProvider > 40
        || !Number.isInteger(timeoutMs) || timeoutMs < 100) {
        throw new RoomWalletEvidenceUnavailable("OUTGOING_SCAN_OPTIONS_INVALID");
    }
    let account;
    try {
        const parsed = Address.parse(roomWallet);
        if (parsed.workChain !== 0) throw new Error("workchain");
        account = parsed.toRawString().toLowerCase();
    } catch {
        throw new RoomWalletEvidenceUnavailable("OUTGOING_SCAN_WALLET_INVALID");
    }

    async function scan(provider) {
        const seen = new Set();
        const transactions = [];
        let cursor = null;
        let complete = false;
        let pages = 0;
        for (; pages < maxPagesPerProvider; ) {
            let url;
            if (provider === "tonapi") {
                url = TONAPI + "/v2/blockchain/accounts/"
                    + encodeURIComponent(account)
                    + "/transactions?sort_order=desc&limit=" + limit;
                if (cursor !== null) url += "&before_lt=" + cursor.toString();
            } else {
                url = TONCENTER + "/transactions?account="
                    + encodeURIComponent(account)
                    + "&sort=desc&limit=" + limit;
                if (cursor !== null) {
                    // TON Center end_lt is inclusive; the previous oldest LT
                    // must be excluded, otherwise a full-page cursor loops.
                    if (cursor <= 1n) {
                        complete = true;
                        break;
                    }
                    url += "&end_lt=" + (cursor - 1n).toString();
                }
            }
            const page = await readPage({
                fetchImpl, url, timeoutMs, budget: requestBudget, provider
            });
            const info = pageInfo(page, { cursor, seen, limit });
            transactions.push(...page);
            pages++;
            if (info.exhausted || info.oldestTime <= cutoffUnixSeconds) {
                complete = true;
                break;
            }
            cursor = info.oldestLt;
        }
        if (!complete) {
            throw new RoomWalletEvidenceUnavailable(
                "OUTGOING_SCAN_PAGE_BUDGET_EXCEEDED",
                provider + " pages=" + pages
            );
        }
        return Object.freeze({ transactions, pages });
    }

    // Each provider has an independent bounded request queue. No source can
    // confirm an outbound transfer without the other source's exact receipt.
    const [first, second] = await Promise.all([
        scan("tonapi"),
        scan("toncenter-v3")
    ]);
    return Object.freeze({
        roomWallet: account,
        tonapiTransactions: Object.freeze(first.transactions),
        toncenterTransactions: Object.freeze(second.transactions),
        scannedPages: Object.freeze({
            tonapi: first.pages,
            toncenterV3: second.pages
        }),
        historyComplete: true,
        // A scan can confirm a signed payment but cannot prove "not sent".
        refundOrRebroadcastAuthorized: false
    });
}
