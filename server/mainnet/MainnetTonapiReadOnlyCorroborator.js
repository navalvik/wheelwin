/**
 * Mainnet phase 5: on-demand, independent-indexer CROSS-CHECK (review only).
 *
 * TonAPI is a separate HTTP indexer from Toncenter v3; two indexers agreeing
 * does NOT supply authenticated TON liteserver block proofs. The caller must
 * never treat this report as settlement evidence, a 3/3 payment gate, refund
 * authorization or a payout capability. No signing, storage, background
 * polling, Testnet fallback or new Mainnet payment path exists here.
 *
 * One transaction GET per genuine 3/3 candidate; strict account, hash,
 * sender, recipient, amount, time, successful execution and on-chain
 * text-comment BOC are independently compared with the candidate report.
 */
import { Cell } from "@ton/core";
import { parseTonAddress } from "../payment/incoming/TonAddressIdentity.js";
import { isMainnetCandidateReport } from "./MainnetPaymentCandidateEvaluator.js";

export const MAINNET_TONAPI_ORIGIN = "https://tonapi.io";
const MAX_BYTES = 524288;

function canonical(address) {
    try {
        const a = parseTonAddress(address);
        return a.workchain === 0 && a.testOnly !== true ? a.identity : null;
    } catch { return null; }
}
function hashHex(hash) {
    if (typeof hash !== "string") return null;
    if (/^[a-fA-F0-9]{64}$/.test(hash)) return hash.toLowerCase();
    if (!/^[A-Za-z0-9+/_-]{43}=?$/.test(hash)) return null;
    const bytes = Buffer.from(hash.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    return bytes.length === 32 ? bytes.toString("hex") : null;
}
function atomic(value) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
        return String(value);
    return typeof value === "string" && /^[1-9][0-9]*$/.test(value)
        ? value : null;
}
function commentFromBoc(rawBody) {
    if (typeof rawBody !== "string" || rawBody.length > 8192
        || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(rawBody)) return null;
    try {
        const roots = Cell.fromBoc(Buffer.from(
            rawBody.replace(/-/g, "+").replace(/_/g, "/"), "base64"
        ));
        if (roots.length !== 1) return null;
        const slice = roots[0].beginParse();
        if (slice.loadUint(32) !== 0) return null;
        const text = slice.loadStringTail();
        return /^WW1:[A-Za-z0-9_-]{1,64}$/.test(text) ? text.slice(4) : null;
    } catch { return null; }
}
function validCandidate(candidate, roomId) {
    return candidate?.roomId === roomId
        && candidate.network === "mainnet" && candidate.asset === "TON"
        && candidate.status === "PROVIDER_INDEXED_CANDIDATE"
        && candidate.settlementAuthorized === false
        && candidate.gameStartAuthorized === false
        && typeof candidate.playerId === "string" && !!candidate.playerId.trim()
        && /^[A-Za-z0-9_-]{1,64}$/.test(candidate.paymentReference)
        && !!hashHex(candidate.transactionId)
        && !!canonical(candidate.roomWalletAddress)
        && !!canonical(candidate.senderAddress)
        && atomic(candidate.amountAtomic) !== null
        && Number.isSafeInteger(candidate.transactionTimeMs)
        && candidate.transactionTimeMs > 0;
}
function validReport(report) {
    if (!isMainnetCandidateReport(report)
        || report.network !== "mainnet"
        || report.status !== "THREE_CANDIDATES_FOR_REVIEW"
        || report.threeOfThreeCandidates !== true
        || report.candidateCount !== 3
        || report.settlementAuthorized !== false
        || report.gameStartAuthorized !== false
        || !Array.isArray(report.candidates)
        || report.candidates.length !== 3
        || typeof report.roomId !== "string" || !report.roomId.trim()
        || !report.candidates.every(x => validCandidate(x, report.roomId)))
        return false;
    return ["playerId", "paymentReference", "transactionId"].every(key =>
        new Set(report.candidates.map(row =>
            key === "transactionId" ? hashHex(row[key]) : row[key]
        )).size === 3
    ) && new Set(report.candidates.map(row =>
        canonical(row.roomWalletAddress))).size === 1;
}
function sameTransaction(tx, candidate) {
    if (!tx || typeof tx !== "object" || Array.isArray(tx)) return false;
    const msg = tx.in_msg;
    return hashHex(tx.hash) === hashHex(candidate.transactionId)
        && tx.success === true && tx.aborted === false
        && typeof tx.block === "string"
        && /^\(0,[1-9][0-9]*,[A-Fa-f0-9]{16}\)$/.test(tx.block)
        && canonical(tx.account?.address) === canonical(candidate.roomWalletAddress)
        && msg?.msg_type === "int_msg"
        && msg.bounced === false
        && canonical(msg.source?.address) === canonical(candidate.senderAddress)
        && canonical(msg.destination?.address) === canonical(candidate.roomWalletAddress)
        && atomic(msg.value) === candidate.amountAtomic
        && Number.isSafeInteger(tx.utime)
        && tx.utime > 0
        && tx.utime * 1000 === candidate.transactionTimeMs
        && commentFromBoc(msg.raw_body) === candidate.paymentReference;
}
function blocked(reason, checked = 0) {
    return Object.freeze({
        network: "mainnet",
        provider: "tonapi-mainnet-v2",
        status: "BLOCKED",
        reason,
        checked,
        independentIndexerCorroborated: false,
        cryptographicProofVerified: false,
        settlementAuthorized: false,
        gameStartAuthorized: false
    });
}

