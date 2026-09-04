/**
 * Runtime configuration gate for Room Wallet settlement.
 *
 * This module deliberately contains no private keys and does not enable the
 * new settlement path unless explicitly requested by configuration.
 */

export function isRoomWalletSettlementEnabled(env = process.env) {
    const value = String(env.ROOM_WALLET_SETTLEMENT_MODE || "").trim().toUpperCase();
    return value === "ROOM_WALLET";
}

export function assertRoomWalletSettlementCanBeEnabled(service) {
    if (!service || typeof service.isConfigured !== "function" || !service.isConfigured()) {
        throw new Error("ROOM_WALLET settlement requested but Room Wallet runtime configuration is not available");
    }
}
