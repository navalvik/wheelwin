import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";

/**
 * Most offline suites import the Testnet-only payment constant with the env OFF.
 * Reproduce an actual Mainnet startup with ROOM_WALLET_PAYMENTS_ENABLED=true
 * in a fresh Node process so the module-level constant is genuinely ON.
 * No account, key, network or filesystem access is needed.
 */
function checkEnvironment(network){
    const script=`
        import {RoomLobbyBridge} from "./socket/RoomLobbyBridge.js";
        import {LIVE_PAYMENT_ACCEPTANCE_ENABLED} from "./payment/PaymentLifecycleAvailability.js";
        const probe=runtime=>{
            const bridge=Object.create(RoomLobbyBridge.prototype);
            if(runtime!==undefined)
                bridge._paymentApplicationBinding={runtime};
            return bridge._livePaymentAcceptanceEnabled();
        };
        const flags={
            global:LIVE_PAYMENT_ACCEPTANCE_ENABLED,
            missing:probe(undefined),
            held:probe({network:"mainnet",initialized:true,
                getCapabilities:()=>({livePaymentAcceptanceEnabled:false})}),
            ready:probe({network:"mainnet",initialized:true,
                getCapabilities:()=>({livePaymentAcceptanceEnabled:true})}),
            uninitialized:probe({network:"mainnet",initialized:false,
                getCapabilities:()=>({livePaymentAcceptanceEnabled:true})}),
            crashed:probe({network:"mainnet",initialized:true,
                getCapabilities:()=>{throw Error("RPC_UNAVAILABLE");}}),
            testnet:probe({network:"testnet",initialized:true,
                getCapabilities:()=>({livePaymentAcceptanceEnabled:false})})
        };
        process.stdout.write(JSON.stringify(flags));
    `;
    const proc=spawnSync(process.execPath,["--input-type=module","-e",script],{
        cwd:process.cwd(),
        env:{...process.env,TON_NETWORK:network,ROOM_WALLET_PAYMENTS_ENABLED:"true",
            MAINNET_NATIVE_RELEASE_ENABLED:"true"},
        encoding:"utf8",timeout:12000
    });
    assert.equal(proc.status,0,proc.stderr||proc.error?.message);
    return JSON.parse(proc.stdout);
}

test("Mainnet live opt-in cannot bypass failing runtime via global Testnet switch",()=>{
    const mainnet=checkEnvironment("mainnet");
    assert.equal(mainnet.global,false,
        "original release constant is strictly Testnet-only even with Mainnet opt-in");
    assert.deepEqual(mainnet,{
        global:false,missing:false,held:false,ready:true,
        uninitialized:false,crashed:false,testnet:false
    });
});

test("original Testnet live acceptance switch retains identical behavior",()=>{
    const testnet=checkEnvironment("testnet");
    assert.equal(testnet.global,true);
    assert.equal(testnet.testnet,true);
    assert.equal(testnet.missing,true);
    // Even if a Mainnet runtime was accidentally attached, do not trust the
    // Testnet opt-in over the explicit Mainnet runtime readiness.
    assert.equal(testnet.held,false);
    assert.equal(testnet.uninitialized,false);
    assert.equal(testnet.crashed,false);
});
