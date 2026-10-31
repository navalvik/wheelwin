import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {TestnetNativeTonService} from "../payment/roomWallet/TestnetNativeTonService.js";
import {RefundObligationStore} from "../payment/refund/RefundObligationStore.js";
import {RefundObligation} from "../payment/refund/RefundObligation.js";
import {TestnetPendingRefundReconciler} from "../payment/runtime/TestnetPendingRefundReconciler.js";
import {TestnetPendingPayoutReconciler} from "../payment/runtime/TestnetPendingPayoutReconciler.js";
import {LEDGER_ENTRY_KIND} from "../payment/ledger/LedgerConstants.js";

const NOW=1800000000000;
const PAYER="0:"+"a".repeat(64),SOURCE="0:"+"b".repeat(64);
const ID="rfd_"+"c".repeat(32),TX="1".repeat(64),IN_TX="2".repeat(64),MSG="3".repeat(64);

function refunds(t,{network="mainnet",indexedNetwork=null,independentNetwork=null,
    intentNetwork=null,ambiguous=false,withFee=true}={}) {
    const dir=mkdtempSync(join(tmpdir(),"ww-mainnet-readonly-refund-recovery-"));
    t.after(()=>rmSync(dir,{recursive:true,force:true}));
    const networkName=network.toUpperCase(),globalId=network==="mainnet"?-239:-3;
    const store=new RefundObligationStore({dataDir:join(dir,"refunds")});
    store.initialize();
    store.create(new RefundObligation({
        schemaVersion:1,obligationId:ID,
        idempotencyKey:networkName+":p-olga:in-tx",
        networkName,globalId,roomNumber:37,roomId:"expired-room",
        playerId:"Olga",paymentIntentId:"p-olga",incomingTransactionId:"in-tx",
        amountAtomic:1000000000,denomination:"TON",payerAddress:PAYER,
        refundDestination:PAYER,closureReason:"setup_expired",createdAtMs:NOW-2000,
        state:"PENDING",attempts:[],outgoingTransactionId:null,finalizedEvidence:null
    }));
    store.markSubmissionUnknown(ID,{
        attempt:{networkName,globalId,idempotencyKey:networkName+":p-olga:in-tx",
            attemptId:ID+":attempt",state:"SUBMISSION_UNKNOWN",
            startedAtMs:NOW-1000,completedAtMs:NOW-1000,
            outgoingTransactionId:null,errorCode:null},
        transferAmountAtomic:998000000,gasChargeAtomic:2000000
    });
    const calls={history:0,indexed:0,independent:0,settled:0};
    const observer={
        async findOutgoingTransfer(q){
            calls.history++;
            assert.equal(q.sourceWalletAddress,SOURCE);
            assert.equal(q.amountAtomic,998000000);
            assert.equal(q.minCreatedAtMs,NOW-2000);
            return ambiguous?{ambiguous:true}:{
                transactionId:TX,sourceAddress:SOURCE,
                destinationAddress:PAYER,amountAtomic:998000000
            };
        },
        async verifyIndexedRecipientCredit(q){
            calls.indexed++;
            assert.equal(q.transactionId,TX);
            return {status:"MASTERCHAIN_INDEXED_RECIPIENT_CREDIT_OBSERVED",
                globalId:indexedNetwork==="testnet"?-3:indexedNetwork==="mainnet"?-239:globalId,
                sourceFinality:"finalized",recipientFinality:"finalized",
                sourceTransactionId:TX,recipientTransactionId:IN_TX,messageHash:MSG,
                destinationAddress:PAYER,amountAtomic:998000000,
                sourceBlockRef:{workchain:0,shard:"8000000000000000",seqno:222}};
        }
    };
    const independent={
        async verifyTransfer(){
            calls.independent++;
            return {status:"INDEPENDENT_INDEXED_CREDIT_OBSERVED",
                provider:"tonapi-"+(independentNetwork??network),
                sourceTransactionId:TX,recipientTransactionId:IN_TX,messageHash:MSG,
                sourceWalletAddress:SOURCE,destinationAddress:PAYER,
                amountAtomic:998000000,actualFeeAtomic:withFee?1000000:null};
        }
    };
    const intentStore={listForRoom:()=>[{
        network:intentNetwork??network,paymentReference:"p-olga",
        transactionId:"in-tx",expectedSender:PAYER,destinationWalletAddress:SOURCE
    }]};
    const worker=new TestnetPendingRefundReconciler({
        network,refundStore:store,intentStore,
        toncenterObserver:observer,independentVerifier:independent,
        nowProvider:()=>NOW,maxPerPass:2
    });
    return {worker,store,dir,calls};
}

