import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,existsSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {TestnetNativeRoomPayoutTransport} from "../payment/runtime/TestnetNativeRoomPayoutTransport.js";
import {TonapiTestnetPayoutVerifier} from "../payment/refund/TonapiTestnetPayoutVerifier.js";
import {RoomPayoutCalculator} from "../payment/ledger/RoomPayoutCalculator.js";

const ROOM="0:"+"a".repeat(64);
const WINNER="0:"+"b".repeat(64);
const OWNER="0:"+"c".repeat(64);
const ROOM_ID="mainnet-wallet-payout";
const PAYOUT_ID="payout_"+"f".repeat(32);

function plan(network="mainnet") {
    return RoomPayoutCalculator.computePlan({
        payoutId:PAYOUT_ID,roomId:ROOM_ID,asset:"TON",network,
        principalAtomic:3000000000,
        winner:{recipientId:"Olga",address:WINNER},
        owner:{recipientId:"WheelWin",address:OWNER},
        nowMs:1800000000000
    }).toJSON();
}
const request={roomId:ROOM_ID,payoutId:PAYOUT_ID,roomWalletAddress:ROOM,
    winnerWallet:WINNER,ownerWallet:OWNER};

function harness(t,{credit=true,creditGlobalId=-239,independentProvider="tonapi-mainnet",
    payoutNetwork="mainnet",noAdapter=false,wrongPool=false,wrongOutbox=false,root=null}={}){
    const dataDir=root??mkdtempSync(join(tmpdir(),"wheelwin-native-outgoing-parity-"));
    if(root===null)t.after(()=>rmSync(dataDir,{recursive:true,force:true}));
    const sent=[],settled=[];
    const adapter={
        _sequenceStateDir:join(dataDir,"outbound-sequences"),
        supportsDurableTransferRetry:()=>true,
        async sendTransfer(args){sent.push(args);return {ok:true,txHash:"mock-no-chain-hash"};},
        async estimateOutboundTransferFee(){return {ok:true,totalNano:1000000n};}
    };
    const observer={
        // The production observer has both methods; the transport selects
        // indexed verification only when its historical API is present.
        async observeRecipientCredit(){return null;},
        async findOutgoingTransfer({destinationIdentity,amountAtomic}){
            return {transactionId:destinationIdentity===WINNER?"winner-source-tx":"owner-source-tx",
                sourceAddress:ROOM,destinationAddress:destinationIdentity,amountAtomic};
        },
        async verifyIndexedRecipientCredit({destinationIdentity,transactionId,amountAtomic}){
            if(!credit)return null;
            const isWinner=destinationIdentity===WINNER;
            return {
                status:"MASTERCHAIN_INDEXED_RECIPIENT_CREDIT_OBSERVED",
                sourceTransactionId:transactionId,
                recipientTransactionId:isWinner?"winner-recipient-tx":"owner-recipient-tx",
                messageHash:isWinner?"winner-message-hash":"owner-message-hash",
                destinationAddress:destinationIdentity,amountAtomic,
                globalId:creditGlobalId,sourceFinality:"finalized",recipientFinality:"finalized",
                sourceMcBlockSeqno:101,recipientMcBlockSeqno:102,latestIndexedMcBlockSeqno:110
            };
        }
    };
    const verifier={
        async verifyTransfer({sourceTransactionId,recipientTransactionId,
            messageHash,sourceWalletAddress,destinationAddress,amountAtomic}){
            return {status:"INDEPENDENT_INDEXED_CREDIT_OBSERVED",
                provider:independentProvider,sourceTransactionId,recipientTransactionId,
                messageHash,sourceWalletAddress,destinationAddress,amountAtomic,
                actualFeeAtomic:800000};
        }
    };
    const transport=new TestnetNativeRoomPayoutTransport({
        network:"mainnet",dataDir,
        walletPool:{network:wrongPool?"testnet":"mainnet",
            getReservationForRoom:()=>({
                roomNumber:1,reservedByRoomId:ROOM_ID,address:ROOM,network:payoutNetwork
            })},
        ...(noAdapter?{walletResolver:()=>{},tonService:{}}:{adapter:wrongOutbox
            ?{...adapter,_sequenceStateDir:join(dataDir,"another-outbox")}:adapter}),
        outgoingObserver:observer,independentVerifier:verifier,
        ledger:{settlePayout:args=>{settled.push(args);return {replay:false};}}
    });
    return {transport,sent,settled,dataDir};
}

test("Mainnet uses the same native payout sequence, isolated pre-send journal, no duplicate",async t=>{
    const h=harness(t);
    const payout=plan();
    assert.equal(payout.network,"mainnet");
    assert.equal(payout.principalAtomic,3000000000);
    assert.equal(payout.transfers.find(x=>x.recipientRole==="WINNER").netAtomic,2850000000);
    assert.equal(payout.transfers.find(x=>x.recipientRole==="OWNER").netAtomic,147000000);
    assert.equal(payout.gasReserveAtomic,3000000);
    assert.equal((await h.transport.submit({...request,plan:payout})).status,"SUBMITTED_UNCONFIRMED");
    assert.equal(h.sent.length,2);
    assert.equal(h.sent[0].destination,WINNER);
    assert.equal(h.sent[1].destination,OWNER);
    assert.equal(h.sent[0].sourceReserveNano,150000000n);
    assert.equal(h.sent[1].sourceReserveNano,3000000n);
    assert.ok(existsSync(join(h.dataDir,"mainnet-native-payout-attempts",PAYOUT_ID+".jsonl")));
    assert.ok(!existsSync(join(h.dataDir,"testnet-native-payout-attempts")));
    assert.equal((await h.transport.submit({...request,plan:payout})).status,
        "ALREADY_ATTEMPTED_NEEDS_RECONCILIATION");
    assert.equal(h.sent.length,2);
    const report=await h.transport.reconcile({...request,plan:payout});
    assert.equal(report.status,"BOTH_MASTERCHAIN_INDEXED_CREDITS_OBSERVED_UNFINALIZED");
    assert.equal(h.sent.length,2);
    const finalized=await h.transport.reconcileAndSettle({...request,plan:payout});
    assert.equal(finalized.status,"BOTH_PAYOUTS_SETTLED_FROM_DUAL_FINALITY");
    assert.equal(h.settled.length,2);
    assert.equal(h.sent.length,2);
});

