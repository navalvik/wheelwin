/**
 * R17.9L.5A — Deterministic hashes for deposit bindings and deploy authorization.
 * Uses the same sha256 + stableStringify pattern as TonFinancialPersistence.
 */

import { createHash } from "node:crypto";

import { stableStringify } from "../persistence/tonFinancialRecordUtils.js";

function sha256Hex(value) {

    return createHash("sha256")
        .update(stableStringify(value), "utf8")
        .digest("hex");

}

export function computeDepositBindingHash({
    roomId,
    gameId,
    depositId,
    bindings = []
} = {}) {

    return sha256Hex({
        roomId: String(roomId ?? ""),
        gameId: String(gameId ?? ""),
        depositId: String(depositId ?? ""),
        bindings: (Array.isArray(bindings) ? bindings : []).map((binding) => ({
            playerId: String(binding?.playerId ?? ""),
            wallet: String(binding?.wallet ?? ""),
            expectedAmount: Number(binding?.expectedAmount)
        }))
    });

}

export function computeDeploymentAuthorizationHash({
    roomId,
    gameId,
    depositId,
    bindingHash,
    createdAt,
    network
} = {}) {

    return sha256Hex({
        roomId: String(roomId ?? ""),
        gameId: String(gameId ?? ""),
        depositId: String(depositId ?? ""),
        bindingHash: String(bindingHash ?? ""),
        createdAt: Number(createdAt),
        network: String(network ?? "")
    });

}
