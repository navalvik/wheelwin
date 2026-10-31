import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {buildNetworkOutgoingRefundProvider,buildTestnetOutgoingRefundProvider,buildMainnetPaymentRuntime} from "../payment/runtime/PaymentRuntimeFactory.js";
import {RefundLifecycleCoordinator} from "../payment/refund/RefundLifecycleCoordinator.js";
import {RefundObligationStore} from "../payment/refund/RefundObligationStore.js";
import {RefundObligation} from "../payment/refund/RefundObligation.js";

const NOW=1800000000000;
const SOURCE="0:"+"a".repeat(64),PAYER="0:"+"b".repeat(64);
const ROOM_ID="expired-mainnet-room",REF="WW-MAINNET-OLGA";
const TRANSACTION="incoming-olga",ID="rfd_"+"c".repeat(32);
function fixture(t,{network="mainnet",ambiguous=false}={}) {
    const root=mkdtempSync(join(tmpdir(),"ww-outgoing-capability-"));
    t.after(()=>rmSync(root,{recursive:true,force:true}));
    const store=new RefundObligationStore({dataDir:join(root,"refunds")});
    store.initialize();
    const networkName=network.toUpperCase(),globalId=network==="mainnet"?-239:-3;
    const key=networkName+":"+REF+":"+TRANSACTION;
    store.create(new RefundObligation({
        schemaVersion:1,obligationId:ID,idempotencyKey:key,
        networkName,globalId,roomNumber:2,roomId:ROOM_ID,playerId:"Olga",
        paymentIntentId:REF,incomingTransactionId:TRANSACTION,
        amountAtomic:1000000000,denomination:"TON",payerAddress:PAYER,
        refundDestination:PAYER,closureReason:"setup_expired",createdAtMs:NOW-5000,
        state:"PENDING",attempts:[],outgoingTransactionId:null,finalizedEvidence:null
    }));
    const seen={signed:[],broadcasted:[]};
    const submitter={
        signer:{async signTransfer(args){seen.signed.push(args);return {signed:"ONLY_OFFLINE_MOCK"};}},
        broadcaster:{async broadcast(args){
            seen.broadcasted.push(args);
            if(ambiguous)throw Error("SIMULATED_RPC_LOST_REPLY");
            return {status:"SUBMITTED",transactionId:"mock-outgoing-1"};
        }},
        finalityEvidenceProvider:{async getSettlementEvidence(){return null;}},
        outgoingTransferProvider:{
            async getOutgoingTransfer(){return null;},
            async findOutgoingTransfer(){return null;}
        }
    };
    const outgoing=buildNetworkOutgoingRefundProvider({
        network,globalId,submitter,finalityEvidenceProvider:null
    });
    const incomingIntent={
        paymentReference:REF,network,destinationWalletAddress:SOURCE
    };
    const lifecycle=(enabled)=>new RefundLifecycleCoordinator({
        networkName,store,
        intentStore:{require:()=>incomingIntent},
        ledgerStore:{listForRoom:()=>[]},
        outgoingRefundProvider:outgoing,
        nowProvider:()=>NOW,mainnetOutgoingEnabled:enabled
    });
    return {root,store,outgoing,seen,submitter,lifecycle,globalId,networkName};
}

test("same Testnet refund provider builder verifies explicit Mainnet chain, no auto signer",t=>{
    const h=fixture(t);
    assert.equal(h.outgoing?.networkName,"MAINNET");
    assert.equal(h.outgoing?.globalId,-239);
    assert.equal(h.outgoing?.canExecute(),true);
    assert.equal(buildNetworkOutgoingRefundProvider({
        network:"mainnet",globalId:-3,submitter:h.submitter
    }),null);
    assert.equal(buildNetworkOutgoingRefundProvider({
        network:"mainnet",globalId:-239,submitter:{}
    }),null);
    assert.equal(buildNetworkOutgoingRefundProvider({
        network:"mainnet",globalId:-239,submitter:null
    }),null);
    assert.throws(()=>buildNetworkOutgoingRefundProvider({
        network:"unsupported",globalId:-239,submitter:h.submitter
    }));
    assert.equal(buildTestnetOutgoingRefundProvider({
        globalId:-239,submitter:h.submitter
    }),null);
    assert.equal(buildTestnetOutgoingRefundProvider({
        globalId:-3,submitter:h.submitter
    })?.networkName,"TESTNET");
    assert.throws(()=>buildMainnetPaymentRuntime({
        refundSubmitter:h.submitter
    }),/MAINNET_RUNTIME_FINANCIAL_INJECTION_DISABLED/);
    assert.equal(h.seen.broadcasted.length,0);
});

