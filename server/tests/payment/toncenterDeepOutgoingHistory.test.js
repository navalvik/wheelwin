import test from "node:test";
import assert from "node:assert/strict";
import {ToncenterTransactionsClient} from "../../payment/toncenter/ToncenterTransactionsClient.js";
import {ToncenterTestnetOutgoingTransferProvider} from "../../payment/refund/ToncenterTestnetOutgoingTransferProvider.js";

const NOW=1_800_000_000_000;
const SENDER="0:"+"a".repeat(64);
const PAYEE="0:"+"b".repeat(64);
const OTHER="0:"+"c".repeat(64);
function row(id,recipient=OTHER){
    return {
        hash:id.repeat(64),account:SENDER,now:Math.floor(NOW/1000)-10,
        description:{aborted:false,action:{success:true}},
        out_msgs:[{source:SENDER,destination:recipient,value:"998000000",bounced:false}]
    };
}
function observer(pages,{pageSize=2,maxPages=5}={}){
    const offsets=[];
    const client={getTransactions:async query=>{
        offsets.push(query.offset ?? 0);
        return {transactions:pages[query.offset??0]??[]};
    }};
    return {offsets,provider:new ToncenterTestnetOutgoingTransferProvider({
        client,nowProvider:()=>NOW,pageSize,maxPages
    })};
}
const find={sourceWalletAddress:SENDER,destinationIdentity:PAYEE,
    amountAtomic:998_000_000,minCreatedAtMs:NOW-30_000};
test("find exact paid transfer on third fully indexed v3 history page",async()=>{
    const h=observer({0:[row("1"),row("2")],2:[row("3"),row("4")],
        4:[row("5",PAYEE)]},{maxPages:3});
    const match=await h.provider.findOutgoingTransfer(find);
    assert.equal(match.transactionId,"5".repeat(64));
    assert.deepEqual(h.offsets,[0,2,4]);
});
test("history cap is an explicit unresolved error, not no-payment determination",async()=>{
    const h=observer({0:[row("1"),row("2")]},{maxPages:1});
    await assert.rejects(h.provider.findOutgoingTransfer(find),
        /OUTGOING_HISTORY_INCOMPLETE/);
    assert.deepEqual(h.offsets,[0]);
});
test("new transaction arriving between pages cannot silently displace an older page",async()=>{
    const h=observer({0:[row("1"),row("2")],2:[row("2"),row("3")]});
    await assert.rejects(h.provider.findOutgoingTransfer(find),
        /OUTGOING_HISTORY_PAGE_DRIFT/);
});
test("provider rejecting malformed oversized and invalid history also fails closed",async()=>{
    const cases=[
        {0:[row("1"),row("2"),row("3")]},
        {0:[row("1"),{account:SENDER,now:Math.floor(NOW/1000)}]}
    ];
    for(const pages of cases)
        await assert.rejects(observer(pages).provider.findOutgoingTransfer(find),
            /OUTGOING_TRANSACTIONS_UNAVAILABLE|OUTGOING_HISTORY_MALFORMED/);
});
test("Toncenter HTTP transport paginates only nonzero offsets and validates them before requests",async()=>{
    const urls=[];
    const client=new ToncenterTransactionsClient({
        apiKeyProvider:()=>"fake-test-only-key",
        fetchImpl:async url=>{
            urls.push(url);
            return {status:200,json:async()=>({transactions:[],address_book:{}})};
        }
    });
    const query={account:SENDER,startUtime:0,endUtime:100,limit:2};
    await client.getTransactions(query);
    await client.getTransactions({...query,offset:2});
    assert.equal(urls.length,2);
    assert.equal(new URL(urls[0]).searchParams.has("offset"),false);
    assert.equal(new URL(urls[1]).searchParams.get("offset"),"2");
    for(const offset of [-1,0.5,1_000_001,"2",NaN]){
        await assert.rejects(client.getTransactions({...query,offset}),/offset/);
    }
    assert.equal(urls.length,2);
});

test("recovered room payment older than 7 days searches back to original durable claim",async()=>{
    const fortyDays=40*24*60*60*1000;
    const originalClaim=NOW-fortyDays;
    const h=observer({0:[row("5",PAYEE)]},{maxPages:3});
    const match=await h.provider.findOutgoingTransfer({
        ...find,minCreatedAtMs:originalClaim
    });
    assert.equal(match.transactionId,"5".repeat(64));
    // An old claim must never be silently cropped to a default 7-day window.
    assert.deepEqual(h.offsets,[0]);
    const calls=[];
    const real=new ToncenterTestnetOutgoingTransferProvider({
        nowProvider:()=>NOW,
        client:{getTransactions:async params=>{
            calls.push(params);
            return {transactions:[row("5",PAYEE)]};
        }}
    });
    await real.getOutgoingTransfer({
        sourceWalletAddress:SENDER,transactionId:"5".repeat(64),
        minCreatedAtMs:originalClaim
    });
    assert.equal(calls[0].startUtime,Math.floor(originalClaim/1000));
});
