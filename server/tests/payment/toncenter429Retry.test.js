import test from "node:test";
import assert from "node:assert/strict";
import {ToncenterTransactionsClient} from "../../payment/toncenter/ToncenterTransactionsClient.js";

test("explicit legacy retry opt-in honors Retry-After on a synthetic read", async () => {
    const waits=[];
    let calls=0;
    const client=new ToncenterTransactionsClient({
        apiKeyProvider:()=>"synthetic-key",
        rateLimitRetries:2,
        delay:async ms=>waits.push(ms),
        fetchImpl:async()=>{
            calls++;
            if(calls===1)return {status:429,headers:{get:name=>name==="retry-after"?"2":null}};
            return {status:200,json:async()=>({transactions:[],address_book:{}})};
        }
    });
    const result=await client.getTransactions({
        account:"0:"+"a".repeat(64),startUtime:1,endUtime:2,limit:10
    });
    assert.equal(calls,2);
    assert.deepEqual(waits,[2000]);
    assert.deepEqual(result.transactions,[]);
});

test("explicit legacy retry opt-in stops after its finite budget", async () => {
    let calls=0;
    const client=new ToncenterTransactionsClient({
        apiKeyProvider:()=>"synthetic-key",
        rateLimitRetries:2,
        delay:async()=>{},
        fetchImpl:async()=>{calls++;return {status:429,headers:{get:()=>null}};}
    });
    await assert.rejects(client.getTransactions({
        account:"0:"+"b".repeat(64),startUtime:1,endUtime:2,limit:10
    }),error=>error.code==="TONCENTER_RATE_LIMITED"&&error.details.attempts===3);
    assert.equal(calls,3);
});
