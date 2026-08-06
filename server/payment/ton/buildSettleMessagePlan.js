/**
 * R7.66F — Build settle body for v4 (legacy) or game (GameEscrow ABI).
 */

import {
    GAME_ESCROW_MODE_GAME,
    hashGameContractSnapshot,
    resolveGameEscrowMode
} from "./buildGameEscrowStateInit.js";
import {
    serializeGameEscrowSettleBody,
    serializeLegacySettleBody
} from "./gameContract/GameContractSerializer.js";

/**
 * @param {object} settlementRequest
 * @param {object|null} [tonConfig]
 * @returns {{
 *   ok: boolean,
 *   mode: string,
 *   snapshotHash: string|null,
 *   body: import("@ton/core").Cell|null,
 *   reason?: string
 * }}
 */
export function buildSettleMessagePlan(settlementRequest, tonConfig = null) {

    const mode = resolveGameEscrowMode(
        settlementRequest?.gameEscrowMode ?? tonConfig?.gameEscrowMode
    );

    if (mode !== GAME_ESCROW_MODE_GAME) {

        return {
            ok: true,
            mode,
            snapshotHash: settlementRequest?.snapshotHash ?? null,
            body: serializeLegacySettleBody({
                winnerAmount: settlementRequest?.winnerAmount,
                organizerAmount: settlementRequest?.organizerAmount
            })
        };

    }

    let snapshotHash = settlementRequest?.snapshotHash ?? null;

    if (!snapshotHash && settlementRequest?.snapshot) {

        snapshotHash = hashGameContractSnapshot(settlementRequest.snapshot)
            .toString("hex");

    }

    if (!snapshotHash) {

        return {
            ok: false,
            mode,
            reason: "snapshot_hash_missing",
            snapshotHash: null,
            body: null
        };

    }

    return {
        ok: true,
        mode,
        snapshotHash,
        body: serializeGameEscrowSettleBody({
            snapshotHash,
            winnerWallet: settlementRequest.winnerWallet,
            winnerAmount: settlementRequest.winnerAmount,
            ownerAmount: settlementRequest.organizerAmount
                ?? settlementRequest.ownerAmount,
            organizerAmount: settlementRequest.organizerAmount
        })
    };

}
