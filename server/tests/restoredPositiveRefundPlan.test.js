import test from "node:test";
import assert from "node:assert/strict";
import { RoomWalletSettlementAdapter } from "../payment/roomWallet/RoomWalletSettlementAdapter.js";

test("original refund computes recipient-funded gas and never sends while planning", async () => {
    let broadcasts = 0;
    let feeChecks = 0;
    const settlement = new RoomWalletSettlementAdapter({
        roomWalletAdapter: {
            sendTransfer: async () => { broadcasts++; throw new Error("broadcast forbidden"); },
            getBalance: async () => 3_000_000_000n,
            estimateOutboundTransferFee: async ({ roomNumber, amountNano }) => {
                feeChecks++;
                assert.equal(roomNumber, 1);
                assert.equal(amountNano, 1_000_000_000n);
                return {ok: true, totalNano: 1_000_000n, inFwdFeeNano: 100_000n,
                    storageFeeNano: 100_000n, gasFeeNano: 700_000n, fwdFeeNano: 100_000n};
            }
        }
    });
    const result = await settlement.planRefunds({
        roomNumber: 1,
        refunds: [{playerId: "bob", wallet: "0:"+"b".repeat(64), amountNano: 1_000_000_000n}]
    });
    assert.equal(result.ok, true);
    assert.equal(feeChecks, 1);
    assert.equal(broadcasts, 0);
    assert.equal(result.refundPlan.entries.length, 1);
    const entry = result.refundPlan.entries[0];
    const gross = BigInt(entry.grossRefundNano);
    const fee = BigInt(entry.recipientGasChargeNano);
    const net = BigInt(entry.recipientTransferAmountNano);
    assert.equal(gross, 1_000_000_000n);
    assert.ok(fee >= 1_000_000n);
    assert.equal(net + fee, gross);
    assert.ok(net > 0n);
});
