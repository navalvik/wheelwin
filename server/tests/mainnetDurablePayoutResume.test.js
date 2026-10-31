import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,unlinkSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {keyPairFromSeed} from "@ton/crypto";
import {WalletContractV4} from "@ton/ton";
import {RoomWalletAdapter} from "../payment/roomWallet/RoomWalletAdapter.js";
import {TestnetNativeRoomPayoutTransport} from "../payment/runtime/TestnetNativeRoomPayoutTransport.js";
import {RoomPayoutCalculator} from "../payment/ledger/RoomPayoutCalculator.js";

const WINNER="0:"+"a".repeat(64),OWNER="0:"+"b".repeat(64);
const ROOM="mainnet-resume-room",PAYOUT="payout_"+"d".repeat(32);
function harness(t) {
    const dir=mkdtempSync(join(tmpdir(),"wheelwin-mainnet-durable-resume-"));
    t.after(()=>rmSync(dir,{recursive:true,force:true}));
    const keys=keyPairFromSeed(Buffer.alloc(32,23));
    const address=WalletContractV4.create({
        workchain:0,publicKey:keys.publicKey
    }).address.toString();
    const state={seqno:7,broadcasts:[],winnerIndexed:false,ownerIndexed:false};
    const identity={roomNumber:1,network:"mainnet",workchain:0,
        address,publicKey:keys.publicKey,secretKey:keys.secretKey};
    const service={
        getSeqno:async()=>state.seqno,
        broadcastTransaction:async boc=>{
            state.broadcasts.push(boc);
            return {status:"SUBMITTED_UNCONFIRMED"};
        }
    };
    const walletPool={network:"mainnet",
        getReservationForRoom:()=>({
            roomNumber:1,address,network:"mainnet",reservedByRoomId:ROOM
        })
    };
    const observer={
        async findOutgoingTransfer({destinationIdentity,amountAtomic}){
            if(destinationIdentity===WINNER && !state.winnerIndexed)return null;
            if(destinationIdentity===OWNER && !state.ownerIndexed)return null;
            return {transactionId:destinationIdentity===WINNER?"winner-out":"owner-out",
                destinationAddress:destinationIdentity,sourceAddress:address,amountAtomic};
        },
        async verifyIndexedRecipientCredit({destinationIdentity,transactionId,amountAtomic}){
            if(destinationIdentity===WINNER && !state.winnerIndexed)return null;
            if(destinationIdentity===OWNER && !state.ownerIndexed)return null;
            return {status:"MASTERCHAIN_INDEXED_RECIPIENT_CREDIT_OBSERVED",
                sourceTransactionId:transactionId,
                recipientTransactionId:destinationIdentity===WINNER?"winner-in":"owner-in",
                messageHash:destinationIdentity===WINNER?"winner-msg":"owner-msg",
                sourceAddress:address,destinationAddress:destinationIdentity,
                amountAtomic,globalId:-239,sourceFinality:"finalized",
                recipientFinality:"finalized",sourceMcBlockSeqno:100,
                recipientMcBlockSeqno:101,latestIndexedMcBlockSeqno:102};
        }
    };
    const independentVerifier={
        async verifyTransfer(args){
            return {status:"INDEPENDENT_INDEXED_CREDIT_OBSERVED",
                provider:"tonapi-mainnet",...args,actualFeeAtomic:800000};
        }
    };
    const settled=[];
    const plan=RoomPayoutCalculator.computePlan({
        payoutId:PAYOUT,roomId:ROOM,asset:"TON",network:"mainnet",
        principalAtomic:3_000_000_000,
        winner:{recipientId:"Olga",address:WINNER},
        owner:{recipientId:"WheelWin",address:OWNER},
        nowMs:1_800_000_000_000
    }).toJSON();
    const request={roomId:ROOM,payoutId:PAYOUT,roomWalletAddress:address,
        winnerWallet:WINNER,ownerWallet:OWNER,plan};
    const outbox=join(dir,"outbound-sequences");
    const make=()=>{
        const adapter=new RoomWalletAdapter({
            sequenceStateDir:outbox,tonService:service,
            walletResolver:async()=>identity,
            seqnoConfirmTimeoutMs:10,seqnoConfirmPollMs:5,
            sleep:async()=>{}
        });
        return new TestnetNativeRoomPayoutTransport({
            walletPool,adapter,dataDir:dir,network:"mainnet",
            outgoingObserver:observer,independentVerifier,
            ledger:{settlePayout:args=>{settled.push(args);return {replay:false};}}
        });
    };
    return {state,request,make,dir,outbox,settled};
}

