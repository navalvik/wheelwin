import test from "node:test";
import assert from "node:assert/strict";
import { keyPairFromSeed } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";
import { createRoomWalletRuntimeResolver } from "../../payment/roomWallet/RoomWalletRuntimeResolver.js";
import { RoomWalletAdapter } from "../../payment/roomWallet/RoomWalletAdapter.js";
import { TestnetNativeTonService } from "../../payment/roomWallet/TestnetNativeTonService.js";

function catalog() {
    return Array.from({length:64},(_,i)=>{
        const number=i+1;
        const keys=keyPairFromSeed(Buffer.alloc(32,number));
        return {
            roomNumber:number,network:"testnet",workchain:0,
            address:WalletContractV4.create({workchain:0,publicKey:keys.publicKey}).address.toString(),
            publicKey:keys.publicKey.toString("hex"),
            secretKey:keys.secretKey.toString("hex")
        };
    });
}
test("restored V4 registry resolves 64 test keys and rejects a mismatched key",async()=>{
    const list=catalog();
    const resolve=createRoomWalletRuntimeResolver({
        env:{TON_NETWORK:"testnet",ROOM_WALLETS_TESTNET_JSON:JSON.stringify(list)}
    });
    const addr=await resolve(2);
    assert.equal(addr.roomNumber,2);
    assert.equal(addr.secretKey.length,64);
    assert.equal(addr.publicKey.length,32);
    assert.equal(addr.address,list[1].address);
    const altered=list.map(x=>({...x}));
    altered[1].secretKey=altered[2].secretKey;
    assert.throws(()=>createRoomWalletRuntimeResolver({
        env:{TON_NETWORK:"testnet",ROOM_WALLETS_TESTNET_JSON:JSON.stringify(altered)}
    }));
});
test("native Testnet TonClient fee quote carries the real source fee sum",async()=>{
    const rpc=new TestnetNativeTonService({client:{
        estimateExternalMessageFee:async()=>({source_fees:{
            in_fwd_fee:100_000,storage_fee:300_000,gas_fee:400_000,fwd_fee:200_000
        }}),
        getBalance:async()=>3_000_000_000n,
        getContractState:async()=>({state:"active"}),
        runMethod:async()=>({stack:{readNumber:()=>1}}),
        sendFile:async()=>{}
    }});
    const wallet=catalog()[1];
    assert.equal(await rpc.getBalance(wallet.address),3_000_000_000n);
    assert.equal(await rpc.getSeqno(wallet.address),1);
    const fees=await rpc.estimateExternalMessageFee(wallet.address,{body:null});
    assert.equal(fees.totalFeeNano,1_000_000n);
    assert.equal(fees.storageFeeNano,300_000n);
});
test("restored V4 adapter builds a wallet-signed ordinary transfer without real RPC",async()=>{
    const wallets=catalog();
    const resolve=createRoomWalletRuntimeResolver({
        env:{TON_NETWORK:"testnet",ROOM_WALLETS_TESTNET_JSON:JSON.stringify(wallets)}
    });
    let observed=null;
    const rpc={
        getBalance:async()=>3_000_000_000n,
        getSeqno:async()=>7,
        estimateExternalMessageFee:async()=>({
            inFwdFeeNano:50_000n,storageFeeNano:50_000n,
            gasFeeNano:450_000n,fwdFeeNano:450_000n,totalFeeNano:1_000_000n
        }),
        broadcastTransaction:async boc=>{observed=boc;return {hash:"mock-transaction-submission"};}
    };
    const adapter=new RoomWalletAdapter({tonService:rpc,walletResolver:resolve});
    const quote=await adapter.estimateOutboundTransferFee({
        roomNumber:2,destination:wallets[2].address,amountNano:2_846_000_000n,
        bounce:false
    });
    assert.equal(quote.ok,true);
    assert.equal(quote.totalNano,1_000_000n);
    assert.equal(observed,null);
    const submitted=await adapter.sendTransfer({
        roomNumber:2,destination:wallets[2].address,
        amountNano:2_846_000_000n,bounce:false,sourceReserveNano:10_000_000n
    });
    assert.equal(submitted.ok,true);
    assert.equal(submitted.code,"SENT");
    assert.ok(typeof observed==="string" && observed.length>50);
    // Mock acknowledgement is not proof of final on-chain delivery.
});

