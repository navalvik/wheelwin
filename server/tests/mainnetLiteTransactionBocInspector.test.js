import test from "node:test";
import assert from "node:assert/strict";
import {
    Address, beginCell, Cell, Dictionary, storeTransaction
} from "@ton/core";
import {
    inspectMainnetLiteTransactionBoc,
    inspectMainnetThreeCandidateLiteBocs
} from "../mainnet/MainnetLiteTransactionBocInspector.js";
import { PaymentIntent } from "../payment/PaymentIntent.js";
import { ToncenterTransactionsClient } from "../payment/toncenter/ToncenterTransactionsClient.js";
import { MainnetIndexedReceiptFinalityInspector } from "../mainnet/MainnetIndexedReceiptFinalityInspector.js";
import { assessMainnetRoomPaymentCandidates } from "../mainnet/MainnetPaymentCandidateEvaluator.js";
import { MAINNET_TONCENTER_URL } from "../mainnet/MainnetReadOnlyPreflight.js";

const roomId = "room-lite-boc-integrity";
const wallet = "0:"+ "a".repeat(64);
const players = ["Olga","Bob","Lena"];
const senders = ["b","c","d"].map(x => "0:"+x.repeat(64));
const references = ["LITE_OLGA_1","LITE_BOB_2","LITE_LENA_3"];
const time = Math.floor(Date.now()/1000)-10;
const nowMs = time * 1000;
const env = {TON_NETWORK:"mainnet",ROOM_WALLET_PAYMENTS_ENABLED:"false"};

function transaction(i, changes = {}) {
    const body = beginCell().storeUint(0,32)
        .storeStringTail("WW1:" + references[i]).endCell();
    const info = {
        type:"internal",ihrDisabled:true,bounce:false,bounced:false,
        src:Address.parse(senders[i]),dest:Address.parse(wallet),
        value:{coins:1000000000n},ihrFee:0n,forwardFee:0n,
        createdLt:1n,createdAt:time,
        ...changes.info
    };
    const tx = {
        address:BigInt("0x"+"a".repeat(64)),lt:BigInt(i+2),
        prevTransactionHash:0n,prevTransactionLt:1n,
        now:time,outMessagesCount:0,oldStatus:"active",endStatus:"active",
        inMessage:{
            info,init:null,body:changes.body ?? body
        },
        outMessages:Dictionary.empty(),
        totalFees:{coins:0n},
        stateUpdate:{oldHash:Buffer.alloc(32),newHash:Buffer.alloc(32)},
        description:{
            type:"generic",creditFirst:true,storagePhase:null,creditPhase:null,
            computePhase:{type:"skipped",reason:"no-state"},
            actionPhase:null,aborted:false,bouncePhase:null,destroyed:false,
            ...changes.description
        },
        ...changes.transaction
    };
    const cell = beginCell().store(storeTransaction(tx)).endCell();
    return {cell,boc:cell.toBoc().toString("base64"),
        hash:cell.hash().toString("hex")};
}
function candidate(i, fixture) {
    return {
        network:"mainnet",asset:"TON",status:"PROVIDER_INDEXED_CANDIDATE",
        roomId,playerId:players[i],paymentReference:references[i],
        transactionId:fixture.hash,roomWalletAddress:wallet,
        senderAddress:senders[i],amountAtomic:"1000000000",
        transactionTimeMs:nowMs,settlementAuthorized:false,
        gameStartAuthorized:false
    };
}
const fixture = [0,1,2].map(i => transaction(i));

function indexedTx(i) {
    return {
        hash:fixture[i].hash,account:wallet,now:time,emulated:false,
        block_ref:{workchain:0,shard:"8000000000000000",seqno:5500+i},
        mc_block_seqno:900+i,
        description:{aborted:false,compute_ph:{success:true},action:{success:true}},
        in_msg:{source:senders[i],destination:wallet,value:"1000000000",
            message_content:{decoded:{type:"text_comment",comment:"WW1:"+references[i]}}}
    };
}
async function report(indices = [0,1,2]) {
    const client = new ToncenterTransactionsClient({
        baseUrl:MAINNET_TONCENTER_URL,apiKeyProvider:()=>"FAKE",
        fetchImpl:async(url)=>new Response(JSON.stringify(
            new URL(url).pathname.endsWith("masterchainInfo")
                ? {last:{global_id:-239,seqno:920}}
                : {transactions:indices.map(indexedTx),address_book:{}}
        ),{status:200})
    });
    const inspector = new MainnetIndexedReceiptFinalityInspector({
        env,client,resolveActiveRoomWallet:()=>({
            roomNumber:7,address:wallet,reservedByRoomId:roomId
        })
    });
    const inspection = await inspector.inspectRoom({
        roomId,walletAddress:wallet,floorMs:nowMs-30000,
        ceilingMs:nowMs+2000,limit:10
    });
    return assessMainnetRoomPaymentCandidates({
        roomId,roomPlayerIds:players,roomWalletAddress:wallet,
        intents:players.map((playerId,i)=>new PaymentIntent({
            paymentReference:references[i],roomId,playerId,
            network:"mainnet",asset:"TON",destinationWalletId:"room-wallet-7",
            destinationWalletAddress:wallet,expectedSender:senders[i],
            amountAtomic:1000000000,createdAt:nowMs-30000,
            expiresAt:nowMs+480000,roomDeadlineMs:nowMs+480000
        })),inspection,nowMs
    });
}

