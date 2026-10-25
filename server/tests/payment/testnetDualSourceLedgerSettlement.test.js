import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {TestnetNativeRoomPayoutTransport} from "../../payment/runtime/TestnetNativeRoomPayoutTransport.js";
import {RoomPayoutCalculator} from "../../payment/ledger/RoomPayoutCalculator.js";
import {TonapiTestnetPayoutVerifier} from "../../payment/refund/TonapiTestnetPayoutVerifier.js";

const R="0:"+"a".repeat(64),W="0:"+"b".repeat(64),O="0:"+"c".repeat(64);
const ROOM="room-t3",PAYOUT="payout_"+"d".repeat(32);
const h=n=>n.toString(16).padStart(64,"0");
const tx={winnerSource:h(1),winnerRecipient:h(2),winnerMsg:h(3),
    ownerSource:h(4),ownerRecipient:h(5),ownerMsg:h(6)};
const plan=()=>RoomPayoutCalculator.computePlan({
    payoutId:PAYOUT,roomId:ROOM,asset:"TON",network:"testnet",
    principalAtomic:3_000_000_000,safetyMarginAtomic:10_000_000,
    winner:{recipientId:"Lena",address:W},
    owner:{recipientId:"WheelWin",address:O},
    networkFees:{winner:{feeAtomic:2_000_000},owner:{feeAtomic:2_000_000}},
    nowMs:1_800_000_000_000
}).toJSON();
const query=()=>({roomId:ROOM,payoutId:PAYOUT,roomWalletAddress:R,
    winnerWallet:W,ownerWallet:O,plan:plan()});
