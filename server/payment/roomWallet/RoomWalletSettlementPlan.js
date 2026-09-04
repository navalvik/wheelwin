/**
 * Room Wallet settlement planning.
 *
 * This module plans transfers only. It does not broadcast blockchain
 * transactions and does not alter WheelWin game rules.
 */

import {
    OWNER_PAYOUT_NANO,
    RESIDUAL_SWEEP_NANO,
    ROOM_RESERVE_NANO
} from "./RoomWalletFinancialPolicy.js";

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
        amountNano: OWNER_PAYOUT_NANO,
        retainedNano: ROOM_RESERVE_NANO,
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
        amountNano: RESIDUAL_SWEEP_NANO,
        gasSource: "ROOM_WALLET",
        triggerNano: 500000000n
    };

}
