import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {TestnetWinnerPayoutCoordinator} from "../payment/runtime/TestnetWinnerPayoutCoordinator.js";
import {TestnetNativeRoomPayoutTransport} from "../payment/runtime/TestnetNativeRoomPayoutTransport.js";
import {RoomPayoutCalculator} from "../payment/ledger/RoomPayoutCalculator.js";

const ADDRESS=n=>"0:"+n.toString(16).padStart(64,"0");
const SOURCE=ADDRESS(1),PAYER=ADDRESS(201),OWNER=ADDRESS(250);
const ROOM="room-mainnet-payout-integration",GAME="game-mainnet-payout";
const PLAYERS=["Olga","Bob","Lena"];
const NOW=1800000000000;

function harness(t,{wrongNetwork=null,wrongPool=false,wrongLedger=false,
    wrongOutbox=false,withIndependent=true,withIndexed=true,credit=false}={}){
    const dataDir=mkdtempSync(join(tmpdir(),"wheelwin-mainnet-payout-join-"));
    t.after(()=>rmSync(dataDir,{recursive:true,force:true}));
    const submitted=[],plans=new Map(),claims=new Map();
    const ledger={
        getConfirmedPrincipalAtomic:()=>3000000000,
        planPayout(args){
            if(plans.has(args.payoutId))return {replay:true,plan:plans.get(args.payoutId)};
            const plan=RoomPayoutCalculator.computePlan({
                ...args,network:"mainnet",asset:"TON",principalAtomic:3000000000
            }).toJSON();
            plans.set(args.payoutId,plan);
            return {replay:false,plan};
        }
    };
    const walletPool={
        network:"mainnet",
        getReservationForRoom:()=>({
            roomNumber:1,network:"mainnet",address:SOURCE,reservedByRoomId:ROOM
        })
    };
    const adapter={
        _sequenceStateDir:join(dataDir,wrongOutbox?"other-outbox":"outbound-sequences"),
        supportsDurableTransferRetry:()=>true,
        async sendTransfer(args){submitted.push(args);return {ok:true,txHash:"mock-offline-only"};},
        async estimateOutboundTransferFee(){return {ok:true,totalNano:1000000n};}
    };
    const outgoingObserver={
        async observeRecipientCredit(){return null;},
        async findOutgoingTransfer({destinationIdentity,amountAtomic}){
            if(!credit)return null;
            return {transactionId:destinationIdentity===PAYER?"winner-out":"owner-out",
                sourceAddress:SOURCE,destinationAddress:destinationIdentity,amountAtomic};
        },
        ...(withIndexed?{async verifyIndexedRecipientCredit({destinationIdentity,transactionId,amountAtomic}){
            if(!credit)return null;
            return {status:"MASTERCHAIN_INDEXED_RECIPIENT_CREDIT_OBSERVED",
                sourceTransactionId:transactionId,recipientTransactionId:"recipient-in",
                messageHash:"common-message",destinationAddress:destinationIdentity,
                amountAtomic,globalId:-239,
                sourceFinality:"finalized",recipientFinality:"finalized",
                sourceMcBlockSeqno:90,recipientMcBlockSeqno:91,latestIndexedMcBlockSeqno:92};
        }}:{})
    };
    const independentVerifier=withIndependent?{
        async verifyTransfer(q){return {status:"INDEPENDENT_INDEXED_CREDIT_OBSERVED",
            provider:"tonapi-mainnet",...q,actualFeeAtomic:1000000};}
    }:null;
    const transport=new TestnetNativeRoomPayoutTransport({
        network:wrongNetwork??"mainnet",
        dataDir,walletPool:wrongPool?{...walletPool}:walletPool,
        ledger:wrongLedger?{...ledger}:ledger,
        adapter,outgoingObserver,independentVerifier
    });
    const intents=PLAYERS.map((playerId,i)=>({
        roomId:ROOM,playerId,network:"mainnet",asset:"TON",
        state:"SETTLED",expectedSender:i===0?PAYER:ADDRESS(202+i),
        transactionId:"incoming-"+i,amountAtomic:1000000000
    }));
    const paymentRuntime={
        network:"mainnet",networkDataDir:dataDir,
        walletPool,ledger,refundStore:{list:()=>[]},
        paymentService:{listPaymentIntentsForRoom:()=>intents},
        outcomeStore:{
            get:id=>claims.get(id)??null,
            claim(id,kind,context){claims.set(id,{kind,context});}
        }
    };
    const args={
        paymentRuntime,
        roomManager:{getRoom:()=>({players:PLAYERS})},
        playerManager:{getIdentity:id=>({
            wallet:id==="Olga"?PAYER:ADDRESS(202+PLAYERS.indexOf(id))
        })},
        contextResolver:{resolveRoomByGameId:()=>ROOM},
        winnerEngine:{getResult:()=>({winnerPlayerId:"Olga"})},
        ownerWalletProvider:()=>OWNER,payoutSubmitter:transport
    };
    return {transport,paymentRuntime,args,submitted,plans,dataDir};
}

