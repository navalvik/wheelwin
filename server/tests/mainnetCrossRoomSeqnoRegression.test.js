import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {keyPairFromSeed} from "@ton/crypto";
import {WalletContractV4} from "@ton/ton";
import {RoomWalletAdapter} from "../payment/roomWallet/RoomWalletAdapter.js";

function harness(t) {
    const root=mkdtempSync(join(tmpdir(),"wheelwin-mainnet-cross-room-seqno-"));
    t.after(()=>rmSync(root,{recursive:true,force:true}));
    const keys=keyPairFromSeed(Buffer.alloc(32,19));
    const address=WalletContractV4.create({
        workchain:0,publicKey:keys.publicKey
    }).address.toString();
    const identity={roomNumber:1,network:"mainnet",workchain:0,
        address,publicKey:keys.publicKey,secretKey:keys.secretKey};
    const state={now:1800000000000,seqno:7,broadcasts:[],
        loseReply:false,seqnoUnavailable:false,beforeSeqno:null};
    const service={
        getSeqno:async()=>{
            if(state.beforeSeqno)await state.beforeSeqno();
            if(state.seqnoUnavailable)throw Error("SIMULATED_SEQNO_RPC_UNAVAILABLE");
            return state.seqno;
        },
        broadcastTransaction:async boc=>{
            state.broadcasts.push(boc);
            if(state.loseReply)throw Error("SIMULATED_LOST_BROADCAST_REPLY");
            return {hash:"simulation-no-chain"};
        }
    };
    const dataDir=join(root,"mainnet");
    const sequenceStateDir=join(dataDir,"outbound-sequences");
    const make=()=>new RoomWalletAdapter({
        sequenceStateDir,tonService:service,
        walletResolver:async()=>identity,now:()=>state.now,
        seqnoConfirmTimeoutMs:10,seqnoConfirmPollMs:5,
        sleep:async ms=>{state.now+=ms;}
    });
    const payload=(session,player,amount)=>({
        roomNumber:1,destination:"0:"+
            (player==="Olga"?"a":"b").repeat(64),
        amountNano:BigInt(amount),bounce:false,
        idempotencyKey:"refund:"+session+":"+player
    });
    return {state,make,payload,address,sequenceStateDir};
}

test("two consecutive failed sessions cannot reuse the same wallet seqno after ambiguous refund",async t=>{
    const h=harness(t);
    h.state.loseReply=true;
    const olga=h.payload("SESSION_A","Olga",990000000);
    const bob=h.payload("SESSION_B","Bob",990000000);
    await assert.rejects(h.make().sendTransfer(olga),/SIMULATED_LOST_BROADCAST_REPLY/);
    assert.equal(h.state.broadcasts.length,1);

    // New adapter simulates restart. Unadvanced seqno MUST hold the next
    // game's different refund even though the earlier RPC reply was lost.
    h.state.loseReply=false;
    const held=await h.make().sendTransfer(bob);
    assert.equal(held.ok,false);
    assert.equal(held.code,"SEQNO_CONFIRMATION_TIMEOUT");
    assert.equal(h.state.broadcasts.length,1);

    h.state.seqnoUnavailable=true;
    const unreadable=await h.make().sendTransfer(bob);
    assert.equal(unreadable.ok,false);
    assert.equal(h.state.broadcasts.length,1);

    // Only authoritative chain advancement can release the later session.
    h.state.seqnoUnavailable=false;
    h.state.seqno=8;
    const later=await h.make().sendTransfer(bob);
    assert.equal(later.ok,true);
    assert.equal(later.seqno,8);
    assert.equal(h.state.broadcasts.length,2);
    assert.notEqual(h.state.broadcasts[0],h.state.broadcasts[1]);

    // Lost reply on this second send can replay the SAME signed message,
    // not create a third transfer at an artificially incremented seqno.
    const replay=await h.make().sendTransfer(bob);
    assert.equal(replay.ok,true);
    assert.equal(replay.seqno,8);
    assert.equal(h.state.broadcasts.length,3);
    assert.equal(h.state.broadcasts[1],h.state.broadcasts[2]);
    h.state.seqno=9;
    const settled=await h.make().sendTransfer(bob);
    assert.equal(settled.code,"ACCEPTED_AWAITING_CREDIT");
    assert.equal(h.state.broadcasts.length,3);
});

