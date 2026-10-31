import test from "node:test";
import assert from "node:assert/strict";
import { ToncenterTransactionsClient } from "../payment/toncenter/ToncenterTransactionsClient.js";
import { ToncenterIncomingProvider } from "../payment/toncenter/ToncenterIncomingProvider.js";
import { mapToncenterTransactionsResponse } from "../payment/toncenter/ToncenterTransactionsMapper.js";
import {
    ToncenterIndexedFinalityEvidenceProvider
} from "../payment/toncenter/ToncenterIndexedFinalityEvidenceProvider.js";
import {
    RoomPaymentObservationService,hasTrustedRoomPaymentSettlementEvidence
} from "../payment/toncenter/RoomPaymentObservationService.js";
import { PaymentIntent } from "../payment/PaymentIntent.js";
import {
    TONCENTER_CHAIN_CONFIG,requireToncenterChainConfig
} from "../payment/toncenter/ToncenterConstants.js";

const wallet="0:"+"a".repeat(64);
const senders=["b","c","d"].map(letter=>"0:"+letter.repeat(64));
const now=Math.floor(Date.now()/1000)*1000;
const refs=["OLGA_1","BOB_2","LENA_3"];
const roomId="toncenter-shared-three-player-room";
const deadline=now+440000;
function intents(network) {
    return refs.map((paymentReference,i)=>new PaymentIntent({
        paymentReference,roomId,playerId:["Olga","Bob","Lena"][i],
        network,asset:"TON",destinationWalletId:"room-wallet-7",
        destinationWalletAddress:wallet,expectedSender:senders[i],
        amountAtomic:1000000000,createdAt:now-40000,
        expiresAt:deadline,roomDeadlineMs:deadline
    }));
}
function transactions({missingMemo=false}={}) {
    return refs.map((ref,i)=>({
        hash:"same-toncenter-tx-"+i,account:wallet,
        now:now/1000-5,emulated:false,
        block_ref:{workchain:0,shard:"8000000000000000",seqno:5000+i},
        mc_block_seqno:9000+i,
        description:{aborted:false,compute_ph:{success:true},action:{success:true}},
        in_msg:{source:senders[i],destination:wallet,value:"1000000000",
            message_content:{decoded:{type:"text_comment",
                comment:missingMemo&&i===1?"":"WW1:"+ref}}}
    }));
}
function configured({network="mainnet",reportedGlobalId,reportedDepth=9100,missingMemo=false}={}) {
    const chain=requireToncenterChainConfig(network);
    const calls=[];
    const client=new ToncenterTransactionsClient({
        baseUrl:chain.baseUrl,apiKeyProvider:()=>"SYNTHETIC-NO-SECRETS",
        fetchImpl:async(url,init)=>{
            calls.push({path:new URL(url).pathname,method:init.method});
            const body=new URL(url).pathname.endsWith("masterchainInfo")
                ? {last:{global_id:reportedGlobalId??chain.globalId,seqno:reportedDepth}}
                : {transactions:transactions({missingMemo}),address_book:{}};
            return new Response(JSON.stringify(body),{status:200});
        }
    });
    const provider=new ToncenterIncomingProvider({
        client,mapper:(response,query)=>mapToncenterTransactionsResponse(
            response,{...query,network}
        )
    });
    const evidence=new ToncenterIndexedFinalityEvidenceProvider({
        client,network,nowProvider:()=>now
    });
    const observation=new RoomPaymentObservationService({
        provider,network,settlementEvidenceProvider:evidence,
        nowProvider:()=>now
    });
    return {chain,client,calls,observation};
}
async function check(instance,network) {
    return instance.observation.checkRoomPayments({
        roomId,walletAddress:wallet,paymentIntents:intents(network),
        floorMs:now-40000,ceilingMs:now+1000,
        destinationWalletId:"room-wallet-7"
    });
}