test("Mainnet winner/owner coordinator joins existing V4 transport only with full native evidence and shared seqno",t=>{
    const h=harness(t);
    assert.throws(()=>new TestnetWinnerPayoutCoordinator(h.args),
        /MAINNET_PAYOUT_SUBMISSION_NOT_ENABLED/);
    const coordinator=new TestnetWinnerPayoutCoordinator({
        ...h.args,mainnetPayoutEnabled:true
    });
    assert.ok(coordinator);
    assert.equal(h.submitted.length,0);
    assert.equal(h.plans.size,0);
});

test("Mainnet payout planner uses original V4 submitter, winner confirmation required before owner broadcast",async t=>{
    const h=harness(t);
    const coordinator=new TestnetWinnerPayoutCoordinator({
        ...h.args,mainnetPayoutEnabled:true
    });
    const first=await coordinator.onGameResult({gameId:GAME});
    assert.equal(first.status,"WINNER_CONFIRMATION_PENDING");
    assert.equal(h.submitted.length,1);
    assert.equal(h.submitted[0].destination,PAYER);
    assert.equal(h.plans.size,1);
    const plan=[...h.plans.values()][0];
    assert.equal(plan.network,"mainnet");
    assert.equal(plan.transfers.find(x=>x.recipientRole==="WINNER").netAtomic,2850000000);
    assert.equal(plan.transfers.find(x=>x.recipientRole==="OWNER").netAtomic,147000000);
    const replay=await coordinator.onGameResult({gameId:GAME});
    assert.ok(replay.status);
    assert.equal(h.submitted.length,1,"repeated result cannot broadcast another winner or owner payout");
    assert.equal(h.plans.size,1,"durable payout plan must not be duplicated");
});

test("Mainnet payout coordinator rejects mismatched transport evidence/ledger/pool",t=>{
    assert.throws(()=>harness(t,{wrongOutbox:true}),
        /PAYOUT_MAINNET_SHARED_DURABLE_SEQNO_REQUIRED/);
    for(const options of [
        {wrongPool:true},{wrongLedger:true},
        {withIndexed:false},{withIndependent:false}
    ]){
        const h=harness(t,options);
        assert.throws(()=>new TestnetWinnerPayoutCoordinator({
            ...h.args,mainnetPayoutEnabled:true
        }),/MAINNET_PAYOUT_COMPLETE_TRANSPORT_REQUIRED/);
        assert.equal(h.submitted.length,0);
        assert.equal(h.plans.size,0);
    }
});

test("Mainnet full payout configuration is never constructed by the app preparation runtime",t=>{
    const h=harness(t);
    assert.equal(h.paymentRuntime.network,"mainnet");
    const plannerOnly=new TestnetWinnerPayoutCoordinator({
        ...h.args,payoutSubmitter:null
    });
    assert.ok(plannerOnly);
    assert.equal(h.submitted.length,0);
});
