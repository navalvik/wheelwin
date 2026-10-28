import test from "node:test";
import assert from "node:assert/strict";
import {ToncenterTestnetOutgoingTransferProvider} from "../../payment/refund/ToncenterTestnetOutgoingTransferProvider.js";

const ROOM="0:"+"a".repeat(64);
const RECIPIENT="0:"+"b".repeat(64);
const WRONG="0:"+"c".repeat(64);
const NOW=1_800_000_000_000;
const SOURCE_TX="1".repeat(64),DEST_TX="2".repeat(64),MSG_HASH="3".repeat(64);
const NANO=998_000_000;

function source(overrides={}){
    return {
        account:ROOM,hash:SOURCE_TX,now:Math.floor(NOW/1000)-2,
        description:{aborted:false,action:{success:true}},
        out_msgs:[{hash:MSG_HASH,source:ROOM,destination:RECIPIENT,
            value:String(NANO),bounced:false}],
        ...overrides
    };
}
function recipient(overrides={}){
    return {
        account:RECIPIENT,hash:DEST_TX,now:Math.floor(NOW/1000)-1,
        description:{aborted:false,action:{success:true}},
        in_msg:{hash:MSG_HASH,source:ROOM,destination:RECIPIENT,
            value:String(NANO),bounced:false},
        ...overrides
    };
}
function makeProvider(senderRow=source(),destRows=[recipient()]){
    const calls=[];
    const client={getTransactions:async args=>{
        calls.push(args);
        if(args.account===ROOM)return {transactions:[senderRow]};
        if(args.account===RECIPIENT)return {transactions:destRows};
        throw Error("unexpected account");
    }};
    return {calls,provider:new ToncenterTestnetOutgoingTransferProvider({
        client,nowProvider:()=>NOW
    })};
}
const request={
    sourceWalletAddress:ROOM,destinationIdentity:RECIPIENT,
    transactionId:SOURCE_TX,amountAtomic:NANO,minCreatedAtMs:NOW-10_000
};

test("source outgoing hash and recipient incoming hash prove same transfer was observed, not finality",async()=>{
    const {provider,calls}=makeProvider();
    const credit=await provider.observeRecipientCredit(request);
    assert.equal(credit.status,"RECIPIENT_CREDIT_OBSERVED_UNFINALIZED");
    assert.equal(credit.sourceTransactionId,SOURCE_TX);
    assert.equal(credit.recipientTransactionId,DEST_TX);
    assert.equal(credit.messageHash,MSG_HASH);
    assert.equal(credit.amountAtomic,NANO);
    assert.deepEqual(calls.map(x=>x.account),[ROOM,RECIPIENT]);
    assert.ok(calls.every(x=>x.startUtime===Math.floor((NOW-10_000)/1000)));
});
test("missing destination credit cannot be substituted with room outgoing transaction",async()=>{
    const x=makeProvider(source(),[]);
    assert.equal(await x.provider.observeRecipientCredit(request),null);
});
test("wrong destination message, hash, amount or source cannot falsely credit player",async()=>{
    const altered=[
        recipient({in_msg:{...recipient().in_msg,hash:"f".repeat(64)}}),
        recipient({in_msg:{...recipient().in_msg,source:WRONG}}),
        recipient({in_msg:{...recipient().in_msg,value:String(NANO-1)}}),
        recipient({in_msg:{...recipient().in_msg,destination:WRONG}}),
        recipient({description:{aborted:true,action:{success:false}}}),
        recipient({account:WRONG})
    ];
    for(const row of altered){
        assert.equal(await makeProvider(source(),[row]).provider.observeRecipientCredit(request),null);
    }
});
test("multiple candidate recipient credits, expired claims, wrong transaction or extra sender outputs fail closed",async()=>{
    const two=makeProvider(source(),[recipient(),recipient({hash:"e".repeat(64)})]);
    assert.equal(await two.provider.observeRecipientCredit(request),null);
    const oldSource=source({now:Math.floor((NOW-80_000)/1000)});
    assert.equal(await makeProvider(oldSource).provider.observeRecipientCredit(request),null);
    assert.equal(await makeProvider().provider.observeRecipientCredit({
        ...request,transactionId:"9".repeat(64)
    }),null);
    const double=source({out_msgs:[source().out_msgs[0],{
        hash:"4".repeat(64),source:ROOM,destination:WRONG,value:"1"
    }]});
    assert.equal(await makeProvider(double).provider.observeRecipientCredit(request),null);
});
