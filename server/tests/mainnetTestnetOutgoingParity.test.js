import test from "node:test";
import assert from "node:assert/strict";
import { verifyOutgoingRefundFinality } from "../payment/refund/OutgoingRefundFinality.js";
import { TestnetWinnerPayoutCoordinator } from "../payment/runtime/TestnetWinnerPayoutCoordinator.js";
import { RoomPayoutCalculator } from "../payment/ledger/RoomPayoutCalculator.js";

const NOW=1800000000000;
const wallet=n=>"0:"+n.toString(16).padStart(64,"0");
const source=wallet(1),payer=wallet(2),owner=wallet(3);
const roomId="room-mainnet-outgoing-parity";

function obligation(network) {
    return {
        networkName:network.toUpperCase(),
        globalId:network==="testnet"?-3:-239,
        roomId,roomNumber:1,obligationId:"refund-outgoing-parity",
        idempotencyKey:network+":refund-outgoing-parity",
        refundDestination:payer,amountAtomic:1000000000,
        createdAtMs:NOW-20000,outgoingTransactionId:null,
        finalizedEvidence:null
    };
}
function evidence(network,txId="outgoing-1") {
    const block={workchain:0,shard:"8000000000000000",seqno:100};
    return {
        networkIdentity:{network,globalId:network==="testnet"?-3:-239,
            source:"toncenter-masterchain-info",observedAtMs:NOW},
        transactionInclusion:{transactionId:txId,accountId:source,block},
        finality:{status:"finalized",source:"toncenter-indexed-v3-masterchain",
            transactionId:txId,accountId:source,block,
            masterchainSeqno:111,observedAtMs:NOW}
    };
}
function verify(network,{receipt=evidence(network),transfer=null,debt=obligation(network),txId="outgoing-1"}={}) {
    return verifyOutgoingRefundFinality({
        obligation:debt,sourceWalletAddress:source,
        outgoingTransactionId:txId,evidence:receipt,
        outgoingTransfer:transfer??{transactionId:txId,
            sourceAddress:source,destinationAddress:payer,amountAtomic:1000000000},
        nowMs:NOW
    });
}

test("Testnet and Mainnet use identical outgoing refund finality verification",()=>{
    for(const network of ["testnet","mainnet"]) {
        const report=verify(network);
        assert.equal(report.verified,true);
        assert.equal(report.finalizedEvidence.networkName,network.toUpperCase());
        assert.equal(report.finalizedEvidence.globalId,network==="mainnet"?-239:-3);
        assert.equal(report.finalizedEvidence.destination,payer);
        assert.equal(report.finalizedEvidence.amountAtomic,1000000000);
        assert.equal(report.finalizedEvidence.transactionId,"outgoing-1");
        assert.equal(report.finalizedEvidence.finalized,true);
    }
});

test("outgoing verifier refuses cross-network evidence and mismatched sender/destination/amount",()=>{
    for(const network of ["testnet","mainnet"]) {
        const other=network==="testnet"?"mainnet":"testnet";
        const wrongNetwork=verify(network,{receipt:evidence(other)});
        assert.equal(wrongNetwork.verified,false);
        assert.equal(wrongNetwork.reason,"NETWORK_IDENTITY_UNVERIFIED");
        for(const transfer of [
            {transactionId:"outgoing-1",sourceAddress:wallet(4),destinationAddress:payer,amountAtomic:1000000000},
            {transactionId:"outgoing-1",sourceAddress:source,destinationAddress:wallet(4),amountAtomic:1000000000},
            {transactionId:"outgoing-1",sourceAddress:source,destinationAddress:payer,amountAtomic:999999999},
            {transactionId:"different-tx",sourceAddress:source,destinationAddress:payer,amountAtomic:1000000000}
        ]) assert.equal(verify(network,{transfer}).verified,false);
        const missing=verify(network,{receipt:null});
        // Null uses no evidence, it can never verify a transfer.
        assert.equal(missing.verified,false);
        assert.equal(verify(network,{debt:{...obligation(network),globalId:0}}).verified,false);
        assert.equal(verify(network,{debt:{...obligation(network),outgoingTransactionId:"another"}}).verified,false);
    }
});

