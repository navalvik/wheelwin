import { RoomPayoutCalculator } from "../../payment/ledger/RoomPayoutCalculator.js";

// Storage schema label only; payout math and rounding are owned by the shared
// Testnet RoomPayoutCalculator implementation.
export const MAINNET_PAYOUT_RULE_ID = "MAINNET_WINNER_95_OWNER_4_9_RESERVE_0_1";

/** Mainnet adapter over the shared network-independent payout calculator. */
export function calculateMainnetPayout(principalAtomic) {
    const allocation = RoomPayoutCalculator.allocatePrincipal(principalAtomic);
    return Object.freeze({
        principalAtomic: allocation.principalAtomic,
        winnerAtomic: allocation.winnerGrossAllocationAtomic,
        ownerAtomic: allocation.ownerGrossAllocationAtomic,
        reserveAtomic: allocation.gasReserveAtomic,
        ruleId: MAINNET_PAYOUT_RULE_ID
    });
}
