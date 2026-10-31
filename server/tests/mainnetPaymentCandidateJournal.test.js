import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ToncenterTransactionsClient } from "../payment/toncenter/ToncenterTransactionsClient.js";
import { PaymentIntent } from "../payment/PaymentIntent.js";
import { Address } from "@ton/core";
import { IncomingTransfer } from "../payment/incoming/IncomingTransfer.js";
import { deriveIncomingTransactionId } from "../payment/incoming/IncomingTransferIdentity.js";
import { matchIncomingTransferToIntent } from "../payment/incoming/IncomingTransferMatcher.js";
import { MainnetIndexedReceiptFinalityInspector } from "../mainnet/MainnetIndexedReceiptFinalityInspector.js";
import { assessMainnetRoomPaymentCandidates } from "../mainnet/MainnetPaymentCandidateEvaluator.js";
import { MainnetCandidateReviewJournal } from "../mainnet/MainnetCandidateReviewJournal.js";
import { MAINNET_TONCENTER_URL } from "../mainnet/MainnetReadOnlyPreflight.js";

const roomId="room-mainnet-candidates";
const wallet="0:"+"a".repeat(64);
const senders=["b","c","d"].map(x=>"0:"+x.repeat(64));
const players=["Olga","Bob","Lena"];
const references=["WW_OLGA_001","WW_BOB_002","WW_LENA_003"];
const t=Math.floor(Date.now()/1000)*1000;
const env={TON_NETWORK:"mainnet",ROOM_WALLET_PAYMENTS_ENABLED:"false"};
const roomDeadline=t+480000;
const query={roomId,walletAddress:wallet,floorMs:t-30000,ceilingMs:t+2000,limit:10};
function intents(options={}) {
    return players.map((playerId,i)=>new PaymentIntent({
        paymentReference:references[i],
        roomId, playerId, network:"mainnet", asset:"TON",
        destinationWalletId:"room-wallet-7",
        destinationWalletAddress:wallet,
        expectedSender:senders[i],
        amountAtomic:1000000000,
        createdAt:t-30000,
        expiresAt:roomDeadline,
        roomDeadlineMs:roomDeadline,
        ...options
    }));
}
function tx(i,extra={}) {
    return {
        hash:"mainnet-pay-tx-"+i,account:wallet,now:t/1000-5,
        emulated:false,
        block_ref:{workchain:0,shard:"8000000000000000",seqno:5500+i},
        mc_block_seqno:900+i,
        description:{aborted:false,compute_ph:{success:true},action:{success:true}},
        in_msg:{
            source:senders[i],destination:wallet,value:"1000000000",
            message_content:{decoded:{type:"text_comment",comment:"WW1:"+references[i]}}
        },...extra
    };
}
function fixture({rows=[tx(0),tx(1),tx(2)],globalId=-239,reserve=()=>({
    roomNumber:7,address:wallet,reservedByRoomId:roomId
})}={}) {
    const calls=[];
    const client=new ToncenterTransactionsClient({
        baseUrl:MAINNET_TONCENTER_URL,
        apiKeyProvider:()=>"SYNTHETIC-MAINNET-KEY",
        fetchImpl:async(url,request)=>{
            const path=new URL(url).pathname;
            calls.push({path,method:request.method});
            const data=path.endsWith("masterchainInfo")
                ?{last:{global_id:globalId,seqno:920}}
                :{transactions:rows,address_book:{}};
            return new Response(JSON.stringify(data),{status:200});
        }
    });
    const inspector=new MainnetIndexedReceiptFinalityInspector({
        env,client,resolveActiveRoomWallet:reserve
    });
    return {inspector,calls};
}
async function assessed({rows,intentList=intents(),nowMs=t, room=roomId, walletAddress=wallet,
    globalId=-239, reserve}={}) {
    const f=fixture({rows,globalId,reserve});
    const inspection=await f.inspector.inspectRoom({...query,roomId:room,walletAddress});
    return {report:assessMainnetRoomPaymentCandidates({
        roomId:room,roomPlayerIds:players,roomWalletAddress:walletAddress,
        intents:intentList,inspection,nowMs
    }),inspection,calls:f.calls};
}
function withDir(action) {
    const dir=mkdtempSync(join(tmpdir(),"wheelwin-mainnet-candidate-"));
    try{return action(dir);}finally{rmSync(dir,{recursive:true,force:true});}
}

