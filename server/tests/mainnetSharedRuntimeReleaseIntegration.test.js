import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";
import {buildMainnetPaymentRuntime} from "../payment/runtime/PaymentRuntimeFactory.js";
import {bindPaymentRuntimeToApplication} from "../payment/runtime/PaymentApplicationBinder.js";
import {RoomLobbyBridge} from "../socket/RoomLobbyBridge.js";
import {TestnetNativeRoomPayoutTransport} from "../payment/runtime/TestnetNativeRoomPayoutTransport.js";
import {TestnetPendingRefundReconciler} from "../payment/runtime/TestnetPendingRefundReconciler.js";
import {TestnetPendingPayoutReconciler} from "../payment/runtime/TestnetPendingPayoutReconciler.js";

const NOW=1800000000000,ROOM="mainnet-native-release-fixture";
const wallet=n=>"0:"+n.toString(16).padStart(64,"0");
const PLAYERS=["Olga","Bob","Lena"];

function fixture(t,{releaseEnabled=true,missingQuote=false}={}){
    const root=mkdtempSync(join(tmpdir(),"ww-mainnet-runtime-release-"));
    t.after(()=>rmSync(root,{recursive:true,force:true}));
    const walletCatalogPath=join(root,"wallets.json");
    writeFileSync(walletCatalogPath,JSON.stringify(Array.from({length:64},(_,i)=>({
        roomNumber:i+1,network:"mainnet",address:wallet(i+1)
    }))));
    let clock=NOW,transactions=[],signs=0,broadcasts=0,deps=null;
    const source=wallet(1);
    const observer={
        _chain:{network:"mainnet",globalId:-239},
        async findOutgoingTransfer(){return null;},
        async getOutgoingTransfer(){return null;},
        async verifyIndexedRecipientCredit(){return null;}
    };
    const independent={
        _network:"mainnet",
        async verifyTransfer(){return null;}
    };
    const release={
        createRefundSubmitter({network,globalId}){
            assert.equal(network,"mainnet");
            assert.equal(globalId,-239);
            return {
                signer:{
                    ...(missingQuote?{}:{async quoteRefund(){return {transferAmountAtomic:998000000,gasChargeAtomic:2000000};}}),
                    async signTransfer(){signs++;return {offline:true};}
                },
                broadcaster:{async broadcast(){broadcasts++;return {status:"UNKNOWN"};}},
                outgoingTransferProvider:observer,
                finalityEvidenceProvider:{async getSettlementEvidence(){return null;}}
            };
        },
        resolveDependencies(runtime){
            if(deps)return deps;
            const roomWalletAdapter={
                _sequenceStateDir:join(runtime.networkDataDir,"outbound-sequences"),
                supportsDurableTransferRetry:()=>true,
                async sendTransfer(){throw Error("NO_LIVE_BROADCAST_IN_OFFLINE_TEST");},
                async estimateOutboundTransferFee(){return {ok:true,totalNano:1000000n};}
            };
            const tonService={network:"mainnet",globalId:-239};
            const payoutTransport=new TestnetNativeRoomPayoutTransport({
                network:"mainnet",dataDir:runtime.networkDataDir,
                walletPool:runtime.walletPool,ledger:runtime.ledger,
                adapter:roomWalletAdapter,outgoingObserver:observer,
                independentVerifier:independent
            });
            const pendingRefundRecovery=new TestnetPendingRefundReconciler({
                network:"mainnet",refundStore:runtime.refundStore,
                intentStore:runtime.intentStore,toncenterObserver:observer,
                independentVerifier:independent
            });
            const pendingPayoutRecovery=new TestnetPendingPayoutReconciler({
                network:"mainnet",ledgerStore:runtime.ledgerStore,
                ledger:runtime.ledger,walletPool:runtime.walletPool,
                transport:payoutTransport
            });
            deps={roomWalletAdapter,tonService,payoutTransport,
                pendingRefundRecovery,pendingPayoutRecovery};
            return deps;
        }
    };
    const fetchImpl=async url=>{
        assert.equal(new URL(url).origin,"https://toncenter.com");
        return new Response(JSON.stringify(new URL(url).pathname.endsWith("masterchainInfo")
            ?{last:{global_id:-239,seqno:19000}}
            :{transactions,address_book:{}}),{status:200});
    };
    const options={
        dataDir:join(root,"finance"),walletCatalogPath,
        nowProvider:()=>clock,fetchImpl,apiKeyProvider:()=>"OFFLINE_FAKE",
        ...(releaseEnabled?{mainnetFinancialRelease:release}:{})
    };
    const runtime=buildMainnetPaymentRuntime(options);
    const requirements=PLAYERS.map((playerId,i)=>({
        roomId:ROOM,playerId,paymentReference:"WW-MAINNET-RELEASE-"+i,
        expectedSender:wallet(100+i),amountAtomic:1000000000
    }));
    function pay(count){
        clock=NOW+10000;
        const reservation=runtime.walletPool.getReservationForRoom(ROOM);
        transactions=requirements.slice(0,count).map((p,i)=>({
            hash:createHash("sha256").update(p.paymentReference).digest("hex"),
            account:reservation.address,now:NOW/1000+10,emulated:false,
            block_ref:{workchain:0,shard:"8000000000000000",seqno:100+i},
            mc_block_seqno:9001+i,
            description:{aborted:false,compute_ph:{success:true},action:{success:true}},
            in_msg:{source:p.expectedSender,destination:reservation.address,
                value:"1000000000",bounced:false,
                message_content:{decoded:{type:"text_comment",
                    comment:"WW1:"+p.paymentReference}}}
        }));
    }
    const descriptor={
        roomId:ROOM,roomCreatedAt:NOW-20000,network:"mainnet",asset:"TON",
        stakeLedgerRelation:"ONE_PLAYER_STAKE_AND_PRINCIPAL_PER_PAYMENT",
        requiredPlayers:requirements
    };
    t.after(()=>runtime.shutdown());
    return {runtime,descriptor,pay,
        get deps(){return deps;},get signs(){return signs;},
        get broadcasts(){return broadcasts;}};
}

