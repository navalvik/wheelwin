import test from "node:test";
import assert from "node:assert/strict";
import { ToncenterReadBudget } from "../payment/toncenter/ToncenterReadBudget.js";
import { ToncenterTransactionsClient } from "../payment/toncenter/ToncenterTransactionsClient.js";

function fakeClock() {
    let time=0, nextId=1;
    const tasks=new Map();
    return {
        now:()=>time,
        schedule(fn,ms){ const id=nextId++; tasks.set(id,{due:time+ms,fn}); return id; },
        cancel(id){tasks.delete(id);},
        advance(to){
            if(to<time) throw Error("backward time");
            while(true){
                const next=[...tasks].sort((a,b)=>a[1].due-b[1].due)[0];
                if(!next || next[1].due>to) break;
                tasks.delete(next[0]);time=next[1].due;next[1].fn();
            }
            time=to;
        }
    };
}

test("active Page4 read overtakes queued historical recovery at same Toncenter quota", async ()=>{
    const clock=fakeClock(),budget=new ToncenterReadBudget({
        requestsPerSecond:2,reducedRequestsPerSecond:1,
        now:clock.now,schedule:clock.schedule,cancel:clock.cancel});
    const order=[];
    const first=budget.acquire().then(()=>order.push("old-first"));
    const old=budget.acquire().then(()=>order.push("old-second"));
    const page4=budget.acquire({priority:"page4"}).then(()=>order.push("page4"));
    await first;
    assert.deepEqual(order,["old-first"]);
    clock.advance(500);await page4;
    assert.deepEqual(order,["old-first","page4"]);
    clock.advance(1000);await old;
    assert.deepEqual(order,["old-first","page4","old-second"]);
});

test("HTTP429 pauses all clients and temporarily slows dispatch without duplicating reads", async ()=>{
    const clock=fakeClock(),budget=new ToncenterReadBudget({
        requestsPerSecond:6,reducedRequestsPerSecond:2,
        defaultCooldownMs:2000,recoveryMs:5000,
        now:clock.now,schedule:clock.schedule,cancel:clock.cancel});
    let calls=0;
    const fetchImpl=async ()=>{calls++;return calls===1
        ? {status:429,headers:{get:()=> "3"}}
        : {status:200,json:async()=>({transactions:[]})};};
    const clientA=new ToncenterTransactionsClient({
        fetchImpl,apiKeyProvider:()=>"test-secret",readBudget:budget});
    const clientB=new ToncenterTransactionsClient({
        fetchImpl,apiKeyProvider:()=>"test-secret",readBudget:budget});
    const query={account:"0:test",startUtime:1,endUtime:2};
    await assert.rejects(clientA.getTransactions(query),error=>error.statusCode===429);
    assert.equal(calls,1,"429 must cause no rapid local retries");
    const next=clientB.getTransactions({...query,priority:"page4"});
    await Promise.resolve();await Promise.resolve();
    assert.equal(calls,1,"all clients share the same 429 cooldown");
    clock.advance(2999); await Promise.resolve();
    assert.equal(calls,1);
    clock.advance(3000);
    const response=await next;
    assert.equal(calls,2);
    assert.deepEqual(response.transactions,[]);
});

test("multiple active Page4 calls get fair requests under one process-wide budget", async ()=>{
    const clock=fakeClock(),budget=new ToncenterReadBudget({
        requestsPerSecond:6,reducedRequestsPerSecond:2,
        now:clock.now,schedule:clock.schedule,cancel:clock.cancel});
    const events=[];
    const p=Array.from({length:12},(_,i)=>budget.acquire({priority:"page4"})
        .then(()=>events.push({id:i,at:clock.now()})));
    await Promise.resolve();
    for(let t=0;t<=2500;t+=200) clock.advance(t);
    await Promise.all(p);
    assert.equal(events.length,12);
    for(const entry of events){
        const rolling=events.filter(x=>x.at>=entry.at-999 && x.at<=entry.at);
        assert.ok(rolling.length<=6,"no 1-second window may exceed the global budget");
    }
});

test("one HTTP429 does not change payment state or invoke any wallet transaction", async ()=>{
    const budget=new ToncenterReadBudget();
    const calls=[];
    const fake=async (url,init)=>{
        calls.push({url,method:init.method});
        return {status:429,headers:{get:()=>null}};
    };
    const client=new ToncenterTransactionsClient({
        fetchImpl:fake,apiKeyProvider:()=>"synthetic",readBudget:budget});
    await assert.rejects(client.getTransactions({
        account:"0:room",startUtime:1,endUtime:5,priority:"page4"
    }),error=>error.statusCode===429);
    assert.equal(calls.length,1);
    assert.equal(calls[0].method,"GET");
    assert.ok(calls[0].url.includes("/api/v3/transactions"));
});
