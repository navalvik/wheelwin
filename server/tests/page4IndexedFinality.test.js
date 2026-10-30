import test from "node:test";
import assert from "node:assert/strict";
import { ToncenterTransactionsClient } from "../payment/toncenter/ToncenterTransactionsClient.js";
import { ToncenterIndexedFinalityEvidenceProvider } from "../payment/toncenter/ToncenterIndexedFinalityEvidenceProvider.js";
import { ToncenterIncomingProvider } from "../payment/toncenter/ToncenterIncomingProvider.js";
import { RoomPaymentObservationService, hasTrustedRoomPaymentSettlementEvidence } from "../payment/toncenter/RoomPaymentObservationService.js";
import { PaymentIntent } from "../payment/PaymentIntent.js";
import { TonPaymentSettlementEvidenceProvider, assessTonPaymentSettlementEvidence } from "../payment/incoming/TonPaymentSettlementEvidence.js";

const account = "0:"+"a".repeat(64);
const other = "0:"+"b".repeat(64);
const tx = "testnet-transaction-hash";
const record = Object.freeze({
    transactionId:tx, accountId:account,
    block:{workchain:0,shard:"8000000000000000",seqno:4788},
    mcBlockSeqno:88112,
    emulated:false
});
const ok = (last=88115) => new Response(JSON.stringify({
    last:{global_id:-3,seqno:last}
}),{status:200,headers:{"content-type":"application/json"}});

function setup({last=88115,globalId=-3,response=null}={}) {
    const requests=[];
    const client=new ToncenterTransactionsClient({
        fetchImpl:async (url)=>{
            requests.push(url);
            return response ?? new Response(JSON.stringify({
                last:{global_id:globalId,seqno:last}
            }),{status:200,headers:{"content-type":"application/json"}});
        },
        apiKeyProvider:()=>"testnet-key"
    });
    const provider=new ToncenterIndexedFinalityEvidenceProvider({client});
    return {provider,requests};
}

test("old already-indexed payment can be finalized without subscribing before it arrived",async()=>{
    const f=setup();
    const session=await f.provider.beginObservation({accountId:account});
    assert.equal(f.requests.length,0,"opening page4 needs no API or SSE");
    const evidence=await f.provider.getSettlementEvidence({
        accountId:account,providerTransactionId:tx,observationSession:session,
        indexedTransaction:record
    });
    assert.equal(f.requests.length,1);
    assert.ok(f.requests[0].endsWith("/api/v3/masterchainInfo"));
    assert.equal(evidence?.finality?.source,"toncenter-indexed-v3-masterchain");
    assert.equal(evidence?.finality?.masterchainSeqno,88112);
    assert.equal(assessTonPaymentSettlementEvidence(evidence,{
        accountId:account,transactionId:tx,nowMs:Date.now()
    }).authorized,true);
    await f.provider.endObservation(session);
    assert.equal(f.provider.isObservationValid(session),true,
        "post-observation settled evidence must remain valid in coordinator");
});

test("one masterchain read per check for all 3 payment hashes",async()=>{
    const f=setup();
    const session=await f.provider.beginObservation({accountId:account});
    const result=await Promise.all([1,2,3].map(n=>{
        const hash=tx+"-"+n;
        return f.provider.getSettlementEvidence({
            accountId:account,providerTransactionId:hash,observationSession:session,
            indexedTransaction:{...record,transactionId:hash}
        });
    }));
    assert.equal(f.requests.length,1);
    assert.equal(result.filter(Boolean).length,3);
});

test("wrong destination, wrong tx, missing block and speculative/unfinalized records fail closed",async()=>{
    const f=setup();
    const session=await f.provider.beginObservation({accountId:account});
    for(const invalid of [
        {...record,transactionId:"other-hash"},
        {...record,accountId:other},
        {...record,block:null},
        {...record,mcBlockSeqno:0},
        {...record,emulated:true}
    ]) {
        assert.equal(await f.provider.getSettlementEvidence({
            accountId:account,providerTransactionId:tx,observationSession:session,
            indexedTransaction:invalid
        }),null);
    }
    assert.equal(f.requests.length,0,"untrusted tx never gets a provider read");
});

