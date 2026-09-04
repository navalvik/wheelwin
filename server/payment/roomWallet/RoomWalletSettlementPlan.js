/**
 * Room Wallet settlement planning.
 *
 * This module plans transfers only. It does not broadcast blockchain
 * transactions and does not alter WheelWin game rules.
 */

import { ROOM_WALLET_POLICY } from "./RoomWalletFinancialPolicy.js";

export function buildOwnerPayoutPlan({ gameId, roomId, ownerWallet }) {

    const normalizedGameId = String(gameId ?? "").trim();
    const normalizedRoomId = String(roomId ?? "").trim();
    const destination = String(ownerWallet ?? "").trim();

    if (!normalizedGameId || !normalizedRoomId || !destination) {
        return {
            ok: false,
            code: "INVALID_OWNER_PAYOUT_PLAN"
        };
    }

    return {
        ok: true,
        kind: "OWNER_PAYOUT",
        gameId: normalizedGameId,
        roomId: normalizedRoomId,
        destination,
        amountNano: ROOM_WALLET_POLICY.ownerPayoutMinimumNano,
        retainedNano: ROOM_WALLET_POLICY.ownerRetainedNano,
        gasSource: "ROOM_WALLET"
    };

}

export function buildResidualSweepPlan({ roomId, residuesWallet }) {

    const normalizedRoomId = String(roomId ?? "").trim();
    const destination = String(residuesWallet ?? "").trim();

    if (!normalizedRoomId || !destination) {
        return {
            ok: false,
            code: "INVALID_RESIDUAL_SWEEP_PLAN"
        };
    }

    return {
        ok: true,
        kind: "RESIDUAL_SWEEP",
        roomId: normalizedRoomId,
        destination,
        amountNano: ROOM_WALLET_POLICY.residualSweepNano,
        gasSource: "ROOM_WALLET",
        triggerNano: ROOM_WALLET_POLICY.residualTriggerNano,
    };

}
