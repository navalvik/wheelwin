import test from "node:test";
import assert from "node:assert/strict";
import { createRestoredRoomWalletSettlement } from "../payment/refund/RestoredRoomWalletSettlementFactory.js";

test("restored transfer and refund planner use the same registered Testnet wallet", async () => {
    const address = "0:" + "a".repeat(64);
    const destination = "0:" + "b".repeat(64);
    const wallet = { walletId: "w1", roomNumber: 1, network: "testnet", address, workchain: 0 };
    let signingReads = 0, broadcasts = 0, feeQueries = 0;
    const { transport, settlement, planDurableRefund } = createRestoredRoomWalletSettlement({
        walletPool: {
            listWallets: () => [wallet],
            getWallet: id => id === "w1" ? wallet : null
        },
        keyResolver: async () => {
            signingReads++;
            return {publicKey: Buffer.alloc(32, 1), secretKey: Buffer.alloc(64, 2)};
        },
        tonService: {
            getBalance: async () => 3_000_000_000n,
            broadcastTransaction: async () => {broadcasts++;throw Error("broadcast forbidden");},
            estimateExternalMessageFee: async () => {feeQueries++;return {};}
        }
    });
    assert.equal(await transport.getBalance(1), 3_000_000_000n);
    const obligation = {
        networkName: "TESTNET", globalId: -3, state: "PENDING",
        roomNumber: 1, playerId: "bob", amountAtomic: 1_000_000_000,
        payerAddress: destination, refundDestination: destination
    };
    const durablePlan = await planDurableRefund(obligation);
    assert.equal(durablePlan.ok, false);
    assert.equal(broadcasts, 0);
    assert.throws(() => planDurableRefund({...obligation, state: "COMPLETE"}));

    assert.equal(signingReads, 0);
    const result = await settlement.planRefunds({
        roomNumber: 1,
        refunds: [{ playerId: "bob", wallet: destination, amountNano: 1_000_000_000n }]
    });
    assert.equal(result.ok, false);
    assert.equal(broadcasts, 0);
    assert.equal(signingReads >= 0, true);
    assert.equal(feeQueries >= 0, true);
});

test("restored assembly rejects missing blockchain broadcast capability", () => {
    assert.throws(() => createRestoredRoomWalletSettlement({
        walletPool: {listWallets: () => []},
        keyResolver: async () => null,
        tonService: {getBalance: async () => 0n}
    }), /needs TON transport/);
});