test("default Mainnet runtime still has no signer, no session settlement and no Page5",t=>{
    const h=fixture(t,{releaseEnabled:false});
    h.runtime.initialize();
    h.runtime.sessionAdapter.prepareRoom(h.descriptor);
    assert.equal(h.runtime.outgoingRefundProvider,null);
    assert.equal(h.runtime.getCapabilities().settlementEnabled,false);
    assert.equal(h.runtime.getCapabilities().livePaymentAcceptanceEnabled,false);
    assert.deepEqual(h.runtime.paymentGate.getGameStartGateStatus(ROOM,PLAYERS),{
        eligible:false,reason:"mainnet_settlement_not_enabled"
    });
    assert.equal(h.signs,0);
    assert.equal(h.broadcasts,0);
});

test("Mainnet release requires complete refund capabilities and rejects bare signer injection",t=>{
    assert.throws(()=>buildMainnetPaymentRuntime({
        refundSubmitter:{}
    }),/MAINNET_RUNTIME_FINANCIAL_INJECTION_DISABLED/);
    assert.throws(()=>buildMainnetPaymentRuntime({
        mainnetFinancialRelease:{createRefundSubmitter:()=>({})}
    }),/MAINNET_RUNTIME_FINANCIAL_INJECTION_DISABLED/);
    assert.throws(()=>fixture(t,{releaseEnabled:true,missingQuote:true}),
        /MAINNET_RELEASE_REFUND_EXECUTOR_UNAVAILABLE/);
});

