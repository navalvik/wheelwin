/**
 * R17.8V.2P.K — Extract DEPLOY attach + fee from a confirmed TonCenter transaction.
 *
 * Pure helper: no network, no ValueTon, no config.
 */

import { canonicalizeTonWalletAddress } from "../../models/TonWalletAddress.js";
import { parseNanoton } from "./nanoton.js";

/**
 * @param {object|null|undefined} tx
 * @returns {string|null}
 */
export function transactionHashOf(tx) {

    const hash = String(
        tx?.transaction_id?.hash
        ?? tx?.txHash
        ?? tx?.hash
        ?? ""
    ).trim();

    return hash || null;

}

/**
 * @param {object} msg
 * @returns {string|null}
 */
function outMsgDestination(msg) {

    return canonicalizeTonWalletAddress(
        msg?.destination
        ?? msg?.recipient
        ?? msg?.to
        ?? null
    );

}

/**
 * @param {object} msg
 * @returns {bigint|null}
 */
function outMsgValueNanoton(msg) {

    if (!msg || typeof msg !== "object") {

        return null;

    }

    return parseNanoton(msg.value ?? msg.amount ?? null);

}

/**
 * TonCenter v2 fee fields are nanotons. Prefer total `fee`, else sum parts.
 *
 * @param {object} tx
 * @returns {bigint|null}
 */
export function extractNetworkFeeNanoton(tx) {

    if (!tx || typeof tx !== "object") {

        return null;

    }

    const total = parseNanoton(tx.fee);

    if (total != null) {

        return total;

    }

    const storage = parseNanoton(tx.storage_fee) ?? 0n;
    const other = parseNanoton(tx.other_fee) ?? 0n;
    const gas = parseNanoton(tx.gas_fee) ?? 0n;
    const sum = storage + other + gas;

    return sum > 0n ? sum : null;

}

/**
 * @param {object} tx
 * @param {{ contractAddress: string, deploymentTxHash?: string|null }} options
 * @returns {{
 *   ok: true,
 *   attachedNanoton: bigint,
 *   networkFeeNanoton: bigint,
 *   deploymentCostNanoton: bigint,
 *   matchedOutDestination: string
 * } | {
 *   ok: false,
 *   reason: string
 * }}
 */
export function extractDeployCostFromTransaction(tx, options = {}) {

    if (!tx || typeof tx !== "object") {

        return { ok: false, reason: "transaction_missing" };

    }

    const contractAddress = canonicalizeTonWalletAddress(options.contractAddress);

    if (!contractAddress) {

        return { ok: false, reason: "contract_address_invalid" };

    }

    const expectedHash = options.deploymentTxHash
        ? String(options.deploymentTxHash).trim()
        : null;

    if (expectedHash) {

        const actualHash = transactionHashOf(tx);

        if (!actualHash || actualHash !== expectedHash) {

            return { ok: false, reason: "transaction_hash_mismatch" };

        }

    }

    const outs = tx.out_msgs ?? tx.outMessages ?? [];

    if (!Array.isArray(outs) || outs.length === 0) {

        return { ok: false, reason: "out_messages_missing" };

    }

    let attachedNanoton = null;
    let matchedOutDestination = null;

    for (const msg of outs) {

        const destination = outMsgDestination(msg);

        if (!destination || destination !== contractAddress) {

            continue;

        }

        const value = outMsgValueNanoton(msg);

        if (value == null || value <= 0n) {

            return { ok: false, reason: "attached_value_invalid" };

        }

        attachedNanoton = value;
        matchedOutDestination = destination;
        break;

    }

    if (attachedNanoton == null) {

        return { ok: false, reason: "attached_out_message_missing" };

    }

    const networkFeeNanoton = extractNetworkFeeNanoton(tx);

    if (networkFeeNanoton == null || networkFeeNanoton < 0n) {

        return { ok: false, reason: "network_fee_invalid" };

    }

    // Fee may be 0 on some fixtures; allow >= 0. Real DEPLOY has fee > 0.
    const deploymentCostNanoton = attachedNanoton + networkFeeNanoton;

    if (deploymentCostNanoton <= 0n) {

        return { ok: false, reason: "deployment_cost_invalid" };

    }

    return {
        ok: true,
        attachedNanoton,
        networkFeeNanoton,
        deploymentCostNanoton,
        matchedOutDestination
    };

}
