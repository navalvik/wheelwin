import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {RefundObligationStore} from "../../payment/refund/RefundObligationStore.js";
import {RefundObligation} from "../../payment/refund/RefundObligation.js";
import {TestnetPendingRefundReconciler} from "../../payment/runtime/TestnetPendingRefundReconciler.js";

const NOW=1_800_000_000_000;
const PAYER="0:"+"a".repeat(64),ROOM="0:"+"b".repeat(64);
const ID="rfd_0123456789abcdef0123456789abcdef";
const TX="1".repeat(64),IN_TX="2".repeat(64),MESSAGE="3".repeat(64);
function setup(t,{badMasterchain=false,secondary=true,sourceValid=true,ambiguous=false,
    feeMissing=false}={}){
    const root=mkdtempSync(join(tmpdir(),"ww-refund-two-source-"));
    t.after(()=>rmSync(root,{recursive:true,force:true}));
    const store=new RefundObligationStore({dataDir:join(root,"refunds")});
    store.initialize();
    store.create(new RefundObligation({
        schemaVersion:1,obligationId:ID,idempotencyKey:"TESTNET:p-olga:in-tx",
        networkName:"TESTNET",globalId:-3,roomNumber:37,roomId:"room-expired",
        playerId:"Olga",paymentIntentId:"p-olga",incomingTransactionId:"in-tx",
        amountAtomic:1_000_000_000,denomination:"TON",
        payerAddress:PAYER,refundDestination:PAYER,
        closureReason:"setup_expired",createdAtMs:NOW-2000,state:"PENDING",
        attempts:[],outgoingTransactionId:null,finalizedEvidence:null
    }));
    store.markSubmissionUnknown(ID,{
        attempt:{networkName:"TESTNET",globalId:-3,
            idempotencyKey:"TESTNET:p-olga:in-tx",attemptId:ID+":attempt",
            state:"SUBMISSION_UNKNOWN",startedAtMs:NOW-1000,completedAtMs:NOW-1000,
            outgoingTransactionId:null,errorCode:null},
        transferAmountAtomic:998_000_000,gasChargeAtomic:2_000_000
    });
    let calls=0,independentCalls=0;
    const intents={listForRoom:()=>[{
        paymentReference:"p-olga",transactionId:"in-tx",
        expectedSender:PAYER,
        destinationWalletAddress:sourceValid?ROOM:PAYER
    }]};
    const chain={
        async findOutgoingTransfer(args){
            calls++;
            assert.equal(args.amountAtomic,998_000_000);
            assert.equal(args.minCreatedAtMs,NOW-2000);
            return ambiguous?{ambiguous:true}:{
                transactionId:TX,sourceAddress:ROOM,destinationAddress:PAYER,
                amountAtomic:998_000_000};
        },
        async verifyIndexedRecipientCredit(){
            return badMasterchain?null:{
                status:"MASTERCHAIN_INDEXED_RECIPIENT_CREDIT_OBSERVED",
                globalId:-3,sourceFinality:"finalized",recipientFinality:"finalized",
                sourceTransactionId:TX,recipientTransactionId:IN_TX,
                messageHash:MESSAGE,destinationAddress:PAYER,amountAtomic:998_000_000,
                sourceBlockRef:{workchain:0,shard:"8000000000000000",seqno:222}
            };
        }
    };
    const verifier={
        async verifyTransfer(){
            independentCalls++;
            return secondary?{
                status:"INDEPENDENT_INDEXED_CREDIT_OBSERVED",provider:"tonapi-testnet",
                sourceTransactionId:TX,recipientTransactionId:IN_TX,
                messageHash:MESSAGE,sourceWalletAddress:ROOM,
                destinationAddress:PAYER,amountAtomic:998_000_000,
                actualFeeAtomic:feeMissing?null:1_000_000
            }:null;
        }
    };
    const reconciler=new TestnetPendingRefundReconciler({
        refundStore:store,intentStore:intents,toncenterObserver:chain,
        independentVerifier:verifier,nowProvider:()=>NOW,maxPerPass:2
    });
    return {store,reconciler,root,counts:()=>({calls,independentCalls})};
}
test("dual-source 0.998 GRAM credit automatically closes old unknown refund, no extra broadcast",async t=>{
    const x=setup(t);
    const first=await x.reconciler.runPass();
    assert.equal(first.results[0].status,"REFUND_COMPLETE_TWO_SOURCES");
    const finished=x.store.get(ID);
    assert.equal(finished.state,"COMPLETE");
    assert.equal(finished.amountAtomic,1_000_000_000);
    assert.equal(finished.transferAmountAtomic,998_000_000);
    assert.equal(finished.gasChargeAtomic,2_000_000);
    assert.equal(finished.outgoingTransactionId,TX);
    assert.equal(finished.finalizedEvidence.blockId,"0:8000000000000000:222");
    const restored=new RefundObligationStore({dataDir:join(x.root,"refunds")});
    restored.initialize();
    assert.equal(restored.get(ID).state,"COMPLETE");
    assert.equal((await x.reconciler.runPass()).status,"NO_SUBMITTED_REFUNDS");
    assert.equal(x.counts().calls,1);
});
test("Toncenter pre-finality or missing independent recipient credit holds refund",async t=>{
    for(const scenario of [{badMasterchain:true},{secondary:false},{ambiguous:true}]){
        const x=setup(t,scenario);
        const status=(await x.reconciler.runPass()).results[0].status;
        assert.notEqual(status,"REFUND_COMPLETE_TWO_SOURCES");
        assert.equal(x.store.get(ID).state,"SUBMISSION_UNKNOWN");
    }
});
test("PENDING, unattempted refunds remain strictly outside settlement",async t=>{
    const x=setup(t);
    const fake={listPending:()=>[{...x.store.get(ID).toRecord(),state:"PENDING"}],
        completeFromVerifiedHistory:()=>{throw Error("must not close PENDING")}};
    const worker=new TestnetPendingRefundReconciler({
        refundStore:fake,intentStore:{listForRoom:()=>[]},
        toncenterObserver:{findOutgoingTransfer:async()=>{throw Error("no query")},
            verifyIndexedRecipientCredit:async()=>null},
        independentVerifier:{verifyTransfer:async()=>null}
    });
    assert.equal((await worker.runPass()).status,"NO_SUBMITTED_REFUNDS");
});
test("historical finality cannot silently replace a previously recorded outgoing transaction hash",t=>{
    const x=setup(t);
    assert.throws(()=>x.store.completeFromVerifiedHistory(ID,{
        outgoingTransactionId:TX,
        finalizedEvidence:{
            networkName:"TESTNET",globalId:-3,transactionId:"other",
            amountAtomic:998_000_000,destination:PAYER,finalized:true,
            observedAtMs:NOW,blockId:"0:8000000000000000:222"
        }
    }),/mismatches obligation/);
    assert.equal(x.store.get(ID).state,"SUBMISSION_UNKNOWN");
});