test("Mainnet release reuses 3/3 original session coordinator, ledger and ready-only game gate",async t=>{
    const h=fixture(t);
    assert.equal(h.runtime.getCapabilities().settlementEnabled,false);
    h.runtime.initialize();
    assert.equal(h.runtime.getCapabilities().settlementEnabled,true);
    assert.equal(h.runtime.getCapabilities().outgoingRefundTransfersEnabled,true);
    h.runtime.sessionAdapter.prepareRoom(h.descriptor);
    assert.equal(h.runtime.paymentGate.getGameStartGateStatus(ROOM,PLAYERS).eligible,false);
    h.pay(2);
    const partial=await h.runtime.sessionAdapter.observeRoomPayments({roomId:ROOM});
    assert.equal(partial.report.counts.settled,2);
    assert.equal(h.runtime.paymentGate.getGameStartGateStatus(ROOM,PLAYERS).eligible,false);
    h.pay(3);
    const settled=await h.runtime.sessionAdapter.observeRoomPayments({roomId:ROOM});
    assert.equal(settled.report.counts.settled,1);
    assert.equal(h.runtime.paymentGate.getGameStartGateStatus(ROOM,PLAYERS).eligible,true);
    assert.equal(h.runtime.ledger.getConfirmedPrincipalAtomic(ROOM),3000000000);
    assert.equal(h.signs,0);
    assert.equal(h.broadcasts,0);
    h.deps.payoutTransport._independentVerifier=null;
    assert.equal(h.runtime.getCapabilities().settlementEnabled,false);
    assert.deepEqual(h.runtime.paymentGate.getGameStartGateStatus(ROOM,PLAYERS),{
        eligible:false,reason:"mainnet_settlement_not_enabled"
    });
    await assert.rejects(h.runtime.sessionAdapter.observeRoomPayments({roomId:ROOM}),
        /mainnet settlement is not yet enabled/);
    assert.equal(h.signs,0);
    assert.equal(h.broadcasts,0);
});

test("real Page4 binder and RoomLobbyBridge share Mainnet runtime readiness; legacy Testnet switch untouched",t=>{
    const h=fixture(t);
    h.runtime.initialize();
    let gate=null,refundHook=null;
    const binding=bindPaymentRuntimeToApplication(h.runtime,{
        roomManager:{
            getRoom:id=>id===ROOM?{createdAt:NOW-20000,players:PLAYERS}:null,
            attachRefundLifecycle:hook=>{refundHook=hook;}
        },
        gameStartAuthorization:{configurePaymentGate:next=>{gate=next;}},
        paymentAcceptanceEnabled:false
    });
    assert.equal(refundHook,h.runtime.refundLifecycle);
    assert.equal(gate,h.runtime.paymentGate);
    const bridge=Object.create(RoomLobbyBridge.prototype);
    bridge._paymentApplicationBinding=binding;
    assert.equal(bridge._livePaymentAcceptanceEnabled(),true,
        "fully assembled runtime can drive the same Page4 socket path");
    const prepared=binding.prepareRoomPaymentSession(ROOM,h.descriptor.requiredPlayers);
    assert.equal(prepared.payments.length,3);
    assert.equal(gate.getGameStartGateStatus(ROOM,PLAYERS).eligible,false);
    assert.equal(h.signs,0);
    assert.equal(h.broadcasts,0);

    h.deps.payoutTransport._independentVerifier=null;
    assert.equal(bridge._livePaymentAcceptanceEnabled(),false,
        "Page4 must close instantly if independent verifier disappears");
    assert.throws(()=>binding.prepareRoomPaymentSession(ROOM,h.descriptor.requiredPlayers),
        /live room-wallet payment acceptance is disabled/);
    assert.equal(gate.getGameStartGateStatus(ROOM,PLAYERS).eligible,false);
    assert.equal(h.signs,0);
    assert.equal(h.broadcasts,0);
});

test("Mainnet preparation-only runtime cannot enable Page4 using binding or bridge",t=>{
    const h=fixture(t,{releaseEnabled:false});
    h.runtime.initialize();
    const binding=bindPaymentRuntimeToApplication(h.runtime,{
        roomManager:{getRoom:()=>({createdAt:NOW-20000,players:PLAYERS})},
        paymentAcceptanceEnabled:true
    });
    const bridge=Object.create(RoomLobbyBridge.prototype);
    bridge._paymentApplicationBinding=binding;
    assert.equal(bridge._livePaymentAcceptanceEnabled(),false);
    assert.throws(()=>binding.prepareRoomPaymentSession(ROOM,h.descriptor.requiredPlayers),
        /live room-wallet payment acceptance is disabled/);
    assert.equal(h.runtime.paymentService.listPaymentIntentsForRoom(ROOM).length,0);
    assert.equal(h.signs,0);
    assert.equal(h.broadcasts,0);
});