export class MainnetTonapiReadOnlyCorroborator {
    constructor({
        env = process.env,
        fetchImpl = globalThis.fetch,
        timeoutMs = 7000
    } = {}) {
        if (String(env?.TON_NETWORK ?? "").toLowerCase() !== "mainnet"
            || String(env?.ROOM_WALLET_PAYMENTS_ENABLED ?? "") === "true") {
            throw new Error("MAINNET_CROSSCHECK_NETWORK_OR_LIVE_PAYMENTS_INVALID");
        }
        if (typeof fetchImpl !== "function"
            || !Number.isSafeInteger(timeoutMs)
            || timeoutMs < 100 || timeoutMs > 30000) {
            throw new Error("MAINNET_CROSSCHECK_TRANSPORT_INVALID");
        }
        this._fetch = fetchImpl;
        this._timeout = timeoutMs;
        // No token is persisted or included in any report.
        this._apiKeyProvider = () => env?.TONAPI_API_KEY;
    }

    async corroborateRoom(report) {
        if (!validReport(report)) return blocked("TRUSTED_THREE_CANDIDATES_REQUIRED");
        const key = this._apiKeyProvider();
        if (typeof key !== "string" || !key.trim()) return blocked("TONAPI_KEY_REQUIRED");
        let checked = 0;
        for (const candidate of report.candidates) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), this._timeout);
            let tx;
            try {
                const url = MAINNET_TONAPI_ORIGIN + "/v2/blockchain/transactions/"
                    + hashHex(candidate.transactionId);
                const response = await this._fetch(url, {
                    method: "GET", redirect: "error", signal: controller.signal,
                    headers: { Authorization: "Bearer " + key.trim(),
                        Accept: "application/json" }
                });
                const size = response.headers?.get?.("content-length");
                if (response.status !== 200
                    || (size !== null && size !== undefined
                        && (!/^\d+$/.test(size) || Number(size) > MAX_BYTES))) {
                    return blocked("TONAPI_TRANSACTION_UNAVAILABLE", checked);
                }
                tx = await response.json();
            } catch {
                return blocked("TONAPI_TRANSACTION_UNAVAILABLE", checked);
            } finally {
                clearTimeout(timer);
            }
            if (!sameTransaction(tx, candidate)) {
                return blocked("TONAPI_TRANSACTION_MISMATCH", checked);
            }
            checked += 1;
        }
        return Object.freeze({
            network: "mainnet", provider: "tonapi-mainnet-v2",
            status: "THREE_INDEXER_MATCHES_FOR_REVIEW",
            reason: null, checked,
            independentIndexerCorroborated: true,
            cryptographicProofVerified: false,
            settlementAuthorized: false,
            gameStartAuthorized: false
        });
    }
}
