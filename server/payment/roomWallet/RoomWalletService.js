/**
 * Composition root for the Room Wallet payment subsystem.
 *
 * This service wires the runtime resolver, registry, TON transport adapter and
 * settlement adapter without changing WheelWin gameplay or settlement math.
 */

import { RoomWalletAdapter } from "./RoomWalletAdapter.js";
import {
    createRoomWalletRuntimeResolver,
    createRoomWalletRegistryFromEnv
} from "./RoomWalletRuntimeResolver.js";
import { RoomWalletSettlementAdapter } from "./RoomWalletSettlementAdapter.js";

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
        ...(gasReserveNano === undefined ? {} : { gasReserveNano })
    });
    const settlementAdapter = new RoomWalletSettlementAdapter({
        roomWalletAdapter,
        logger
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