function setup(t,{historical=true,secondary=true,missing=null,fee=1_000_000}={}){
    const dir=mkdtempSync(join(tmpdir(),"ww-dual-finality-"));
    t.after(()=>rmSync(dir,{recursive:true,force:true}));
    const sent=[],settled=[];
    const ledger={settlePayout(data){settled.push(data);return {replay:false,settled:true};}};
    const adapter={
        async sendTransfer(data){sent.push(data);return {ok:true,code:"SENT",txHash:"mock"};}
    };
    const observer={
        async findOutgoingTransfer({destinationIdentity,amountAtomic}){
            return {transactionId:destinationIdentity===W?tx.winnerSource:tx.ownerSource,
                sourceAddress:R,destinationAddress:destinationIdentity,amountAtomic};
        },
        async verifyIndexedRecipientCredit({destinationIdentity,transactionId,amountAtomic}){
            if(!historical)return null;
            const winner=destinationIdentity===W;
            return {
                status:"MASTERCHAIN_INDEXED_RECIPIENT_CREDIT_OBSERVED",
                sourceTransactionId:transactionId,
                recipientTransactionId:winner?tx.winnerRecipient:tx.ownerRecipient,
                messageHash:winner?tx.winnerMsg:tx.ownerMsg,
                destinationAddress:destinationIdentity,amountAtomic,globalId:-3,
                sourceMcBlockSeqno:101,recipientMcBlockSeqno:102,
                latestIndexedMcBlockSeqno:110,
                sourceFinality:"finalized",recipientFinality:"finalized"
            };
        },
        async observeRecipientCredit(){throw new Error("never downgrade historical finality");}
    };
    const independent=secondary?{
        async verifyTransfer(args){
            if(missing===args.destinationAddress)return null;
            const winner=args.destinationAddress===W;
            return {status:"INDEPENDENT_INDEXED_CREDIT_OBSERVED",
                sourceTransactionId:args.sourceTransactionId,
                recipientTransactionId:args.recipientTransactionId,
                messageHash:winner?tx.winnerMsg:tx.ownerMsg,
                sourceWalletAddress:R,destinationAddress:args.destinationAddress,
                amountAtomic:args.amountAtomic,actualFeeAtomic:fee,provider:"tonapi-testnet"};
        }
    }:null;
    const transport=new TestnetNativeRoomPayoutTransport({
        dataDir:dir,adapter,ledger,
        independentVerifier:independent,outgoingObserver:observer,
        walletPool:{getReservationForRoom:()=>({roomNumber:2,reservedByRoomId:ROOM,address:R})}
    });
    return {transport,ledger,settled,sent};
}
test("two sources final and exact: settle both payouts with actual gas, no new broadcast",async t=>{
    const v=setup(t),q=query();
    await v.transport.submit(q);
    assert.equal(v.sent.length,2);
    const result=await v.transport.reconcileAndSettle(q);
    assert.equal(result.status,"BOTH_PAYOUTS_SETTLED_FROM_DUAL_FINALITY");
    assert.equal(v.settled.length,2);
    assert.deepEqual(v.settled.map(x=>x.recipientId),["Lena","WheelWin"]);
    assert.deepEqual(v.settled.map(x=>x.executionResult.transactionId),
        [tx.winnerSource,tx.ownerSource]);
    assert.ok(v.settled.every(x=>x.executionResult.actualFeeAtomic===1_000_000));
    assert.equal(v.sent.length,2);
});
test("missing TonAPI/independent source cannot settle even with two finalized Toncenter transactions",async t=>{
    const v=setup(t,{secondary:false}),q=query();
    await v.transport.submit(q);
    const result=await v.transport.reconcileAndSettle(q);
    assert.equal(result.status,"INDEPENDENT_FINALITY_VERIFIER_UNAVAILABLE");
    assert.equal(v.settled.length,0);
});
test("one recipient missing independent confirmation leaves BOTH obligations open",async t=>{
    const v=setup(t,{missing:O}),q=query();
    await v.transport.submit(q);
    const result=await v.transport.reconcileAndSettle(q);
    assert.equal(result.status,"PAYOUT_INDEPENDENT_CHECK_PENDING");
    assert.equal(v.settled.length,0);
});
test("one nonfinal masterchain transaction prevents all ledger settlement",async t=>{
    const v=setup(t,{historical:false}),q=query();
    await v.transport.submit(q);
    const result=await v.transport.reconcileAndSettle(q);
    assert.equal(result.status,"RECIPIENT_CREDIT_CONFIRMATION_PENDING");
    assert.equal(v.settled.length,0);
});
test("improper actual fee refuses ledger settlement",async t=>{
    const v=setup(t,{fee:NaN}),q=query();
    await v.transport.submit(q);
    const result=await v.transport.reconcileAndSettle(q);
    assert.equal(result.status,"PAYOUT_INDEPENDENT_CHECK_PENDING");
    assert.equal(v.settled.length,0);
});
test("the real independent HTTP verifier checks two transaction hashes and matching inbound/outbound message",async()=>{
    const calls=[];
    const txMap={
        [tx.winnerSource]:{
            hash:tx.winnerSource,success:true,aborted:false,account:{address:R},
            total_fees:"1000000",
            out_msgs:[{hash:tx.winnerMsg,source:R,destination:W,value:"2848000000",bounced:false}]
        },
        [tx.winnerRecipient]:{
            hash:tx.winnerRecipient,success:true,aborted:false,account:{address:W},
            in_msg:{hash:tx.winnerMsg,source:R,destination:W,value:"2848000000",bounced:false}
        }
    };
    const api=new TonapiTestnetPayoutVerifier({
        fetchImpl:async url=>{calls.push(url);const hash=decodeURIComponent(url.split("/").at(-1));
            return {status:200,json:async()=>txMap[hash]};}
    });
    const result=await api.verifyTransfer({
        sourceTransactionId:tx.winnerSource,recipientTransactionId:tx.winnerRecipient,
        messageHash:tx.winnerMsg,sourceWalletAddress:R,destinationAddress:W,
        amountAtomic:2_848_000_000
    });
    assert.equal(result.status,"INDEPENDENT_INDEXED_CREDIT_OBSERVED");
    assert.equal(result.actualFeeAtomic,1_000_000);
    assert.equal(calls.length,2);
    assert.ok(calls.every(url=>url.startsWith("https://testnet.tonapi.io/v2/blockchain/transactions/")));
    const missing=await api.verifyTransfer({
        sourceTransactionId:tx.winnerSource,recipientTransactionId:tx.winnerRecipient,
        messageHash:tx.winnerMsg,sourceWalletAddress:R,destinationAddress:W,
        amountAtomic:2_848_000_001
    });
    assert.equal(missing,null);
});
