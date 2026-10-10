import { createHash } from "node:crypto";

import { canonicalizeTonWalletAddress } from "../../models/TonWalletAddress.js";

const MAX_UINT64 = (1n << 64n) - 1n;

/**
 * Normalize an optional unsigned 64-bit Room Wallet message identifier.
 * The TON message body stores this as exactly 64 bits, so keeping it as a
 * decimal string avoids JavaScript Number precision loss.
 */
export function normalizeRoomWalletRefundQueryId(value) {
    if (value == null || (typeof value === "string" && value.trim() === "")) {
        return null;
    }

    let queryId;
    try {
        queryId = typeof value === "bigint" ? value : BigInt(String(value).trim());
    } catch {
        return null;
    }

    if (queryId < 0n || queryId > MAX_UINT64) {
        return null;
    }

    return queryId.toString(10);
}

/**
 * Stable per-payment-session/per-recipient refund identity.
 *
 * It is deterministic across restarts and never incorporates signing
 * material. The 64-bit value is carried in the ordinary internal-message
 * body and persisted in the frozen refund plan before any broadcast.
 */
export function deriveRoomWalletRefundQueryId({
    paymentSessionId,
    playerId,
    playerIndex,
    wallet
} = {}) {
    const sessionId = String(paymentSessionId ?? "").trim();
    const player = String(playerId ?? "").trim();
    const rawSeat = playerIndex == null ? null : Number(playerIndex);
    const seat = Number.isInteger(rawSeat) && rawSeat >= 0 ? rawSeat : null;
    const recipient = canonicalizeTonWalletAddress(wallet)
        ?? String(wallet ?? "").trim();

    if (!sessionId || !recipient || (!player && seat == null)) {
        return null;
    }

    const material = [
        "wheelwin-room-wallet-refund-query-id-v1",
        sessionId,
        player,
        seat == null ? "" : String(seat),
        recipient
    ].join("\u0000");
    const digest = createHash("sha256").update(material, "utf8").digest();
    let queryId = digest.readBigUInt64BE(0);

    if (queryId === 0n) {
        queryId = 1n;
    }

    return queryId.toString(10);
}

/**
 * Query IDs are exact transaction identities, not best-effort hints.
 * Null matches only an absent/unparseable on-chain query ID.
 */
export function roomWalletRefundQueryIdsMatch(expected, observed) {
    const expectedQueryId = normalizeRoomWalletRefundQueryId(expected);
    const observedQueryId = normalizeRoomWalletRefundQueryId(observed);
    return expectedQueryId !== null
        && observedQueryId !== null
        && expectedQueryId === observedQueryId;
}