test("three distinct Mainnet transfers produce review-only 3/3 candidate report",async()=>{
    const {report,calls}=await assessed();
    assert.equal(report.status,"THREE_CANDIDATES_FOR_REVIEW");
    assert.equal(report.candidateCount,3);
    assert.equal(report.threeOfThreeCandidates,true);
    assert.equal(report.settlementAuthorized,false);
    assert.equal(report.gameStartAuthorized,false);
    assert.deepEqual(report.candidates.map(c=>c.playerId),players);
    assert.deepEqual(report.candidates.map(c=>c.transactionId),
        [0,1,2].map(i=>"mainnet-pay-tx-"+i));
    assert.ok(report.candidates.every(c=>c.settlementAuthorized===false
        && c.gameStartAuthorized===false && c.status==="PROVIDER_INDEXED_CANDIDATE"));
    assert.deepEqual(calls.map(x=>x.path),[
        "/api/v3/masterchainInfo","/api/v3/transactions","/api/v3/masterchainInfo"
    ]);
    assert.ok(calls.every(x=>x.method==="GET"));
});

test("one or two payers are retained as candidates but never authorize 3/3 gate",async()=>{
    for(const count of [1,2]){
        const {report}=await assessed({rows:[tx(0),tx(1)].slice(0,count)});
        assert.equal(report.candidateCount,count);
        assert.equal(report.threeOfThreeCandidates,false);
        assert.equal(report.gameStartAuthorized,false);
        assert.equal(report.settlementAuthorized,false);
    }
});

test("missing memo never matches an intent on Mainnet",async()=>{
    const rows=[tx(0),tx(1),tx(2)];
    rows[1].in_msg.message_content.decoded.comment="";
    const {report}=await assessed({rows});
    assert.equal(report.candidateCount,2);
    assert.ok(!report.candidates.some(c=>c.playerId==="Bob"));
});

test("wrong sender, amount, or expired transaction never match",async()=>{
    const rows=[tx(0),tx(1),tx(2)];
    rows[0].in_msg.source=senders[1];
    rows[1].in_msg.value="2000000000";
    rows[2].now=Math.floor((t-400000)/1000);
    const {report}=await assessed({rows});
    assert.equal(report.candidateCount,0);
    assert.equal(report.threeOfThreeCandidates,false);
});

test("duplicate payer payments match Testnet earliest-stake rule, excess stays uncredited",async()=>{
    const {report}=await assessed({rows:[tx(0),tx(1),tx(2),tx(1,{hash:"second-bob",now:t/1000-1})]});
    assert.equal(report.status,"THREE_CANDIDATES_FOR_REVIEW");
    assert.equal(report.candidateCount,3);
    assert.equal(report.excessCount,1);
    assert.equal(report.candidates.find(x=>x.playerId==="Bob").transactionId,"mainnet-pay-tx-1");
    assert.equal(report.excessCandidates[0].transactionId,"second-bob");
    assert.equal(report.excessCandidates[0].primaryTransactionId,"mainnet-pay-tx-1");
    assert.equal(report.excessCandidates[0].status,"UNVERIFIED_EXCESS_CANDIDATE");
    assert.equal(report.excessCandidates[0].excessReason,"ADDITIONAL_PAYMENT_FOR_PLAYER");
    assert.equal(report.settlementAuthorized,false);
    assert.equal(report.gameStartAuthorized,false);
    withDir(dir=>{
        const journal=new MainnetCandidateReviewJournal({dataDir:dir});
        journal.initialize();
        const first=journal.recordCandidates(report);
        assert.equal(first.newlyRecorded,3);
        assert.equal(first.newlyRecordedExcess,1);
        assert.equal(first.excessCount,1);
        assert.equal(journal.listExcessForRoom(roomId).length,1);
        assert.equal(journal.listRoom(roomId).length,4);
        assert.equal(journal.recordCandidates(report).newlyRecordedExcess,0);
        const restarted=new MainnetCandidateReviewJournal({dataDir:dir});
        restarted.initialize();
        assert.equal(restarted.listRoom(roomId).length,4);
        const excess=restarted.getByTransactionId("second-bob");
        assert.equal(excess.status,"UNVERIFIED_EXCESS_CANDIDATE");
        assert.equal(excess.settlementAuthorized,false);
        assert.equal(excess.gameStartAuthorized,false);
        assert.equal(restarted.recordCandidates(report).newlyRecorded,0);
        assert.equal(restarted.recordCandidates(report).newlyRecordedExcess,0);
        assert.equal(readdirSync(join(dir,"mainnet-candidate-review","records")).length,4);
    });
});

