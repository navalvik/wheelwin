import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,existsSync,writeFileSync} from "node:fs";
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
    payoutNetwork="mainnet",noAdapter=false,wrongPool=false,wrongOutbox=false,ownerMissing=false,
    winnerLedgerSettled=false,ownerBalanceNano=150_000_000n,independentBalanceNano=null,root=null}={}){
    const dataDir=root??mkdtempSync(join(tmpdir(),"wheelwin-native-outgoing-parity-"));
    if(root===null)t.after(()=>rmSync(dataDir,{recursive:true,force:true}));
    const sent=[],settled=[],unpaidTerminals=[];
    const adapter={
        _sequenceStateDir:join(dataDir,"outbound-sequences"),
        supportsDurableTransferRetry:()=>true,
        async sendTransfer(args){sent.push(args);return {ok:true,txHash:"mock-no-chain-hash"};},
        async canFundTransfer({roomNumber,amountNano}){
            return {ok:ownerBalanceNano>=amountNano,roomNumber,address:ROOM,
                balanceNano:ownerBalanceNano,amountNano};
        },
        async estimateOutboundTransferFee({roomNumber,destination,amountNano}){
            return {ok:true,totalNano:1000000n,roomNumber,destination,amountNano};
        }
    };
    const observer={
        // The production observer has both methods; the transport selects
        // indexed verification only when its historical API is present.
        async observeRecipientCredit(){return null;},
        async findOutgoingTransfer({destinationIdentity,amountAtomic}){
            if(ownerMissing && destinationIdentity===OWNER)return null;
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
    if(independentBalanceNano!==null) {
        verifier.observeAccountBalance=async ({address})=>({
            status:"INDEPENDENT_ACCOUNT_BALANCE_OBSERVED",
            network:"mainnet",provider:"tonapi-mainnet",address,
            balanceAtomic:String(independentBalanceNano),observedAtMs:Date.now()
        });
    }
    const transport=new TestnetNativeRoomPayoutTransport({
        network:"mainnet",dataDir,
        walletPool:{network:wrongPool?"testnet":"mainnet",
            getReservationForRoom:()=>({
                roomNumber:1,reservedByRoomId:ROOM_ID,address:ROOM,network:payoutNetwork
            })},
        ...(noAdapter?{walletResolver:()=>{},tonService:{}}:{adapter:wrongOutbox
            ?{...adapter,_sequenceStateDir:join(dataDir,"another-outbox")}:adapter}),
        outgoingObserver:observer,independentVerifier:verifier,
        ledger:{
            settlePayout:args=>{settled.push(args);return {replay:false};},
            terminateOwnerCommissionUnpaid:args=>{unpaidTerminals.push(args);return {replay:false,terminal:true,paid:false};},
            listPayoutObligations:()=>[
                {payoutId:PAYOUT_ID,recipientId:"Olga",role:"WINNER",
                    netAtomic:2_850_000_000,settled:winnerLedgerSettled},
                {payoutId:PAYOUT_ID,recipientId:"WheelWin",role:"OWNER",
                    netAtomic:148_500_000,settled:false}
            ]
        }
    });
    return {transport,sent,settled,unpaidTerminals,dataDir,verifier};
}

test("Mainnet uses the same native payout sequence, isolated pre-send journal, no duplicate",async t=>{
    const h=harness(t);
    const payout=plan();
    assert.equal(payout.network,"mainnet");
    assert.equal(payout.principalAtomic,3000000000);
    assert.equal(payout.transfers.find(x=>x.recipientRole==="WINNER").netAtomic,2850000000);
    assert.equal(payout.transfers.find(x=>x.recipientRole==="OWNER").netAtomic,148500000);
    assert.equal(payout.gasReserveAtomic,1500000);
    assert.equal((await h.transport.submit({...request,plan:payout})).status,"SUBMITTED_UNCONFIRMED");
    assert.equal(h.sent.length,2);
    assert.equal(h.sent[0].destination,WINNER);
    assert.equal(h.sent[1].destination,OWNER);
    assert.equal(h.sent[0].sourceReserveNano,150000000n);
    assert.equal(h.sent[1].sourceReserveNano,1500000n);
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

test("Mainnet settles proved winner alone, never invents an owner settlement",async t=>{
    const h=harness(t,{ownerMissing:true});
    const payout=plan();
    const sent=await h.transport.submit({...request,plan:payout});
    assert.equal(sent.status,"SUBMITTED_UNCONFIRMED");
    assert.equal(h.sent.length,2);
    const first=await h.transport.reconcileAndSettle({...request,plan:payout});
    assert.equal(first.status,"WINNER_SETTLED_OWNER_UNCONFIRMED");
    assert.equal(first.ownerSettled,false);
    assert.equal(h.settled.length,1);
    assert.equal(h.settled[0].recipientId,"Olga");
    assert.equal(h.sent.length,2,"read-only settlement must never send again");
    const replay=await h.transport.reconcileAndSettle({...request,plan:payout});
    assert.equal(replay.status,"WINNER_SETTLED_OWNER_UNCONFIRMED");
    assert.equal(h.settled.length,2,"test ledger stub records calls; production ledger idempotently replays");
    assert.equal(h.settled[1].recipientId,"Olga");
});

test("Mainnet never settles winner alone with Testnet global ID, wrong TonAPI provider or missing credit",async t=>{
    for(const options of [
        {ownerMissing:true,creditGlobalId:-3},
        {ownerMissing:true,independentProvider:"tonapi-testnet"},
        {ownerMissing:true,credit:false}
    ]){
        const h=harness(t,options);
        const payout=plan();
        await h.transport.submit({...request,plan:payout});
        const sendCount=h.sent.length;
        const outcome=await h.transport.reconcileAndSettle({...request,plan:payout});
        assert.notEqual(outcome.status,"WINNER_SETTLED_OWNER_UNCONFIRMED");
        assert.equal(h.settled.length,0,
            "wrong-network or missing finality cannot settle even the winner");
        assert.equal(h.sent.length,sendCount,
            "finality checks remain observation-only");
    }
});

test("read-only owner gas diagnostics never releases wallet or marks owner paid",async t=>{
    const payout=plan();
    const due=payout.transfers.find(x=>x.recipientRole==="OWNER").netAtomic;
    const h=harness(t,{credit:false,winnerLedgerSettled:true,
        ownerBalanceNano:BigInt(due)});
    assert.equal((await h.transport.submit({...request,plan:payout})).status,
        "WINNER_CONFIRMATION_PENDING");
    const before=h.sent.length;
    const candidate=await h.transport.assessOwnerCommissionGasShortfall({...request,plan:payout});
    assert.equal(candidate.status,"OWNER_GAS_SHORTFALL_CANDIDATE_READ_ONLY");
    assert.equal(candidate.estimatedShortfallAtomic,"1000000");
    assert.equal(candidate.terminal,false);
    assert.equal(candidate.walletReleasable,false);
    assert.equal(h.sent.length,before);
    assert.equal(h.settled.length,0);

    const funded=harness(t,{credit:false,winnerLedgerSettled:true,
        ownerBalanceNano:200_000_000n});
    await funded.transport.submit({...request,plan:payout});
    const adequate=await funded.transport.assessOwnerCommissionGasShortfall({...request,plan:payout});
    assert.equal(adequate.status,"OWNER_GAS_SHORTFALL_NOT_OBSERVED");
    assert.equal(adequate.terminal,false);

    const unresolved=harness(t,{credit:false,winnerLedgerSettled:false,
        ownerBalanceNano:0n});
    await unresolved.transport.submit({...request,plan:payout});
    const hold=await unresolved.transport.assessOwnerCommissionGasShortfall({...request,plan:payout});
    assert.equal(hold.status,"OWNER_GAS_SHORTFALL_ASSESSMENT_HOLD");
    assert.equal(hold.reason,"PAYOUT_ASSESSMENT_WINNER_UNFINALIZED_OR_OWNER_CLOSED");
});

test("existing owner broadcast claim blocks any owner-gas-shortfall diagnostic terminalization",async t=>{
    const h=harness(t,{winnerLedgerSettled:true,credit:true,ownerBalanceNano:0n});
    const payout=plan();
    await h.transport.submit({...request,plan:payout});
    const result=await h.transport.assessOwnerCommissionGasShortfall({...request,plan:payout});
    assert.equal(result.status,"OWNER_GAS_SHORTFALL_ASSESSMENT_HOLD");
    assert.equal(result.reason,"PAYOUT_ASSESSMENT_OWNER_ATTEMPT_AMBIGUOUS");
    assert.equal(result.terminal,false);
    assert.equal(result.walletReleasable,false);
});

test("Mainnet owner principal deficiency needs matching independent balance and remains read-only",async t=>{
    const h=harness(t,{credit:false,winnerLedgerSettled:true,ownerBalanceNano:140_000_000n});
    const payout=plan();
    await h.transport.submit({...request,plan:payout});
    h.verifier.observeAccountBalance=async ({address})=>({
        status:"INDEPENDENT_ACCOUNT_BALANCE_OBSERVED",
        provider:"tonapi-mainnet",network:"mainnet",
        address,balanceAtomic:"140000000",observedAtMs:Date.now()
    });
    const before=h.sent.length;
    const proof=await h.transport.corroborateOwnerPrincipalShortfall({...request,plan:payout});
    assert.equal(proof.status,"OWNER_PRINCIPAL_SHORTFALL_CORROBORATED_READ_ONLY");
    assert.equal(proof.toncenterBalanceAtomic,"140000000");
    assert.equal(proof.tonapiBalanceAtomic,"140000000");
    assert.equal(proof.terminal,false);
    assert.equal(proof.walletReleasable,false);
    assert.equal(h.sent.length,before);
    assert.equal(h.settled.length,0);
});

test("Mainnet owner principal witness rejects stale, wrong-network, changed-balance and missing indexer",async t=>{
    const h=harness(t,{credit:false,winnerLedgerSettled:true,ownerBalanceNano:140_000_000n});
    const payout=plan();
    await h.transport.submit({...request,plan:payout});
    const observe=value=>async ({address})=>({
        status:"INDEPENDENT_ACCOUNT_BALANCE_OBSERVED",
        provider:"tonapi-mainnet",network:"mainnet",
        address,balanceAtomic:"140000000",observedAtMs:Date.now(),...value
    });
    const failures=[
        [{network:"testnet"},"OWNER_INDEPENDENT_BALANCE_UNVERIFIED"],
        [{provider:"tonapi-testnet"},"OWNER_INDEPENDENT_BALANCE_UNVERIFIED"],
        [{balanceAtomic:"139999999"},"OWNER_BALANCE_SOURCES_DISAGREE"],
        [{address:OWNER},"OWNER_BALANCE_SOURCES_DISAGREE"],
        [{observedAtMs:1},"OWNER_INDEPENDENT_BALANCE_UNVERIFIED"],
        [{balanceAtomic:"bad"},"OWNER_INDEPENDENT_BALANCE_UNVERIFIED"]
    ];
    for(const [witness,reason] of failures){
        h.verifier.observeAccountBalance=observe(witness);
        const result=await h.transport.corroborateOwnerPrincipalShortfall({...request,plan:payout});
        assert.equal(result.status,"OWNER_PRINCIPAL_SHORTFALL_HOLD");
        assert.equal(result.reason,reason);
        assert.equal(result.terminal,false);
    }
    delete h.verifier.observeAccountBalance;
    const missing=await h.transport.corroborateOwnerPrincipalShortfall({...request,plan:payout});
    assert.equal(missing.reason,"OWNER_INDEPENDENT_BALANCE_SOURCE_MISSING");
});

test("owner send claim appearing during independent balance read defeats shortfall release",async t=>{
    const h=harness(t,{credit:false,winnerLedgerSettled:true,ownerBalanceNano:140_000_000n});
    const payout=plan();
    await h.transport.submit({...request,plan:payout});
    h.verifier.observeAccountBalance=async ({address})=>{
        writeFileSync(join(h.dataDir,"mainnet-native-payout-attempts",PAYOUT_ID+".OWNER.json"),
            JSON.stringify({payoutId:PAYOUT_ID,role:"OWNER",state:"SUBMISSION_UNKNOWN"}));
        return {status:"INDEPENDENT_ACCOUNT_BALANCE_OBSERVED",
            provider:"tonapi-mainnet",network:"mainnet",
            address,balanceAtomic:"140000000",observedAtMs:Date.now()};
    };
    const r=await h.transport.corroborateOwnerPrincipalShortfall({...request,plan:payout});
    assert.equal(r.status,"OWNER_PRINCIPAL_SHORTFALL_HOLD");
    assert.equal(r.reason,"OWNER_OUTBOUND_CLAIM_RACE_OR_AMBIGUITY");
    assert.equal(r.walletReleasable,false);
    assert.equal(r.terminal,false);
});

test("Mainnet automatic owner shortage writes one exclusive unpaid claim without owner send",async t=>{
    const h=harness(t,{
        credit:true,winnerLedgerSettled:true,
        ownerBalanceNano:140_000_000n,independentBalanceNano:140_000_000n
    });
    const payout=plan();
    const first=await h.transport.submit({...request,plan:payout});
    assert.equal(first.status,"OWNER_COMMISSION_UNPAID_GAS_SHORTAGE_TERMINAL");
    assert.equal(first.ownerPaid,false);
    assert.equal(first.unpaidAtomic,148_500_000);
    assert.equal(h.sent.length,1);
    assert.equal(h.sent[0].destination,WINNER);
    assert.equal(h.unpaidTerminals.length,1);
    assert.equal(h.unpaidTerminals[0].recipientId,"WheelWin");
    const marker=join(h.dataDir,"mainnet-native-payout-attempts",
        PAYOUT_ID+".OWNER.json");
    assert.equal(existsSync(marker),true);
    const receipt=JSON.parse((await import("node:fs")).readFileSync(marker,"utf8"));
    assert.equal(receipt.state,"OWNER_COMMISSION_UNPAID_GAS_SHORTAGE_TERMINAL");
    const replay=await h.transport.submit({...request,plan:payout,resume:true});
    assert.equal(replay.status,"OWNER_COMMISSION_UNPAID_GAS_SHORTAGE_TERMINAL");
    assert.equal(h.sent.length,1,"reconnect cannot send a previously terminalized owner leg");
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
