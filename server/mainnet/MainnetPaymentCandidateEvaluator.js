/**
 * Mainnet phase 4A: pure three-player payment candidate evaluation.
 *
 * The only supported input receipt report must have been produced by the
 * Mainnet Indexed Receipt Finality Inspector (provenance-bound WeakSet).
 * This is NOT settlement, a financial ledger credit, or permission for Page5.
 * In particular, provider-reported indexed depth is not a second independent
 * cryptographic/on-chain verification capability.
 *
 * Caller MUST supply the three authoritative persisted PaymentIntent objects.
 * Neither browser-supplied requirements nor unsigned client payloads qualify.
 */
import { PaymentIntent } from "../payment/PaymentIntent.js";
import { PAYMENT_INTENT_STATE } from "../payment/PaymentIntentStatus.js";
import { parseTonAddress } from "../payment/incoming/TonAddressIdentity.js";
import { IncomingTransfer } from "../payment/incoming/IncomingTransfer.js";
import { deriveIncomingTransactionId } from "../payment/incoming/IncomingTransferIdentity.js";
import { matchIncomingTransferToIntent } from "../payment/incoming/IncomingTransferMatcher.js";
import {
    isMainnetIndexedInspectionReport,
    MAINNET_INDEXED_RECEIPT_STATUS
} from "./MainnetIndexedReceiptFinalityInspector.js";
import { MAINNET_GLOBAL_ID } from "./MainnetReadOnlyPreflight.js";

const trustedCandidateReports = new WeakSet();
const THREE = 3;

function identity(value) {
    try {
        const parsed = parseTonAddress(value);
        return parsed.workchain === 0 && parsed.testOnly !== true
            ? parsed.identity : null;
    } catch {
        return null;
    }
}

function block(reason) {
    return Object.freeze({
        network: "mainnet",
        status: "BLOCKED",
        reason,
        candidates: Object.freeze([]),
        candidateCount: 0,
        threeOfThreeCandidates: false,
        settlementAuthorized: false,
        gameStartAuthorized: false
    });
}

export function isMainnetCandidateReport(value) {
    return value !== null && typeof value === "object"
        && trustedCandidateReports.has(value);
}

