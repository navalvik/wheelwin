/**
 * Runtime configuration gate for Room Wallet settlement.
 *
 * This module deliberately contains no private keys and does not enable the
 * new settlement path unless explicitly requested by configuration.
 */

import { RoomWalletSettlementRouter } from "../RoomWalletSettlementRouter.js";
import { createRoomWalletService } from "./RoomWalletService.js";

export function isRoomWalletSettlementEnabled(env = process.env) {
    const value = String(env.ROOM_WALLET_SETTLEMENT_MODE || "").trim().toUpperCase();
    return value === "ROOM_WALLET";
}

export function assertRoomWalletSettlementCanBeEnabled(service) {
    if (!service || typeof service.isConfigured !== "function" || !service.isConfigured()) {
        throw new Error("ROOM_WALLET settlement requested but Room Wallet runtime configuration is not available");
    }
}

/**
 * Compose the settlement adapter passed to ContractSettlementManager.
 *
 * Default (mode absent/invalid): legacy GameEscrow adapter via a disabled router.
 * ROOM_WALLET_SETTLEMENT_MODE=ROOM_WALLET requires valid runtime wallet config
 * and fails closed when that configuration is missing.
 */
export function composeRoomWalletSettlementRouter({
    legacySettlementAdapter,
    tonService = null,
    logger = null,
    env = process.env
} = {}) {
    if (!legacySettlementAdapter) {
        throw new Error("composeRoomWalletSettlementRouter requires legacySettlementAdapter");
    }

    if (!isRoomWalletSettlementEnabled(env)) {
        return new RoomWalletSettlementRouter({
            legacySettlementAdapter,
            enabled: false
        });
    }

    if (!tonService) {
        throw new Error(
            "ROOM_WALLET settlement requested but tonService is not available"
        );
    }

    const service = createRoomWalletService({
        tonService,
        logger,
        env
    });

    assertRoomWalletSettlementCanBeEnabled(service);

    return new RoomWalletSettlementRouter({
        legacySettlementAdapter,
        roomWalletSettlementAdapter: service.settlementAdapter,
        enabled: true
    });
}
