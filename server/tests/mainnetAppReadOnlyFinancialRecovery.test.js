import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {buildMainnetPaymentRuntime,buildPaymentRuntime} from "../payment/runtime/PaymentRuntimeFactory.js";
import {createMainnetReadOnlyFinancialRecovery} from "../payment/runtime/MainnetReadOnlyFinancialRecovery.js";
import {ToncenterTransactionsClient} from "../payment/toncenter/ToncenterTransactionsClient.js";

const wallet=n=>"0:"+n.toString(16).padStart(64,"0"),NOW=1800000000000;
function setup(t,network="mainnet") {
    const root=mkdtempSync(join(tmpdir(),"ww-mainnet-app-readonly-"));
    t.after(()=>rmSync(root,{recursive:true,force:true}));
    const walletCatalogPath=join(root,"64-wallets.json");
    writeFileSync(walletCatalogPath,JSON.stringify(Array.from({length:64},(_,i)=>({
        roomNumber:i+1,network,address:wallet(i+1)
    }))));
    const calls=[];
    const baseUrl=network==="mainnet"?"https://toncenter.com":"https://testnet.toncenter.com";
    const fetchImpl=async(url,init)=>{
        calls.push({url,init});
        const path=new URL(url).pathname;
        return new Response(JSON.stringify(path.endsWith("masterchainInfo")
            ?{last:{global_id:network==="mainnet"?-239:-3,seqno:20000}}
            :{transactions:[],address_book:{}}),{status:200});
    };
    const runtime=(network==="mainnet"?buildMainnetPaymentRuntime:buildPaymentRuntime)({
        dataDir:join(root,"finance"),walletCatalogPath,nowProvider:()=>NOW,
        fetchImpl,apiKeyProvider:()=>"OFFLINE_NO_SECRET"
    });
    runtime.initialize();
    t.after(()=>runtime.shutdown());
    const client=new ToncenterTransactionsClient({
        baseUrl,fetchImpl,apiKeyProvider:()=>"OFFLINE_NO_SECRET"
    });
    const independent={
        _network:network,
        async verifyTransfer(){return null;}
    };
    return {runtime,client,independent,calls};
}
test("Mainnet app read-only wiring uses original recovery workers and never loads a sender or queries 64 wallets",async t=>{
    const h=setup(t);
    const wired=createMainnetReadOnlyFinancialRecovery({
        runtime:h.runtime,client:h.client,independentVerifier:h.independent,
        nowProvider:()=>NOW
    });
    assert.equal(wired.observer._chain.network,"mainnet");
    assert.equal(wired.observer._chain.globalId,-239);
    assert.equal(wired.incomingProvider.baseUrl,"https://toncenter.com");
    assert.equal(wired.historicalIncoming.runtime,h.runtime);
    assert.equal(wired.historicalIncoming._chain.globalId,-239);
    assert.equal(wired.pendingRefunds._refunds,h.runtime.refundStore);
    assert.equal(wired.pendingRefunds._identity.globalId,-239);
    assert.equal(wired.historicalIncoming.chainObserver,wired.pendingRefunds._chain);
    assert.equal(wired.historicalIncoming.independentVerifier,wired.pendingRefunds._independent);
    assert.equal(h.runtime.outgoingRefundProvider,null);
    assert.equal(h.runtime.getCapabilities().livePaymentAcceptanceEnabled,false);
    assert.deepEqual(h.runtime.paymentGate.getGameStartGateStatus("unknown-room",["Olga","Bob","Lena"]),{
        eligible:false,reason:"mainnet_settlement_not_enabled"
    });
    const first=await wired.historicalIncoming.runPass();
    const second=await wired.pendingRefunds.runPass();
    assert.equal(first,undefined);
    assert.equal(second.status,"NO_SUBMITTED_REFUNDS");
    assert.equal(h.calls.length,0,"no chain polling when there are no closed rooms or submitted debts");
});
test("Mainnet app read-only wiring observes a closed room without ever sending a refund",async t=>{
    const h=setup(t);
    h.runtime.refundStore.recordClosedRoom({
        roomId:"expired-mainnet-room",roomNumber:12,
        closureReason:"setup_expired",closedAtMs:NOW-1000,
        networkName:"MAINNET",globalId:-239
    });
    const wired=createMainnetReadOnlyFinancialRecovery({
        runtime:h.runtime,client:h.client,independentVerifier:h.independent,
        nowProvider:()=>NOW
    });
    assert.deepEqual(await wired.historicalIncoming.runPass(),{
        roomId:"expired-mainnet-room",status:"NO_INTENTS"
    });
    assert.equal((await wired.pendingRefunds.runPass()).scanned,0);
    assert.equal(h.runtime.outgoingRefundProvider,null);
    assert.equal(h.runtime.refundStore.list().length,0);
    assert.equal(h.calls.length,0,"closed room without receipts must not trigger wallet scanning");
});
test("Mainnet read-only startup fails closed for Testnet runtime or Toncenter endpoint",t=>{
    const testnet=setup(t,"testnet");
    assert.throws(()=>createMainnetReadOnlyFinancialRecovery({
        runtime:testnet.runtime,client:testnet.client,
        independentVerifier:testnet.independent
    }),/MAINNET_READ_ONLY_RUNTIME_REQUIRED/);
    const mainnet=setup(t);
    assert.throws(()=>createMainnetReadOnlyFinancialRecovery({
        runtime:mainnet.runtime,client:testnet.client,
        independentVerifier:mainnet.independent
    }),/Mainnet outgoing observer requires matching Toncenter endpoint/);
    assert.throws(()=>createMainnetReadOnlyFinancialRecovery({
        runtime:mainnet.runtime,client:mainnet.client,
        independentVerifier:testnet.independent
    }),/MAINNET_READ_ONLY_INDEPENDENT_VERIFIER_REQUIRED/);
    assert.equal(mainnet.calls.length,0);
    assert.equal(testnet.calls.length,0);
});
test("Mainnet read-only recovery does not activate an already-authorized outgoing financial runtime",t=>{
    const h=setup(t);
    const wrapper=Object.create(h.runtime);
    Object.defineProperty(wrapper,"outgoingRefundProvider",{value:{canExecute:()=>true}});
    assert.throws(()=>createMainnetReadOnlyFinancialRecovery({
        runtime:wrapper,client:h.client,independentVerifier:h.independent
    }),/MAINNET_READ_ONLY_RUNTIME_REQUIRED/);
    assert.equal(h.calls.length,0);
});
