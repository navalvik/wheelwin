import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";
import {buildMainnetPaymentRuntime} from "../payment/runtime/PaymentRuntimeFactory.js";
import {TestnetWinnerPayoutCoordinator} from "../payment/runtime/TestnetWinnerPayoutCoordinator.js";
import {assessThreePlayerPaymentGate} from "../payment/runtime/ThreePlayerPaymentGate.js";
import {LEDGER_ENTRY_KIND} from "../payment/ledger/LedgerConstants.js";

const NOW=1800000000000;
const address=n=>"0:"+n.toString(16).padStart(64,"0");
const PLAYERS=["Olga","Bob","Lena"];
const AMOUNT=1000000000;
const NETWORK="mainnet";
const ROOM_WALLET_1=address(1);

function harness(t) {
    const root=mkdtempSync(join(tmpdir(),"wheelwin-mainnet-full-finance-"));
    t.after(()=>rmSync(root,{recursive:true,force:true}));
    const catalogPath=join(root,"64-public-wallets.json");
    writeFileSync(catalogPath,JSON.stringify(Array.from({length:64},(_,i)=>({
        roomNumber:i+1,network:NETWORK,address:address(i+1)
    }))));
    const dataDir=join(root,"payments"),calls=[];
    let transactions=[];
    const fetchImpl=async(url,init)=>{
        const path=new URL(url).pathname;
        calls.push({path,method:init.method});
        assert.equal(new URL(url).origin,"https://toncenter.com",
            "the mock receives only Mainnet RPC URLs");
        const data=path.endsWith("masterchainInfo")
            ?{last:{global_id:-239,seqno:20000}}
            :{transactions,address_book:{}};
        return new Response(JSON.stringify(data),{status:200});
    };
    function runtime(){
        const r=buildMainnetPaymentRuntime({
            dataDir,walletCatalogPath:catalogPath,
            nowProvider:()=>NOW,fetchImpl,
            apiKeyProvider:()=>"OFFLINE-SYNTHETIC-NO-REAL-KEY"
        });
        r.initialize();
        return r;
    }
    const descriptor=roomId=>({
        roomId,roomCreatedAt:NOW-20000,
        network:NETWORK,asset:"TON",
        stakeLedgerRelation:"ONE_PLAYER_STAKE_AND_PRINCIPAL_PER_PAYMENT",
        requiredPlayers:PLAYERS.map((playerId,i)=>({
            roomId,playerId,paymentReference:"WW-MAIN-"+roomId+"-"+i,
            expectedSender:address(120+i),amountAtomic:AMOUNT
        }))
    });
    function txFor(requirement,slot,ordinal) {
        return {
            hash:createHash("sha256").update(requirement.paymentReference).digest("hex"),
            account:slot.address,now:NOW/1000-5,emulated:false,
            block_ref:{workchain:0,shard:"8000000000000000",seqno:200+ordinal},
            mc_block_seqno:9000+ordinal,
            description:{aborted:false,compute_ph:{success:true},action:{success:true}},
            in_msg:{
                source:requirement.expectedSender,destination:slot.address,
                value:String(requirement.amountAtomic),bounced:false,
                message_content:{decoded:{type:"text_comment",
                    comment:"WW1:"+requirement.paymentReference}}
            }
        };
    }
    function setPaid(d,slot,count){
        transactions=d.requiredPlayers.slice(0,count).map((p,i)=>txFor(p,slot,i));
    }
    return {root,dataDir,runtime,descriptor,setPaid,calls};
}
function principalFor(r,roomId){
    return r.ledgerStore.listForRoom(roomId)
        .filter(x=>x.kind===LEDGER_ENTRY_KIND.INCOMING_PRINCIPAL);
}
function gateSnapshot(r,d){
    const roomId=d.roomId;
    return assessThreePlayerPaymentGate({
        roomId,roomPlayerIds:PLAYERS,network:"mainnet",asset:"TON",
        requirements:d.requiredPlayers.map(p=>({
            ...p,network:"mainnet",asset:"TON",roomId,
            destinationWalletAddress:r.paymentService.getWalletForRoom(roomId)?.address
        })),
        intents:r.paymentService.listPaymentIntentsForRoom(roomId),
        principalEntries:principalFor(r,roomId),nowMs:NOW
    });
}