test("duplicate transaction ID and incomplete transaction page fail closed",async()=>{
    let r=await assessed({rows:[tx(0),tx(1),tx(0)]});
    assert.equal(r.report.status,"BLOCKED");
    assert.equal(r.report.candidateCount,0);
    const rows=Array.from({length:10},(_,i)=>tx(i%3,{hash:"window-"+i}));
    r=await assessed({rows});
    assert.equal(r.report.status,"BLOCKED");
});

test("expired intent, invalid roster, mismatched wallet and Testnet fail",async()=>{
    const {inspection}=await assessed();
    assert.equal(assessMainnetRoomPaymentCandidates({
        roomId,roomPlayerIds:players,roomWalletAddress:wallet,
        intents:intents(),inspection,nowMs:roomDeadline
    }).status,"BLOCKED");
    assert.equal(assessMainnetRoomPaymentCandidates({
        roomId,roomPlayerIds:["Olga","Bob","Bob"],roomWalletAddress:wallet,
        intents:intents(),inspection,nowMs:t
    }).status,"BLOCKED");
    assert.equal(assessMainnetRoomPaymentCandidates({
        roomId,roomPlayerIds:players,roomWalletAddress:senders[0],
        intents:intents(),inspection,nowMs:t
    }).status,"BLOCKED");
    const f=fixture({globalId:-3});
    await assert.rejects(f.inspector.inspectRoom(query),/MAINNET_INCOMING_CHAIN_IDENTITY_INVALID/);
});

test("forged unsigned inspection object cannot create payment candidates",()=>{
    const fake={
        roomId,network:"mainnet",globalId:-239,readOnly:true,
        resultWindowComplete:true,settlementAuthorized:false,gameStartAuthorized:false,
        receipts:[{paymentReference:references[0],status:"INDEXED_MASTERCHAIN_DEPTH_OK"}]
    };
    const r=assessMainnetRoomPaymentCandidates({
        roomId,roomPlayerIds:players,roomWalletAddress:wallet,
        intents:intents(),inspection:fake,nowMs:t
    });
    assert.equal(r.reason,"UNTRUSTED_OR_INCOMPLETE_INSPECTION");
    assert.equal(r.candidateCount,0);
});

test("immutable candidate journal replays after restart without duplicate records",async()=>{
    const {report}=await assessed();
    withDir(dir=>{
        const journal=new MainnetCandidateReviewJournal({dataDir:dir});
        assert.throws(()=>journal.recordCandidates(report),/NOT_INITIALIZED/);
        journal.initialize();
        const first=journal.recordCandidates(report);
        assert.equal(first.candidateCount,3);
        assert.equal(first.newlyRecorded,3);
        assert.equal(first.settlementAuthorized,false);
        assert.equal(first.gameStartAuthorized,false);
        const second=journal.recordCandidates(report);
        assert.equal(second.newlyRecorded,0);
        assert.equal(journal.listRoom(roomId).length,3);
        const recovered=new MainnetCandidateReviewJournal({dataDir:dir});
        recovered.initialize();
        assert.equal(recovered.listRoom(roomId).length,3);
        assert.equal(recovered.recordCandidates(report).newlyRecorded,0);
        assert.equal(recovered.getByTransactionId("mainnet-pay-tx-0").status,
            "PROVIDER_INDEXED_CANDIDATE");
        assert.equal(readdirSync(join(dir,"mainnet-candidate-review","records")).length,3);
    });
});

