import test from "node:test";
import assert from "node:assert/strict";
import {ToncenterTestnetOutgoingTransferProvider} from "../../payment/refund/ToncenterTestnetOutgoingTransferProvider.js";

const ROOM="0:"+"a".repeat(64),RECIPIENT="0:"+"b".repeat(64);
const NOW=1_800_000_000_000;
const OUT_HASH="1".repeat(64),IN_HASH="2".repeat(64),MESSAGE_HASH="3".repeat(64);
const block=(seqno)=>({workchain:0,shard:"8000000000000000",seqno});
const source=()=>({
    account:ROOM,hash:OUT_HASH,now:Math.floor(NOW/1000)-10,
    mc_block_seqno:100,block_ref:block(30),emulated:false,finality:2,
    description:{aborted:false,action:{success:true}},
    out_msgs:[{hash:MESSAGE_HASH,source:ROOM,destination:RECIPIENT,
        value:"998000000",bounced:false}]
});
const recipient=()=>({
    account:RECIPIENT,hash:IN_HASH,now:Math.floor(NOW/1000)-8,
    mc_block_seqno:101,block_ref:block(31),emulated:false,finality:2,
    description:{aborted:false,action:{success:true}},
    in_msg:{hash:MESSAGE_HASH,source:ROOM,destination:RECIPIENT,
        value:"998000000",bounced:false}
});
const query={
    sourceWalletAddress:ROOM,destinationIdentity:RECIPIENT,
    transactionId:OUT_HASH,amountAtomic:998_000_000,minCreatedAtMs:NOW-30_000
};
function setup({sender=source(),receiver=recipient(),head={last:{global_id:-3,seqno:110}}}={}){
    const calls=[];
    const provider=new ToncenterTestnetOutgoingTransferProvider({
        nowProvider:()=>NOW,
        client:{
            getTransactions:async args=>{
                calls.push(args);
                return {transactions:args.account===ROOM?[sender]
                    :args.account===RECIPIENT?[receiver]:[]};
            },
            getMasterchainInfo:async()=>{
                calls.push({masterchainInfo:true});
                return head;
            }
        }
    });
    return {provider,calls};
}
test("old outgoing and recipient credit can be verified against indexed Testnet masterchain after restart",async()=>{
    const x=setup();
    const result=await x.provider.verifyIndexedRecipientCredit(query);
    assert.equal(result.status,"MASTERCHAIN_INDEXED_RECIPIENT_CREDIT_OBSERVED");
    assert.equal(result.globalId,-3);
    assert.equal(result.sourceFinality,"finalized");
    assert.equal(result.recipientFinality,"finalized");
    assert.equal(result.sourceMcBlockSeqno,100);
    assert.equal(result.recipientMcBlockSeqno,101);
    assert.equal(result.latestIndexedMcBlockSeqno,110);
    assert.equal(result.messageHash,MESSAGE_HASH);
    assert.deepEqual(x.calls.map(v=>v.account??"masterchain"),[ROOM,RECIPIENT,"masterchain"]);
    assert.ok(x.calls.slice(0,2).every(v=>v.startUtime===Math.floor((NOW-30_000)/1000)));
});
test("mainnet head, stale head, missing indexed block, emulation, or wrong workchain never pass",async()=>{
    const scenarios=[
        {head:{last:{global_id:-239,seqno:110}}},
        {head:{last:{global_id:-3,seqno:101}}},
        {head:{last:{global_id:-3,seqno:100}}},
        {head:{last:{global_id:-3,seqno:-1}}},
        {sender:{...source(),mc_block_seqno:null}},
        {receiver:{...recipient(),block_ref:null}},
        {sender:{...source(),emulated:true}},
        {sender:{...source(),finality:0}},
        {sender:{...source(),finality:1}},
        {receiver:{...recipient(),finality:1}},
        {receiver:{...recipient(),finality:0}},
        {sender:{...source(),finality:null}},
        {receiver:{...recipient(),finality:"2"}},
        {receiver:{...recipient(),emulated:true}},
        {sender:{...source(),block_ref:{...block(30),workchain:-1}}},
        {receiver:{...recipient(),mc_block_seqno:999}},
        {receiver:{...recipient(),in_msg:{...recipient().in_msg,hash:"f".repeat(64)}}}
    ];
    for(const x of scenarios){
        const result=await setup(x).provider.verifyIndexedRecipientCredit(query);
        assert.equal(result,null,JSON.stringify(Object.keys(x)));
    }
});
test("no recipient credit -> no masterchain query and no fabricated finality",async()=>{
    const x=setup({receiver:{...recipient(),description:{aborted:true}}});
    assert.equal(await x.provider.verifyIndexedRecipientCredit(query),null);
    assert.equal(x.calls.length,2);
});
