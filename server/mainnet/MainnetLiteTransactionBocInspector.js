/**
 * Mainnet phase 6A: inspect a liteserver-supplied transaction BoC WITHOUT
 * treating it as a verified block-inclusion proof.
 *
 * A BoC's representation hash checks its internal integrity and ties its
 * decoded payment data to a claimed transaction hash. It does NOT anchor the
 * transaction to a trusted shard block or masterchain block. No caller can
 * use any result from here as settlement, Page5, refund, or payout authority.
 *
 * No liteserver networking, mutable ledger, background polling, signing or
 * Mainnet payment activation is implemented in this module. fetchTransactionBoc
 * is deliberately an untrusted read-only dependency provided by the caller.
 */
import { Cell, loadTransaction } from "@ton/core";
import { parseTonAddress } from "../payment/incoming/TonAddressIdentity.js";
import { isMainnetCandidateReport } from "./MainnetPaymentCandidateEvaluator.js";

const MAX_BOC_BYTES = 131072;

function canonical(value) {
    try {
        const parsed = parseTonAddress(value);
        return parsed.workchain === 0 && parsed.testOnly !== true
            ? parsed.identity : null;
    } catch { return null; }
}
function hexHash(value) {
    if (typeof value !== "string") return null;
    if (/^[a-fA-F0-9]{64}$/.test(value)) return value.toLowerCase();
    if (!/^[a-zA-Z0-9+/_-]{43}=?$/.test(value)) return null;
    const bytes = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    return bytes.length === 32 ? bytes.toString("hex") : null;
}
function blocked(reason) {
    return Object.freeze({
        network: "mainnet",
        status: "BLOCKED",
        reason,
        bocHashMatched: false,
        transactionFieldsMatched: false,
        masterchainTrustAnchorVerified: false,
        shardInclusionProofVerified: false,
        cryptographicProofVerified: false,
        settlementAuthorized: false,
        gameStartAuthorized: false
    });
}
function candidateValid(candidate) {
    return candidate?.network === "mainnet"
        && candidate?.asset === "TON"
        && candidate?.status === "PROVIDER_INDEXED_CANDIDATE"
        && candidate?.settlementAuthorized === false
        && candidate?.gameStartAuthorized === false
        && typeof candidate?.paymentReference === "string"
        && /^[A-Za-z0-9_-]{1,64}$/.test(candidate.paymentReference)
        && typeof candidate?.roomId === "string" && !!candidate.roomId.trim()
        && typeof candidate?.playerId === "string" && !!candidate.playerId.trim()
        && !!canonical(candidate.roomWalletAddress)
        && !!canonical(candidate.senderAddress)
        && !!hexHash(candidate.transactionId)
        && typeof candidate.amountAtomic === "string"
        && /^[1-9][0-9]*$/.test(candidate.amountAtomic)
        && Number.isSafeInteger(candidate.transactionTimeMs)
        && candidate.transactionTimeMs > 0;
}
function parseOneBoc(data) {
    if (typeof data !== "string" || data.length === 0
        || data.length > MAX_BOC_BYTES * 2
        || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(data)) return null;
    try {
        const bytes = Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
        if (bytes.length === 0 || bytes.length > MAX_BOC_BYTES) return null;
        const roots = Cell.fromBoc(bytes);
        if (roots.length !== 1 || roots[0].isExotic) return null;
        return roots[0];
    } catch { return null; }
}
function extractReference(body) {
    try {
        if (!body || body.isExotic) return null;
        const slice = body.beginParse();
        if (slice.remainingBits < 32 || slice.loadUint(32) !== 0) return null;
        const text = slice.loadStringTail();
        return /^WW1:[A-Za-z0-9_-]{1,64}$/.test(text) ? text.slice(4) : null;
    } catch { return null; }
}

/**
 * Verify a transaction BoC hash and native TON fields against exactly one
 * review candidate. A successful result still proves NOTHING about inclusion.
 */
