/**
 * R17.8V.2P.P — Pure helper: match reimbursement out-transfer on a chain tx.
 * No network, no signing, no wallet secrets.
 */

import { canonicalizeTonWalletAddress } from "../../models/TonWalletAddress.js";
import { reimbursementAddressesEqual } from "./ReimbursementWalletConfig.js";
import { tonStringToNanoton } from "./nanoton.js";
import { transactionHashOf } from "./extractDeployCostFromTransaction.js";

/**
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
function destinationsMatch(left, right) {

    const a = canonicalizeTonWalletAddress(left);
    const b = canonicalizeTonWalletAddress(right);

    if (a && b) {

        return a === b;

    }

    return reimbursementAddressesEqual(left, right);

}

/**
 * @param {object} msg
 * @returns {string|null}
 */
function outMsgDestination(msg) {

    return msg?.destination
        ?? msg?.recipient
        ?? msg?.to
        ?? null;

}

/**
 * @param {object} msg
 * @returns {bigint|null}
 */
function outMsgValueNanoton(msg) {

    if (!msg || typeof msg !== "object") {

        return null;

    }

    const raw = msg.value ?? msg.amount ?? null;

    if (typeof raw === "bigint") {

        return raw >= 0n ? raw : null;

    }

    if (typeof raw === "number" && Number.isFinite(raw) && Number.isInteger(raw)) {

        return BigInt(raw);

    }

    const asTon = tonStringToNanoton(String(raw ?? "").trim());

    if (asTon != null) {

        // Heuristic: values with a decimal point are TON; pure ints are nanotons.
        if (String(raw).includes(".")) {

            return asTon;

        }

    }

    const digits = String(raw ?? "").trim();

    if (/^\d+$/.test(digits)) {

        return BigInt(digits);

    }

    return asTon;

}

/**
 * Validate a reimbursement wallet transaction against expected transfer.
 *
 * @param {object|null|undefined} tx
 * @param {{
 *   txHash: string,
 *   deployWallet: string,
 *   amountTon: string,
 *   reimbursementWallet?: string|null
 * }} expected
 * @returns {{ ok: true, matchedDestination: string, amountNanoton: bigint }
 *   | { ok: false, reason: string }}
 */
export function extractReimbursementTransferFromTransaction(tx, expected = {}) {

    if (!tx || typeof tx !== "object") {

        return { ok: false, reason: "transaction_missing" };

    }

    if (tx.aborted === true) {

        return { ok: false, reason: "transaction_aborted" };

    }

    const expectedHash = String(expected.txHash ?? "").trim();
    const actualHash = transactionHashOf(tx);

    if (!expectedHash) {

        return { ok: false, reason: "expected_tx_hash_missing" };

    }

    if (!actualHash || actualHash !== expectedHash) {

        return { ok: false, reason: "transaction_hash_mismatch" };

    }

    const deployWallet = String(expected.deployWallet ?? "").trim();
    const amountTon = String(expected.amountTon ?? "").trim();
    const expectedAmount = tonStringToNanoton(amountTon);

    if (!deployWallet) {

        return { ok: false, reason: "deploy_wallet_missing" };

    }

    if (expectedAmount == null || expectedAmount <= 0n) {

        return { ok: false, reason: "amount_invalid" };

    }

    const reimbursementWallet = String(expected.reimbursementWallet ?? "").trim();

    if (reimbursementWallet) {

        const source = tx.in_msg?.source
            ?? tx.in_msg?.source_friendly
            ?? tx.account
            ?? null;

        // Soft check when source present — some fixtures omit account fields.
        if (source && !destinationsMatch(source, reimbursementWallet)) {

            // External-in messages often have null source; only reject clear mismatch.
            const canonicalSource = canonicalizeTonWalletAddress(source);

            if (canonicalSource) {

                return { ok: false, reason: "reimbursement_wallet_mismatch" };

            }

        }

    }

    const outs = tx.out_msgs ?? tx.outMessages ?? [];

    if (!Array.isArray(outs) || outs.length === 0) {

        return { ok: false, reason: "out_messages_missing" };

    }

    for (const msg of outs) {

        const destination = outMsgDestination(msg);

        if (!destination || !destinationsMatch(destination, deployWallet)) {

            continue;

        }

        const value = outMsgValueNanoton(msg);

        if (value == null) {

            return { ok: false, reason: "out_value_invalid" };

        }

        if (value !== expectedAmount) {

            return { ok: false, reason: "amount_mismatch" };

        }

        return {
            ok: true,
            matchedDestination: canonicalizeTonWalletAddress(destination)
                ?? String(destination),
            amountNanoton: value
        };

    }

    // Distinguish wrong destination vs wrong amount when outs exist.
    for (const msg of outs) {

        const destination = outMsgDestination(msg);

        if (!destination) {

            continue;

        }

        if (destinationsMatch(destination, deployWallet)) {

            return { ok: false, reason: "amount_mismatch" };

        }

    }

    return { ok: false, reason: "destination_mismatch" };

}

export { transactionHashOf };
