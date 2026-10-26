import test from "node:test";
import assert from "node:assert/strict";
import { planLegacyRoomWalletRefund } from "../payment/refund/LegacyRefundPlanningBridge.js";
const obligation = { networkName: "TESTNET", globalId: -3, state: "PENDING",
    roomNumber: 2, playerId: "bob", amountAtomic: 1000000000,
    refundDestination: "0:"+"a".repeat(64), payerAddress: "0:"+"a".repeat(64) };
test("durable refund maps to original planning shape without transfers", async () => {
    let called = 0;
    const result = await planLegacyRoomWalletRefund({obligation,settlement:{
        planRefunds: async request => {called++; assert.deepEqual(request,{
            roomNumber: 2, refunds: [{playerId:"bob",wallet:obligation.payerAddress,amountNano:1000000000n}]
        });return {ok:true};}
    }});
    assert.equal(called,1);assert.equal(result.ok,true);
});
test("refuses completed and misdirected refunds before planning", async () => {
    let called = 0;
    const settlement = {planRefunds: async () => {called++;}};
    assert.throws(() => planLegacyRoomWalletRefund({obligation:{...obligation,state:"COMPLETE"},settlement}));
    assert.throws(() => planLegacyRoomWalletRefund({obligation:{...obligation,refundDestination:"other"},settlement}));
    assert.throws(() => planLegacyRoomWalletRefund({obligation:{...obligation,networkName:"MAINNET"},settlement}));
    assert.equal(called,0);
});
