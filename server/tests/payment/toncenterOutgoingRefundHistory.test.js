import test from "node:test";
import assert from "node:assert/strict";
import {ToncenterTestnetOutgoingTransferProvider} from "../../payment/refund/ToncenterTestnetOutgoingTransferProvider.js";

const ROOM="0:"+"a".repeat(64),PAYER="0:"+"b".repeat(64),OTHER="0:"+"c".repeat(64);
const NOW=1_800_000_000_000;
const TX="f".repeat(64);
function row({hash=TX,source=ROOM,destination=PAYER,value="998000000",aborted=false,
    actionSuccess=true,extra=false}={}){
    const out={source,destination,value,bounced:false};
    return {
        hash,account:ROOM,now:Math.floor(NOW/1000),
        description:{aborted,action:{success:actionSuccess}},
        out_msgs:extra?[out,{...out,destination:OTHER}]:[out]
    };
}
function history(transactions){
    const requests=[];
    return {
        requests,
        provider:new ToncenterTestnetOutgoingTransferProvider({
            nowProvider:()=>NOW,
            client:{getTransactions:async args=>{
                requests.push(args);
                return {transactions};
            }}
        })
    };
}
test("readonly Testnet source outgoing identifies exact 0.998 GRAM refund",async()=>{
    const x=history([row()]);
    const out=await x.provider.getOutgoingTransfer({
        sourceWalletAddress:ROOM,transactionId:TX
    });
    assert.deepEqual(out,{
        transactionId:TX,sourceAddress:ROOM,destinationAddress:PAYER,
        amountAtomic:998_000_000
    });
    const lookup=await x.provider.findOutgoingTransfer({
        sourceWalletAddress:ROOM,destinationIdentity:PAYER,amountAtomic:998_000_000
    });
    assert.equal(lookup.transactionId,TX);
    assert.equal(x.requests[0].account,ROOM);
    assert.equal(x.requests[0].limit,1000);
});
test("wrong source, failed wallet action, aborted row and second output never prove refund",async()=>{
    for(const o of [
        {source:OTHER},{aborted:true},{actionSuccess:false},
        {extra:true},{value:"999000000"},{value:"-1"}
    ]){
        const x=history([row(o)]);
        const found=await x.provider.findOutgoingTransfer({
            sourceWalletAddress:ROOM,destinationIdentity:PAYER,amountAtomic:998_000_000
        });
        assert.equal(found,null);
        assert.equal(await x.provider.getOutgoingTransfer({
            sourceWalletAddress:ROOM,transactionId:TX
        }),o.value==="999000000" && !o.extra ? null : null);
    }
});
test("two possible outgoing refunds are ambiguous, never picked arbitrarily",async()=>{
    const x=history([row(),row({hash:"e".repeat(64)})]);
    const matched=await x.provider.findOutgoingTransfer({
        sourceWalletAddress:ROOM,destinationIdentity:PAYER,amountAtomic:998_000_000
    });
    assert.equal(matched.ambiguous,true);
});
test("unavailable network data, invalid source and missing tx fail closed",async()=>{
    const x=history([]);
    assert.equal(await x.provider.getOutgoingTransfer({
        sourceWalletAddress:ROOM,transactionId:TX
    }),null);
    assert.equal(await x.provider.findOutgoingTransfer({
        sourceWalletAddress:ROOM,destinationIdentity:PAYER,amountAtomic:998_000_000
    }),null);
    await assert.rejects(x.provider.getOutgoingTransfer({
        sourceWalletAddress:"invalid",transactionId:TX
    }),/INVALID/);
});