test("single valid native-TON BoC hash and amount/memo match, but cannot authorize settlement",()=>{
    const result=inspectMainnetLiteTransactionBoc({
        candidate:candidate(0,fixture[0]),
        transactionBocBase64:fixture[0].boc
    });
    assert.equal(result.status,"BOC_FIELDS_MATCH_UNANCHORED");
    assert.equal(result.bocHashMatched,true);
    assert.equal(result.transactionFieldsMatched,true);
    assert.equal(result.masterchainTrustAnchorVerified,false);
    assert.equal(result.shardInclusionProofVerified,false);
    assert.equal(result.cryptographicProofVerified,false);
    assert.equal(result.settlementAuthorized,false);
    assert.equal(result.gameStartAuthorized,false);
});

test("all three exact BoCs stay review-only, no automatic network requests",async()=>{
    const genuine=await report();
    assert.equal(genuine.candidateCount,3);
    const calls=[];
    const result=await inspectMainnetThreeCandidateLiteBocs({
        report:genuine,fetchTransactionBoc:async({roomId:rid,transactionId})=>{
            calls.push({rid,transactionId});
            return fixture.find(x=>x.hash===transactionId)?.boc;
        }
    });
    assert.equal(result.status,"THREE_BOC_FIELDS_MATCH_UNANCHORED");
    assert.equal(result.checked,3);
    assert.equal(result.cryptographicProofVerified,false);
    assert.equal(result.settlementAuthorized,false);
    assert.equal(result.gameStartAuthorized,false);
    assert.equal(calls.length,3);
});

test("partial, forged and absent source reports reject before any lite BoC request",async()=>{
    let requests=0;
    const fetchTransactionBoc=async()=>{requests++;return fixture[0].boc;};
    const full=await report();
    assert.equal((await inspectMainnetThreeCandidateLiteBocs({
        report:{...full},fetchTransactionBoc
    })).status,"BLOCKED");
    for(const indices of [[0],[0,1]]){
        const partial=await report(indices);
        assert.equal((await inspectMainnetThreeCandidateLiteBocs({
            report:partial,fetchTransactionBoc
        })).status,"BLOCKED");
    }
    assert.equal((await inspectMainnetThreeCandidateLiteBocs({
        report:full
    })).status,"BLOCKED");
    assert.equal(requests,0);
});

test("foreign BoC and forged hash cannot pass; invalid, oversize and multi-root rejected",()=>{
    const original=candidate(0,fixture[0]);
    const bad=[
        {...original,transactionId:fixture[1].hash},
        {...original,transactionId:"not-a-hash"}
    ];
    for(const c of bad){
        assert.equal(inspectMainnetLiteTransactionBoc({
            candidate:c,transactionBocBase64:fixture[0].boc
        }).status,"BLOCKED");
    }
    for(const data of ["", "$$$$", "A".repeat(300000),
        Cell.fromBoc(Buffer.from(fixture[0].boc,"base64"))[0]
            .toBoc().toString("base64").replace(/^./,"!")]){
        assert.equal(inspectMainnetLiteTransactionBoc({
            candidate:original,transactionBocBase64:data
        }).status,"BLOCKED");
    }
});

test("exact sender, destination, amount, time, memo and success are mandatory",()=>{
    const original=candidate(0,fixture[0]);
    for(const changed of [
        {...original, senderAddress:senders[1]},
        {...original, roomWalletAddress:senders[1]},
        {...original, amountAtomic:"2000000000"},
        {...original, transactionTimeMs:nowMs+1000},
        {...original, paymentReference:references[1]}
    ]) {
        const r=inspectMainnetLiteTransactionBoc({
            candidate:changed,transactionBocBase64:fixture[0].boc
        });
        assert.equal(r.status,"BLOCKED");
        assert.equal(r.settlementAuthorized,false);
    }
    const aborted=transaction(0,{description:{aborted:true}});
    assert.equal(inspectMainnetLiteTransactionBoc({
        candidate:candidate(0,aborted),transactionBocBase64:aborted.boc
    }).reason,"TRANSACTION_BOC_FIELDS_MISMATCH");
    const bounced=transaction(0,{info:{bounced:true}});
    assert.equal(inspectMainnetLiteTransactionBoc({
        candidate:candidate(0,bounced),transactionBocBase64:bounced.boc
    }).reason,"TRANSACTION_BOC_FIELDS_MISMATCH");
    const wrongMemo=transaction(0,{body:beginCell().storeUint(16,32).endCell()});
    assert.equal(inspectMainnetLiteTransactionBoc({
        candidate:candidate(0,wrongMemo),transactionBocBase64:wrongMemo.boc
    }).reason,"TRANSACTION_BOC_FIELDS_MISMATCH");
});

test("provider failure returns BLOCKED and no payout capability",async()=>{
    const genuine=await report();
    const r=await inspectMainnetThreeCandidateLiteBocs({
        report:genuine,fetchTransactionBoc:async()=>{throw Error("no liteserver");}
    });
    assert.equal(r.reason,"LITESERVER_BOC_UNAVAILABLE");
    assert.equal(r.checked,0);
    assert.equal(r.cryptographicProofVerified,false);
    assert.equal(r.settlementAuthorized,false);
});
