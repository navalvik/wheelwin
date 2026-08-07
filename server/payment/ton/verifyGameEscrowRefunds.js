/**
 * R7.69C — Pure GameEscrow refund verification (no SDK / no network).
 */

import { canonicalizeTonWalletAddress } from "../../models/TonWalletAddress.js";

export const GAME_ESCROW_ON_CHAIN_STATUS_CANCELLED = 9;

function amountsMatch(expected, actual) {

    const left = Number(expected);
    const right = Number(actual);

    if (!Number.isFinite(left) || !Number.isFinite(right)) {

        return false;

    }

    return Math.round(left * 100) === Math.round(right * 100);

}

function txHashOf(tx) {

    return String(
        tx?.transaction_id?.hash
        ?? tx?.txHash
        ?? tx?.hash
        ?? ""
    ) || null;

}

function outMsgValueGram(msg) {

    if (!msg || typeof msg !== "object") {

        return null;

    }

    if (msg.grmAmount != null && Number.isFinite(Number(msg.grmAmount))) {

        return Number(msg.grmAmount);

    }

    if (msg.amountIsGram === true || msg.currency === "GRM") {

        const direct = Number(msg.value ?? msg.amount);

        return Number.isFinite(direct) ? direct : null;

    }

    const raw = msg.value ?? msg.amount ?? null;

    if (raw == null) {

        return null;

    }

    const asNumber = Number(raw);

    if (!Number.isFinite(asNumber)) {

        return null;

    }

    // TonCenter out_msg.value is nanotons.
    return asNumber / 1e9;

}

function outMsgDestination(msg) {

    return canonicalizeTonWalletAddress(
        msg?.destination
        ?? msg?.recipient
        ?? msg?.to
        ?? null
    );

}

function addressEquals(left, right) {

    const a = canonicalizeTonWalletAddress(left);
    const b = canonicalizeTonWalletAddress(right);

    if (!a || !b) {

        return false;

    }

    return a === b;

}

/**
 * Verify GameEscrow EMERGENCY_CANCEL produced exact refunds for paid seats.
 *
 * @param {{
 *   transactions: object[],
 *   refunds: Array<{ playerIndex: number, wallet: string, amount: number|string }>,
 *   expectedRefundMask?: number|null,
 *   cancelTxHash?: string|null,
 *   contractStatus?: number|string|null
 * }} input
 */
export function verifyGameEscrowRefunds({
    transactions = [],
    refunds = [],
    expectedRefundMask = null,
    cancelTxHash = null,
    contractStatus = null
} = {}) {

    if (contractStatus != null) {

        const statusNum = Number(contractStatus);
        const cancelled = statusNum === GAME_ESCROW_ON_CHAIN_STATUS_CANCELLED
            || String(contractStatus).toUpperCase() === "CANCELLED";

        if (!cancelled) {

            return {
                ok: false,
                reason: "contract_not_cancelled",
                cancelTxHash: cancelTxHash ?? null,
                refundTxs: Object.freeze([]),
                confirmedMask: 0,
                status: "REJECTED"
            };

        }

    }

    const expected = (refunds ?? [])
        .filter((entry) => entry?.wallet && entry?.amount != null)
        .map((entry) => ({
            playerIndex: Number(entry.playerIndex),
            wallet: canonicalizeTonWalletAddress(entry.wallet) ?? entry.wallet,
            amount: entry.amount,
            bit: 1 << Number(entry.playerIndex)
        }));

    if (expected.length === 0) {

        // No paid seats to refund — cancel with empty refunds is valid once CANCELLED.
        if (
            contractStatus != null
            || expectedRefundMask === 0
            || expectedRefundMask == null
        ) {

            return {
                ok: true,
                reason: null,
                cancelTxHash: cancelTxHash ?? null,
                refundTxs: Object.freeze([]),
                confirmedMask: 0,
                status: "CONFIRMED"
            };

        }

        return {
            ok: false,
            reason: "refund_targets_missing",
            cancelTxHash: cancelTxHash ?? null,
            refundTxs: Object.freeze([]),
            confirmedMask: 0,
            status: "REJECTED"
        };

    }

    const confirmedByIndex = new Map();
    let sawAmountMismatch = false;
    let matchedCancelTx = null;

    for (const tx of transactions ?? []) {

        const hash = txHashOf(tx);

        if (cancelTxHash && hash && hash !== String(cancelTxHash)) {

            continue;

        }

        const outs = tx?.out_msgs ?? tx?.outMessages ?? [];

        for (const msg of outs) {

            const destination = outMsgDestination(msg);
            const valueGram = outMsgValueGram(msg);

            if (!destination || valueGram == null) {

                continue;

            }

            for (const target of expected) {

                if (!addressEquals(destination, target.wallet)) {

                    continue;

                }

                if (amountsMatch(target.amount, valueGram)) {

                    confirmedByIndex.set(target.playerIndex, hash);
                    matchedCancelTx = matchedCancelTx ?? hash;

                } else {

                    sawAmountMismatch = true;

                }

            }

        }

        if (confirmedByIndex.size === expected.length) {

            break;

        }

    }

    // If a specific cancelTxHash was requested but not present, scan all txs.
    if (
        cancelTxHash
        && confirmedByIndex.size === 0
        && !sawAmountMismatch
    ) {

        return verifyGameEscrowRefunds({
            transactions,
            refunds,
            expectedRefundMask,
            cancelTxHash: null,
            contractStatus
        });

    }

    let confirmedMask = 0;

    const refundTxs = [];

    for (const target of expected) {

        const hash = confirmedByIndex.get(target.playerIndex) ?? null;

        if (hash) {

            confirmedMask |= target.bit;

            refundTxs.push(Object.freeze({
                playerIndex: target.playerIndex,
                wallet: target.wallet,
                amount: target.amount,
                txHash: hash
            }));

        }

    }

    if (sawAmountMismatch && confirmedByIndex.size < expected.length) {

        return {
            ok: false,
            reason: "amount_mismatch",
            cancelTxHash: matchedCancelTx,
            refundTxs: Object.freeze(refundTxs),
            confirmedMask,
            status: "REJECTED"
        };

    }

    if (confirmedByIndex.size === expected.length) {

        if (
            expectedRefundMask != null
            && (confirmedMask & Number(expectedRefundMask)) !== Number(expectedRefundMask)
        ) {

            return {
                ok: false,
                reason: "refund_mask_mismatch",
                cancelTxHash: matchedCancelTx,
                refundTxs: Object.freeze(refundTxs),
                confirmedMask,
                status: "REJECTED"
            };

        }

        return {
            ok: true,
            reason: null,
            cancelTxHash: matchedCancelTx ?? cancelTxHash ?? null,
            refundTxs: Object.freeze(refundTxs),
            confirmedMask,
            status: "CONFIRMED"
        };

    }

    return {
        ok: false,
        reason: "refunds_not_found",
        cancelTxHash: cancelTxHash ?? null,
        refundTxs: Object.freeze(refundTxs),
        confirmedMask,
        status: "PENDING"
    };

}