export function inspectMainnetLiteTransactionBoc({candidate, transactionBocBase64} = {}) {
    if (!candidateValid(candidate)) return blocked("CANDIDATE_INVALID");
    const root = parseOneBoc(transactionBocBase64);
    if (!root) return blocked("TRANSACTION_BOC_INVALID");
    if (root.hash().toString("hex") !== hexHash(candidate.transactionId))
        return blocked("TRANSACTION_BOC_HASH_MISMATCH");

    let tx;
    try {
        tx = loadTransaction(root.beginParse());
    } catch { return blocked("TRANSACTION_BOC_DECODE_FAILED"); }

    const message = tx?.inMessage;
    const info = message?.info;
    const account = "0:" + tx.address.toString(16).padStart(64, "0");
    if (canonical(account) !== canonical(candidate.roomWalletAddress)
        || tx.now * 1000 !== candidate.transactionTimeMs
        || typeof tx.lt !== "bigint" || tx.lt <= 0n
        || tx.description?.type !== "generic"
        || tx.description?.aborted !== false
        || info?.type !== "internal"
        || info.bounced !== false
        || canonical(info.src?.toRawString?.()) !== canonical(candidate.senderAddress)
        || canonical(info.dest?.toRawString?.()) !== canonical(candidate.roomWalletAddress)
        || info.value?.coins?.toString?.() !== candidate.amountAtomic
        || extractReference(message.body) !== candidate.paymentReference) {
        return blocked("TRANSACTION_BOC_FIELDS_MISMATCH");
    }
    return Object.freeze({
        network: "mainnet",
        status: "BOC_FIELDS_MATCH_UNANCHORED",
        reason: "TRUSTED_MASTERCHAIN_AND_SHARD_INCLUSION_PROOFS_REQUIRED",
        bocHashMatched: true,
        transactionFieldsMatched: true,
        masterchainTrustAnchorVerified: false,
        shardInclusionProofVerified: false,
        cryptographicProofVerified: false,
        settlementAuthorized: false,
        gameStartAuthorized: false
    });
}

/**
 * Requires the genuine, provenance-bound 3/3 review report and performs at
 * most one on-demand callback per transaction. The caller's BoC provider is
 * untrusted: even 3/3 matches never authorize financial mutations.
 */
export async function inspectMainnetThreeCandidateLiteBocs({
    report, fetchTransactionBoc
} = {}) {
    if (!isMainnetCandidateReport(report)
        || report.network !== "mainnet"
        || report.status !== "THREE_CANDIDATES_FOR_REVIEW"
        || report.threeOfThreeCandidates !== true
        || report.candidateCount !== 3
        || report.settlementAuthorized !== false
        || report.gameStartAuthorized !== false
        || !Array.isArray(report.candidates)
        || report.candidates.length !== 3
        || !report.candidates.every(x => candidateValid(x)
            && x.roomId === report.roomId)
        || new Set(report.candidates.map(x => hexHash(x.transactionId))).size !== 3
        || new Set(report.candidates.map(x => x.playerId)).size !== 3
        || new Set(report.candidates.map(x => x.paymentReference)).size !== 3
        || typeof fetchTransactionBoc !== "function") {
        return blocked("THREE_TRUSTED_CANDIDATES_AND_BOC_SOURCE_REQUIRED");
    }
    let checked = 0;
    for (const candidate of report.candidates) {
        let boc;
        try {
            boc = await fetchTransactionBoc({
                roomId: report.roomId,
                transactionId: candidate.transactionId,
                roomWalletAddress: candidate.roomWalletAddress
            });
        } catch {
            return Object.freeze({...blocked("LITESERVER_BOC_UNAVAILABLE"), checked});
        }
        const result = inspectMainnetLiteTransactionBoc({
            candidate, transactionBocBase64: boc
        });
        if (result.status !== "BOC_FIELDS_MATCH_UNANCHORED") {
            return Object.freeze({...result, checked});
        }
        checked += 1;
    }
    return Object.freeze({
        network: "mainnet",
        status: "THREE_BOC_FIELDS_MATCH_UNANCHORED",
        reason: "TRUSTED_MASTERCHAIN_AND_SHARD_INCLUSION_PROOFS_REQUIRED",
        checked,
        bocHashMatched: true,
        transactionFieldsMatched: true,
        masterchainTrustAnchorVerified: false,
        shardInclusionProofVerified: false,
        cryptographicProofVerified: false,
        settlementAuthorized: false,
        gameStartAuthorized: false
    });
}