function payoutHarness({network="mainnet",paid=3,roomNumber=1,submitter=null,wrongIntentNetwork=false}={}) {
    const players=["Olga","Bob","Lena"];
    const payers=[wallet(5),wallet(6),wallet(7)];
    const planned=new Map(), calls=[];
    const intents=players.map((playerId,i)=>({
        roomId,playerId,amountAtomic:1000000000,asset:"TON",
        network:wrongIntentNetwork?"testnet":network,
        expectedSender:payers[i],
        state:i<paid?"SETTLED":"PENDING",
        transactionId:i<paid?"incoming-"+i:null
    }));
    const ledger={
        getConfirmedPrincipalAtomic:()=>paid*1000000000,
        countOpenObligations:()=>2,
        planPayout(args) {
            calls.push(args);
            if(planned.has(args.payoutId))return {replay:true,plan:planned.get(args.payoutId)};
            const plan=RoomPayoutCalculator.computePlan({
                ...args,network,asset:"TON",principalAtomic:3000000000
            }).toJSON();
            planned.set(args.payoutId,plan);
            return {replay:false,plan};
        }
    };
    const coordinator=new TestnetWinnerPayoutCoordinator({
        paymentRuntime:{
            network,
            paymentService:{listPaymentIntentsForRoom:()=>intents},
            ledger,
            walletPool:{getReservationForRoom:()=>({
                roomNumber,reservedByRoomId:roomId,network,address:source
            })}
        },
        roomManager:{getRoom:()=>({players})},
        playerManager:{getIdentity:id=>({wallet:payers[players.indexOf(id)]})},
        contextResolver:{resolveRoomByGameId:()=>roomId},
        winnerEngine:{getResult:()=>({winnerPlayerId:"Olga"})},
        ownerWalletProvider:()=>owner,
        payoutSubmitter:submitter
    });
    return {coordinator,calls,planned};
}

test("existing winner payout coordinator plans exact Mainnet winner/owner/reserve with no transfer",async()=>{
    const h=payoutHarness();
    const first=await h.coordinator.onGameResult({gameId:"game-mainnet"});
    assert.equal(first.status,"PAYOUT_PLANNED_EXECUTOR_UNAVAILABLE");
    assert.equal(h.calls.length,1);
    assert.equal(h.planned.size,1);
    const plan=[...h.planned.values()][0];
    assert.equal(plan.network,"mainnet");
    assert.equal(plan.principalAtomic,3000000000);
    assert.equal(plan.gasReserveAtomic,3000000);
    assert.equal(plan.transfers.find(t=>t.recipientRole==="WINNER").grossAtomic,2850000000);
    assert.equal(plan.transfers.find(t=>t.recipientRole==="OWNER").grossAtomic,147000000);
    const replay=await h.coordinator.onGameResult({gameId:"game-mainnet"});
    assert.equal(replay.status,"ALREADY_PLANNED_NEEDS_RECONCILIATION");
    assert.equal(h.planned.size,1);
});

test("Mainnet requires 3/3 Mainnet payments before winner payout can even be planned",async()=>{
    for(const params of [{paid:2},{wrongIntentNetwork:true}]) {
        const h=payoutHarness(params);
        await assert.rejects(h.coordinator.onGameResult({gameId:"game-mainnet"}),
            /PAYOUT_THREE_SETTLED_PAYMENTS_REQUIRED/);
        assert.equal(h.planned.size,0);
    }
});

test("Mainnet planner refuses injected outgoing executor, Testnet original constructor remains valid",()=>{
    assert.throws(()=>payoutHarness({network:"mainnet",submitter:{submit(){throw Error("never");}}}),
        /MAINNET_PAYOUT_SUBMISSION_NOT_ENABLED/);
    const testnet=payoutHarness({network:"testnet",roomNumber:2,
        submitter:{submit:async()=>({status:"SUBMITTED_UNCONFIRMED"})}});
    assert.ok(testnet.coordinator);
});

test("historical Testnet room-wallet #1 quarantine does not extend to distinct Mainnet wallet #1",async()=>{
    const testnet=payoutHarness({network:"testnet",roomNumber:1});
    await assert.rejects(testnet.coordinator.onGameResult({gameId:"game-testnet"}),
        /PAYOUT_ROOM_WALLET_UNAVAILABLE/);
    const mainnet=payoutHarness({network:"mainnet",roomNumber:1});
    assert.equal((await mainnet.coordinator.onGameResult({gameId:"game-mainnet"})).status,
        "PAYOUT_PLANNED_EXECUTOR_UNAVAILABLE");
});
