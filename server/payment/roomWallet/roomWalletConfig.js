/**
 * Runtime configuration gate for Room Wallet settlement.
 *
 * This module deliberately contains no private keys and does not enable the
 * new settlement path unless explicitly requested by configuration.
 */

import { RoomWalletSettlementRouter } from "../RoomWalletSettlementRouter.js";
import { createRoomWalletService } from "./RoomWalletService.js";
import {
    TON_RESIDUES_EXPECTED_ADDRESS_ENV,
    resolveResiduesWalletDestination as resolveResiduesWalletDestinationIdentity
} from "./ResiduesWalletConfig.js";

export const ROOM_WALLET_RESIDUAL_SWEEP_ENABLED_ENV =
    "ROOM_WALLET_RESIDUAL_SWEEP_ENABLED";
export { TON_RESIDUES_EXPECTED_ADDRESS_ENV };

export function isRoomWalletSettlementEnabled(env = process.env) {
    const value = String(env.ROOM_WALLET_SETTLEMENT_MODE || "").trim().toUpperCase();
    return value === "ROOM_WALLET";
}

/**
 * Player-payment intake is independent of settlement.
 * ROOM_WALLET_SETTLEMENT_MODE does not enable this path.
 */
export function isRoomWalletPaymentIntakeEnabled(env = process.env) {
    const value = String(env.ROOM_WALLET_PAYMENT_INTAKE_MODE || "").trim().toUpperCase();
    return value === "ROOM_WALLET";
}

/**
 * Residual sweep send gate. Default OFF. Independent of payment intake
 * and of ROOM_WALLET_SETTLEMENT_MODE.
 */
export function isRoomWalletResidualSweepEnabled(env = process.env) {
    const raw = String(env?.[ROOM_WALLET_RESIDUAL_SWEEP_ENABLED_ENV] ?? "")
        .trim()
        .toLowerCase();
    return raw === "true" || raw === "1" || raw === "yes";
}

/**
 * Public Residues receive address. Prefer TON_RESIDUES_EXPECTED_ADDRESS.
 * Compatibility fallback: TON_REIMBURSEMENT_EXPECTED_ADDRESS (same identity).
 * Missing or invalid must not crash startup and must not authorize a sweep send.
 */
export function resolveResiduesWalletDestination(env = process.env) {
    return resolveResiduesWalletDestinationIdentity(env);
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
