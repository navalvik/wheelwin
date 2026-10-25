/**
 * Composition root for the Room Wallet payment subsystem.
 *
 * This service wires the runtime resolver, registry, TON transport adapter and
 * settlement adapter without changing WheelWin gameplay or settlement math.
 *
 * PAYOUT GAS POLICY: Winner/Owner payouts and player refunds are
 * RECIPIENT_PAYS_GAS transfers (the recipient gas charge is deducted from the
 * authoritative gross payout before broadcast). The recipient gas safety
 * margin is configurable via environment with strict fail-closed validation:
 * - ROOM_WALLET_RECIPIENT_GAS_MARGIN_BPS        (default 2000 = 20%)
 * - ROOM_WALLET_RECIPIENT_GAS_MARGIN_FLOOR_NANO (default 1000000 = 0.001 GRAM)
 * Invalid values must not silently degrade the policy: they fail startup.
 */

import { RoomWalletAdapter } from "./RoomWalletAdapter.js";
import {
    createRoomWalletRuntimeResolver,
    createRoomWalletRegistryFromEnv
} from "./RoomWalletRuntimeResolver.js";
import { RoomWalletSettlementAdapter } from "./RoomWalletSettlementAdapter.js";
import { ROOM_WALLET_POLICY } from "./RoomWalletFinancialPolicy.js";

function parseRecipientGasMarginEnv(env) {
    const marginBpsRaw = String(env?.ROOM_WALLET_RECIPIENT_GAS_MARGIN_BPS ?? "").trim();
    const marginFloorRaw = String(env?.ROOM_WALLET_RECIPIENT_GAS_MARGIN_FLOOR_NANO ?? "").trim();

    let marginBps = ROOM_WALLET_POLICY.recipientGasMarginBps;
    let marginFloorNano = ROOM_WALLET_POLICY.recipientGasMarginFloorNano;

    if (marginBpsRaw !== "") {
        if (!/^\d+$/.test(marginBpsRaw)) {
            throw new TypeError(
                "ROOM_WALLET_RECIPIENT_GAS_MARGIN_BPS must be a non-negative integer"
            );
        }
        marginBps = BigInt(marginBpsRaw);
    }

    if (marginFloorRaw !== "") {
        if (!/^\d+$/.test(marginFloorRaw)) {
            throw new TypeError(
                "ROOM_WALLET_RECIPIENT_GAS_MARGIN_FLOOR_NANO must be a non-negative integer"
            );
        }
        marginFloorNano = BigInt(marginFloorRaw);
    }

    return {
        ...(marginBps === ROOM_WALLET_POLICY.recipientGasMarginBps ? {} : { recipientGasMarginBps: marginBps }),
        ...(
            marginFloorNano === ROOM_WALLET_POLICY.recipientGasMarginFloorNano
                ? {}
                : { recipientGasMarginFloorNano: marginFloorNano }
        )
    };
}

export function createRoomWalletService({
    tonService,
    logger = null,
    env = process.env,
    gasReserveNano = undefined
} = {}) {
    if (!tonService) {
        throw new Error("createRoomWalletService requires tonService");
    }

    const registry = createRoomWalletRegistryFromEnv(env);
    const walletResolver = createRoomWalletRuntimeResolver({ env, registry });
    const roomWalletAdapter = new RoomWalletAdapter({
        tonService,
        walletResolver,
        logger,
        // Default OFF until ALL refund/winner/owner/residual-sweep routes use
        // the durable signer. Once enabled, legacy direct sends hard-fail.
        guardedOutboundOnly:
            String(env?.ROOM_WALLET_GUARDED_OUTBOUND_ONLY ?? "").trim().toLowerCase() === "true",
        ...(gasReserveNano === undefined ? {} : { gasReserveNano })
    });
    const settlementAdapter = new RoomWalletSettlementAdapter({
        roomWalletAdapter,
        logger,
        ...parseRecipientGasMarginEnv(env)
    });

    return Object.freeze({
        registry,
        walletResolver,
        roomWalletAdapter,
        settlementAdapter,
        isConfigured() {
            return registry.size() > 0;
        }
    });
}
