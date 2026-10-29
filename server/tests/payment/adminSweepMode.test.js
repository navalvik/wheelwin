import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keyPairFromSeed } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";
import { Address, SendMode } from "@ton/core";
import { RoomWalletAdapter } from "../../payment/roomWallet/RoomWalletAdapter.js";

const keys = keyPairFromSeed(Buffer.alloc(32,11));
const identity = {
    roomNumber:2,network:"testnet",workchain:0,
    publicKey:keys.publicKey,secretKey:keys.secretKey,
    address:WalletContractV4.create({workchain:0,publicKey:keys.publicKey}).address.toString()
};
const destination = WalletContractV4.create({
    workchain:0,publicKey:keyPairFromSeed(Buffer.alloc(32,12)).publicKey
}).address.toString();

test("administrator sweep signs carry-all mode 128, journals before broadcast, never resubmits", async t => {
    const dir = mkdtempSync(join(tmpdir(),"ww-admin-sweep-"));
    t.after(()=>rmSync(dir,{recursive:true,force:true}));
    let broadcasts = 0, seenMode = null;
    const tonService = {
        getBalance:async()=>3_000_000_000n,
        getSeqno:async()=>7,
        estimateExternalMessageFee:async()=>({totalFeeNano:2_000_000n}),
        broadcastTransaction:async boc=>{
            assert.ok(typeof boc==="string" && boc.length>50);
            const claim=JSON.parse(readFileSync(join(dir,"admin-sweeps","2.json"),"utf8"));
            assert.equal(claim.status,"SUBMISSION_UNKNOWN");
            assert.equal(claim.destination, Address.parse(destination).toString({bounceable:true,urlSafe:true}));
            assert.ok(!("boc" in claim));
            broadcasts++;
        }
    };
    const make=()=>new RoomWalletAdapter({
        sequenceStateDir:dir, walletResolver:async()=>identity,tonService
    });
    const adapter=make();
    const original=adapter._buildSignedExternalMessage.bind(adapter);
    adapter._buildSignedExternalMessage=async request=>{
        seenMode=request.sendMode;
        return original(request);
    };
    const result=await adapter.sendAllBalance({roomNumber:2,destination});
    assert.equal(result.ok,true);
    assert.equal(result.code,"SUBMITTED_UNCONFIRMED");
    assert.equal(seenMode,SendMode.CARRY_ALL_REMAINING_BALANCE);
    assert.equal(broadcasts,1);
    const replay=await make().sendAllBalance({roomNumber:2,destination});
    assert.equal(replay.ok,false);
    assert.equal(replay.code,"SWEEP_PREVIOUS_ATTEMPT_REQUIRES_RECONCILIATION");
    assert.equal(broadcasts,1);
});

test("sweep fee preflight refuses insufficient funds without recording a submission",async t=>{
    const dir=mkdtempSync(join(tmpdir(),"ww-admin-sweep-fee-"));
    t.after(()=>rmSync(dir,{recursive:true,force:true}));
    let broadcasts=0;
    const adapter=new RoomWalletAdapter({
        sequenceStateDir:dir,walletResolver:async()=>identity,
        tonService:{
            getBalance:async()=>1_500_000n,
            getSeqno:async()=>1,
            estimateExternalMessageFee:async()=>({totalFeeNano:1_000_000n}),
            broadcastTransaction:async()=>{broadcasts++;}
        }
    });
    const result=await adapter.sendAllBalance({roomNumber:2,destination});
    assert.equal(result.ok,false);
    assert.equal(result.code,"SWEEP_INSUFFICIENT_GAS");
    assert.equal(broadcasts,0);
    assert.equal(existsSync(join(dir,"admin-sweeps","2.json")),false);
});