export function assessMainnetRoomPaymentCandidates({
    roomId,
    roomPlayerIds,
    roomWalletAddress,
    intents,
    inspection,
    nowMs = Date.now()
} = {}) {
    if (!isMainnetIndexedInspectionReport(inspection)
        || inspection.network !== "mainnet"
        || inspection.globalId !== MAINNET_GLOBAL_ID
        || inspection.roomId !== roomId
        || inspection.readOnly !== true
        || inspection.settlementAuthorized !== false
        || inspection.gameStartAuthorized !== false
        || !inspection.resultWindowComplete
        || !Array.isArray(inspection.receipts)) {
        return block("UNTRUSTED_OR_INCOMPLETE_INSPECTION");
    }
    if (typeof roomId !== "string" || !roomId.trim()
        || !Number.isSafeInteger(nowMs) || nowMs <= 0
        || !Array.isArray(roomPlayerIds) || roomPlayerIds.length !== THREE
        || roomPlayerIds.some(x => typeof x !== "string" || !x.trim())
        || new Set(roomPlayerIds).size !== THREE
        || !Array.isArray(intents) || intents.length !== THREE) {
        return block("THREE_PLAYER_ROSTER_REQUIRED");
    }
    const wallet = identity(roomWalletAddress);
    if (!wallet) return block("ROOM_WALLET_INVALID");

    const byRef = new Map(), senders = new Set(), players = new Set();
    let deadline = null;
    for (const intent of intents) {
        if (!(intent instanceof PaymentIntent)
            || intent.roomId !== roomId
            || intent.network !== "mainnet"
            || intent.asset !== "TON"
            || intent.state !== PAYMENT_INTENT_STATE.PENDING
            || intent.transactionId !== null
            || !roomPlayerIds.includes(intent.playerId)
            || players.has(intent.playerId)
            || typeof intent.paymentReference !== "string"
            || !/^[A-Za-z0-9_-]{1,64}$/.test(intent.paymentReference)
            || byRef.has(intent.paymentReference)
            || !Number.isSafeInteger(intent.amountAtomic)
            || intent.amountAtomic <= 0
            || identity(intent.destinationWalletAddress) !== wallet
            || !identity(intent.expectedSender)
            || senders.has(identity(intent.expectedSender))
            || nowMs >= intent.expiresAt
            || nowMs >= intent.roomDeadlineMs) {
            return block("AUTHORITATIVE_INTENTS_INVALID_OR_EXPIRED");
        }
        if (deadline === null) deadline = intent.roomDeadlineMs;
        else if (deadline !== intent.roomDeadlineMs) {
            return block("ROOM_DEADLINES_MISMATCH");
        }
        byRef.set(intent.paymentReference, intent);
        players.add(intent.playerId);
        senders.add(identity(intent.expectedSender));
    }
    if (players.size !== THREE) return block("THREE_PLAYER_ROSTER_REQUIRED");
    if (inspection.receipts.some(x => x?.status === MAINNET_INDEXED_RECEIPT_STATUS.DUPLICATE_TRANSACTION
        || x?.status === MAINNET_INDEXED_RECEIPT_STATUS.WINDOW_INCOMPLETE)) {
        return block("AMBIGUOUS_OR_INCOMPLETE_TRANSACTIONS");
    }

    const rows = new Map();
    const transactionIds = new Set();
    for (const receipt of inspection.receipts) {
        if (receipt?.status !== MAINNET_INDEXED_RECEIPT_STATUS.INDEXED_DEPTH_OK
            || receipt.providerReportedFinality !== true
            || receipt.settlementAuthorized !== false
            || receipt.gameStartAuthorized !== false) continue;
        const intent = byRef.get(receipt.paymentReference);
        if (!intent) continue;
        const hash = receipt.transactionId;
        if (typeof hash !== "string" || !hash.trim()
            || transactionIds.has(hash)) return block("TRANSACTION_REPLAY_OR_INVALID");
        transactionIds.add(hash);
        if (receipt.network !== "mainnet"
            || identity(receipt.accountId) !== wallet
            || identity(receipt.sourceAddress) === null
            || typeof receipt.amountAtomic !== "string"
            || !/^[1-9][0-9]*$/.test(receipt.amountAtomic)
            || !Number.isSafeInteger(receipt.transactionTimeMs)
            || receipt.transactionTimeMs < intent.createdAt
            || receipt.transactionTimeMs >= intent.expiresAt
            || receipt.transactionTimeMs >= intent.roomDeadlineMs
            || !Number.isSafeInteger(receipt.masterchainInclusionSeqno)
            || receipt.masterchainInclusionSeqno < 1) {
            continue;
        }

        // Reuse exactly the Testnet payment-intent matcher. Mainnet does not
        // implement a parallel sender/amount/reference algorithm. The
        // Mainnet-only gates above still enforce authenticated network and
        // indexed receipt metadata. No memo remains ineligible on Mainnet.
        let matched = false;
        try {
            const transfer = new IncomingTransfer({
                network: "mainnet",
                transactionId: deriveIncomingTransactionId({
                    network: "mainnet",
                    providerId: "toncenter",
                    accountId: wallet,
                    transactionId: hash
                }),
                providerTransactionIdentity: {
                    providerId: "toncenter",
                    accountId: wallet,
                    transactionId: hash
                },
                destinationWalletAddress: wallet,
                senderAddress: receipt.sourceAddress,
                amountAtomic: receipt.amountAtomic,
                asset: "TON",
                transactionTime: receipt.transactionTimeMs,
                paymentReference: receipt.paymentReference,
                providerConfirmed: true
            });
            matched = matchIncomingTransferToIntent(transfer, intent).matched;
        } catch {
            // Invalid or non-representable receipt cannot become a candidate.
        }
        if (!matched) continue;
        if (rows.has(intent.paymentReference)) {
            return block("MULTIPLE_TRANSACTIONS_FOR_ONE_INTENT");
        }
        rows.set(intent.paymentReference, Object.freeze({
            network: "mainnet",
            asset: "TON",
            roomId,
            playerId: intent.playerId,
            paymentReference: intent.paymentReference,
            transactionId: hash,
            roomWalletAddress: wallet,
            senderAddress: identity(intent.expectedSender),
            amountAtomic: receipt.amountAtomic,
            transactionTimeMs: receipt.transactionTimeMs,
            masterchainInclusionSeqno: receipt.masterchainInclusionSeqno,
            status: "PROVIDER_INDEXED_CANDIDATE",
            settlementAuthorized: false,
            gameStartAuthorized: false
        }));
    }

    const candidates = Object.freeze([...rows.values()]);
    const ready = candidates.length === THREE;
    const report = Object.freeze({
        network: "mainnet",
        roomId,
        status: ready ? "THREE_CANDIDATES_FOR_REVIEW" : "PARTIAL_CANDIDATES",
        reason: ready ? null : "THREE_DISTINCT_CONFIRMED_INTENTS_NOT_YET_OBSERVED",
        candidates,
        candidateCount: candidates.length,
        threeOfThreeCandidates: ready,
        settlementAuthorized: false,
        gameStartAuthorized: false
    });
    trustedCandidateReports.add(report);
    return report;
}
