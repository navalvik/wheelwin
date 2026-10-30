import test from "node:test";
import assert from "node:assert/strict";
import { ToncenterTransactionsClient } from "../payment/toncenter/ToncenterTransactionsClient.js";
import { ToncenterIndexedFinalityEvidenceProvider } from "../payment/toncenter/ToncenterIndexedFinalityEvidenceProvider.js";
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
