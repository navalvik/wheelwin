import { RoomWalletAdapter } from "../roomWallet/RoomWalletAdapter.js";
import { RoomWalletSettlementAdapter } from "../roomWallet/RoomWalletSettlementAdapter.js";
import { createLegacyRoomWalletIdentityResolver } from "./LegacyRoomWalletIdentityBridge.js";
import { planLegacyRoomWalletRefund } from "./LegacyRefundPlanningBridge.js";

/**
 * Reassemble the October native-transfer and settlement pair.
 * No execution is triggered by construction. Only the already assigned
 * Testnet wallet is available through the protected key resolver.
 *
 * This is intentionally NOT wired into application startup: the durable
 * refund lifecycle has a different submission contract and needs a verified
 * adapter before payment acceptance can be enabled.
 */
export function createRestoredRoomWalletSettlement({
    walletPool, keyResolver, tonService, logger = null,
    inspectHistory, confirmPayout
} = {}) {
    if (!tonService || typeof tonService.getBalance !== "function" ||
        typeof tonService.broadcastTransaction !== "function") {
        throw new Error("restored room-wallet settlement needs TON transport");
    }
    const walletResolver = createLegacyRoomWalletIdentityResolver({
        walletPool, keyResolver
    });
    const transport = new RoomWalletAdapter({
        tonService, walletResolver, logger
    });
    const settlement = new RoomWalletSettlementAdapter({
        roomWalletAdapter: transport, logger,
        ...(inspectHistory ? { inspectHistory } : {}),
        ...(confirmPayout ? { confirmPayout } : {})
    });
    return Object.freeze({
        transport,
        settlement,
        // Read-only preparation from current durable refund obligations.
        // This never calls refundPayments/sendTransfer and cannot move funds.
        planDurableRefund(obligation) {
            return planLegacyRoomWalletRefund({ obligation, settlement });
        }
    });
}
