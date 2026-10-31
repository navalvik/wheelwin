import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {buildMainnetPaymentRuntime,buildPaymentRuntime,selectAppPaymentRuntimeBuilder}
    from "../payment/runtime/PaymentRuntimeFactory.js";
import {createMainnetNativeFinancialRelease}
    from "../payment/runtime/MainnetNativeFinancialRelease.js";
import {ToncenterTransactionsClient}
    from "../payment/toncenter/ToncenterTransactionsClient.js";
import {TestnetWinnerPayoutCoordinator}
    from "../payment/runtime/TestnetWinnerPayoutCoordinator.js";
import {bindPaymentRuntimeToApplication}
    from "../payment/runtime/PaymentApplicationBinder.js";
import {RoomLobbyBridge} from "../socket/RoomLobbyBridge.js";

const NOW=1800000000000,ROOM="mainnet-app-financial-bootstrap";
const wallet=n=>"0:"+n.toString(16).padStart(64,"0");
const PLAYERS=["Olga","Bob","Lena"];

function harness(t,{wrongService=false,wrongObserver=false}={}) {
    const root=mkdtempSync(join(tmpdir(),"ww-mainnet-app-wiring-"));
    t.after(()=>rmSync(root,{recursive:true,force:true}));
    const walletCatalogPath=join(root,"64-public-wallets.json");
    writeFileSync(walletCatalogPath,JSON.stringify(Array.from({length:64},(_,i)=>({
        roomNumber:i+1,network:"mainnet",address:wallet(i+1)
    }))));
    const requests={rpc:0,broadcast:0,walletResolver:0};
    const fetchImpl=async url=>{
        requests.rpc++;
        const path=new URL(url).pathname;
        return new Response(JSON.stringify(path.endsWith("masterchainInfo")
            ?{last:{global_id:-239,seqno:98765}}
            :{transactions:[],address_book:{}}),{status:200});
    };
    const nativeService={
        network:wrongService?"testnet":"mainnet",
        globalId:wrongService?-3:-239,
        async getSeqno(){return 19;},
        async getBalance(){return 0n;},
        async broadcastTransaction(){requests.broadcast++;
            throw Error("NO_REAL_MAINNET_TRANSFERS_ALLOWED_IN_TEST");}
    };
    const release=createMainnetNativeFinancialRelease({
        env:{TON_NETWORK:"mainnet",TON_API_KEY:"OFFLINE_NO_SECRET"},
        nowProvider:()=>NOW,
        walletResolverFactory:()=>{
            requests.walletResolver++;
            return async roomNumber=>({
                roomNumber,network:"mainnet",workchain:0,address:wallet(roomNumber)
            });
        },
        tonServiceFactory:()=>nativeService,
        clientFactory:()=>new ToncenterTransactionsClient({
            baseUrl:wrongObserver?"https://testnet.toncenter.com":"https://toncenter.com",
            fetchImpl,apiKeyProvider:()=>"OFFLINE_NO_SECRET"
        }),
        independentVerifierFactory:()=>({
            _network:"mainnet",async verifyTransfer(){return null;}
        })
    });
    const runtimeFactory=selectAppPaymentRuntimeBuilder({
        tonNetwork:"mainnet",roomWalletPaymentsEnabled:true,
        mainnetNativeReleaseEnabled:true
    });
    const runtime=runtimeFactory({
        dataDir:join(root,"financial"),walletCatalogPath,
        nowProvider:()=>NOW,fetchImpl,apiKeyProvider:()=>"OFFLINE_NO_SECRET",
        mainnetFinancialRelease:release
    });
    t.after(()=>runtime.shutdown());
    return {release,runtime,requests};
}

test("Mainnet app requires both native release and acceptance switches, Testnet factory unchanged",()=>{
    assert.throws(()=>selectAppPaymentRuntimeBuilder({
        tonNetwork:"mainnet",roomWalletPaymentsEnabled:true
    }),/MAINNET_LIVE_PAYMENT_ACCEPTANCE_NOT_ENABLED/);
    assert.throws(()=>selectAppPaymentRuntimeBuilder({
        tonNetwork:"mainnet",mainnetNativeReleaseEnabled:true
    }),/MAINNET_RELEASE_REQUIRES_PAYMENT_OPT_IN/);
    assert.equal(selectAppPaymentRuntimeBuilder({
        tonNetwork:"mainnet",roomWalletPaymentsEnabled:true,
        mainnetNativeReleaseEnabled:true
    }),buildMainnetPaymentRuntime);
    assert.equal(selectAppPaymentRuntimeBuilder({
        tonNetwork:"testnet",roomWalletPaymentsEnabled:true,
        mainnetNativeReleaseEnabled:true
    }),buildPaymentRuntime);
    assert.equal(selectAppPaymentRuntimeBuilder({}),buildPaymentRuntime);
});