test("Mainnet READ-ONLY recovery finishes a submitted refund on two independent indexed sources",async t=>{
    const h=refunds(t);
    const report=await h.worker.runPass();
    assert.equal(report.results[0].status,"REFUND_COMPLETE_TWO_SOURCES");
    const done=h.store.get(ID);
    assert.equal(done.state,"COMPLETE");
    assert.equal(done.finalizedEvidence.networkName,"MAINNET");
    assert.equal(done.finalizedEvidence.globalId,-239);
    assert.equal(done.outgoingTransactionId,TX);
    assert.equal(done.transferAmountAtomic,998000000);
    assert.equal(done.gasChargeAtomic,2000000);
    assert.equal(h.calls.history,1);
    const replay=new RefundObligationStore({dataDir:join(h.dir,"refunds")});
    replay.initialize();
    assert.equal(replay.get(ID).state,"COMPLETE");
    assert.equal((await h.worker.runPass()).status,"NO_SUBMITTED_REFUNDS");
    assert.equal(h.calls.history,1,"recovery must never submit or rescan completed refund");
});

test("Mainnet refund recovery refuses wrong chain, wrong independent provider and wrong payment intent network",async t=>{
    for(const options of [
        {indexedNetwork:"testnet"},
        {independentNetwork:"testnet"},
        {intentNetwork:"testnet"},
        {ambiguous:true}
    ]){
        const h=refunds(t,options);
        const result=await h.worker.runPass();
        assert.equal(result.scanned,1);
        assert.notEqual(result.results[0].status,"REFUND_COMPLETE_TWO_SOURCES");
        assert.equal(h.store.get(ID).state,"SUBMISSION_UNKNOWN");
    }
});

test("Testnet default refund recovery still closes Testnet obligation",async t=>{
    const h=refunds(t,{network:"testnet"});
    const result=await h.worker.runPass();
    assert.equal(result.results[0].status,"REFUND_COMPLETE_TWO_SOURCES");
    assert.equal(h.store.get(ID).finalizedEvidence.globalId,-3);
});

test("Mainnet refund recovery never scans only-PENDING, unattempted records",async t=>{
    const h=refunds(t);
    const original=h.store.get(ID).toRecord();
    const worker=new TestnetPendingRefundReconciler({
        network:"mainnet",refundStore:{
            listPending:()=>[{...original,state:"PENDING"}],
            completeFromVerifiedHistory(){throw Error("must not execute");}
        },
        intentStore:{listForRoom:()=>[]},
        toncenterObserver:{
            findOutgoingTransfer(){throw Error("must not read");},
            verifyIndexedRecipientCredit(){throw Error("must not read");}
        },
        independentVerifier:{verifyTransfer(){throw Error("must not read");}}
    });
    assert.equal((await worker.runPass()).status,"NO_SUBMITTED_REFUNDS");
});

const payout=network=>({
    payoutId:"payout_"+"e".repeat(32),roomId:"room-completed",
    network,transfers:[
        {recipientRole:"WINNER",recipientId:"Olga",address:PAYER,netAtomic:2850000000},
        {recipientRole:"OWNER",recipientId:"WheelWin",address:SOURCE,netAtomic:147000000}
    ]
});

function payoutWorker({network="mainnet",planNetwork=network,
    walletNetwork=network,poolNetwork=network,slot=1,transportNetwork=network}={}){
    const planned=payout(planNetwork),calls=[];
    const transport={
        _network:transportNetwork,
        async reconcileAndSettle(args){
            calls.push(args);
            return {status:"PAYOUT_OUTGOING_CONFIRMATION_PENDING"};
        }
    };
    const worker=new TestnetPendingPayoutReconciler({
        network,maxPerPass:2,
        ledgerStore:{list:()=>[{kind:LEDGER_ENTRY_KIND.PAYOUT_PLAN,
            roomId:planned.roomId,metadata:{payoutId:planned.payoutId,plan:planned}}]},
        ledger:{countOpenObligations:()=>2},
        walletPool:{
            network:poolNetwork,
            getReservationForRoom:()=>({
                roomNumber:slot,network:walletNetwork,
                reservedByRoomId:planned.roomId,address:SOURCE
            })
        },
        transport
    });
    return {worker,calls};
}

