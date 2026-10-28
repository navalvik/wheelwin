import test from "node:test";
import assert from "node:assert/strict";
import { RoomWalletSettlementAdapter } from "../payment/roomWallet/RoomWalletSettlementAdapter.js";

test("restored refund path never broadcasts when fee estimator is unavailable", async () => {
    let transfers = 0;
    const settlement = new RoomWalletSettlementAdapter({
        roomWalletAdapter: {
            sendTransfer: async () => { transfers++; throw new Error("unexpected transfer"); },
            getBalance: async () => 3_000_000_000n,
            estimateOutboundTransferFee: async () => { throw new Error("offline estimator"); }
        },
        inspectHistory: async () => [],
        confirmPayout: async () => { throw new Error("unexpected confirmation"); }
    });
    const result = await settlement.refundPayments({
        roomNumber: 1,
        refunds: [{ playerId: "olga", wallet: "0:" + "b".repeat(64), amountNano: 1_000_000_000n }]
    });
    assert.equal(result.ok, false);
    assert.equal(transfers, 0);
});

test("restored refund path refuses zero refund without sending", async () => {
    let transfers = 0;
    const settlement = new RoomWalletSettlementAdapter({
        roomWalletAdapter: {
            sendTransfer: async () => { transfers++; throw new Error("unexpected transfer"); },
            getBalance: async () => 3_000_000_000n,
            estimateOutboundTransferFee: async () => ({ ok: true, totalNano: 1000n })
        }
    });
    const result = await settlement.refundPayments({
        roomNumber: 1,
        refunds: [{ playerId: "bob", wallet: "0:" + "c".repeat(64), amountNano: 0n }]
    });
    assert.equal(result.ok, false);
    assert.equal(transfers, 0);
});
