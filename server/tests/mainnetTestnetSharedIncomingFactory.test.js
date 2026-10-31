import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";
import {
    buildPaymentRuntime,buildMainnetPaymentRuntime
} from "../payment/runtime/PaymentRuntimeFactory.js";
import {requireToncenterChainConfig} from "../payment/toncenter/ToncenterConstants.js";
import {LEDGER_ENTRY_KIND} from "../payment/ledger/LedgerConstants.js";

const NOW=1800000000000,ROOM="SAME_INCOMING_PARITY";
const addr=n=>"0:"+n.toString(16).padStart(64,"0");
const PLAYERS=["Olga","Bob","Lena"];
function fixture(t,network,{paid=3,wrongAmount=false}={}){
    const root=mkdtempSync(join(tmpdir(),"wheelwin-network-incoming-factory-"));
    t.after(()=>rmSync(root,{recursive:true,force:true}));
    const catalogPath=join(root,"wallets-public.json");
    writeFileSync(catalogPath,JSON.stringify(Array.from({length:64},(_,i)=>({
        roomNumber:i+1,network,address:addr(i+1)
    }))));
    let clock=NOW,transactions=[],reads=0;
    const chain=requireToncenterChainConfig(network);
    const fetchImpl=async url=>{
        assert.equal(new URL(url).origin,chain.baseUrl);
        reads++;
        const payload=new URL(url).pathname.endsWith("masterchainInfo")
            ?{last:{global_id:chain.globalId,seqno:20000}}
            :{transactions,address_book:{}};
        return new Response(JSON.stringify(payload),{status:200});
    };
    const options={dataDir:join(root,"financial"),walletCatalogPath:catalogPath,
        nowProvider:()=>clock,fetchImpl,apiKeyProvider:()=>"OFFLINE_NO_SECRET"};
    const build=network==="mainnet"?buildMainnetPaymentRuntime:buildPaymentRuntime;
    const runtime=build(options);
    runtime.initialize();
    const requirements=PLAYERS.map((playerId,i)=>({
        roomId:ROOM,playerId,paymentReference:"WW-NETWORK-PARITY-"+i,
        expectedSender:addr(100+i),amountAtomic:1000000000
    }));
    const descriptor={roomId:ROOM,roomCreatedAt:NOW-20000,
        network,asset:"TON",
        stakeLedgerRelation:"ONE_PLAYER_STAKE_AND_PRINCIPAL_PER_PAYMENT",
        requiredPlayers:requirements};
    runtime.sessionAdapter.prepareRoom(descriptor);
    const slot=runtime.walletPool.getReservationForRoom(ROOM);
    assert.ok(slot);
    transactions=requirements.slice(0,paid).map((p,i)=>({
        hash:createHash("sha256").update(p.paymentReference).digest("hex"),
        account:slot.address,now:NOW/1000+5,emulated:false,
        block_ref:{workchain:0,shard:"8000000000000000",seqno:301+i},
        mc_block_seqno:9001+i,
        description:{aborted:false,compute_ph:{success:true},action:{success:true}},
        in_msg:{source:p.expectedSender,destination:slot.address,
            value:String(wrongAmount&&i===0?999000000:1000000000),
            bounced:false,
            message_content:{decoded:{type:"text_comment",comment:"WW1:"+p.paymentReference}}
        }
    }));
    clock=NOW+10000;
    return {runtime,slot,requirements,options,build,
        get reads(){return reads;},shutdown:()=>runtime.shutdown()};
}
async function runCase(t,network,scenario){
    const h=fixture(t,network,scenario);
    const result=await h.runtime.coordinator.settleRoomPayments({
        roomId:ROOM,floorMs:NOW-20000,ceilingMs:NOW+10000,now:NOW+10000
    });
    assert.equal(result.refusal,null,JSON.stringify(result));
    const states=h.runtime.paymentService.listPaymentIntentsForRoom(ROOM)
        .map(x=>({playerId:x.playerId,state:x.state,
            paymentReference:x.paymentReference,amountAtomic:x.amountAtomic}));
    const settled=states.filter(x=>x.state==="SETTLED").length;
    const receipts=h.runtime.receiptStore.listForRoom(ROOM).length;
    const requests=h.reads;
    h.shutdown();
    const restarted=h.build(h.options);
    restarted.initialize();
    const principals=restarted.ledgerStore.listForRoom(ROOM)
        .filter(x=>x.kind===LEDGER_ENTRY_KIND.INCOMING_PRINCIPAL);
    assert.equal(principals.length,settled);
    assert.equal(restarted.ledger.getConfirmedPrincipalAtomic(ROOM),
        1000000000*settled);
    const summary={states,settled,receipts,principal:principals.length,
        principalAtomic:restarted.ledger.getConfirmedPrincipalAtomic(ROOM),
        requests};
    restarted.shutdown();
    return summary;
}

test("same incoming runtime: Testnet/Mainnet 3/3 state, receipts and restart principal are identical",async t=>{
    const testnet=await runCase(t,"testnet",{paid:3});
    const mainnet=await runCase(t,"mainnet",{paid:3});
    assert.deepEqual(mainnet,testnet);
    assert.equal(testnet.settled,3);
});

test("same incoming runtime: Testnet/Mainnet 2/3 partial payment behavior is identical",async t=>{
    const testnet=await runCase(t,"testnet",{paid:2});
    const mainnet=await runCase(t,"mainnet",{paid:2});
    assert.deepEqual(mainnet,testnet);
    assert.equal(testnet.settled,2);
});

test("same incoming runtime: Testnet/Mainnet incorrect amount cannot settle player",async t=>{
    const testnet=await runCase(t,"testnet",{paid:3,wrongAmount:true});
    const mainnet=await runCase(t,"mainnet",{paid:3,wrongAmount:true});
    assert.deepEqual(mainnet,testnet);
    assert.equal(testnet.settled,2);
    assert.equal(testnet.states[0].state,"PENDING");
});
