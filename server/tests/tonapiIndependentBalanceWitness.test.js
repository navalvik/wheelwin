import test from "node:test";
import assert from "node:assert/strict";
import {TonapiTestnetPayoutVerifier} from "../payment/refund/TonapiTestnetPayoutVerifier.js";

const SOURCE="0:"+"a".repeat(64);
for(const network of ["testnet","mainnet"]) {
    test(network+": exact raw TonAPI account balance is read-only and network-isolated",async()=>{
        const calls=[];
        const verifier=new TonapiTestnetPayoutVerifier({
            network,timeoutMs:1000,apiKeyProvider:()=>"",
            fetchImpl:async (url,options)=>{
                calls.push({url,options});
                return {status:200,async json(){return {
                    address:SOURCE,status:"active",balance:"140000000"
                };}};
            }
        });
        const result=await verifier.observeAccountBalance({address:SOURCE});
        assert.equal(result.status,"INDEPENDENT_ACCOUNT_BALANCE_OBSERVED");
        assert.equal(result.balanceAtomic,"140000000");
        assert.equal(result.network,network);
        assert.equal(result.provider,network==="mainnet"?"tonapi-mainnet":"tonapi-testnet");
        assert.ok(Number.isSafeInteger(result.observedAtMs));
        assert.equal(calls.length,1);
        assert.ok(calls[0].url.startsWith(network==="mainnet"
            ?"https://tonapi.io/":"https://testnet.tonapi.io/"));
        assert.ok(calls[0].url.includes("/v2/blockchain/accounts/"));
        assert.equal(calls[0].options.method,"GET");
    });
}
test("TonAPI refuses bad balance, mismatched account, rate limit and failed response",async()=>{
    const results=[
        {status:429,data:{status:"active",balance:"1"}},
        {status:503,data:{status:"active",balance:"1"}},
        {status:200,data:{status:"active",balance:"not-number"}},
        {status:200,data:{status:"active",balance:"-1"}},
        {status:200,data:{status:"active",balance:1.4}},
        {status:200,data:{status:"active",balance:"999999999999999999999999"}},
        {status:200,data:{status:"active",balance:"100",address:"0:"+"b".repeat(64)}},
        {status:200,data:{status:"active",balance:"100"}},
        {status:200,data:{balance:"100"}},
        {status:200,data:{status:"unknown",balance:"100"}}
    ];
    for(const record of results){
        const verifier=new TonapiTestnetPayoutVerifier({
            timeoutMs:1000,apiKeyProvider:()=>"",
            fetchImpl:async()=>({
                status:record.status,
                async json(){return record.data;}
            })
        });
        assert.equal(await verifier.observeAccountBalance({address:SOURCE}),null);
    }
});
