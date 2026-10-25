/**
 * Read-only Testnet Room Wallet payment evidence.
 *
 * Two independent indexed APIs must agree on TON transaction identity (LT +
 * 256-bit hash) and on the inbound sender, destination and nano amount.
 * An outage, stale index or disagreement NEVER means "the player did not pay".
 *
 * This module never reads signing keys, broadcasts, settles or refunds.
 * It supplements the existing primary TON transport; activation is explicit.
 */

const TESTNET_TONAPI = "https://testnet.tonapi.io";
const TESTNET_TONCENTER_V3 = "https://testnet.toncenter.com/api/v3";

export class RoomWalletEvidenceUnavailable extends Error {
    constructor(code, detail = "") {
        super(`${code}${detail ? ": " + detail : ""}`);
        this.name = "RoomWalletEvidenceUnavailable";
        this.code = code;
        this.retryable = true;
    }
}

export function normalizeRawTonAddress(value) {
    const input = typeof value === "string"
        ? value
        : (value && typeof value === "object" ? value.address ?? null : null);
    if (typeof input !== "string") return null;
    const match = /^(-?\d+):([0-9a-f]{64})$/i.exec(input.trim());
    return match ? `${Number(match[1])}:${match[2].toLowerCase()}` : null;
}

export function normalizeTonTransactionHash(value) {
    if (typeof value !== "string") return null;
    const input = value.trim();
    if (/^[0-9a-f]{64}$/i.test(input)) return input.toLowerCase();
    if (!/^[a-z0-9+/]{43}=?$/i.test(input)) return null;
    const bytes = Buffer.from(input, "base64");
    return bytes.length === 32 ? bytes.toString("hex") : null;
}

function nanoString(value) {
    try {
        if (typeof value !== "string" && typeof value !== "bigint" && typeof value !== "number") {
            return null;
        }
        if (typeof value === "number" && !Number.isSafeInteger(value)) return null;
        const parsed = BigInt(value);
        return parsed > 0n ? parsed.toString(10) : null;
    } catch {
        return null;
    }
}

function normalizeEntry(tx) {
    if (!tx || typeof tx !== "object") return null;
    const inbound = tx.in_msg ?? tx.inMessage;
    if (!inbound || typeof inbound !== "object") return null;
    const lt = String(tx.lt ?? tx.transaction_id?.lt ?? "");
    const hash = normalizeTonTransactionHash(tx.hash ?? tx.transaction_id?.hash);
    const source = normalizeRawTonAddress(inbound.source);
    const destination = normalizeRawTonAddress(inbound.destination);
    const amount = nanoString(inbound.value);
    const utime = Number(tx.utime ?? tx.now);
    if (!/^\d+$/.test(lt) || !hash || !source || !destination || !amount
        || !Number.isSafeInteger(utime) || utime <= 0) return null;
    const failed = tx.success === false
        || tx.aborted === true
        || tx.description?.aborted === true
        || tx.description?.compute_ph?.success === false;
    const successful = tx.success === true;
    return Object.freeze({ lt, hash, source, destination, amount, utime, failed, successful });
}

/**
 * Compare independently fetched transaction lists. Do not treat missing rows
 * on a lagging indexer as absence of a payment. Only intersected receipts
 * with identical values are returned for the authoritative observer.
 */