test("Mainnet missing winner credit blocks owner broadcast and duplicate retry",async t=>{
    const h=harness(t,{credit:false});
    const first=await h.transport.submit({...request,plan:plan()});
    assert.equal(first.status,"WINNER_CONFIRMATION_PENDING");
    assert.equal(h.sent.length,1);
    assert.equal(h.sent[0].destination,WINNER);
    assert.equal((await h.transport.submit({...request,plan:plan()})).status,
        "ALREADY_ATTEMPTED_NEEDS_RECONCILIATION");
    assert.equal(h.sent.length,1);
});

test("Mainnet payout refuses Testnet plan, Testnet wallet, or unconfigured adapter",async t=>{
    const h=harness(t);
    await assert.rejects(h.transport.submit({...request,plan:plan("testnet")}),
        /PAYOUT_PLAN_NOT_AUTHORIZED/);
    assert.equal(h.sent.length,0);
    assert.throws(()=>harness(t,{wrongPool:true}),/PAYOUT_MAINNET_WALLET_POOL_REQUIRED/);
    assert.throws(()=>harness(t,{noAdapter:true}),/PAYOUT_MAINNET_EXPLICIT_ADAPTER_REQUIRED/);
    const mismatch=harness(t,{payoutNetwork:"testnet"});
    await assert.rejects(mismatch.transport.submit({...request,plan:plan()}),
        /PAYOUT_ROOM_WALLET_MISMATCH/);
    assert.equal(mismatch.sent.length,0);
});

test("Testnet masterchain ID cannot confirm Mainnet payout or release ledger",async t=>{
    const h=harness(t,{creditGlobalId:-3});
    const first=await h.transport.submit({...request,plan:plan()});
    assert.equal(first.status,"WINNER_CONFIRMATION_PENDING");
    assert.equal(h.sent.length,1);
    assert.equal((await h.transport.reconcile({...request,plan:plan()})).status,
        "RECIPIENT_CREDIT_CONFIRMATION_PENDING");
    assert.equal((await h.transport.reconcileAndSettle({...request,plan:plan()})).autoSettlement,false);
    assert.equal(h.settled.length,0);
});

test("Testnet TonAPI response cannot settle a Mainnet payout",async t=>{
    const h=harness(t,{independentProvider:"tonapi-testnet"});
    await h.transport.submit({...request,plan:plan()});
    const report=await h.transport.reconcileAndSettle({...request,plan:plan()});
    assert.equal(report.status,"PAYOUT_INDEPENDENT_CHECK_PENDING");
    assert.equal(h.settled.length,0);
});

const H1="a".repeat(64),H2="b".repeat(64),HM="c".repeat(64);
test("the same TonAPI verifier selects official network endpoint and checks recipient credit",async()=>{
    for(const network of ["mainnet","testnet"]){
        const calls=[];
        const base=network==="mainnet"?"https://tonapi.io":"https://testnet.tonapi.io";
        const sourceTx={
            hash:H1,account:{address:ROOM},success:true,aborted:false,total_fees:"800000",
            out_msgs:[{hash:HM,source:{address:ROOM},destination:{address:WINNER},
                value:"2850000000",bounced:false}]
        };
        const recipientTx={
            hash:H2,account:{address:WINNER},success:true,aborted:false,
            in_msg:{hash:HM,source:{address:ROOM},destination:{address:WINNER},
                value:"2850000000",bounced:false}
        };
        const verifier=new TonapiTestnetPayoutVerifier({
            network,apiKeyProvider:()=>"",
            fetchImpl:async url=>{
                calls.push(url);
                return {status:200,json:async()=>url.endsWith(H1)?sourceTx:recipientTx};
            }
        });
        const result=await verifier.verifyTransfer({
            sourceTransactionId:H1,recipientTransactionId:H2,messageHash:HM,
            sourceWalletAddress:ROOM,destinationAddress:WINNER,amountAtomic:2850000000
        });
        assert.equal(result?.status,"INDEPENDENT_INDEXED_CREDIT_OBSERVED");
        assert.equal(result?.provider,"tonapi-"+network);
        assert.equal(result?.actualFeeAtomic,800000);
        assert.equal(calls.length,2);
        assert.ok(calls.every(url=>url.startsWith(base+"/v2/blockchain/transactions/")));
    }
});

test("TonAPI verifier rejects crossing Testnet/Mainnet endpoints",()=>{
    assert.throws(()=>new TonapiTestnetPayoutVerifier({
        network:"mainnet",baseUrl:"https://testnet.tonapi.io"
    }),/invalid TonAPI Testnet read-only configuration/);
    assert.throws(()=>new TonapiTestnetPayoutVerifier({
        network:"testnet",baseUrl:"https://tonapi.io"
    }),/invalid TonAPI Testnet read-only configuration/);
});

test("Mainnet payout refuses wrong or absent shared durable seqno journal",t=>{
    assert.throws(()=>harness(t,{wrongOutbox:true}),
        /PAYOUT_MAINNET_SHARED_DURABLE_SEQNO_REQUIRED/);
});
