import test from "node:test";
import assert from "node:assert/strict";
import {RoomPayoutCalculator} from "../payment/ledger/RoomPayoutCalculator.js";
import {PayoutPlan} from "../payment/ledger/PayoutPlan.js";
import {
    APPROVED_WINNER_RULE_ID,
    LEGACY_OWNER_4_9_RULE_ID
} from "../payment/ledger/PayoutAllocationConfig.js";

const input={
    payoutId:"payout_"+"1".repeat(32),roomId:"historical-payout-recovery",
    asset:"TON",network:"mainnet",principalAtomic:3_000_000_000,
    nowMs:1_800_000_000_000,
    winner:{recipientId:"Olga",address:"0:"+"a".repeat(64)},
    owner:{recipientId:"WheelWin",address:"0:"+"b".repeat(64)}
};

test("new Testnet/Mainnet payout plans allocate exact 95/4.95/0.05 with no fee deduction",()=>{
    for(const network of ["testnet","mainnet"]){
        const plan=RoomPayoutCalculator.computePlan({...input,network});
        assert.equal(plan.transferFor("WINNER").netAtomic,2_850_000_000);
        assert.equal(plan.transferFor("OWNER").netAtomic,148_500_000);
        assert.equal(plan.gasReserveAtomic,1_500_000);
        assert.equal(plan.allocation.ruleId,APPROVED_WINNER_RULE_ID);
        assert.equal(plan.reconcile(),true);
        assert.equal(PayoutPlan.fromJSON(plan.toJSON()).transferFor("OWNER").netAtomic,148_500_000);
    }
});

test("old 95/4.9/0.1 durable plans retain original transfer obligations after restart",()=>{
    const fresh=RoomPayoutCalculator.computePlan(input).toJSON();
    const historic=structuredClone(fresh);
    historic.allocation={
        ruleId:LEGACY_OWNER_4_9_RULE_ID,
        numerator:95,denominator:100,ownerNumerator:49,ownerDenominator:1000,
        allocationSource:null
    };
    historic.transfers[1].grossAtomic=147_000_000;
    historic.transfers[1].netAtomic=147_000_000;
    historic.gasReserveAtomic=3_000_000;
    historic.safetyMarginAtomic=3_000_000;
    historic.totalGrossAtomic=2_997_000_000;
    historic.totalNetAtomic=2_997_000_000;
    const restored=PayoutPlan.fromJSON(historic);
    assert.equal(restored.transferFor("OWNER").netAtomic,147_000_000);
    assert.equal(restored.gasReserveAtomic,3_000_000);
    assert.equal(restored.reconcile(),true);
    assert.deepEqual(PayoutPlan.fromJSON(restored.toJSON()).toJSON(),restored.toJSON());
    // Newly created plans still follow the approved rule, never the legacy one.
    const newer=RoomPayoutCalculator.computePlan(input);
    assert.equal(newer.transferFor("OWNER").netAtomic,148_500_000);
});

test("caller cannot smuggle a legacy underpayment into a new plan",()=>{
    const newPlan=RoomPayoutCalculator.computePlan(input).toJSON();
    for(const mutation of [
        record=>{record.transfers[1].grossAtomic=147_000_000; record.transfers[1].netAtomic=147_000_000; record.gasReserveAtomic=3_000_000;},
        record=>{record.allocation.ruleId=LEGACY_OWNER_4_9_RULE_ID; record.allocation.ownerNumerator=99;},
        record=>{record.allocation.ruleId=LEGACY_OWNER_4_9_RULE_ID; record.allocation.ownerDenominator=2000;}
    ]){
        const altered=structuredClone(newPlan);
        mutation(altered);
        assert.throws(()=>PayoutPlan.fromJSON(altered),/fixed 95%/);
    }
});
