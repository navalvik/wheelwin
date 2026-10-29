import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomPayoutCalculator} from '../../payment/ledger/RoomPayoutCalculator.js';
import {PayoutPlan} from '../../payment/ledger/PayoutPlan.js';
const params={payoutId:'payout-example',roomId:'room-example',asset:'TON',network:'testnet',
 principalAtomic:3_000_000_000,nowMs:1_800_000_000_000,
 winner:{recipientId:'Lena',address:'0:'+'a'.repeat(64)},
 owner:{recipientId:'WheelWin',address:'0:'+'b'.repeat(64)}};
test('3x1 GRAM -> full 2.85 winner, 0.147 owner, 0.003 source gas allocation',()=>{
 const p=RoomPayoutCalculator.computePlan(params);
 assert.equal(p.transferFor('WINNER').netAtomic,2_850_000_000);
 assert.equal(p.transferFor('OWNER').netAtomic,147_000_000);
 assert.equal(p.gasReserveAtomic,3_000_000);
 assert.equal(p.totalReservedFeeAtomic,0);
 assert.equal(p.totalNetAtomic+p.gasReserveAtomic,params.principalAtomic);
 assert.equal(PayoutPlan.fromJSON(p.toJSON()).reconcile(),true);
});
test('30 GRAM bank scales shares with no fixed top-up',()=>{
 const p=RoomPayoutCalculator.computePlan({...params,principalAtomic:30_000_000_000});
 assert.equal(p.transferFor('WINNER').netAtomic,28_500_000_000);
 assert.equal(p.transferFor('OWNER').netAtomic,1_470_000_000);
 assert.equal(p.gasReserveAtomic,30_000_000);
});
test('unavailable, stale or excessive quotes do not reduce either payout',()=>{
 for(const feeAtomic of [undefined,null,NaN,-1,1.5,9_000_000_000]){
  const p=RoomPayoutCalculator.computePlan({...params,networkFees:{winner:{feeAtomic,quotedAtMs:1},owner:{feeAtomic,quotedAtMs:1}}});
  assert.equal(p.transferFor('WINNER').netAtomic,2_850_000_000);
  assert.equal(p.transferFor('OWNER').netAtomic,147_000_000);
 }
});
test('rounding stays in reserve and caller cannot override fixed shares',()=>{
 const p=RoomPayoutCalculator.computePlan({...params,principalAtomic:3_000_000_019,safetyMarginAtomic:3_000_000_000,allocation:{numerator:1,denominator:100}});
 assert.equal(p.transferFor('WINNER').netAtomic,2_850_000_018);
 assert.equal(p.transferFor('OWNER').netAtomic,147_000_000);
 assert.equal(p.gasReserveAtomic,3_000_001);
 const changed=structuredClone(p.toJSON()); changed.transfers[0].grossAtomic--; changed.transfers[0].netAtomic--; changed.transfers[1].grossAtomic++; changed.transfers[1].netAtomic++;
 assert.throws(()=>PayoutPlan.fromJSON(changed),/fixed 95%/);
});
test('persisted recipient amount cannot silently change during validation',()=>{
 const record=RoomPayoutCalculator.computePlan(params).toJSON();
 const reduced=structuredClone(record); reduced.transfers[0].netAtomic--;
 assert.throws(()=>PayoutPlan.fromJSON(reduced),/net amount/);
 const fee=structuredClone(record); fee.transfers[1].reservedFeeAtomic=1;
 assert.throws(()=>PayoutPlan.fromJSON(fee),/must be zero/);
});