test("partial candidate entries survive crash/restart and later 3/3 review",async()=>{
    const first=(await assessed({rows:[tx(0),tx(1)]})).report;
    const full=(await assessed()).report;
    withDir(dir=>{
        const journal=new MainnetCandidateReviewJournal({dataDir:dir});
        journal.initialize();
        assert.equal(journal.recordCandidates(first).newlyRecorded,2);
        const restarted=new MainnetCandidateReviewJournal({dataDir:dir});
        restarted.initialize();
        assert.equal(restarted.recordCandidates(full).newlyRecorded,1);
        assert.equal(restarted.listRoom(roomId).length,3);
        assert.equal(restarted.recordCandidates(full).newlyRecorded,0);
    });
});

test("different room or player claiming prior transaction is rejected",async()=>{
    const {report}=await assessed();
    const otherRoom="room-mainnet-other";
    const others=intents().map(intent=>new PaymentIntent({
        ...intent.toRecord(),roomId:otherRoom,
        paymentReference:"OTHER_"+intent.paymentReference
    }));
    const foreignRows=[tx(0,{in_msg:{
        source:senders[0],destination:wallet,value:"1000000000",
        message_content:{decoded:{type:"text_comment",comment:"WW1:OTHER_"+references[0]}}
    }}),tx(1),tx(2)];
    const next=(await assessed({rows:foreignRows,intentList:others,
        room:otherRoom,reserve:()=>({roomNumber:7,address:wallet,reservedByRoomId:otherRoom})})).report;
    withDir(dir=>{
        const j=new MainnetCandidateReviewJournal({dataDir:dir});j.initialize();
        j.recordCandidates(report);
        assert.equal(next.candidateCount,1);
        assert.throws(()=>j.recordCandidates(next),/TRANSACTION_REUSE/);
        assert.equal(j.listRoom(roomId).length,3);
        assert.equal(j.listRoom(otherRoom).length,0);
    });
});

test("fake candidate report and corrupted journal must fail closed",async()=>{
    const {report}=await assessed();
    withDir(dir=>{
        const j=new MainnetCandidateReviewJournal({dataDir:dir});j.initialize();
        assert.throws(()=>j.recordCandidates({...report}),/UNTRUSTED/);
        j.recordCandidates(report);
        const folder=join(dir,"mainnet-candidate-review","records");
        const [filename]=readdirSync(folder);
        writeFileSync(join(folder,filename),"{broken");
        const reloaded=new MainnetCandidateReviewJournal({dataDir:dir});
        assert.throws(()=>reloaded.initialize(),/JOURNAL_CORRUPT/);
    });
});


test("preinitialized concurrent workers cannot claim one reference for two transfers",async()=>{
    const first=(await assessed({rows:[tx(0)]})).report;
    const conflicting=(await assessed({rows:[tx(0,{hash:"another-mainnet-transfer"})]})).report;
    assert.equal(first.candidateCount,1);
    assert.equal(conflicting.candidateCount,1);
    withDir(dir=>{
        const a=new MainnetCandidateReviewJournal({dataDir:dir});
        const b=new MainnetCandidateReviewJournal({dataDir:dir});
        a.initialize();
        b.initialize(); // Stale maps deliberately precede both writes.
        assert.equal(a.recordCandidates(first).newlyRecorded,1);
        assert.throws(()=>b.recordCandidates(conflicting),/REFERENCE_REUSE/);
        assert.equal(b.recordCandidates(first).newlyRecorded,0);
        const recovered=new MainnetCandidateReviewJournal({dataDir:dir});
        recovered.initialize();
        assert.equal(recovered.listRoom(roomId).length,1);
        assert.equal(recovered.getByTransactionId("another-mainnet-transfer"),null);
    });
});