test("Mainnet app uses one original wallet adapter for refunds and winner/owner payout",t=>{
    const h=harness(t);
    assert.equal(h.runtime.initialized,false);
    assert.equal(h.runtime.getCapabilities().livePaymentAcceptanceEnabled,false);
    h.runtime.initialize();
    const services=h.release.resolveDependencies(h.runtime);
    assert.equal(h.release.resolveDependencies(h.runtime),services);
    assert.equal(h.runtime.getCapabilities().livePaymentAcceptanceEnabled,true);
    assert.equal(h.runtime.getCapabilities().settlementEnabled,true);
    assert.equal(h.runtime.getCapabilities().outgoingRefundTransfersEnabled,true);
    assert.equal(h.runtime.network,"mainnet");
    assert.equal(h.runtime.globalId,-239);
    assert.equal(services.roomWalletAdapter,services.payoutTransport._adapter);
    assert.equal(services.roomWalletAdapter._tonService,services.tonService);
    assert.equal(services.roomWalletAdapter._sequenceStateDir,
        join(h.runtime.networkDataDir,"outbound-sequences"));
    assert.equal(h.runtime.outgoingRefundProvider._observation,services.outgoingObserver);
    assert.equal(services.outgoingObserver._chain.globalId,-239);
    assert.equal(services.pendingRefundRecovery._refunds,h.runtime.refundStore);
    assert.equal(services.pendingPayoutRecovery._store,h.runtime.ledgerStore);
    assert.equal(services.pendingPayoutRecovery._transport,services.payoutTransport);
    assert.equal(services.historicalIncoming._chain.globalId,-239);
    const binding=bindPaymentRuntimeToApplication(h.runtime,{
        paymentAcceptanceEnabled:false,
        roomManager:{getRoom:()=>({createdAt:NOW-1000,players:PLAYERS})}
    });
    const bridge=Object.create(RoomLobbyBridge.prototype);
    bridge._paymentApplicationBinding=binding;
    assert.equal(bridge._livePaymentAcceptanceEnabled(),true);
    const payout=new TestnetWinnerPayoutCoordinator({
        paymentRuntime:h.runtime,roomManager:{getRoom:()=>({players:PLAYERS})},
        playerManager:{getIdentity:id=>({wallet:wallet(100+PLAYERS.indexOf(id))})},
        contextResolver:{resolveRoomByGameId:()=>ROOM},
        winnerEngine:{getResult:()=>({winnerPlayerId:"Olga"})},
        ownerWalletProvider:()=>wallet(250),
        payoutSubmitter:services.payoutTransport,
        mainnetPayoutEnabled:true
    });
    assert.ok(payout);
    assert.equal(h.requests.broadcast,0);
    assert.equal(h.requests.rpc,0);
    assert.equal(h.requests.walletResolver,1);
    // Lost independent finality must immediately revoke both intake and Page5.
    services.payoutTransport._independentVerifier=null;
    assert.equal(h.runtime.getCapabilities().livePaymentAcceptanceEnabled,false);
    assert.equal(bridge._livePaymentAcceptanceEnabled(),false);
    assert.deepEqual(h.runtime.paymentGate.getGameStartGateStatus(ROOM,PLAYERS),{
        eligible:false,reason:"mainnet_settlement_not_enabled"
    });
    assert.equal(h.requests.broadcast,0);
});

test("Mainnet wallet network mismatch cannot construct a financial runtime",t=>{
    assert.throws(()=>harness(t,{wrongService:true}),/MAINNET_RELEASE_NATIVE_RPC_UNAVAILABLE/);
});

test("Mainnet Testnet endpoint mismatch rejects refund/payout bootstrap before acceptance",t=>{
    assert.throws(()=>harness(t,{wrongObserver:true}),
        /Mainnet outgoing observer requires matching Toncenter endpoint/);
});

test("Mainnet preparation-only startup continues to have no keys, no transfers or settlement",t=>{
    const h=harness(t);
    // The ordinary preparation runtime must never instantiate the release
    // assembly. It is built without the server-owned bundle.
    const r=buildMainnetPaymentRuntime({
        dataDir:h.runtime.dataDir,
        walletCatalogPath:join(h.runtime.dataDir,"..","64-public-wallets.json")
    });
    void r;
    assert.equal(h.requests.broadcast,0);
    assert.equal(h.requests.walletResolver,1);
});
