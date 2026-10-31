import test from "node:test";
import assert from "node:assert/strict";
import { beginCell } from "@ton/core";
import { ToncenterTransactionsClient } from "../payment/toncenter/ToncenterTransactionsClient.js";
import { PaymentIntent } from "../payment/PaymentIntent.js";
import { MainnetIndexedReceiptFinalityInspector } from "../mainnet/MainnetIndexedReceiptFinalityInspector.js";
import { assessMainnetRoomPaymentCandidates } from "../mainnet/MainnetPaymentCandidateEvaluator.js";
import { MAINNET_TONCENTER_URL } from "../mainnet/MainnetReadOnlyPreflight.js";
import {
    MainnetTonapiReadOnlyCorroborator, MAINNET_TONAPI_ORIGIN
} from "../mainnet/MainnetTonapiReadOnlyCorroborator.js";

const roomId = "room-mainnet-secondary-review";
const wallet = "0:"+"a".repeat(64);
const senders = ["b","c","d"].map(x => "0:"+x.repeat(64));
const players = ["Olga","Bob","Lena"];
const references = ["WW_O_1","WW_B_2","WW_L_3"];
const hashes = ["11","22","33"].map(x => x.repeat(32));
const t = Math.floor(Date.now()/1000)*1000;
const now = Math.floor(t/1000)-5;
const env = {TON_NETWORK:"mainnet",ROOM_WALLET_PAYMENTS_ENABLED:"false"};
const validEnv = {...env,TONAPI_API_KEY:"SYNTHETIC-TONAPI-KEY"};
const deadline = t+480000;
const query = {roomId,walletAddress:wallet,floorMs:t-30000,ceilingMs:t+2000,limit:10};

function intents() {
    return players.map((playerId,i)=>new PaymentIntent({
        paymentReference:references[i],roomId,playerId,
        network:"mainnet",asset:"TON",destinationWalletId:"room-wallet-1",
        destinationWalletAddress:wallet,expectedSender:senders[i],
        amountAtomic:1000000000,createdAt:t-30000,
        expiresAt:deadline,roomDeadlineMs:deadline
    }));
}
function indexedTx(i) {
    return {
        hash:hashes[i],account:wallet,now,emulated:false,
        block_ref:{workchain:0,shard:"8000000000000000",seqno:5500+i},
        mc_block_seqno:900+i,
        description:{aborted:false,compute_ph:{success:true},action:{success:true}},
        in_msg:{source:senders[i],destination:wallet,value:"1000000000",
            message_content:{decoded:{type:"text_comment",comment:"WW1:"+references[i]}}}
    };
}
async function candidateReport(indices=[0,1,2]) {
    const client = new ToncenterTransactionsClient({
        baseUrl:MAINNET_TONCENTER_URL,
        apiKeyProvider:()=>"SYNTHETIC-TONCENTER-KEY",
        fetchImpl:async(url)=>new Response(JSON.stringify(
            new URL(url).pathname.endsWith("masterchainInfo")
                ? {last:{global_id:-239,seqno:920}}
                : {transactions:indices.map(indexedTx),address_book:{}}
        ),{status:200})
    });
    const inspector = new MainnetIndexedReceiptFinalityInspector({
        env,client,resolveActiveRoomWallet:()=>({
            roomNumber:1,address:wallet,reservedByRoomId:roomId
        })
    });
    const inspection = await inspector.inspectRoom(query);
    return assessMainnetRoomPaymentCandidates({
        roomId,roomPlayerIds:players,roomWalletAddress:wallet,
        intents:intents(),inspection,nowMs:t
    });
}
function boc(ref,opcode=0) {
    return beginCell().storeUint(opcode,32)
        .storeStringTail("WW1:"+ref).endCell().toBoc().toString("base64");
}
function tonapiTx(i, overrides={}) {
    return {
        hash:hashes[i],account:{address:wallet},
        success:true,aborted:false,block:"(0,5500,8000000000000000)",
        utime:now,
        in_msg:{msg_type:"int_msg",bounced:false,value:1000000000,
            source:{address:senders[i]},destination:{address:wallet},
            raw_body:boc(references[i])},
        ...overrides
    };
}
function fixture({envValue=validEnv, rows=hashes.map((_,i)=>tonapiTx(i)),
    status=200,fetchError=false}={}) {
    const calls=[];
    const client=new MainnetTonapiReadOnlyCorroborator({
        env:envValue,
        fetchImpl:async(url,init)=>{
            calls.push({url,init});
            if(fetchError)throw Error("PRIVATE_UPSTREAM_ERROR");
            const hash=url.split("/").at(-1);
            const i=hashes.indexOf(hash);
            return new Response(JSON.stringify(rows[i] ?? {message:"missing"}),{status});
        }
    });
    return {client,calls};
}