test("restart repairs interrupted claim-before-transaction append without double counting",async()=>{
    const {report}=await assessed({rows:[tx(0)]});
    withDir(dir=>{
        const j=new MainnetCandidateReviewJournal({dataDir:dir});
        j.initialize();
        assert.equal(j.recordCandidates(report).newlyRecorded,1);
        const root=join(dir,"mainnet-candidate-review");
        const records=join(root,"records");
        const refs=join(root,"references");
        assert.equal(readdirSync(refs).length,1);
        const transactionFile=join(records,readdirSync(records)[0]);
        rmSync(transactionFile); // Simulated interruption after exclusive reference claim.
        const recovered=new MainnetCandidateReviewJournal({dataDir:dir});
        recovered.initialize();
        assert.equal(recovered.listRoom(roomId).length,1);
        assert.equal(readdirSync(records).length,1);
        assert.equal(recovered.recordCandidates(report).newlyRecorded,0);
    });
});

test("missing or corrupted reference claim fails closed on restart",async()=>{
    const {report}=await assessed({rows:[tx(0)]});
    withDir(dir=>{
        const j=new MainnetCandidateReviewJournal({dataDir:dir});
        j.initialize();
        j.recordCandidates(report);
        const refs=join(dir,"mainnet-candidate-review","references");
        const referenceFile=join(refs,readdirSync(refs)[0]);
        writeFileSync(referenceFile,"{broken");
        assert.throws(
            ()=>new MainnetCandidateReviewJournal({dataDir:dir}).initialize(),
            /JOURNAL_CORRUPT/
        );
        rmSync(referenceFile);
        assert.throws(
            ()=>new MainnetCandidateReviewJournal({dataDir:dir}).initialize(),
            /REFERENCE_CLAIM_MISSING_OR_CONFLICT/
        );
    });
});


test("Mainnet candidate matching uses shared Testnet raw/friendly address identity rules",async()=>{
    const friendly=intents().map((intent,i)=>new PaymentIntent({
        ...intent.toRecord(),
        expectedSender:Address.parse(senders[i]).toString({
            testOnly:false,bounceable:false,urlSafe:true
        }),
        destinationWalletAddress:Address.parse(wallet).toString({
            testOnly:false,bounceable:true,urlSafe:true
        })
    }));
    const {report}=await assessed({intentList:friendly});
    assert.equal(report.status,"THREE_CANDIDATES_FOR_REVIEW");
    assert.equal(report.candidateCount,3);
    assert.equal(report.settlementAuthorized,false);
    assert.equal(report.gameStartAuthorized,false);
});

test("same-amount Mainnet memo swaps do not reassign Olga and Bob",async()=>{
    const rows=[tx(0),tx(1),tx(2)];
    rows[0].in_msg.message_content.decoded.comment="WW1:"+references[1];
    rows[1].in_msg.message_content.decoded.comment="WW1:"+references[0];
    const {report}=await assessed({rows});
    assert.equal(report.candidateCount,1);
    assert.deepEqual(report.candidates.map(x=>x.playerId),["Lena"]);
    assert.equal(report.gameStartAuthorized,false);
});

