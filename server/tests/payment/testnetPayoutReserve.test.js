import test from "node:test";
import assert from "node:assert/strict";
import { RoomPayoutCalculator } from "../../payment/ledger/RoomPayoutCalculator.js";
import { PayoutPlan } from "../../payment/ledger/PayoutPlan.js";

const params = {
    payoutId: "oj7v-new-game",
    roomId: "new-testnet-room",
    asset: "TON",
    network: "testnet",
    principalAtomic: 3_000_000_000,
    safetyMarginAtomic: 10_000_000,
    winner: { recipientId: "Lena", address: "0:" + "a".repeat(64) },
    owner: { recipientId: "WheelWin", address: "0:" + "b".repeat(64) },
    networkFees: { winner: {feeAtomic: 4_000_000}, owner: {feeAtomic: 2_000_000}},
    nowMs: 1_800_000_000_000
};

test("3x1 GRAM settled -> 2.85 winner gross, 0.14 owner gross, 0.01 room reserve",()=>{
    const p=RoomPayoutCalculator.computePlan(params);
    assert.equal(p.transferFor("WINNER").grossAtomic,2_850_000_000);
    assert.equal(p.transferFor("OWNER").grossAtomic,140_000_000);
    assert.equal(p.transferFor("WINNER").netAtomic,2_846_000_000);
    assert.equal(p.transferFor("OWNER").netAtomic,138_000_000);
    assert.equal(p.safetyMarginAtomic,10_000_000);
    assert.equal(p.reconcile(),true);
    assert.equal(
        p.totalNetAtomic+p.totalReservedFeeAtomic+p.safetyMarginAtomic,
        params.principalAtomic
    );
    const json = p.toJSON();
    assert.equal(json.safetyMarginAtomic,10_000_000);
    assert.equal(PayoutPlan.fromJSON(json).reconcile(),true);
});
test("no implicit reserve in historical payout plans; replay remains backward compatible",()=>{
    const old=RoomPayoutCalculator.computePlan({...params,safetyMarginAtomic:undefined});
    assert.equal(old.safetyMarginAtomic,0);
    assert.equal(old.transferFor("OWNER").grossAtomic,150_000_000);
    assert.equal(PayoutPlan.fromJSON(old.toJSON()).reconcile(),true);
});
test("reserve cannot create negative owner or exceed available principal",()=>{
    for(const value of [150_000_001,3_000_000_000,-1,1.5,NaN]){
        assert.throws(()=>RoomPayoutCalculator.computePlan({...params,safetyMarginAtomic:value}));
    }
});
test("10 GRAM per seat retains the same fixed room margin while preserving 95/5 winner rule",()=>{
    const p=RoomPayoutCalculator.computePlan({...params,principalAtomic:30_000_000_000});
    assert.equal(p.transferFor("WINNER").grossAtomic,28_500_000_000);
    assert.equal(p.transferFor("OWNER").grossAtomic,1_490_000_000);
    assert.equal(p.safetyMarginAtomic,10_000_000);
});