test("Mainnet reuses exactly the Testnet Toncenter indexed confirmation flow for 3/3 players",async()=>{
    const f=configured({network:"mainnet"});
    const result=await check(f,"mainnet");
    assert.deepEqual(f.calls.map(x=>x.path).sort(),[
        "/api/v3/masterchainInfo","/api/v3/transactions"
    ]);
    assert.ok(f.calls.every(x=>x.method==="GET"));
    assert.equal(result.transfers.length,3);
    assert.equal(result.observations.filter(x=>x.status==="matched").length,3);
    assert.equal(result.settlementEvidenceAvailable,true);
    for(const transfer of result.transfers) {
        assert.equal(transfer.network,"mainnet");
        assert.equal(hasTrustedRoomPaymentSettlementEvidence(result,transfer,now),true);
        assert.equal(transfer.asset,"TON");
    }
    assert.equal(result.paymentConfirmation,false); // Observer never settles itself
    assert.equal(f.observation.hasBackgroundWork(),false);
});

test("original default Testnet behaviour and -3 global ID remain unchanged",async()=>{
    const f=configured({network:"testnet"});
    const result=await check(f,"testnet");
    assert.equal(result.observations.filter(x=>x.status==="matched").length,3);
    assert.equal(result.settlementEvidenceAvailable,true);
    assert.ok(result.transfers.every(x=>x.network==="testnet"));
    assert.ok(result.transfers.every(x=>
        hasTrustedRoomPaymentSettlementEvidence(result,x,now)));
    const mapped=mapToncenterTransactionsResponse({
        transactions:transactions(),address_book:{}
    },{
        walletAddress:wallet,floorMs:now-40000,ceilingMs:now+1000,limit:10
    });
    assert.equal(mapped.records[0].network,"testnet");
    assert.equal(TONCENTER_CHAIN_CONFIG.testnet.globalId,-3);
});

test("Testnet chain response cannot confirm Mainnet payment, and vice versa",async()=>{
    for(const [network,wrong] of [["mainnet",-3],["testnet",-239]]) {
        const f=configured({network,reportedGlobalId:wrong});
        const result=await check(f,network);
        assert.equal(result.settlementEvidenceAvailable,false);
        assert.ok(result.transfers.every(x=>
            !hasTrustedRoomPaymentSettlementEvidence(result,x,now)));
    }
});

test("same ordinary FinalityProvider pins endpoint to the explicit network",()=>{
    const f=configured({network:"mainnet"});
    assert.throws(()=>new ToncenterIndexedFinalityEvidenceProvider({
        client:f.client,network:"testnet"
    }),/Testnet/);
    const testnet=configured({network:"testnet"});
    assert.throws(()=>new ToncenterIndexedFinalityEvidenceProvider({
        client:testnet.client,network:"mainnet"
    }),/selected TON network/);
    assert.throws(()=>requireToncenterChainConfig("MAINNET"),/NETWORK_REQUIRED/);
    assert.throws(()=>requireToncenterChainConfig("unknown"),/NETWORK_REQUIRED/);
    assert.throws(()=>mapToncenterTransactionsResponse({
        transactions:[],address_book:{}
    },{
        walletAddress:wallet,floorMs:now-1000,ceilingMs:now+1000,
        limit:10,network:"unknown"
    }),/NETWORK_REQUIRED/);
});

test("Mainnet payment without memo never becomes a matched player stake",async()=>{
    const f=configured({network:"mainnet",missingMemo:true});
    const result=await check(f,"mainnet");
    assert.equal(result.observations.filter(x=>x.status==="matched").length,2);
    assert.ok(result.transfers.some(x=>x.paymentReference===null));
    assert.equal(result.paymentConfirmation,false);
});

test("Mainnet lacks authorization if indexed masterchain depth is insufficient",async()=>{
    const f=configured({network:"mainnet",reportedDepth:8999});
    const result=await check(f,"mainnet");
    assert.equal(result.settlementEvidenceAvailable,false);
    assert.ok(result.transfers.every(x=>
        !hasTrustedRoomPaymentSettlementEvidence(result,x,now)));
});
