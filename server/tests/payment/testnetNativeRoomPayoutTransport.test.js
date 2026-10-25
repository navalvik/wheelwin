import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {RoomPayoutCalculator} from "../../payment/ledger/RoomPayoutCalculator.js";
import {TestnetNativeRoomPayoutTransport} from "../../payment/runtime/TestnetNativeRoomPayoutTransport.js";

const ROOM="0:"+"a".repeat(64),WINNER="0:"+"b".repeat(64),OWNER="0:"+"c".repeat(64);
const PAYOUT="payout_"+"a".repeat(32),ROOMID="room-xyz";
function harness(t,{failRole=null,outgoingObserver=null}={}){
    const dir=mkdtempSync(join(tmpdir(),"wheelwin-v4-outgoing-"));
    t.after(()=>rmSync(dir,{recursive:true,force:true}));
    const seen=[];
    const adapter={
        async estimateOutboundTransferFee(args){
            seen.push({op:"quote",...args});
            return {ok:true,totalNano:1_000_000n};
        },
        async sendTransfer(args){
            seen.push({op:"send",...args});
            return failRole===seen.filter(x=>x.op==="send").length
                ? {ok:false,code:"FAILED"} : {ok:true,code:"SENT",txHash:"mock-hash"};
        }
    };
    const walletPool={getReservationForRoom:()=>({
        roomNumber:2,reservedByRoomId:ROOMID,address:ROOM
    })};
    const transport=new TestnetNativeRoomPayoutTransport({
        walletPool,adapter,dataDir:dir,outgoingObserver
    });
    return {transport,seen,dir};
}
function payout(fees){
    return RoomPayoutCalculator.computePlan({
        payoutId:PAYOUT,roomId:ROOMID,asset:"TON",network:"testnet",
        principalAtomic:3_000_000_000,safetyMarginAtomic:10_000_000,
        winner:{recipientId:"Lena",address:WINNER},
        owner:{recipientId:"WheelWin",address:OWNER},
        networkFees:fees,nowMs:Date.now()
    }).toJSON();
}
const inputs={roomId:ROOMID,payoutId:PAYOUT,roomWalletAddress:ROOM,
    winnerWallet:WINNER,ownerWallet:OWNER};
test("two real-Testnet fee quotes produce recipient-funded gas charges",async t=>{
    const h=harness(t);
    const fee=await h.transport.quote({
        roomId:ROOMID,roomWallet:ROOM,winnerWallet:WINNER,ownerWallet:OWNER,
        principalAtomic:3_000_000_000
    });
    assert.equal(fee.winner.feeAtomic,2_000_000);
    assert.equal(fee.owner.feeAtomic,2_000_000);
    assert.deepEqual(h.seen.map(x=>x.op),["quote","quote"]);
    assert.ok(payout(fee).safetyMarginAtomic===10_000_000);
});
test("one 3-player result sends winner then owner, respecting room reserve and no double-submit",async t=>{
    const h=harness(t);
    const fee=await h.transport.quote({
        roomId:ROOMID,roomWallet:ROOM,winnerWallet:WINNER,ownerWallet:OWNER,
        principalAtomic:3_000_000_000
    });
    const plan=payout(fee);
    const outcome=await h.transport.submit({...inputs,plan});
    assert.equal(outcome.status,"SUBMITTED_UNCONFIRMED");
    const sent=h.seen.filter(x=>x.op==="send");
    assert.equal(sent.length,2);
    assert.equal(sent[0].amountNano,2_848_000_000n);
    assert.equal(sent[1].amountNano,138_000_000n);
    assert.equal(sent[0].sourceReserveNano,150_000_000n);
    assert.equal(sent[1].sourceReserveNano,10_000_000n);
    const second=await h.transport.submit({...inputs,plan});
    assert.equal(second.status,"ALREADY_ATTEMPTED_NEEDS_RECONCILIATION");
    assert.equal(h.seen.filter(x=>x.op==="send").length,2);
});
test("an unresolved first send never broadcasts the owner leg",async t=>{
    const h=harness(t,{failRole:1});
    const fee={winner:{feeAtomic:2_000_000},owner:{feeAtomic:2_000_000}};
    const first=await h.transport.submit({...inputs,plan:payout(fee)});
    assert.equal(first.status,"SUBMISSION_UNKNOWN");
    assert.equal(h.seen.filter(x=>x.op==="send").length,1);
    const again=await h.transport.submit({...inputs,plan:payout(fee)});
    assert.equal(again.status,"ALREADY_ATTEMPTED_NEEDS_RECONCILIATION");
    assert.equal(h.seen.filter(x=>x.op==="send").length,1);
});
test("mismatched payout/room/recipient is rejected before sending",async t=>{
    const h=harness(t);
    const plan=payout({winner:{feeAtomic:2_000_000},owner:{feeAtomic:2_000_000}});
    await assert.rejects(h.transport.submit({...inputs,ownerWallet:WINNER,plan}),/PAYOUT_PLAN_NOT_AUTHORIZED/);
    assert.equal(h.seen.filter(x=>x.op==="send").length,0);
});

test("winner and owner are matched to two different blockchain transactions without resending",async t=>{
    const readCalls=[];
    const h=harness(t,{outgoingObserver:{
        async findOutgoingTransfer({sourceWalletAddress,destinationIdentity,amountAtomic}){
            readCalls.push({sourceWalletAddress,destinationIdentity,amountAtomic});
            return {
                transactionId:destinationIdentity===WINNER?"winner-on-chain":"owner-on-chain",
                sourceAddress:ROOM,destinationAddress:destinationIdentity,amountAtomic
            };
        }
    }});
    const fees={winner:{feeAtomic:2_000_000},owner:{feeAtomic:2_000_000}};
    const plan=payout(fees);
    assert.equal((await h.transport.reconcile({...inputs,plan})).status,
        "NO_BROADCAST_ATTEMPT_RECORDED");
    await h.transport.submit({...inputs,plan});
    const sendCount=h.seen.filter(x=>x.op==="send").length;
    const result=await h.transport.reconcile({...inputs,plan});
    assert.equal(result.status,"BOTH_OUTGOING_MATCHES_FOUND_UNFINALIZED");
    assert.equal(result.winnerTransactionId,"winner-on-chain");
    assert.equal(result.ownerTransactionId,"owner-on-chain");
    assert.equal(readCalls.length,2);
    assert.ok(readCalls.every(x=>x.sourceWalletAddress===ROOM));
    assert.ok(readCalls.every(x=>Number.isSafeInteger(x.minCreatedAtMs)
        && x.minCreatedAtMs>0), "every outgoing history check must be bounded by the claim");
    assert.equal(h.seen.filter(x=>x.op==="send").length,sendCount);
});
test("missing or ambiguous outgoing transfer never becomes confirmed",async t=>{
    const h=harness(t,{outgoingObserver:{
        async findOutgoingTransfer({destinationIdentity}){
            return destinationIdentity===WINNER?{transactionId:"win"}:null;
        }
    }});
    const plan=payout({winner:{feeAtomic:2_000_000},owner:{feeAtomic:2_000_000}});
    await h.transport.submit({...inputs,plan});
    const result=await h.transport.reconcile({...inputs,plan});
    assert.equal(result.status,"PAYOUT_OUTGOING_CONFIRMATION_PENDING");
    assert.equal(result.winnerObserved,true);
    assert.equal(result.ownerObserved,false);
});