test("wrong network, inadequate confirmations and provider HTTP429 never settle",async()=>{
    for(const options of [
        {globalId:-239},
        {last:88112},
        {response:new Response("Too many requests",{status:429})}
    ]) {
        const f=setup(options);
        const session=await f.provider.beginObservation({accountId:account});
        assert.equal(await f.provider.getSettlementEvidence({
            accountId:account,providerTransactionId:tx,observationSession:session,
            indexedTransaction:record
        }),null);
    }
});

test("provider cannot be used on Mainnet and cannot authorize without session",async()=>{
    const client=new ToncenterTransactionsClient({
        baseUrl:"https://toncenter.com",apiKeyProvider:()=>"key",fetchImpl:async()=>ok()
    });
    assert.throws(()=>new ToncenterIndexedFinalityEvidenceProvider({client}),
        /Testnet/);
    const f=setup();
    assert.equal(await f.provider.getSettlementEvidence({
        accountId:account,providerTransactionId:tx,
        observationSession:Object.freeze({}),indexedTransaction:record
    }),null);
});

test("three previously sent native TON payments become eligible for 3/3 gate without SSE",async()=>{
    const time=Math.floor(Date.now()/1000)*1000;
    const senders=["b","c","d"].map(c=>"0:"+c.repeat(64));
    const intents=senders.map((sender,i)=>new PaymentIntent({
        paymentReference:"WW-PAY-ROOM1-000"+(i+1),
        roomId:"room-three-confirmations",playerId:"player-"+i,
        network:"testnet",destinationWalletId:"room-wallet-6",
        destinationWalletAddress:account,expectedSender:sender,
        amountAtomic:1000000000,asset:"TON",createdAt:time-40000,
        expiresAt:time+440000,roomDeadlineMs:time+440000
    }));
    const transactions=intents.map((intent,i)=>({
        hash:"historical-payment-"+i,account,now:time/1000-4,
        emulated:false,block_ref:{workchain:0,shard:"8000000000000000",seqno:4788+i},
        mc_block_seqno:88112+i,
        description:{aborted:false,compute_ph:{success:true},action:{success:true}},
        in_msg:{source:senders[i],destination:account,value:"1000000000",
            message_content:{decoded:{
                type:"text_comment",comment:"WW1:"+intent.paymentReference
            }}}
    }));
    const called=[];
    const client=new ToncenterTransactionsClient({
        apiKeyProvider:()=>"synthetic-testnet-key",
        fetchImpl:async(url)=>{
            called.push(new URL(url).pathname);
            const payload=url.endsWith("/api/v3/masterchainInfo")
                ? {last:{global_id:-3,seqno:88120}}
                : {transactions,address_book:{}};
            return new Response(JSON.stringify(payload),{status:200});
        }
    });
    const service=new RoomPaymentObservationService({
        provider:new ToncenterIncomingProvider({client}),
        settlementEvidenceProvider:new ToncenterIndexedFinalityEvidenceProvider({client})
    });
    const observation=await service.checkRoomPayments({
        roomId:"room-three-confirmations",walletAddress:account,
        paymentIntents:intents,floorMs:time-40000,ceilingMs:time+1000,
        destinationWalletId:"room-wallet-6"
    });
    assert.deepEqual(called.sort(),[
        "/api/v3/masterchainInfo","/api/v3/transactions"
    ]);
    assert.equal(observation.resultWindowComplete,true);
    assert.equal(observation.observations.filter(x=>x.status==="matched").length,3);
    assert.equal(observation.transfers.length,3);
    assert.equal(observation.settlementEvidenceAvailable,true);
    for(const transfer of observation.transfers) {
        assert.equal(hasTrustedRoomPaymentSettlementEvidence(
            observation,transfer,Date.now()),true);
    }
    assert.equal(service.hasBackgroundWork(),false);
});
