import assert from "node:assert/strict";
import { test } from "node:test";
import {
    calculateRoomPayout,
    calculateCancelledRoomRefund
} from "../payment/RoomWalletPayoutPolicy.js";

test("winner gets exactly 95 percent, with fees and owner inside remaining five", () => {
    const result = calculateRoomPayout({
        totalPoolUnits: "30000000000",
        winnerTransferFeeUnits: "3000000",
        ownerTransferFeeUnits: "2000000",
        retainedBalanceUnits: "5000000"
    });
    assert.equal(result.winnerUnits, "28500000000");
    assert.equal(result.ownerUnits, "1490000000");
    assert.equal(
        BigInt(result.winnerUnits) + BigInt(result.ownerUnits)
        + BigInt(result.winnerTransferFeeUnits)
        + BigInt(result.ownerTransferFeeUnits)
        + BigInt(result.retainedBalanceUnits),
        30000000000n
    );
});

test("settlement fails closed when the five-percent allowance cannot cover fees", () => {
    assert.throws(() => calculateRoomPayout({
        totalPoolUnits: "100",
        winnerTransferFeeUnits: "6",
        ownerTransferFeeUnits: "0"
    }), /exceed/);
});

test("pre-Page5 refund deducts the player's outgoing fee", () => {
    const result = calculateCancelledRoomRefund({
        paidUnits: "10000000000",
        refundTransferFeeUnits: "3000000"
    });
    assert.equal(result.refundUnits, "9997000000");
    assert.throws(() => calculateCancelledRoomRefund({
        paidUnits: "3",
        refundTransferFeeUnits: "3"
    }), /smaller/);
});

test("reject non-integer, negative, or mixed-form amounts", () => {
    for (const bad of ["-1", "1.5", "1e9", "01", "NaN"]) {
        assert.throws(() => calculateCancelledRoomRefund({
            paidUnits: bad,
            refundTransferFeeUnits: "1"
        }));
    }
});
