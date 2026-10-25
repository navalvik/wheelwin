import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RefundObligation } from "../../payment/refund/RefundObligation.js";
import { RefundObligationStore } from "../../payment/refund/RefundObligationStore.js";
import { verifyOutgoingRefundFinality } from "../../payment/refund/OutgoingRefundFinality.js";

const NOW=1_800_000_000_000;
const PAYER="0:"+"a".repeat(64),ROOM="0:"+"b".repeat(64);
const TX="ton-testnet-refund-tx-1";
function original(){
    return new RefundObligation({
        schemaVersion:1,obligationId:"rfd_0123456789abcdef0123456789abcdef",
        idempotencyKey:"TESTNET:p-olga:in-tx",networkName:"TESTNET",globalId:-3,
        roomNumber:2,roomId:"room-expired",playerId:"Olga",paymentIntentId:"p-olga",
        incomingTransactionId:"in-tx",amountAtomic:1_000_000_000,
        denomination:"TON",payerAddress:PAYER,refundDestination:PAYER,
        closureReason:"setup_expired",createdAtMs:NOW-1000,state:"PENDING",
        attempts:[],outgoingTransactionId:null,finalizedEvidence:null
    });
}
function attempt(state){
    return {networkName:"TESTNET",globalId:-3,idempotencyKey:"TESTNET:p-olga:in-tx",
        attemptId:"rfd_0123456789abcdef0123456789abcdef:1",
        state,startedAtMs:NOW,completedAtMs:NOW,
        outgoingTransactionId:null,errorCode:null};
}
function evidence(){
    const block={workchain:0,shard:"8000000000000000",seqno:123};
    return {
        networkIdentity:{network:"testnet",globalId:-3,
            source:"toncenter-masterchain-info",observedAtMs:NOW},
        transactionInclusion:{transactionId:TX,accountId:ROOM,block},
        finality:{status:"finalized",source:"toncenter-streaming-v2",
            transactionId:TX,accountId:ROOM,block,masterchainSeqno:124,
            observedAtMs:NOW}
    };
}
test("frozen gas plan: refund 1 GRAM less 0.002 GRAM network charge, no replay or change",t=>{
    const dir=mkdtempSync(join(tmpdir(),"ww-refund-gas-"));
    t.after(()=>rmSync(dir,{recursive:true,force:true}));
    const store=new RefundObligationStore({dataDir:dir});
    store.initialize();
    store.create(original());
    const pinned=store.markSubmissionUnknown(original().obligationId,{
        attempt:attempt("SUBMISSION_UNKNOWN"),
        transferAmountAtomic:998_000_000,gasChargeAtomic:2_000_000
    });
    assert.equal(pinned.amountAtomic,1_000_000_000);
    assert.equal(pinned.transferAmountAtomic,998_000_000);
    assert.equal(pinned.gasChargeAtomic,2_000_000);
    assert.throws(()=>store.markSubmissionUnknown(pinned.obligationId,{
        attempt:attempt("SUBMISSION_UNKNOWN"),transferAmountAtomic:997_000_000,gasChargeAtomic:3_000_000
    }),/only a PENDING/);
    assert.throws(()=>store.update({...pinned.toRecord(),gasChargeAtomic:3_000_000}),/equal gross principal/);
    const restarted=new RefundObligationStore({dataDir:dir});
    restarted.initialize();
    assert.equal(restarted.get(pinned.obligationId).transferAmountAtomic,998_000_000);
    assert.equal(restarted.get(pinned.obligationId).state,"SUBMISSION_UNKNOWN");
});
test("actual 0.998 GRAM outgoing finality completes full 1 GRAM obligation only with proof",t=>{
    const dir=mkdtempSync(join(tmpdir(),"ww-refund-chain-"));
    t.after(()=>rmSync(dir,{recursive:true,force:true}));
    const store=new RefundObligationStore({dataDir:dir});
    store.initialize();
    store.create(original());
    store.markSubmissionUnknown(original().obligationId,{
        attempt:attempt("SUBMISSION_UNKNOWN"),
        transferAmountAtomic:998_000_000,gasChargeAtomic:2_000_000
    });
    const submitted=store.markSubmitted(original().obligationId,{
        outgoingTransactionId:TX,
        attempt:{...attempt("SUBMITTED"),outgoingTransactionId:TX}
    });
    const verify=amountAtomic=>verifyOutgoingRefundFinality({
        obligation:submitted,sourceWalletAddress:ROOM,outgoingTransactionId:TX,
        evidence:evidence(),outgoingTransfer:{
            sourceAddress:ROOM,destinationAddress:PAYER,transactionId:TX,amountAtomic
        },nowMs:NOW
    });
    assert.equal(verify(1_000_000_000).verified,false);
    assert.equal(verify(997_000_000).verified,false);
    const ok=verify(998_000_000);
    assert.equal(ok.verified,true);
    assert.equal(ok.finalizedEvidence.amountAtomic,998_000_000);
    const complete=store.markComplete(submitted.obligationId,{finalizedEvidence:ok.finalizedEvidence});
    assert.equal(complete.state,"COMPLETE");
    assert.equal(complete.amountAtomic,1_000_000_000);
    assert.equal(complete.gasChargeAtomic,2_000_000);
});
test("a net amount cannot be invented without an exact matching player-paid fee",()=>{
    assert.throws(()=>new RefundObligation({...original().toRecord(),
        state:"SUBMISSION_UNKNOWN",transferAmountAtomic:998_000_000,gasChargeAtomic:0
    }),/equal gross principal/);
    assert.throws(()=>new RefundObligation({...original().toRecord(),
        state:"PENDING",transferAmountAtomic:998_000_000,gasChargeAtomic:2_000_000
    }),/pending refund/);
});