test("Testnet seqno 0 requires an explicitly uninitialized WalletV4 account",async()=>{
    const wallet=catalog()[1];
    let runCalls=0;
    const fresh=new TestnetNativeTonService({client:{
        getContractState:async()=>({state:"uninitialized"}),
        runMethod:async()=>{runCalls++;throw new Error("must not call seqno on fresh wallet");}
    }});
    assert.equal(await fresh.getSeqno(wallet.address),0);
    assert.equal(runCalls,0);
    const frozen=new TestnetNativeTonService({client:{
        getContractState:async()=>({state:"frozen"})
    }});
    await assert.rejects(frozen.getSeqno(wallet.address),/TESTNET_WALLET_STATE_UNAVAILABLE/);
    const unknown=new TestnetNativeTonService({client:{
        getContractState:async()=>{throw new Error("TESTNET_RPC_TIMEOUT");}
    }});
    await assert.rejects(unknown.getSeqno(wallet.address),/TESTNET_RPC_TIMEOUT/);
    const brokenActive=new TestnetNativeTonService({client:{
        getContractState:async()=>({state:"active"}),
        runMethod:async()=>{throw new Error("SEQNO_RPC_TIMEOUT");}
    }});
    await assert.rejects(brokenActive.getSeqno(wallet.address),/SEQNO_RPC_TIMEOUT/);
});

test("WalletV4 adapter refuses fee quote and transfer when seqno RPC is unavailable",async()=>{
    const wallets=catalog();
    const resolver=createRoomWalletRuntimeResolver({
        env:{TON_NETWORK:"testnet",ROOM_WALLETS_TESTNET_JSON:JSON.stringify(wallets)}
    });
    let broadcasts=0;
    let estimates=0;
    const adapter=new RoomWalletAdapter({
        walletResolver:resolver,
        tonService:{
            getBalance:async()=>3_000_000_000n,
            getSeqno:async()=>{throw new Error("SEQNO_RPC_TIMEOUT");},
            estimateExternalMessageFee:async()=>{estimates++;return {totalFeeNano:1_000_000n};},
            broadcastTransaction:async()=>{broadcasts++;return {status:"SUBMITTED"};}
        }
    });
    const request={
        roomNumber:2,destination:wallets[2].address,
        amountNano:1_000_000_000n,bounce:false
    };
    const quote=await adapter.estimateOutboundTransferFee(request);
    assert.equal(quote.ok,false);
    assert.equal(quote.code,"FEE_ESTIMATION_UNAVAILABLE");
    await assert.rejects(adapter.sendTransfer(request),/SEQNO_RPC_TIMEOUT/);
    assert.equal(estimates,0);
    assert.equal(broadcasts,0);
});

test('RPC timeout seqno hold survives a new adapter instance', async t => {
    const {mkdtempSync, rmSync} = await import('node:fs');
    const {tmpdir} = await import('node:os');
    const {join} = await import('node:path');
    const stateDir = mkdtempSync(join(tmpdir(), 'ww-seqno-restart-'));
    t.after(() => rmSync(stateDir, {recursive:true, force:true}));
    const wallets = catalog();
    const walletResolver = createRoomWalletRuntimeResolver({env:{TON_NETWORK:'testnet', ROOM_WALLETS_TESTNET_JSON:JSON.stringify(wallets)}});
    let broadcasts = 0, clock = 0, seqno = 7;
    const tonService = {
        getBalance:async () => 10_000_000_000n,
        getSeqno:async () => seqno,
        broadcastTransaction:async () => { broadcasts++; throw new Error('RPC_TIMEOUT'); }
    };
    const make = () => new RoomWalletAdapter({walletResolver, tonService, sequenceStateDir:stateDir,
        now:() => clock, sleep:async ms => {clock += ms;}, seqnoConfirmTimeoutMs:10, seqnoConfirmPollMs:5});
    const request = {roomNumber:2, destination:wallets[2].address, amountNano:1_000_000_000n, bounce:false};
    await assert.rejects(make().sendTransfer(request), /RPC_TIMEOUT/);
    assert.equal(broadcasts, 1);
    const held = await make().sendTransfer(request);
    assert.equal(held.ok, false);
    assert.equal(broadcasts, 1, 'restart must not reuse ambiguous seqno');
    seqno = 8;
    await assert.rejects(make().sendTransfer(request), /RPC_TIMEOUT/);
    assert.equal(broadcasts, 2, 'authoritative seqno advancement permits the next independent transfer');
});