test("one shared Testnet matcher enforces Mainnet explicit memo without changing Testnet history",()=>{
    const testnetIntent=new PaymentIntent({
        ...intents()[0].toRecord(),network:"testnet"
    });
    const mainnetIntent=intents()[0];
    const makeTransfer=network=>new IncomingTransfer({
        network,
        transactionId:deriveIncomingTransactionId({
            network,providerId:"toncenter",
            accountId:wallet,transactionId:"raw-no-memo-"+network
        }),
        providerTransactionIdentity:{
            providerId:"toncenter",accountId:wallet,
            transactionId:"raw-no-memo-"+network
        },
        destinationWalletAddress:wallet,
        senderAddress:senders[0],amountAtomic:"1000000000",
        asset:"TON",transactionTime:t-5000,
        paymentReference:null,providerConfirmed:true
    });
    assert.equal(matchIncomingTransferToIntent(makeTransfer("testnet"),
        testnetIntent).matched,true);
    assert.equal(matchIncomingTransferToIntent(makeTransfer("mainnet"),
        mainnetIntent).matched,false);
});


test("Mainnet picks earliest chain timestamp, not provider order, for duplicate payer",async()=>{
    const later=tx(1,{hash:"aaa-later",now:t/1000-2});
    const earlier=tx(1,{hash:"zzz-earlier",now:t/1000-9});
    const {report}=await assessed({rows:[later,tx(0),tx(1),tx(2),earlier]});
    assert.equal(report.candidateCount,3);
    assert.equal(report.excessCount,2);
    assert.equal(report.candidates.find(x=>x.playerId==="Bob").transactionId,"zzz-earlier");
    assert.deepEqual(report.excessCandidates.map(x=>x.transactionId).sort(),
        ["aaa-later","mainnet-pay-tx-1"].sort());
    assert.equal(report.settlementAuthorized,false);
});

test("same-block timestamp ties use transaction-ID ordering as shared Testnet observer",async()=>{
    const rows=[tx(1,{hash:"zz-bob"}),tx(2),tx(0),tx(1,{hash:"aa-bob"})];
    const {report}=await assessed({rows});
    assert.equal(report.candidateCount,3);
    assert.equal(report.excessCount,1);
    assert.equal(report.candidates.find(x=>x.playerId==="Bob").transactionId,"aa-bob");
    assert.equal(report.excessCandidates[0].transactionId,"zz-bob");
});

test("durable excess transaction cannot be rewritten as a primary or another payer",async()=>{
    const base=(await assessed({rows:[tx(0),tx(1),tx(2),tx(1,{hash:"second-bob"})]})).report;
    const next=(await assessed({rows:[tx(0),tx(1),tx(2),tx(1,{hash:"second-bob",
        in_msg:{source:senders[0],destination:wallet,value:"1000000000",
            message_content:{decoded:{type:"text_comment",comment:"WW1:"+references[0]}}}
    })]})).report;
    withDir(dir=>{
        const j=new MainnetCandidateReviewJournal({dataDir:dir});
        j.initialize();
        j.recordCandidates(base);
        assert.equal(j.listExcessForRoom(roomId).length,1);
        assert.equal(next.candidateCount,3);
        assert.equal(next.excessCount,1);
        assert.throws(()=>j.recordCandidates(next),/TRANSACTION_REUSE/);
        const restarted=new MainnetCandidateReviewJournal({dataDir:dir});
        restarted.initialize();
        assert.equal(restarted.getByTransactionId("second-bob").playerId,"Bob");
        assert.equal(restarted.listExcessForRoom(roomId).length,1);
    });
});

test("corrupted durable excess or missing primary claim fails closed on restart",async()=>{
    const report=(await assessed({rows:[tx(0),tx(1),tx(2),tx(1,{hash:"second-bob"})]})).report;
    withDir(dir=>{
        const j=new MainnetCandidateReviewJournal({dataDir:dir});
        j.initialize();
        j.recordCandidates(report);
        const folder=join(dir,"mainnet-candidate-review","records");
        const name=readdirSync(folder).find(filename=>{
            const raw=JSON.parse(readFileSync(join(folder,filename),"utf8"));
            return raw.status==="UNVERIFIED_EXCESS_CANDIDATE";
        });
        writeFileSync(join(folder,name),"{}");
        assert.throws(()=>new MainnetCandidateReviewJournal({dataDir:dir}).initialize(),
            /JOURNAL_CORRUPT/);
    });
});