test("Mainnet offline finance: three verified native TON receipts -> durable ledger -> winner/owner plan; live Page5 stays blocked",async t=>{
    const h=harness(t),roomId="MAINNET_SUCCESS";
    let runtime=h.runtime();
    const desc=h.descriptor(roomId);
    const prepared=runtime.sessionAdapter.prepareRoom(desc);
    assert.equal(prepared.payments.length,3);
    assert.equal(prepared.payments[0].destinationWalletAddress,ROOM_WALLET_1);
    assert.equal(runtime.getCapabilities().settlementEnabled,false);
    const slot=runtime.walletPool.getReservationForRoom(roomId);
    for(let i=1;i<=3;i++){
        h.setPaid(desc,slot,i);
        const report=await runtime.coordinator.settleRoomPayments({roomId,floorMs:NOW-20000,ceilingMs:NOW+1000,now:NOW});
        assert.equal(report.refusal,null,JSON.stringify(report));
        const actual=runtime.paymentService.listPaymentIntentsForRoom(roomId)
            .filter(x=>x.state==="SETTLED");
        assert.equal(actual.length,i,"only the observed payers may be marked settled; report="+JSON.stringify(report)+"; states="+JSON.stringify(runtime.paymentService.listPaymentIntentsForRoom(roomId).map(x=>({id:x.paymentReference,state:x.state,tx:x.transactionId}))));
        assert.equal(runtime.paymentGate.getGameStartGateStatus(roomId,PLAYERS).eligible,
            false,"production Mainnet Page5 gate never opens during preparation");
    }
    assert.equal(h.calls.filter(x=>x.path==="/api/v3/transactions").length,3);
    assert.equal(principalFor(runtime,roomId).length,0,
        "the receipt->ledger crash boundary has not been repaired yet");
    runtime.shutdown();
    runtime=h.runtime();
    assert.equal(principalFor(runtime,roomId).length,3,
        "startup repairs one authoritative principal per persisted settled intent");
    assert.equal(runtime.ledger.getConfirmedPrincipalAtomic(roomId),3*AMOUNT);
    assert.equal(runtime.getCapabilities().outgoingRefundTransfersEnabled,false);
    const playerWallet=Object.fromEntries(desc.requiredPlayers.map(p=>[p.playerId,p.expectedSender]));
    const payout=new TestnetWinnerPayoutCoordinator({
        paymentRuntime:runtime,
        roomManager:{getRoom:id=>id===roomId?{players:PLAYERS}:null},
        playerManager:{getIdentity:id=>({wallet:playerWallet[id]})},
        contextResolver:{resolveRoomByGameId:id=>id==="GAME_SUCCESS"?roomId:null},
        winnerEngine:{getResult:()=>({winnerPlayerId:"Olga"})},
        ownerWalletProvider:()=>address(250),
        payoutSubmitter:null
    });
    assert.equal((await payout.onGameResult({gameId:"GAME_SUCCESS"})).status,
        "PAYOUT_PLANNED_EXECUTOR_UNAVAILABLE");
    const obligations=runtime.ledger.listPayoutObligations(roomId);
    assert.equal(obligations.length,2);
    assert.ok(obligations.every(x=>!x.settled));
    const plan=runtime.ledgerStore.listForRoom(roomId)
        .find(x=>x.kind===LEDGER_ENTRY_KIND.PAYOUT_PLAN)?.metadata?.plan;
    assert.equal(plan?.network,"mainnet");
    assert.equal(plan?.principalAtomic,3*AMOUNT);
    assert.equal(plan.transfers.find(x=>x.recipientRole==="WINNER").netAtomic,2850000000);
    assert.equal(plan.transfers.find(x=>x.recipientRole==="OWNER").netAtomic,147000000);
    assert.equal((await payout.onGameResult({gameId:"GAME_SUCCESS"})).status,
        "ALREADY_PLANNED_NEEDS_RECONCILIATION");
    runtime.shutdown();
    runtime=h.runtime();
    assert.equal(runtime.ledger.listPayoutObligations(roomId).length,2);
    assert.equal(runtime.paymentGate.getGameStartGateStatus(roomId,PLAYERS).eligible,false);
    runtime.shutdown();
});

