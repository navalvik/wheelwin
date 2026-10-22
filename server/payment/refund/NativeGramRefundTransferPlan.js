/**
 * Strict fee-funded native GRAM refund plan.
 *
 * One consistent monetary identity for quote -> signing -> chain verification.
 * Advisory/read-only until a secure signer, broadcaster, and durable fee-plan
 * reservation are integrated. No fee is invented from a constant or percentage.
 */
import { calculateCancelledRoomRefund } from "../RoomWalletPayoutPolicy.js";
import { tonAddressIdentityOrNull, tonAddressIdentitiesEqual } from "../incoming/TonAddressIdentity.js";

const nonnegativeAtomic = value =>
    typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)
        ? BigInt(value) : null;

/**
 * A quote must be obtained from an authoritative Testnet fee estimator.
 * No transfer is signed/broadcast by this function.
 */
export function buildNativeGramRefundTransferPlan({ obligation, sourceWalletAddress, feeQuote }) {
    if (!obligation || obligation.networkName !== "TESTNET" || obligation.globalId !== -3 ||
        obligation.denomination !== "TON" ||
        tonAddressIdentityOrNull(sourceWalletAddress) === null ||
        tonAddressIdentityOrNull(obligation.refundDestination) === null ||
        tonAddressIdentitiesEqual(sourceWalletAddress, obligation.refundDestination)) {
        throw new Error("REFUND_IDENTITY_UNVERIFIED");
    }
    if (!feeQuote || feeQuote.networkName !== "TESTNET" ||
        feeQuote.globalId !== -3 ||
        feeQuote.obligationId !== obligation.obligationId ||
        !tonAddressIdentitiesEqual(feeQuote.sourceWalletAddress, sourceWalletAddress) ||
        !tonAddressIdentitiesEqual(feeQuote.destinationAddress, obligation.refundDestination) ||
        feeQuote.paidAmountAtomic !== String(obligation.amountAtomic)) {
        throw new Error("REFUND_FEE_QUOTE_IDENTITY_MISMATCH");
    }
    const fee = nonnegativeAtomic(feeQuote.maxFeeAtomic);
    if (fee === null || fee === 0n || fee > BigInt(Number.MAX_SAFE_INTEGER) ||
        feeQuote.finalized !== true || feeQuote.estimateSource !== "testnet-network-estimator") {
        throw new Error("REFUND_FEE_QUOTE_NOT_VERIFIED");
    }
    const split = calculateCancelledRoomRefund({
        paidUnits: String(obligation.amountAtomic),
        refundTransferFeeUnits: fee.toString()
    });
    return Object.freeze({
        obligationId: obligation.obligationId,
        idempotencyKey: obligation.idempotencyKey,
        networkName: "TESTNET",
        globalId: -3,
        sourceWalletAddress,
        refundDestination: obligation.refundDestination,
        originalPaidAmountAtomic: String(obligation.amountAtomic),
        refundAmountAtomic: split.refundUnits,
        reservedFeeAtomic: split.refundTransferFeeUnits,
        denomination: "TON",
        // The contract of the future signer is to send exactly refundAmountAtomic
        // and never use sendMode 128/remaining balance.
        sendRemainingBalance: false
    });
}
