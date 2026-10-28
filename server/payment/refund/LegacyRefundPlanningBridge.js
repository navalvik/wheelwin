import { tonAddressIdentitiesEqual } from "../incoming/TonAddressIdentity.js";

/**
 * Read-only conversion from a durable Testnet refund obligation to the
 * October room-wallet refund PLANNING contract. Never submits transfers.
 */
export function planLegacyRoomWalletRefund({ obligation, settlement }) {
    if (!obligation || obligation.networkName !== "TESTNET" ||
        obligation.globalId !== -3 || obligation.state !== "PENDING" ||
        !Number.isSafeInteger(obligation.roomNumber) || obligation.roomNumber < 1 ||
        obligation.roomNumber > 64 ||
        !Number.isSafeInteger(obligation.amountAtomic) || obligation.amountAtomic <= 0 ||
        typeof obligation.refundDestination !== "string" ||
        !tonAddressIdentitiesEqual(obligation.refundDestination, obligation.payerAddress) ||
        typeof obligation.playerId !== "string" || !obligation.playerId ||
        typeof settlement?.planRefunds !== "function") {
        throw new Error("unsupported or non-pending Testnet refund obligation");
    }
    return settlement.planRefunds({
        roomNumber: obligation.roomNumber,
        refunds: [{
            playerId: obligation.playerId,
            wallet: obligation.refundDestination,
            amountNano: BigInt(obligation.amountAtomic)
        }]
    });
}