test("Mainnet offline timeout: two observed payers -> exactly two durable refund debts; never a Page5 game or send",async t=>{
    const h=harness(t),roomId="MAINNET_EXPIRED";
    let runtime=h.runtime();
    const desc=h.descriptor(roomId);
    runtime.sessionAdapter.prepareRoom(desc);
    const slot=runtime.walletPool.getReservationForRoom(roomId);
    h.setPaid(desc,slot,2);
    const report=await runtime.coordinator.settleRoomPayments({roomId,floorMs:NOW-20000,ceilingMs:NOW+1000,now:NOW});
    assert.equal(report.refusal,null,JSON.stringify(report));
    assert.equal(runtime.paymentService.listPaymentIntentsForRoom(roomId)
        .filter(x=>x.state==="SETTLED").length,2);
    assert.equal(runtime.paymentGate.getGameStartGateStatus(roomId,PLAYERS).eligible,false);
    runtime.shutdown();
    runtime=h.runtime();
    assert.equal(principalFor(runtime,roomId).length,2);
    const debts=runtime.refundLifecycle.prepareClosedRoom({
        roomId,roomNumber:16,closureReason:"setup_expired",status:"DESTROYED"
    });
    assert.equal(debts.length,2);
    assert.ok(debts.every(x=>x.networkName==="MAINNET"
        && x.globalId===-239));
    assert.equal(runtime.refundStore.listPending().length,2);
    assert.equal(runtime.refundLifecycle.prepareLateConfirmedPayments(roomId).length,2);
    assert.equal(runtime.refundStore.list().length,2,
        "replay cannot duplicate debt");
    assert.equal(runtime.outgoingRefundProvider,null);
    runtime.shutdown();
    runtime=h.runtime();
    const pending=runtime.refundStore.listPending();
    assert.equal(pending.length,2);
    assert.ok(pending.every(x=>x.state==="PENDING"));
    assert.equal(runtime.refundLifecycle.recover().length,2);
    assert.ok(runtime.refundLifecycle.recover().every(x=>
        x.outcome==="PENDING_EXECUTION_DISABLED"));
    assert.equal(runtime.paymentGate.getGameStartGateStatus(roomId,PLAYERS).eligible,false);
    runtime.shutdown();
});

test("Mainnet offline aborted 3/3 before Page5: all three payers get obligations, not winner payout",async t=>{
    const h=harness(t),roomId="MAINNET_ABORT_3_OF_3";
    let runtime=h.runtime();
    const desc=h.descriptor(roomId);
    runtime.sessionAdapter.prepareRoom(desc);
    h.setPaid(desc,runtime.walletPool.getReservationForRoom(roomId),3);
    assert.equal((await runtime.coordinator.settleRoomPayments({roomId,floorMs:NOW-20000,ceilingMs:NOW+1000,now:NOW})).refusal,null);
    runtime.shutdown();
    runtime=h.runtime();
    assert.equal(principalFor(runtime,roomId).length,3);
    assert.equal(runtime.paymentGate.getGameStartGateStatus(roomId,PLAYERS).eligible,false);
    const debts=runtime.refundLifecycle.prepareClosedRoom({
        roomId,roomNumber:20,closureReason:"setup_expired",status:"DESTROYED"
    });
    assert.equal(debts.length,3);
    assert.equal(runtime.outcomeStore.get(roomId)?.kind,"REFUND");
    const id=Object.fromEntries(desc.requiredPlayers.map(p=>[p.playerId,p.expectedSender]));
    const payout=new TestnetWinnerPayoutCoordinator({
        paymentRuntime:runtime,
        roomManager:{getRoom:()=>({players:PLAYERS})},
        playerManager:{getIdentity:id_=>({wallet:id[id_]})},
        contextResolver:{resolveRoomByGameId:()=>roomId},
        winnerEngine:{getResult:()=>({winnerPlayerId:"Olga"})},
        ownerWalletProvider:()=>address(250),payoutSubmitter:null
    });
    await assert.rejects(payout.onGameResult({gameId:"ABORTED_GAME"}),/PAYOUT_REFUND_CONFLICT/);
    assert.equal(runtime.ledgerStore.listForRoom(roomId)
        .filter(x=>x.kind===LEDGER_ENTRY_KIND.PAYOUT_PLAN).length,0);
    assert.equal(runtime.refundStore.list().length,3);
    runtime.shutdown();
});
