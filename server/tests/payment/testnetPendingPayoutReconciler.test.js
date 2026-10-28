import test from "node:test";
import assert from "node:assert/strict";
import {TestnetPendingPayoutReconciler} from "../../payment/runtime/TestnetPendingPayoutReconciler.js";
import {LEDGER_ENTRY_KIND} from "../../payment/ledger/LedgerConstants.js";

const addr=n=>"0:"+n.toString(16).padStart(64,"0");
function plan(n){
    const payoutId="payout_"+n.toString(16).padStart(32,"0");
    const roomId="room-"+n;
    return {payoutId,roomId,transfers:[
        {recipientRole:"WINNER",recipientId:"Lena",address:addr(100+n),netAtomic:2850000000},
        {recipientRole:"OWNER",recipientId:"WheelWin",address:addr(200+n),netAtomic:140000000}
    ]};
}
function setup({rooms=12,missing=new Set(),pending=new Set()}={}){
    const plans=Array.from({length:rooms},(_,i)=>plan(i+2));
    const calls=[];
    const reconciler=new TestnetPendingPayoutReconciler({
        ledgerStore:{list:()=>plans.map(p=>({
            kind:LEDGER_ENTRY_KIND.PAYOUT_PLAN,roomId:p.roomId,
            metadata:{payoutId:p.payoutId,plan:p}
        }))},
        ledger:{countOpenObligations:id=>pending.has(id)?0:2},
        walletPool:{getReservationForRoom:id=>
            missing.has(id)?null:{reservedByRoomId:id,roomNumber:2,address:addr(9)}},
        transport:{async reconcileAndSettle(q){calls.push(q);return {status:"PAYOUT_OUTGOING_CONFIRMATION_PENDING"};}},
        maxPerPass:5
    });
    return {reconciler,calls,plans};
}
test("scan persistent plans, never need live RoomManager or re-broadcast",async()=>{
    const h=setup();
    const first=await h.reconciler.runPass();
    assert.equal(first.scanned,5);
    assert.equal(h.calls.length,5);
    assert.equal(h.calls[0].payoutId,h.plans[0].payoutId);
    assert.equal(h.calls[0].winnerWallet,h.plans[0].transfers[0].address);
    const second=await h.reconciler.runPass();
    assert.equal(second.scanned,5);
    assert.equal(h.calls.length,10);
    assert.equal(h.calls[5].payoutId,h.plans[5].payoutId);
    const third=await h.reconciler.runPass();
    assert.equal(third.scanned,5);
    assert.equal(h.calls[10].payoutId,h.plans[10].payoutId);
    assert.equal(h.calls[12].payoutId,h.plans[0].payoutId);
});
test("missing wallet or already-closed payout is skipped without execution",async()=>{
    const h=setup({rooms:3,missing:new Set(["room-2"]),pending:new Set(["room-3"])});
    const r=await h.reconciler.runPass();
    assert.equal(r.scanned,2);
    assert.equal(r.results[0].status,"PAYOUT_WALLET_RESERVATION_MISSING_HOLD");
    assert.equal(h.calls.length,1);
    assert.equal(h.calls[0].roomId,"room-4");
});
test("all obligations settled yields no work and zero outgoing calls",async()=>{
    const h=setup({rooms:2,pending:new Set(["room-2","room-3"])});
    const r=await h.reconciler.runPass();
    assert.equal(r.status,"NO_OPEN_PAYOUTS");
    assert.equal(r.scanned,0);
    assert.equal(h.calls.length,0);
});
test("overlapping passes never duplicate work, and temporary RPC exceptions cannot crash it",async()=>{
    let release;
    const task=new Promise(resolve=>{release=resolve;});
    let count=0;
    const p=plan(2);
    const service=new TestnetPendingPayoutReconciler({
        ledgerStore:{list:()=>[{kind:LEDGER_ENTRY_KIND.PAYOUT_PLAN,
            roomId:p.roomId,metadata:{payoutId:p.payoutId,plan:p}}]},
        ledger:{countOpenObligations:()=>2},
        walletPool:{getReservationForRoom:()=>({reservedByRoomId:p.roomId,roomNumber:2,address:addr(9)})},
        transport:{async reconcileAndSettle(){count++;await task;throw Error("network")}}
    });
    const pass=service.runPass();
    assert.equal((await service.runPass()).status,"RECONCILIATION_IN_PROGRESS");
    assert.equal(count,1);
    release();
    const out=await pass;
    assert.equal(out.results[0].status,"PAYOUT_RECONCILIATION_RETRY_LATER");
    assert.equal(count,1);
});
test("invalid configuration can never create a payout recovery poller",()=>{
    assert.throws(()=>new TestnetPendingPayoutReconciler({
        ledgerStore:{list:()=>[]},ledger:{countOpenObligations:()=>0},
        walletPool:{getReservationForRoom:()=>null},
        transport:{reconcileAndSettle:async()=>({})},maxPerPass:999
    }),/PAYOUT_RECONCILER_CONFIG_INVALID/);
});
