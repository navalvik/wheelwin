import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {PaymentIntent} from "../payment/PaymentIntent.js";
import {PaymentIntentStore} from "../payment/PaymentIntentStore.js";
import {PAYMENT_INTENT_STATE} from "../payment/PaymentIntentStatus.js";
import {LedgerStore} from "../payment/ledger/LedgerStore.js";
import {LEDGER_ENTRY_KIND} from "../payment/ledger/LedgerConstants.js";
import {
    REFUND_NETWORK, REFUND_GLOBAL_ID_BY_NETWORK,
    RefundObligation
} from "../payment/refund/RefundObligation.js";
import {RefundObligationStore} from "../payment/refund/RefundObligationStore.js";
import {RefundLifecycleCoordinator} from "../payment/refund/RefundLifecycleCoordinator.js";

const NOW=1800000000000;
const wallet="0:"+"a".repeat(64);
const payers=["b","c","d"].map(x=>"0:"+x.repeat(64));

function harness(network,settledCount,{root=null}={}) {
    const base=root??mkdtempSync(join(tmpdir(),"wheelwin-network-refund-"));
    const dir=join(base,network); // same durable layout as PaymentRuntimeFactory
    const intentStore=new PaymentIntentStore({
        dataDir:join(dir,"payments"),nowProvider:()=>NOW
    });
    const ledgerStore=new LedgerStore({
        dataDir:join(dir,"ledger"),nowProvider:()=>NOW
    });
    const store=new RefundObligationStore({dataDir:join(dir,"refunds")});
    intentStore.initialize();
    ledgerStore.initialize();
    store.initialize();
    for(let i=0;i<3;i++) {
        const paymentReference="REF_"+network+"_"+i;
        const incomingTransactionId="chain:"+network+":incoming_"+i;
        const intent=new PaymentIntent({
            paymentReference,roomId:"room-refund-parity",playerId:["Olga","Bob","Lena"][i],
            network,asset:"TON",destinationWalletId:"room-wallet-8",
            destinationWalletAddress:wallet,expectedSender:payers[i],
            amountAtomic:1000000000,createdAt:NOW-1000,
            expiresAt:NOW+1000,roomDeadlineMs:NOW+2000
        });
        intentStore.save(intent);
        if(i<settledCount) {
            const matched=intent.transition(PAYMENT_INTENT_STATE.MATCHED,{
                transactionId:incomingTransactionId,now:NOW
            });
            intentStore.update(matched);
            intentStore.update(matched.transition(PAYMENT_INTENT_STATE.SETTLED,{
                now:NOW
            }));
            ledgerStore.append({
                idempotencyKey:"principal:"+paymentReference,
                roomId:"room-refund-parity",kind:LEDGER_ENTRY_KIND.INCOMING_PRINCIPAL,
                amountAtomic:1000000000,playerId:intent.playerId,
                network,asset:"TON",
                metadata:{paymentReference,transactionId:incomingTransactionId,
                    intentState:"SETTLED",source:"SETTLED_PAYMENT_INTENT"}
            });
        }
    }
    const networkName=network.toUpperCase();
    const coordinator=new RefundLifecycleCoordinator({
        store,intentStore,ledgerStore,nowProvider:()=>NOW,networkName
    });
    return {base,dir,store,intentStore,ledgerStore,coordinator,networkName};
}

function prepare(h,closureReason="setup_expired") {
    return h.coordinator.prepareClosedRoom({
        roomId:"room-refund-parity",roomNumber:8,
        closureReason,status:"DESTROYED"
    });
}
async function withFixture(network,count,callback) {
    const h=harness(network,count);
    try {await callback(h);}
    finally {rmSync(h.base,{recursive:true,force:true});}
}

test("working Testnet refund rule is identical on Mainnet: aborted 0/1/2/3 confirmed payers",async()=>{
    for(const network of ["testnet","mainnet"]) {
        for(const count of [0,1,2,3]) {
            await withFixture(network,count,async h=>{
                const entries=prepare(h);
                assert.equal(entries.length,count);
                assert.equal(h.store.list().length,count);
                const closed=h.store.getClosedRoom("room-refund-parity");
                assert.equal(closed.networkName,h.networkName);
                assert.equal(closed.globalId,REFUND_GLOBAL_ID_BY_NETWORK[h.networkName]);
                for(const debt of h.store.list()) {
                    assert.equal(debt.state,"PENDING");
                    assert.equal(debt.networkName,h.networkName);
                    assert.equal(debt.globalId,closed.globalId);
                    assert.equal(debt.refundDestination,payers[["Olga","Bob","Lena"].indexOf(debt.playerId)]);
                    assert.equal(debt.amountAtomic,1000000000);
                }
                assert.equal(prepare(h).length,count);
                assert.equal(h.store.list().length,count);
                if(network==="mainnet") {
                    assert.ok(h.store.list().every(x=>x.networkName==="MAINNET"));
                    assert.ok(h.store.list().every(x=>x.globalId===-239));
                }
            });
        }
    }
});

