import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateCancelledRoomRefund } from "../payment/RoomWalletPayoutPolicy.js";

// Amounts are *native* TON nanotons displayed as GRAM, not Jetton units.
// The network fee must be quoted separately, never fabricated from the stake.
test("cancellation refund deducts exactly the authoritative fee from each possible stake", () => {
    const fee = "10000000"; // synthetic 0.01 GRAM quote, NOT a production gas estimate
    for (const paid of ["1000000000", "2500000000", "10000000000", "25000000000"]) {
        const quote = calculateCancelledRoomRefund({
            paidUnits: paid, refundTransferFeeUnits: fee
        });
        assert.equal(BigInt(quote.refundUnits) + BigInt(quote.refundTransferFeeUnits),
            BigInt(paid), "payer's gross paid amount must cover refund plus transfer fee");
        assert.equal(quote.refundTransferFeeUnits, fee);
    }
});

test("refund fee is never allowed to equal/exceed paid amount or use fractional units", () => {
    for (const fee of ["1000000000", "1000000001", "1.1", "-1", "NaN"]) {
        assert.throws(() => calculateCancelledRoomRefund({
            paidUnits: "1000000000", refundTransferFeeUnits: fee
        }));
    }
    assert.throws(() => calculateCancelledRoomRefund({
        paidUnits: "1000000000"
    }), /refundTransferFeeUnits/);
});

test("no fee is taken when an explicit zero fee is quoted", () => {
    const quote = calculateCancelledRoomRefund({
        paidUnits: "2500000000", refundTransferFeeUnits: "0"
    });
    assert.equal(quote.refundUnits, "2500000000");
});