test("Mainnet refunds stay closed without explicit provider-approved lifecycle activation",async t=>{
    const h=fixture(t);
    await assert.rejects(h.lifecycle(false).submitRefund(ID),
        /Mainnet outgoing refunds are not yet enabled/);
    assert.equal(h.store.get(ID).state,"PENDING");
    assert.equal(h.seen.broadcasted.length,0);
});

test("explicitly approved Mainnet lifecycle persists one mocked transfer and refuses replay",async t=>{
    const h=fixture(t);
    const lifecycle=h.lifecycle(true);
    const recovery=lifecycle.recover({providers:new Map([["MAINNET",h.outgoing]])});
    assert.equal(recovery[0].outcome,"PENDING_AWAITING_SUBMISSION");
    const result=await lifecycle.submitRefund(ID);
    assert.equal(result.outcome,"SUBMITTED");
    assert.equal(result.outgoingTransactionId,"mock-outgoing-1");
    assert.equal(h.store.get(ID).state,"SUBMITTED");
    assert.equal(h.seen.signed.length,1);
    assert.equal(h.seen.signed[0].networkName,"MAINNET");
    assert.equal(h.seen.signed[0].globalId,-239);
    assert.equal(h.seen.broadcasted.length,1);
    await assert.rejects(lifecycle.submitRefund(ID),/must be reconciled/);
    assert.equal(h.seen.broadcasted.length,1);
    const restart=new RefundObligationStore({dataDir:join(h.root,"refunds")});
    restart.initialize();
    assert.equal(restart.get(ID).state,"SUBMITTED");
    assert.equal(restart.listPending().length,1);
});

test("Mainnet ambiguous refund cannot be sent again across process restart",async t=>{
    const h=fixture(t,{ambiguous:true});
    const first=await h.lifecycle(true).submitRefund(ID);
    assert.equal(first.outcome,"SUBMISSION_UNKNOWN");
    assert.equal(h.store.get(ID).state,"SUBMISSION_UNKNOWN");
    assert.equal(h.seen.broadcasted.length,1);
    const restart=new RefundObligationStore({dataDir:join(h.root,"refunds")});
    restart.initialize();
    const lifecycle=new RefundLifecycleCoordinator({
        networkName:"MAINNET",store:restart,
        intentStore:{require:()=>({paymentReference:REF,network:"mainnet",
            destinationWalletAddress:SOURCE})},
        ledgerStore:{listForRoom:()=>[]},outgoingRefundProvider:h.outgoing,
        nowProvider:()=>NOW,mainnetOutgoingEnabled:true
    });
    await assert.rejects(lifecycle.submitRefund(ID),/must be reconciled/);
    assert.equal(h.seen.broadcasted.length,1);
    assert.equal(lifecycle.recover({providers:new Map([["MAINNET",h.outgoing]])})[0].outcome,
        "SUBMISSION_OUTCOME_UNKNOWN_HOLD");
});

test("Mainnet lifecycle rejects incomplete provider, Testnet signer and provider override",async t=>{
    const h=fixture(t);
    assert.throws(()=>new RefundLifecycleCoordinator({
        networkName:"MAINNET",store:h.store,mainnetOutgoingEnabled:true
    }),/MAINNET_REFUND_COMPLETE_PROVIDER_REQUIRED/);
    assert.throws(()=>new RefundLifecycleCoordinator({
        networkName:"TESTNET",store:h.store,
        outgoingRefundProvider:h.outgoing,mainnetOutgoingEnabled:true
    }),/MAINNET_REFUND_COMPLETE_PROVIDER_REQUIRED/);
    const lifecycle=h.lifecycle(true);
    await assert.rejects(lifecycle.submitRefund(ID,{provider:{
        networkName:"MAINNET",globalId:-239,canExecute:()=>true
    }}),/MAINNET_REFUND_PROVIDER_OVERRIDE_FORBIDDEN/);
    assert.equal(h.seen.broadcasted.length,0);
});