export function reconcileDualSourceTransactions({
    tonapiTransactions,
    toncenterTransactions,
    expectedRoomWalletRaw
}) {
    const expected = normalizeRawTonAddress(expectedRoomWalletRaw);
    if (!expected || !Array.isArray(tonapiTransactions) || !Array.isArray(toncenterTransactions)) {
        throw new RoomWalletEvidenceUnavailable("EVIDENCE_INPUT_INVALID");
    }

    const tonapi = tonapiTransactions.map(normalizeEntry).filter(Boolean);
    const toncenter = toncenterTransactions.map(normalizeEntry).filter(Boolean);
    const byLt = new Map();
    for (const item of toncenter) {
        if (byLt.has(item.lt) && byLt.get(item.lt).hash !== item.hash) {
            throw new RoomWalletEvidenceUnavailable("DUPLICATE_LT_ON_PROVIDER");
        }
        byLt.set(item.lt, item);
    }

    const matched = [];
    let awaitingSecondProvider = 0;

    for (const first of tonapi) {
        if (first.destination !== expected) continue;
        const second = byLt.get(first.lt);
        if (!second) {
            awaitingSecondProvider++;
            continue;
        }
        if (first.hash !== second.hash || first.source !== second.source
            || first.destination !== second.destination
            || first.amount !== second.amount || first.utime !== second.utime) {
            throw new RoomWalletEvidenceUnavailable("PROVIDER_EVIDENCE_DISAGREEMENT", first.lt);
        }
        if (first.failed || second.failed || !first.successful) {
            // Even if one API reports success, explicit failure is never credited.
            continue;
        }
        matched.push(Object.freeze({
            transaction_id: Object.freeze({ lt: first.lt, hash: first.hash }),
            utime: first.utime,
            success: true,
            in_msg: Object.freeze({
                source: first.source,
                destination: first.destination,
                value: first.amount,
                message: ""
            }),
            out_msgs: Object.freeze([])
        }));
    }

    return Object.freeze({
        transactions: Object.freeze(matched),
        awaitingSecondProvider,
        source: "tonapi+toncenter-v3"
    });
}

async function readJson(fetchImpl, url, timeoutMs) {
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
                "EVIDENCE_PROVIDER_HTTP_ERROR",
                String(response?.status ?? "unknown")
            );
        }
        return await response.json();
    } catch (error) {
        if (error instanceof RoomWalletEvidenceUnavailable) throw error;
        throw new RoomWalletEvidenceUnavailable("EVIDENCE_PROVIDER_UNAVAILABLE", error?.name ?? "");
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Read-only fallback, Testnet ONLY. The request address is canonicalized by
 * the caller with @ton/core; expectedRoomWalletRaw must be a raw 0:... value.
 * No source is allowed to independently confirm a payment.
 */
export async function fetchDualSourceRoomWalletTransactions({
    address,
    expectedRoomWalletRaw,
    fetchImpl = globalThis.fetch,
    timeoutMs = 10_000,
    limit = 50,
    requestBudget = null
}) {
    if (typeof fetchImpl !== "function" || typeof address !== "string"
        || !normalizeRawTonAddress(expectedRoomWalletRaw)
        || !Number.isInteger(limit) || limit < 1 || limit > 100
        || !Number.isInteger(timeoutMs) || timeoutMs < 100) {
        throw new RoomWalletEvidenceUnavailable("EVIDENCE_REQUEST_INVALID");
    }
    const wallet = encodeURIComponent(address);
    const requests = [
        ["tonapi", `${TESTNET_TONAPI}/v2/blockchain/accounts/${wallet}/transactions?limit=${limit}`],
        ["toncenter-v3", `${TESTNET_TONCENTER_V3}/transactions?account=${wallet}&limit=${limit}`]
    ];
    if (requestBudget !== null && typeof requestBudget?.schedule !== "function") {
        throw new RoomWalletEvidenceUnavailable("EVIDENCE_BUDGET_INVALID");
    }
    const [first, second] = await Promise.all(requests.map(([provider, url]) => {
        const read = () => readJson(fetchImpl, url, timeoutMs);
        return requestBudget ? requestBudget.schedule(provider, read) : read();
    }));
    if (!Array.isArray(first?.transactions) || !Array.isArray(second?.transactions)) {
        throw new RoomWalletEvidenceUnavailable("EVIDENCE_RESPONSE_INVALID");
    }
    return reconcileDualSourceTransactions({
        tonapiTransactions: first.transactions,
        toncenterTransactions: second.transactions,
        expectedRoomWalletRaw
    });
}
