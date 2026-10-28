import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {buildPaymentRuntime} from "../../payment/runtime/PaymentRuntimeFactory.js";
import {LIVE_PAYMENT_ACCEPTANCE_ENABLED} from "../../payment/PaymentLifecycleAvailability.js";

function makeRuntime(t,options={}){
    const root=mkdtempSync(join(tmpdir(),"ww-refund-runtime-test-"));
    t.after(()=>rmSync(root,{recursive:true,force:true}));
    return buildPaymentRuntime({
        dataDir:join(root,"payment-data"),
        network:"testnet",
        walletCatalogPath:join(root,"not-loaded.json"),
        ...options
    });
}
test("current live acceptance stays disabled and default runtime never instantiates outgoing signer",t=>{
    assert.equal(LIVE_PAYMENT_ACCEPTANCE_ENABLED,false);
    const runtime=makeRuntime(t);
    assert.equal(runtime.outgoingRefundProvider,null);
});
test("future explicitly requested refund factory receives exact Testnet wallet pool, no key material",t=>{
    let calls=0;
    const runtime=makeRuntime(t,{refundSubmitterFactory:descriptor=>{
        calls++;
        assert.equal(descriptor.network,"testnet");
        assert.equal(descriptor.globalId,-3);
        assert.equal(typeof descriptor.walletPool.getReservationForRoom,"function");
        assert.ok(descriptor.networkDataDir.endsWith("testnet"));
        assert.equal(Object.isFrozen(descriptor),true);
        assert.equal(Object.hasOwn(descriptor,"secretKey"),false);
        return null;
    }});
    assert.equal(calls,1);
    assert.equal(runtime.outgoingRefundProvider,null);
});
test("ambiguous double-signing configuration is rejected before any outgoing execution",t=>{
    let factoryCalled=false;
    assert.throws(()=>makeRuntime(t,{
        refundSubmitter:{signer:{}},
        refundSubmitterFactory:()=>{factoryCalled=true;return null;}
    }),/REFUND_SIGNER_CONFIGURATION_CONFLICT/);
    assert.equal(factoryCalled,false);
});
test("invalid native factory is rejected, not silently treated as authorization",t=>{
    assert.throws(()=>makeRuntime(t,{refundSubmitterFactory:{}}),
        /refundSubmitterFactory must be a function/);
});
