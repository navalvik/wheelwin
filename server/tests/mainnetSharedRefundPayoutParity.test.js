import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaymentIntent } from "../payment/PaymentIntent.js";
import { PAYMENT_INTENT_STATE } from "../payment/PaymentIntentStatus.js";
import { LEDGER_ENTRY_KIND } from "../payment/ledger/LedgerConstants.js";
import { RoomPayoutCalculator } from "../payment/ledger/RoomPayoutCalculator.js";
import {
    REFUND_NETWORK, REFUND_GLOBAL_ID_BY_NETWORK, RefundObligation
} from "../payment/refund/RefundObligation.js";
import { RefundObligationStore } from "../payment/refund/RefundObligationStore.js";
import { RefundLifecycleCoordinator } from "../payment/refund/RefundLifecycleCoordinator.js";

const NOW = 1793451600000;
const players = ["Olga","Bob","Lena"];
const sender = players.map((_,i) => "0:" + (i+1).toString(16).repeat(64));
const roomId = "mainnet-refund-parity-room";
const amounts = [1000000000,1000000000,1000000000];
function inTemporaryDirectory(action) {
    const dir = mkdtempSync(join(tmpdir(),"ww-mainnet-refund-parity-"));
    try { return action(dir); } finally { rmSync(dir,{recursive:true,force:true}); }
}
function fakePrincipalData(networkName, count) {
    const network = networkName.toLowerCase();
    const intents = players.map((playerId,i) => new PaymentIntent({
        roomId, playerId, network, asset:"TON",
        paymentReference:"PARITY_"+String(i+1),
        destinationWalletId:"wallet-7",
        destinationWalletAddress:"0:"+"a".repeat(64),
        expectedSender:sender[i],
        amountAtomic:amounts[i],
        createdAt:NOW-30000,expiresAt:NOW+480000,
        roomDeadlineMs:NOW+480000,
        state:PAYMENT_INTENT_STATE.SETTLED,
        transactionId:"tx-parity-"+i
    }));
    const principal = intents.slice(0,count).map((intent,i) => ({
        entryId:"principal-"+i,
        kind:LEDGER_ENTRY_KIND.INCOMING_PRINCIPAL,
        roomId,playerId:intent.playerId,
        network,asset:"TON",amountAtomic:intent.amountAtomic,
        metadata:{
            paymentReference:intent.paymentReference,
            transactionId:intent.transactionId,
            intentState:PAYMENT_INTENT_STATE.SETTLED,
            source:"SETTLED_PAYMENT_INTENT"
        }
    }));
    return {
        intentStore:{
            listForRoom:()=>intents,
            findByTransactionId:id=>intents.find(x=>x.transactionId===id)??null
        },
        ledgerStore:{listForRoom:()=>principal}
    };
}
function instance(dir,{networkName=REFUND_NETWORK.MAINNET,count=2,
    outgoingRefundProvider=null}={}) {
    const store = new RefundObligationStore({dataDir:dir});
    const data=fakePrincipalData(networkName,count);
    const lifecycle = new RefundLifecycleCoordinator({
        store,...data,networkName,outgoingRefundProvider,nowProvider:()=>NOW
    });
    return {store,lifecycle};
}

test("Mainnet 1/3, 2/3 and 3/3 destroyed rooms use the identical Testnet refund obligation flow",()=>{
    for(const count of [1,2,3]) {
        inTemporaryDirectory(dir=>{
            const {store,lifecycle}=instance(dir,{count});
            assert.deepEqual(lifecycle.initialize(),[]);
            const first=lifecycle.prepareClosedRoom({
                roomId,roomNumber:7,status:"DESTROYED",closureReason:"payment_timeout"
            });
            assert.equal(first.length,count);
            assert.equal(store.listPending().length,count);
            assert.ok(first.every(x=>!x.replay));
            for(const row of store.listPending()){
                assert.equal(row.networkName,REFUND_NETWORK.MAINNET);
                assert.equal(row.globalId,-239);
                assert.equal(row.state,"PENDING");
                assert.equal(row.refundDestination,row.payerAddress);
                assert.equal(row.amountAtomic,1000000000);
                assert.equal(row.attempts.length,0);
            }
            const repeated=lifecycle.prepareLateConfirmedPayments(roomId);
            assert.equal(repeated.length,count);
            assert.ok(repeated.every(x=>x.replay));
            assert.equal(store.listPending().length,count);
            // No automatic submission is possible on startup recovery.
            const recovered=instance(dir,{count});
            const reports=recovered.lifecycle.initialize();
            assert.equal(reports.length,count);
            assert.ok(reports.every(x=>x.outcome==="PENDING_EXECUTION_DISABLED"));
            assert.equal(recovered.store.listPending().length,count);
        });
    }
});