test("independent adapters sharing Mainnet outbox cannot sign same seqno for separate rooms",async t=>{
    const h=harness(t);
    const first=h.make(),second=h.make();
    const [a,b]=await Promise.allSettled([
        first.sendTransfer(h.payload("SESSION_A","Olga",900000000)),
        second.sendTransfer(h.payload("SESSION_B","Bob",800000000))
    ]);
    assert.equal(h.state.broadcasts.length,1,
        "only one external WalletV4 message can be broadcast with seqno 7");
    assert.equal([a,b].filter(x=>x.status==="fulfilled"
        &&x.value?.ok===true).length,1);
    const blocked=[a,b].find(x=>x.status!=="fulfilled"||x.value?.ok!==true);
    assert.ok(blocked,"second room must not pass seqno safety hold");
    assert.equal(h.state.seqno,7,
        "adapter does not fabricate local chain seqno advancements");
});

test("failed seqno read before signing never falls back to seqno zero",async t=>{
    const h=harness(t);
    h.state.seqnoUnavailable=true;
    await assert.rejects(h.make().sendTransfer(h.payload("SESSION_A","Olga",800000000)),
        /SIMULATED_SEQNO_RPC_UNAVAILABLE/);
    assert.equal(h.state.broadcasts.length,0);
});

test("forced overlapping Mainnet RPC reads are serialized across TWO adapter instances",async t=>{
    const h=harness(t);
    let releaseRead,notifyStarted;
    const readStarted=new Promise(resolve=>{notifyStarted=resolve;});
    const waitForRelease=new Promise(resolve=>{releaseRead=resolve;});
    let reads=0;
    h.state.beforeSeqno=async()=>{
        reads++;
        notifyStarted();
        await waitForRelease;
    };
    const first=h.make(),second=h.make();
    const sendingA=first.sendTransfer(h.payload("SESSION_A","Olga",900000000));
    await readStarted;
    // First adapter has the wallet writer lock but has not yet received
    // seqno=7. The second must not read 7, sign or broadcast.
    await assert.rejects(
        second.sendTransfer(h.payload("SESSION_B","Bob",800000000)),
        /OUTBOUND_WALLET_WRITER_LOCKED/
    );
    assert.equal(reads,1,"only the lock owner can read the authoritative seqno");
    assert.equal(h.state.broadcasts.length,0);
    releaseRead();
    const result=await sendingA;
    assert.equal(result.ok,true);
    assert.equal(result.seqno,7);
    assert.equal(h.state.broadcasts.length,1);
    // Even after the writer exits, the durable seqno hold prevents the next
    // adapter from writing a different message until chain seqno advances.
    h.state.beforeSeqno=null;
    const withheld=await h.make().sendTransfer(h.payload("SESSION_B","Bob",800000000));
    assert.equal(withheld.ok,false);
    assert.equal(withheld.code,"SEQNO_CONFIRMATION_TIMEOUT");
    assert.equal(h.state.broadcasts.length,1);
});

test("an abandoned writer lock fails closed, never auto-clears across restart",async t=>{
    const h=harness(t);
    mkdirSync(h.sequenceStateDir,{recursive:true});
    const lockPath=join(h.sequenceStateDir,createHash("sha256")
        .update(h.address).digest("hex")+".json.lock");
    writeFileSync(lockPath,"unverified previous writer");
    await assert.rejects(
        h.make().sendTransfer(h.payload("SESSION_B","Bob",800000000)),
        /OUTBOUND_WALLET_WRITER_LOCKED/
    );
    assert.equal(h.state.broadcasts.length,0);
    assert.equal(h.state.seqno,7);
});
