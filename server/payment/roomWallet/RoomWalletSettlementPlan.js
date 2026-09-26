/**
 * Room Wallet settlement planning.
 *
 * This module plans transfers only. It does not broadcast blockchain
 * transactions and does not alter WheelWin game rules.
 */

import { ROOM_WALLET_POLICY } from "./RoomWalletFinancialPolicy.js";
import { normalizeRoomNumber } from "./RoomWalletRegistry.js";

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

/**
 * Residual sweep is a Room Wallet treasury plan keyed by roomNumber.
 * It does not use gameplay roomId, gameId, or array indexes.
 */
export function buildResidualSweepPlan({ roomNumber, residuesWallet } = {}) {

    let normalizedRoomNumber;

    try {
        normalizedRoomNumber = normalizeRoomNumber(roomNumber);
    } catch {
        return {
            ok: false,
            code: "INVALID_RESIDUAL_SWEEP_PLAN"
        };
    }

    const destination = String(residuesWallet ?? "").trim();

    if (!destination) {
        return {
            ok: false,
            code: "INVALID_RESIDUAL_SWEEP_PLAN"
        };
    }

    return {
        ok: true,
        kind: "RESIDUAL_SWEEP",
        roomNumber: normalizedRoomNumber,
        destination,
        amountNano: ROOM_WALLET_POLICY.residualSweepNano,
        triggerNano: ROOM_WALLET_POLICY.residualTriggerNano,
        retainedFloorNano: ROOM_WALLET_POLICY.residualRetainedFloorNano,
        sweepGasNano: ROOM_WALLET_POLICY.residualSweepGasNano,
        safetyMarginNano: ROOM_WALLET_POLICY.residualSafetyMarginNano,
        gasSource: "ROOM_WALLET"
    };

}