test("verified Mainnet 3/3 is corroborated by distinct read-only TonAPI GETs",async()=>{
    const report=await candidateReport();
    assert.equal(report.candidateCount,3);
    const {client,calls}=fixture();
    assert.equal(calls.length,0);
    const result=await client.corroborateRoom(report);
    assert.equal(result.status,"THREE_INDEXER_MATCHES_FOR_REVIEW");
    assert.equal(result.checked,3);
    assert.equal(result.independentIndexerCorroborated,true);
    assert.equal(result.cryptographicProofVerified,false);
    assert.equal(result.settlementAuthorized,false);
    assert.equal(result.gameStartAuthorized,false);
    assert.deepEqual(calls.map(x=>x.url),
        hashes.map(hash=>MAINNET_TONAPI_ORIGIN+"/v2/blockchain/transactions/"+hash));
    assert.ok(calls.every(x=>x.init.method==="GET"
        && x.init.redirect==="error"
        && x.init.headers.Authorization==="Bearer SYNTHETIC-TONAPI-KEY"));
    assert.equal(client.sendTransfer,undefined);
    assert.equal(client.settlePayment,undefined);
});

test("forged candidate report and partial 1/3 or 2/3 cannot call secondary provider",async()=>{
    const full=await candidateReport();
    const {client,calls}=fixture();
    assert.equal((await client.corroborateRoom({...full})).status,"BLOCKED");
    assert.equal((await client.corroborateRoom({network:"mainnet",candidateCount:3,
        settlementAuthorized:false,gameStartAuthorized:false,
        candidates:full.candidates})).status,"BLOCKED");
    for(const count of [1,2]){
        const r=await candidateReport([0,1].slice(0,count));
        assert.equal(r.candidateCount,count);
        assert.equal((await client.corroborateRoom(r)).status,"BLOCKED");
    }
    assert.equal(calls.length,0);
});

test("missing credential blocks before requests; Testnet or live mode cannot construct",async()=>{
    const report=await candidateReport();
    const {client,calls}=fixture({envValue:env});
    assert.equal((await client.corroborateRoom(report)).reason,"TONAPI_KEY_REQUIRED");
    assert.equal(calls.length,0);
    assert.throws(()=>fixture({envValue:{...validEnv,TON_NETWORK:"testnet"}}),
        /NETWORK_OR_LIVE_PAYMENTS_INVALID/);
    assert.throws(()=>fixture({envValue:{...validEnv,ROOM_WALLET_PAYMENTS_ENABLED:"true"}}),
        /NETWORK_OR_LIVE_PAYMENTS_INVALID/);
});

test("each money-bearing field mismatch blocks without silently confirming other payers",async()=>{
    const report=await candidateReport();
    const first=tonapiTx(0);
    const altered=[
        {hash:hashes[1]}, {account:{address:senders[0]}},
        {in_msg:{...first.in_msg,source:{address:senders[1]}}},
        {in_msg:{...first.in_msg,destination:{address:senders[1]}}},
        {in_msg:{...first.in_msg,value:2000000000}},
        {in_msg:{...first.in_msg,raw_body:boc(references[1])}},
        {in_msg:{...first.in_msg,raw_body:boc(references[0],7)}},
        {in_msg:{...first.in_msg,bounced:true}},
        {in_msg:{...first.in_msg,msg_type:"ext_in_msg"}},
        {utime:now+1},{success:false},{aborted:true},
        {block:"(-1,5500,8000000000000000)"},{block:null}
    ];
    for(const override of altered) {
        const rows=hashes.map((_,i)=>tonapiTx(i));
        rows[0]={...first,...override};
        const {client,calls}=fixture({rows});
        const result=await client.corroborateRoom(report);
        assert.equal(result.status,"BLOCKED",JSON.stringify(Object.keys(override)));
        assert.equal(result.reason,"TONAPI_TRANSACTION_MISMATCH");
        assert.equal(result.settlementAuthorized,false);
        assert.equal(calls.length,1);
    }
});

test("secondary indexer network error, 429, 503, wrong JSON or missing transaction fail closed",async()=>{
    const report=await candidateReport();
    for(const status of [401,404,429,503]){
        const {client}=fixture({status});
        assert.equal((await client.corroborateRoom(report)).reason,
            "TONAPI_TRANSACTION_UNAVAILABLE");
    }
    const bad=fixture({fetchError:true});
    assert.equal((await bad.client.corroborateRoom(report)).reason,
        "TONAPI_TRANSACTION_UNAVAILABLE");
    const notFound=fixture({rows:[]});
    assert.equal((await notFound.client.corroborateRoom(report)).status,"BLOCKED");
});

test("unsigned, mismatched candidate transaction hashes do not cause arbitrary TonAPI GETs",async()=>{
    // Synthetic v3 hash is valid as a transaction ID in the candidate phase;
    // secondary verification requires a real 32-byte transaction hash.
    const {client,calls}=fixture();
    assert.equal((await client.corroborateRoom({transactionId:"/etc/passwd"})).status,"BLOCKED");
    assert.equal(calls.length,0);
});
