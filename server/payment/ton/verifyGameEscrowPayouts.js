/**
 * R7.66G — Pure GameEscrow payout verification (no SDK / no network).
 */

import { canonicalizeTonWalletAddress } from "../../models/TonWalletAddress.js";

export const GAME_ESCROW_ON_CHAIN_STATUS_SETTLED = 8;

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
 * Verify GameEscrow SETTLE produced winner + owner payouts with matching amounts.
 *
 * @param {{
 *   transactions: object[],
 *   winnerAddress: string,
 *   ownerAddress: string,
 *   winnerAmount: number|string,
 *   ownerAmount: number|string,
 *   settleTxHash?: string|null,
 *   contractStatus?: number|string|null
 * }} input
 * @returns {{
 *   ok: boolean,
 *   reason: string|null,
 *   settleTxHash: string|null,
 *   winnerPayoutTx: string|null,
 *   ownerPayoutTx: string|null,
 *   status: string
 * }}
 */
export function verifyGameEscrowPayouts({
    transactions = [],
    winnerAddress,
    ownerAddress,
    winnerAmount,
    ownerAmount,
    settleTxHash = null,
    contractStatus = null
} = {}) {

    if (contractStatus != null) {

        const statusNum = Number(contractStatus);
        const settled = statusNum === GAME_ESCROW_ON_CHAIN_STATUS_SETTLED
            || String(contractStatus).toUpperCase() === "SETTLED";

        if (!settled) {

            return {
                ok: false,
                reason: "contract_not_settled",
                settleTxHash: settleTxHash ?? null,
                winnerPayoutTx: null,
                ownerPayoutTx: null,
                status: "REJECTED"
            };

        }

    }

    if (!winnerAddress || !ownerAddress) {

        return {
            ok: false,
            reason: "payout_addresses_missing",
            settleTxHash: settleTxHash ?? null,
            winnerPayoutTx: null,
            ownerPayoutTx: null,
            status: "REJECTED"
        };

    }

    let sawWinnerWrongAmount = false;
    let sawOwnerWrongAmount = false;
    let sawWinnerOk = false;
    let sawOwnerOk = false;
    let winnerPayoutTx = null;
    let ownerPayoutTx = null;
    let matchedSettleTx = null;

    for (const tx of transactions ?? []) {

        const hash = txHashOf(tx);

        if (settleTxHash && hash && hash !== String(settleTxHash)) {

            // Prefer the named settle tx when provided; still scan others if none match.
            continue;

        }

        const outs = tx?.out_msgs ?? tx?.outMessages ?? [];

        let winnerHit = null;
        let ownerHit = null;

        for (const msg of outs) {

            const destination = outMsgDestination(msg);
            const valueGram = outMsgValueGram(msg);

            if (!destination || valueGram == null) {

                continue;

            }

            if (addressEquals(destination, winnerAddress)) {

                if (amountsMatch(winnerAmount, valueGram)) {

                    winnerHit = hash;

                } else {

                    sawWinnerWrongAmount = true;

                }

            }

            if (addressEquals(destination, ownerAddress)) {

                if (amountsMatch(ownerAmount, valueGram)) {

                    ownerHit = hash;

                } else {

                    sawOwnerWrongAmount = true;

                }

            }

        }

        if (winnerHit) {

            sawWinnerOk = true;
            winnerPayoutTx = winnerHit;

        }

        if (ownerHit) {

            sawOwnerOk = true;
            ownerPayoutTx = ownerHit;

        }

        if (winnerHit && ownerHit) {

            matchedSettleTx = hash;

            return {
                ok: true,
                reason: null,
                settleTxHash: matchedSettleTx,
                winnerPayoutTx: winnerHit,
                ownerPayoutTx: ownerHit,
                status: "CONFIRMED"
            };

        }

    }

    // If a specific settleTxHash was requested but not present, scan all txs.
    if (
        settleTxHash
        && !sawWinnerOk
        && !sawOwnerOk
        && !sawWinnerWrongAmount
        && !sawOwnerWrongAmount
    ) {

        return verifyGameEscrowPayouts({
            transactions,
            winnerAddress,
            ownerAddress,
            winnerAmount,
            ownerAmount,
            settleTxHash: null,
            contractStatus
        });

    }

    if (sawWinnerWrongAmount || sawOwnerWrongAmount) {

        return {
            ok: false,
            reason: "amount_mismatch",
            settleTxHash: null,
            winnerPayoutTx: sawWinnerOk ? winnerPayoutTx : null,
            ownerPayoutTx: sawOwnerOk ? ownerPayoutTx : null,
            status: "REJECTED"
        };

    }

    if (sawWinnerOk && !sawOwnerOk) {

        return {
            ok: false,
            reason: "missing_owner_payout",
            settleTxHash: null,
            winnerPayoutTx,
            ownerPayoutTx: null,
            status: "REJECTED"
        };

    }

    if (!sawWinnerOk && sawOwnerOk) {

        return {
            ok: false,
            reason: "missing_winner_payout",
            settleTxHash: null,
            winnerPayoutTx: null,
            ownerPayoutTx,
            status: "REJECTED"
        };

    }

    return {
        ok: false,
        reason: "payouts_not_found",
        settleTxHash: settleTxHash ?? null,
        winnerPayoutTx: null,
        ownerPayoutTx: null,
        status: "PENDING"
    };

}