test("default coordinator still creates Testnet -3 refund debts unchanged",()=>{
    inTemporaryDirectory(dir=>{
        const store=new RefundObligationStore({dataDir:dir});
        const data=fakePrincipalData(REFUND_NETWORK.TESTNET,2);
        const lifecycle=new RefundLifecycleCoordinator({store,...data,nowProvider:()=>NOW});
        lifecycle.initialize();
        const added=lifecycle.prepareClosedRoom({
            roomId,roomNumber:7,status:"DESTROYED",closureReason:"payment_timeout"
        });
        assert.equal(added.length,2);
        assert.ok(store.listPending().every(x=>
            x.networkName===REFUND_NETWORK.TESTNET && x.globalId===-3));
        assert.equal(store.getClosedRoom(roomId).globalId,-3);
    });
});

test("all Mainnet refund transfer and finality paths remain disabled even with injected provider",async()=>{
    await inTemporaryDirectory(async dir=>{
        let calls=0;
        const provider={
            networkName:"MAINNET",globalId:-239,canExecute:()=>true,
            signAndBroadcast:async()=>{calls++;return {outcome:"SUBMITTED",outgoingTransactionId:"bad"};}
        };
        const {store,lifecycle}=instance(dir,{count:1,outgoingRefundProvider:provider});
        lifecycle.initialize({providers:new Map([["MAINNET",provider]])});
        lifecycle.prepareClosedRoom({
            roomId,roomNumber:7,status:"DESTROYED",closureReason:"payment_timeout"
        });
        const obligation=store.listPending()[0];
        const id=obligation.obligationId;
        await assert.rejects(lifecycle.submitRefund(id),/Mainnet refund execution remains disabled/);
        await assert.rejects(lifecycle.finalizeRefund(id),/Mainnet refund execution remains disabled/);
        await assert.rejects(lifecycle.reconcileAmbiguousSubmission(id),
            /Mainnet refund execution remains disabled/);
        assert.equal(calls,0);
        assert.equal(store.get(id).state,"PENDING");
        assert.equal(store.get(id).outgoingTransactionId,null);
    });
});

test("cross-network closed-room replay and invalid network identities fail closed",()=>{
    inTemporaryDirectory(dir=>{
        const {store,lifecycle}=instance(dir,{count:1});
        lifecycle.initialize();
        lifecycle.prepareClosedRoom({
            roomId,roomNumber:7,status:"DESTROYED",closureReason:"payment_timeout"
        });
        assert.throws(()=>store.recordClosedRoom({
            roomId:"wrong-chain",roomNumber:7,closureReason:"payment_timeout",
            closedAtMs:NOW,networkName:"MAINNET",globalId:-3
        }),/network identity/);
        assert.throws(()=>store.recordClosedRoom({
            roomId:"wrong-chain",roomNumber:7,closureReason:"payment_timeout",
            closedAtMs:NOW,networkName:"TESTNET",globalId:-239
        }),/network identity/);
        const record=store.listPending()[0].toRecord();
        assert.throws(()=>RefundObligation.fromRecord({
            ...record,networkName:"MAINNET",globalId:-3
        }),/globalId/);
        const incompatible=new RefundLifecycleCoordinator({
            store,...fakePrincipalData("TESTNET",1),nowProvider:()=>NOW
        });
        assert.throws(()=>incompatible.prepareLateConfirmedPayments(roomId),
            /another TON network/);
        assert.throws(()=>new RefundLifecycleCoordinator({
            store,networkName:"testnet"
        }),/refund network must/);
    });
});

test("same payout calculator handles Testnet and Mainnet without another financial formula",()=>{
    const plans=["testnet","mainnet"].map(network=>
        RoomPayoutCalculator.computePlan({
            payoutId:"same-payout",roomId:"parity-payout",asset:"TON",
            network,principalAtomic:3000000000,
            winner:{recipientId:"Olga",address:sender[0]},
            owner:{recipientId:"owner",address:sender[1]},
            nowMs:NOW
        })
    );
    for(const plan of plans){
        assert.equal(plan.transferFor("WINNER").grossAtomic,2850000000);
        assert.equal(plan.transferFor("OWNER").grossAtomic,147000000);
        assert.equal(plan.gasReserveAtomic,3000000);
        assert.equal(plan.reconcile(),true);
        assert.equal(plan.capabilities.transfersEnabled,false);
        assert.equal(plan.capabilities.broadcastsEnabled,false);
    }
    assert.deepEqual(plans[0].transfers.map(x=>x.toJSON()),
        plans[1].transfers.map(x=>x.toJSON()));
    assert.notEqual(plans[0].network,plans[1].network);
});