test("Mainnet restart resumes owner only after genuine winner indexing and durable winner BOC",async t=>{
    const h=harness(t);
    const original=h.make();
    const first=await original.submit(h.request);
    assert.equal(first.status,"WINNER_CONFIRMATION_PENDING");
    assert.equal(h.state.broadcasts.length,1);
    const winnerBoc=h.state.broadcasts[0];

    // Simulated WalletV4 chain acceptance and indexed winner recipient credit.
    h.state.seqno=8;
    h.state.winnerIndexed=true;
    const restarted=h.make();
    const resumed=await restarted.resumeMainnetDurableAfterRestart(h.request);
    assert.ok(resumed.status);
    assert.equal(h.state.broadcasts.length,2);
    assert.notEqual(h.state.broadcasts[1],winnerBoc,
        "owner is a separate signed message with the next on-chain seqno");

    // Until seqno advances, an ambiguous owner attempt can only replay its
    // persisted identical BOC, not sign a second owner payment.
    const same=await h.make().resumeMainnetDurableAfterRestart(h.request);
    assert.ok(same.status);
    assert.equal(h.state.broadcasts.length,3);
    assert.equal(h.state.broadcasts[2],h.state.broadcasts[1],
        "retry is byte-identical to the original owner's WalletV4 BOC");

    // The source chain has now advanced; no further broadcast may occur.
    h.state.seqno=9;
    h.state.ownerIndexed=true;
    const finalized=await h.make().resumeMainnetDurableAfterRestart(h.request);
    assert.ok(finalized.status);
    assert.equal(h.state.broadcasts.length,3);
});

test("Mainnet holds an ambiguous winner claim when signed outbox is missing",async t=>{
    const h=harness(t);
    await h.make().submit(h.request);
    assert.equal(h.state.broadcasts.length,1);
    const {createHash}=await import("node:crypto");
    const key=createHash("sha256").update(PAYOUT+":WINNER").digest("hex");
    unlinkSync(join(h.outbox,"transfers",key+".json"));
    h.state.seqno=8;
    h.state.winnerIndexed=true;
    const result=await h.make().resumeMainnetDurableAfterRestart(h.request);
    assert.equal(result.status,"PAYOUT_DURABLE_RECOVERY_HOLD");
    assert.equal(result.reason,"PAYOUT_RECOVERY_WINNER_PROOF_MISSING");
    assert.equal(h.state.broadcasts.length,1,"never sign an inferred replacement");
});

test("Mainnet holds a missing first journal even if a ledger plan exists",async t=>{
    const h=harness(t);
    const result=await h.make().resumeMainnetDurableAfterRestart(h.request);
    assert.equal(result.status,"PAYOUT_DURABLE_RECOVERY_HOLD");
    assert.equal(result.reason,"PAYOUT_RECOVERY_JOURNAL_MISSING");
    assert.equal(h.state.broadcasts.length,0);
});

test("Mainnet holds owner claimed-before-signing crash instead of sending new owner BOC",async t=>{
    const h=harness(t);
    await h.make().submit(h.request);
    h.state.seqno=8;
    h.state.winnerIndexed=true;
    writeFileSync(join(h.dir,"mainnet-native-payout-attempts",
        PAYOUT+".OWNER.json"),JSON.stringify({
        payoutId:PAYOUT,role:"OWNER",state:"SUBMISSION_UNKNOWN",
        amountAtomic:h.request.plan.transfers.find(x=>x.recipientRole==="OWNER").netAtomic,
        destination:OWNER
    }));
    const result=await h.make().resumeMainnetDurableAfterRestart(h.request);
    assert.equal(result.status,"PAYOUT_DURABLE_RECOVERY_HOLD");
    assert.equal(result.reason,"PAYOUT_RECOVERY_OWNER_PROOF_MISMATCH");
    assert.equal(h.state.broadcasts.length,1);
});
