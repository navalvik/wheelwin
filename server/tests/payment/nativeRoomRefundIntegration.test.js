import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {RefundObligationStore} from "../../payment/refund/RefundObligationStore.js";
import {RefundObligation} from "../../payment/refund/RefundObligation.js";
import {RefundLifecycleCoordinator} from "../../payment/refund/RefundLifecycleCoordinator.js";
import {TestnetOutgoingRefundProvider} from "../../payment/refund/TestnetOutgoingRefundProvider.js";
import {createTestnetNativeRefundCapabilities} from "../../payment/roomWallet/TestnetNativeRefundCapabilities.js";
const FROM="0:"+"a".repeat(64),TO="0:"+"b".repeat(64),NOW=1_800_000_000_000;
const ID="rfd_0123456789abcdef0123456789abcdef";
function setup(t,{failQuote=false,ambiguousSend=false}={}) {
    const root=mkdtempSync(join(tmpdir(),"ww-native-refund-"));
    t.after(()=>rmSync(root,{recursive:true,force:true}));
    const store=new RefundObligationStore({dataDir:join(root,"refunds")});
    store.initialize();
    store.create(new RefundObligation({
        schemaVersion:1,obligationId:ID,idempotencyKey:"TESTNET:p-olga:in-1",
        networkName:"TESTNET",globalId:-3,roomNumber:37,roomId:"expired-room",
        playerId:"Olga",paymentIntentId:"p-olga",incomingTransactionId:"in-1",
        amountAtomic:1_000_000_000,denomination:"TON",payerAddress:TO,
        refundDestination:TO,closureReason:"setup_expired",createdAtMs:NOW-1_000,
        state:"PENDING",attempts:[],outgoingTransactionId:null,finalizedEvidence:null
    }));
    const called={estimate:0,send:0,stateAtSend:null};
    const adapter={
        async estimateOutboundTransferFee(x){
            called.estimate++;
            assert.equal(x.roomNumber,2);
            if(failQuote)return {ok:false};
            return {ok:true,totalNano:1_000_000n};
        },
        async sendTransfer(x){
            called.send++;
            called.stateAtSend=store.get(ID).state;
            assert.equal(store.get(ID).transferAmountAtomic,998_000_000);
            assert.equal(x.sourceReserveNano,0n);
            assert.equal(x.amountNano,998_000_000n);
            assert.equal(x.roomNumber,2);
            if(ambiguousSend)throw new Error("network may have processed the transfer");
            return {ok:true,code:"AWAITING_TRANSACTION_HASH",txHash:null};
        }
    };
    const walletPool={getReservationForRoom:()=>({
        roomNumber:2,address:FROM,reservedByRoomId:"expired-room"
    })};
    const capabilities=createTestnetNativeRefundCapabilities({
        walletPool,roomWalletAdapter:adapter,dataDir:root
    });
    const provider=new TestnetOutgoingRefundProvider({
        globalId:-3,
        ...capabilities,
        finalityEvidenceProvider:{getSettlementEvidence:async()=>null},
        outgoingTransferProvider:{
            getOutgoingTransfer:async()=>null,
            findOutgoingTransfer:async()=>null
        }
    });
    const coordinator=new RefundLifecycleCoordinator({
        store,
        intentStore:{require:id=>({paymentReference:id,destinationWalletAddress:FROM})},
        ledgerStore:{listForRoom:()=>[]},
        nowProvider:()=>NOW
    });
    return {root,provider,coordinator,store,called};
}
test("payer-funded gas is durable BEFORE wallet V4 transfer; no blind resubmission",async t=>{
    const x=setup(t);
    assert.equal(x.provider.canExecute(),true);
    assert.equal(x.provider.canPrepareRefundTransfer(),true);
    const result=await x.coordinator.submitRefund(ID,{provider:x.provider});
    assert.equal(result.outcome,"SUBMISSION_UNKNOWN");
    assert.equal(x.called.estimate,1);
    assert.equal(x.called.send,1);
    assert.equal(x.called.stateAtSend,"SUBMISSION_UNKNOWN");
    assert.equal(x.store.get(ID).amountAtomic,1_000_000_000);
    assert.equal(x.store.get(ID).transferAmountAtomic,998_000_000);
    assert.equal(x.store.get(ID).gasChargeAtomic,2_000_000);
    await assert.rejects(x.coordinator.submitRefund(ID,{provider:x.provider}),
        /not awaiting submission/);
    assert.equal(x.called.send,1);
    const restarted=new RefundObligationStore({dataDir:join(x.root,"refunds")});
    restarted.initialize();
    assert.equal(restarted.get(ID).state,"SUBMISSION_UNKNOWN");
    assert.equal(restarted.get(ID).transferAmountAtomic,998_000_000);
});
test("ambiguous send never repeats, even when result is an exception",async t=>{
    const x=setup(t,{ambiguousSend:true});
    const result=await x.coordinator.submitRefund(ID,{provider:x.provider});
    assert.equal(result.outcome,"SUBMISSION_UNKNOWN");
    await assert.rejects(x.coordinator.submitRefund(ID,{provider:x.provider}),
        /not awaiting submission/);
    assert.equal(x.called.send,1);
});
test("no trustworthy fee estimate means no signed transfer and refund remains pending",async t=>{
    const x=setup(t,{failQuote:true});
    const result=await x.coordinator.submitRefund(ID,{provider:x.provider});
    assert.equal(result.outcome,"FAILED");
    assert.equal(x.store.get(ID).state,"PENDING");
    assert.equal(x.called.send,0);
});
