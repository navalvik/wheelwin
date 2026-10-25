/**
 * Build immutable refund obligations for a room destroyed before Page5.
 *
 * The record of receivedPayments is NOT authoritative: TonCenter v2 HTTP 542
 * left room oj7v with receivedPayments=[] despite three confirmed deposits.
 * This module only builds evidence and obligations; it cannot send GRAM.
 *
 * Reconciliation must run independently of the active room lifecycle, be
 * persisted before wallet reallocation, and be repeated after restart.
 */
import { createHash } from "node:crypto";
import { Address } from "@ton/core";
import { normalizeTonTransactionHash } from "./RoomWalletDualSourceEvidence.js";

export class RoomWalletRefundReconciliationError extends Error {
    constructor(code) {
        super(code);
        this.name = "RoomWalletRefundReconciliationError";
        this.code = code;
    }
}

function rawAddress(value) {
    if (typeof value !== "string") return null;
    try {
        return Address.parse(value).toRawString().toLowerCase();
    } catch {
        return null;
    }
}

function positiveNano(value) {
    try {
        const amount = BigInt(value);
        return amount > 0n ? amount : null;
    } catch {
        return null;
    }
}

function marker(fields) {
    return createHash("sha256")
        .update(fields.join("|"), "utf8")
        .digest("hex");
}

/**
 * @param {Object} args
 * @param {Object} args.session - serialized PaymentSession (or record.payload)
 * @param {Object} args.chainEvidence - result of reconcileDualSourceTransactions
 * @param {boolean} args.gameReachedPage5 - AUTHORITATIVE lifecycle fact
 * @param {boolean} args.historyComplete - caller proves both source histories
 *   cover session.createdAt (or paginates back far enough)
 *
 * Any unsettled obligation MUST be persisted and its Room Wallet quarantined.
 * This function does not mark a refund executed or infer it from local flags.
 */
export function buildExpiredRoomWalletRefundObligations({
    session,
    chainEvidence,
    gameReachedPage5,
    historyComplete = false,
    lateGraceMs = 120_000
} = {}) {
    if (!session || !Array.isArray(session.participants) || session.participants.length !== 3
        || !session.paymentSessionId || !session.gameId || !session.roomId
        || session.roomNumber == null || session.network !== "testnet") {
        throw new RoomWalletRefundReconciliationError("INVALID_PAYMENT_SESSION");
    }
    if (gameReachedPage5 !== false) {
        throw new RoomWalletRefundReconciliationError("PAGE5_OWNERSHIP_NOT_EXCLUDED");
    }
    if (!chainEvidence || !Array.isArray(chainEvidence.transactions)
        || chainEvidence.source !== "tonapi+toncenter-v3") {
        throw new RoomWalletRefundReconciliationError("CHAIN_EVIDENCE_UNAVAILABLE");
    }
    const start = Number(session.createdAt);
    const end = Number(session.paymentDeadline ?? session.expiresAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start
        || !Number.isInteger(lateGraceMs) || lateGraceMs < 0) {
        throw new RoomWalletRefundReconciliationError("INVALID_PAYMENT_WINDOW");
    }
    const roomRaw = rawAddress(session.roomWalletAddress);
    if (!roomRaw) throw new RoomWalletRefundReconciliationError("INVALID_ROOM_WALLET");

    const participants = new Map();
    for (const participant of session.participants) {
        const wallet = rawAddress(participant.wallet ?? participant.walletAddress);
        if (!participant.playerId || !wallet || participants.has(wallet)) {
            throw new RoomWalletRefundReconciliationError("AMBIGUOUS_PARTICIPANT_WALLET");
        }
        const expected = positiveNano(
            participant.requiredAmountNano
                ?? (Number.isFinite(Number(participant.requiredGram))
                    ? Math.round(Number(participant.requiredGram) * 1e9)
                    : null)
        );
        if (expected == null) {
            throw new RoomWalletRefundReconciliationError("INVALID_EXPECTED_PAYMENT");
        }
        participants.set(wallet, { participant, expected });
    }

    const verified = new Set();
    const obligations = [];
    const manualReview = [];

    for (const tx of chainEvidence.transactions) {
        if (tx?.success !== true || !tx.in_msg) continue;
        const to = rawAddress(tx.in_msg.destination);
        const from = rawAddress(tx.in_msg.source);
        if (to !== roomRaw || !participants.has(from)) continue;

        const hash = normalizeTonTransactionHash(tx.transaction_id?.hash ?? tx.hash);
        const lt = String(tx.transaction_id?.lt ?? tx.lt ?? "");
        const amountNano = positiveNano(tx.in_msg.value);
        const timeMs = Number(tx.utime) * 1000;

        if (!hash || !/^\d+$/.test(lt) || amountNano === null
            || !Number.isSafeInteger(timeMs)) {
            manualReview.push(Object.freeze({ code: "UNPARSABLE_INBOUND_EVIDENCE" }));
            continue;
        }
        // Proof of funds near the room lifecycle, not a guess that any later
        // transfer from the same player belongs to this already-dead room.
        if (timeMs < start - 15_000 || timeMs > end + lateGraceMs) continue;

        const receipt = `${hash}:${lt}`;
        if (verified.has(receipt)) {
            throw new RoomWalletRefundReconciliationError("DUPLICATE_INBOUND_RECEIPT");
        }
        verified.add(receipt);

        const { participant, expected } = participants.get(from);
        const id = "rwrefund_" + marker([
            session.network, session.roomId, session.gameId,
            session.paymentSessionId, receipt
        ]);

        const obligation = Object.freeze({
            obligationId: id,
            kind: "ROOM_WALLET_REFUND_OBLIGATION",
            network: "testnet",
            roomId: session.roomId,
            roomNumber: Number(session.roomNumber),
            gameId: session.gameId,
            paymentSessionId: session.paymentSessionId,
            playerId: participant.playerId,
            fromRoomWallet: roomRaw,
            recipientWallet: from,
            inboundTxHash: hash,
            inboundLt: lt,
            inboundUtime: Number(tx.utime),
            grossRefundNano: amountNano.toString(),
            expectedPaymentNano: expected.toString(),
            executionAllowed: amountNano === expected,
            state: "REFUND_RECONCILIATION_REQUIRED"
        });
        obligations.push(obligation);
        if (amountNano !== expected) manualReview.push(Object.freeze({
            code: "UNEXPECTED_PAYMENT_AMOUNT",
            obligationId: id
        }));
    }

    obligations.sort((a, b) => a.inboundLt.localeCompare(b.inboundLt, "en", { numeric: true }));
    return Object.freeze({
        roomId: session.roomId,
        paymentSessionId: session.paymentSessionId,
        roomWallet: roomRaw,
        obligations: Object.freeze(obligations),
        manualReview: Object.freeze(manualReview),
        awaitingSecondProvider: Number(chainEvidence.awaitingSecondProvider ?? 0),
        // Even no observed deposits NEVER clears this quarantine until
        // history is complete and both providers have caught up.
        quarantineRequired: !historyComplete
            || Number(chainEvidence.awaitingSecondProvider ?? 0) > 0
            || obligations.length > 0
            || manualReview.length > 0,
        completedHistory: historyComplete && Number(chainEvidence.awaitingSecondProvider ?? 0) === 0
    });
}
