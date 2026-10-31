import test from "node:test";
import assert from "node:assert/strict";
import { verifyOutgoingRefundFinality } from "../payment/refund/OutgoingRefundFinality.js";
import { TestnetOutgoingRefundProvider } from "../payment/refund/TestnetOutgoingRefundProvider.js";
import { ToncenterTestnetOutgoingTransferProvider } from "../payment/refund/ToncenterTestnetOutgoingTransferProvider.js";

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

test("existing native refund provider uses exact chain identity with mocked signer/broadcaster only",async()=>{
    for(const network of ["testnet","mainnet"]) {
        const name=network.toUpperCase(),globalId=network==="testnet"?-3:-239;
        const seen={signed:[],broadcasted:[]};
        const provider=new TestnetOutgoingRefundProvider({
            networkName:name,globalId,
            signer:{signTransfer:async descriptor=>{
                seen.signed.push(descriptor);
                return {testOnly:"signed-transfer-mock"};
            }},
            broadcaster:{broadcast:async message=>{
                seen.broadcasted.push(message);
                return {status:"SUBMITTED",transactionId:"mock-sent-1"};
            }},
            finalityEvidenceProvider:{getSettlementEvidence:async()=>evidence(network,"mock-sent-1")},
            outgoingTransferProvider:{
                getOutgoingTransfer:async()=>({transactionId:"mock-sent-1",sourceAddress:source,
                    destinationAddress:payer,amountAtomic:1000000000}),
                findOutgoingTransfer:async()=>null
            }
        });
        assert.equal(provider.canExecute(),true);
        assert.deepEqual(await provider.verifyNetwork(),{networkName:name,globalId});
        const debt=obligation(network);
        const authorization=provider.authorizeSubmission({
            obligation:debt,sourceWalletAddress:source
        });
        assert.equal(authorization.globalId,globalId);
        const attempt=await provider.signAndBroadcast({
            obligation:debt,sourceWalletAddress:source,nowMs:NOW
        });
        assert.equal(attempt.outcome,"SUBMITTED");
        assert.equal(attempt.outgoingTransactionId,"mock-sent-1");
        assert.equal(seen.signed.length,1);
        assert.equal(seen.broadcasted.length,1);
        assert.equal(seen.signed[0].networkName,name);
        assert.equal(seen.signed[0].globalId,globalId);
        const final=await provider.observeAndVerifyFinality({
            obligation:debt,sourceWalletAddress:source,
            outgoingTransactionId:"mock-sent-1",nowMs:NOW
        });
        assert.equal(final.verified,true);
        assert.throws(()=>provider.authorizeSubmission({
            obligation:obligation(network==="mainnet"?"testnet":"mainnet"),
            sourceWalletAddress:source
        }),/refund obligation/);
    }
});

test("Testnet provider default remains Testnet-only; Mainnet explicit global ID must match",()=>{
    assert.throws(()=>new TestnetOutgoingRefundProvider({globalId:-239}),
        /requires verified TON Testnet global ID -3/);
    assert.throws(()=>new TestnetOutgoingRefundProvider({
        networkName:"MAINNET",globalId:-3
    }),/verified TON network identity/);
    const p=new TestnetOutgoingRefundProvider({networkName:"MAINNET",globalId:-239});
    assert.equal(p.canExecute(),false);
    assert.equal(p.networkName,"MAINNET");
});

function outgoingIndexer(network,reportedId=null) {
    const globalId=network==="mainnet"?-239:-3;
    const messageHash="test-only-message";
    const sourceTx="outgoing-source-hash";
    const recipientTx="incoming-recipient-hash";
    const row=(account)=>account===source
        ? {
            account:source,hash:sourceTx,now:NOW/1000-2,
            description:{aborted:false,action:{success:true}},
            mc_block_seqno:250,block_ref:{workchain:0,seqno:200,shard:"8000000000000000"},
            finality:2,emulated:false,
            out_msgs:[{hash:messageHash,source,destination:payer,
                bounced:false,value:"1000000000"}]
        }
        : {
            account:payer,hash:recipientTx,now:NOW/1000-2,
            description:{aborted:false},
            mc_block_seqno:251,block_ref:{workchain:0,seqno:201,shard:"8000000000000000"},
            finality:2,emulated:false,
            in_msg:{hash:messageHash,source,destination:payer,bounced:false,value:"1000000000"}
        };
    const client={
        baseUrl:network==="mainnet"?"https://toncenter.com":"https://testnet.toncenter.com",
        async getTransactions({account}){return {transactions:[row(account)]};},
        async getMasterchainInfo(){return {last:{global_id:reportedId??globalId,seqno:260}};}
    };
    const provider=new ToncenterTestnetOutgoingTransferProvider({
        client,network,nowProvider:()=>NOW,
        lookbackMs:100000,pageSize:50,maxPages:2
    });
    return {provider,client};
}

test("same outgoing Toncenter history verifies source and recipient Mainnet indexed credit",async()=>{
    for(const network of ["testnet","mainnet"]) {
        const {provider}=outgoingIndexer(network);
        const expected=await provider.verifyIndexedRecipientCredit({
            sourceWalletAddress:source,destinationIdentity:payer,
            transactionId:"outgoing-source-hash",amountAtomic:1000000000,
            minCreatedAtMs:NOW-5000
        });
        assert.equal(expected.status,"MASTERCHAIN_INDEXED_RECIPIENT_CREDIT_OBSERVED");
        assert.equal(expected.globalId,network==="mainnet"?-239:-3);
        assert.equal(expected.sourceTransactionId,"outgoing-source-hash");
        assert.equal(expected.recipientTransactionId,"incoming-recipient-hash");
        assert.equal(expected.amountAtomic,1000000000);
        assert.equal((await provider.getOutgoingTransfer({
            sourceWalletAddress:source,transactionId:"outgoing-source-hash",
            minCreatedAtMs:NOW-5000
        })).destinationAddress,payer);
        assert.equal((await provider.findOutgoingTransfer({
            sourceWalletAddress:source,destinationIdentity:payer,
            amountAtomic:1000000000,minCreatedAtMs:NOW-5000
        })).transactionId,"outgoing-source-hash");
    }
});

test("Mainnet history refuses Testnet masterchain ID and endpoint",async()=>{
    const h=outgoingIndexer("mainnet",-3);
    assert.equal(await h.provider.verifyIndexedRecipientCredit({
        sourceWalletAddress:source,destinationIdentity:payer,
        transactionId:"outgoing-source-hash",amountAtomic:1000000000,
        minCreatedAtMs:NOW-5000
    }),null);
    assert.throws(()=>new ToncenterTestnetOutgoingTransferProvider({
        network:"mainnet",
        client:{baseUrl:"https://testnet.toncenter.com",getTransactions:async()=>({transactions:[]})}
    }),/matching Toncenter endpoint/);
    assert.throws(()=>new ToncenterTestnetOutgoingTransferProvider({
        network:"mainnet",
        client:{baseUrl:"https://toncenter.com.evil.example",getTransactions:async()=>({transactions:[]})}
    }),/matching Toncenter endpoint/);
});