test("Mainnet payout read-only recovery can inspect its own wallet number 1",async()=>{
    const h=payoutWorker();
    const report=await h.worker.runPass();
    assert.equal(report.scanned,1);
    assert.equal(report.results[0].status,"PAYOUT_OUTGOING_CONFIRMATION_PENDING");
    assert.equal(h.calls.length,1);
    assert.equal(h.calls[0].roomWalletAddress,SOURCE);
});

test("Mainnet payout recovery ignores Testnet plan and holds wrong wallet reservation",async()=>{
    const mismatchedPlan=payoutWorker({planNetwork:"testnet"});
    assert.equal((await mismatchedPlan.worker.runPass()).status,"NO_OPEN_PAYOUTS");
    assert.equal(mismatchedPlan.calls.length,0);
    const wrongWallet=payoutWorker({walletNetwork:"testnet"});
    assert.equal((await wrongWallet.worker.runPass()).results[0].status,
        "PAYOUT_WALLET_RESERVATION_MISSING_HOLD");
    assert.equal(wrongWallet.calls.length,0);
    assert.throws(()=>payoutWorker({poolNetwork:"testnet"}),
        /PAYOUT_MAINNET_RECOVERY_NETWORK_MISMATCH/);
    assert.throws(()=>payoutWorker({transportNetwork:"testnet"}),
        /PAYOUT_MAINNET_RECOVERY_NETWORK_MISMATCH/);
});

test("Testnet payout recovery still quarantines Testnet room wallet number 1",async()=>{
    const h=payoutWorker({network:"testnet"});
    assert.equal((await h.worker.runPass()).results[0].status,
        "PAYOUT_WALLET_RESERVATION_MISSING_HOLD");
    assert.equal(h.calls.length,0);
});

test("same native WalletV4 RPC client switches explicitly to Mainnet and never assumes seqno 0 on RPC failure",async()=>{
    let seqno=7,readFailed=false;
    const mockClient={
        async getContractState(){if(readFailed)throw Error("RPC_DOWN");return {state:"active"};},
        async runMethod(){return {stack:{readNumber:()=>seqno}};},
        async getBalance(){return 1234n;},
        async sendFile(){return undefined;}
    };
    const address=SOURCE;
    const mainnet=new TestnetNativeTonService({network:"mainnet",client:mockClient});
    assert.equal(mainnet.network,"mainnet");
    assert.equal(mainnet.globalId,-239);
    assert.equal(await mainnet.getSeqno(address),7);
    assert.equal(await mainnet.getBalance(address),1234n);
    seqno=8;
    assert.equal(await mainnet.getSeqno(address),8);
    readFailed=true;
    await assert.rejects(mainnet.getSeqno(address),/RPC_DOWN/);
    readFailed=false;
    mockClient.getContractState=async()=>({state:"uninitialized"});
    assert.equal(await mainnet.getSeqno(address),0);
    const testnet=new TestnetNativeTonService({client:mockClient});
    assert.equal(testnet.globalId,-3);
    assert.equal(testnet.network,"testnet");
    assert.throws(()=>new TestnetNativeTonService({
        network:"mainnet",endpoint:"https://testnet.toncenter.com/api/v2/jsonRPC",
        client:mockClient
    }),/MAINNET_NATIVE_RPC_ENDPOINT_MISMATCH/);
    assert.throws(()=>new TestnetNativeTonService({
        network:"mainnet",endpoint:"https://toncenter.com.evil.example/api/v2/jsonRPC",
        client:mockClient
    }),/MAINNET_NATIVE_RPC_ENDPOINT_MISMATCH/);
    assert.throws(()=>new TestnetNativeTonService({network:"unknown",client:mockClient}));
});