test("both networks avoid refund debts after Page6 completion",async()=>{
    for(const network of ["testnet","mainnet"]) {
        await withFixture(network,3,async h=>{
            assert.equal(prepare(h,"result_session_expired").length,0);
            assert.equal(h.store.list().length,0);
            assert.ok(h.store.getClosedRoom("room-refund-parity"));
        });
    }
});

test("Mainnet debts are durable and replay idempotently after restart, never broadcast",async()=>{
    await withFixture("mainnet",2,async h=>{
        const first=prepare(h);
        assert.equal(first.length,2);
        const previous=h.store.list().map(x=>x.toRecord());
        const restartedStore=new RefundObligationStore({
            dataDir:join(h.dir,"refunds")
        });
        const restarted=new RefundLifecycleCoordinator({
            store:restartedStore,intentStore:h.intentStore,
            ledgerStore:h.ledgerStore,nowProvider:()=>NOW,
            networkName:REFUND_NETWORK.MAINNET
        });
        let called=0;
        const injected={networkName:"MAINNET",globalId:-239,
            canExecute:()=>true,signAndBroadcast:()=>{called++;throw Error("never");}
        };
        const report=restarted.initialize({
            providers:new Map([["MAINNET",injected]])
        });
        assert.equal(report.length,2);
        assert.ok(report.every(x=>x.outcome==="PENDING_EXECUTION_DISABLED"));
        assert.deepEqual(restartedStore.list().map(x=>x.toRecord()),previous);
        assert.equal(restarted.prepareLateConfirmedPayments("room-refund-parity").length,2);
        assert.equal(restartedStore.list().length,2);
        for(const debt of restartedStore.list()) {
            await assert.rejects(restarted.submitRefund(debt.obligationId,{provider:injected}),
                /Mainnet outgoing refunds are not yet enabled/);
            await assert.rejects(restarted.finalizeRefund(debt.obligationId,{provider:injected}),
                /Mainnet outgoing refunds are not yet enabled/);
            await assert.rejects(restarted.reconcileAmbiguousSubmission(debt.obligationId,{provider:injected}),
                /Mainnet outgoing refunds are not yet enabled/);
        }
        assert.equal(called,0);
        assert.ok(restartedStore.list().every(x=>x.state==="PENDING"));
    });
});

test("Mainnet refund model rejects wrong globalId; Testnet error contract stays unchanged",()=>{
    assert.equal(REFUND_GLOBAL_ID_BY_NETWORK.TESTNET,-3);
    assert.equal(REFUND_GLOBAL_ID_BY_NETWORK.MAINNET,-239);
    const record={
        schemaVersion:1,obligationId:"obligation",idempotencyKey:"MAINNET:ref:tx",
        networkName:"MAINNET",globalId:-239,roomNumber:8,
        roomId:"r",playerId:"p",paymentIntentId:"ref",
        incomingTransactionId:"tx",amountAtomic:1000000000,
        denomination:"TON",payerAddress:payers[0],refundDestination:payers[0],
        closureReason:"timeout",createdAtMs:NOW,state:"PENDING",attempts:[],
        outgoingTransactionId:null,finalizedEvidence:null,lastError:null
    };
    assert.equal(RefundObligation.fromRecord(record).globalId,-239);
    assert.throws(()=>RefundObligation.fromRecord({...record,globalId:-3}),
        /Mainnet globalId must be -239/);
    assert.throws(()=>RefundObligation.fromRecord({
        ...record,networkName:"TESTNET",globalId:-239
    }),/Testnet globalId must be -3/);
});

test("network-bound closed rooms cannot replay into another chain",async()=>{
    await withFixture("mainnet",1,async h=>{
        prepare(h);
        assert.throws(()=>h.store.recordClosedRoom({
            roomId:"room-refund-parity",roomNumber:8,
            closureReason:"setup_expired",closedAtMs:NOW,
            networkName:"TESTNET",globalId:-3
        }),/conflicts with its durable original/);
        const wrong=new RefundLifecycleCoordinator({
            store:h.store,intentStore:h.intentStore,ledgerStore:h.ledgerStore,
            nowProvider:()=>NOW,networkName:"TESTNET"
        });
        assert.throws(()=>wrong.prepareLateConfirmedPayments("room-refund-parity"),
            /closed-room refund network mismatch/);
    });
});
