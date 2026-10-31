import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";
import {assessMainnetFinancialReleaseReadiness} from "../payment/runtime/MainnetFinancialReleaseReadiness.js";
import {buildMainnetPaymentRuntime} from "../payment/runtime/PaymentRuntimeFactory.js";
import {RoomPaymentSessionAdapter} from "../payment/runtime/RoomPaymentSessionAdapter.js";

const NOW=1800000000000,ROOM="mainnet-gate-release-readiness";
const wallet=n=>"0:"+n.toString(16).padStart(64,"0");
const PLAYERS=["Olga","Bob","Lena"];
function withRuntime(t) {
    const root=mkdtempSync(join(tmpdir(),"ww-mainnet-financial-gate-"));
    t.after(()=>rmSync(root,{recursive:true,force:true}));
    const walletCatalogPath=join(root,"mainnet-public-catalog.json");
    writeFileSync(walletCatalogPath,JSON.stringify(Array.from({length:64},(_,i)=>({
        roomNumber:i+1,address:wallet(i+1),network:"mainnet"
    }))));
    let now=NOW,transactions=[];
    const fetchImpl=async url=>{
        assert.equal(new URL(url).origin,"https://toncenter.com");
        const path=new URL(url).pathname;
        const payload=path.endsWith("masterchainInfo")
            ?{last:{global_id:-239,seqno:20000}}
            :{transactions,address_book:{}};
        return new Response(JSON.stringify(payload),{status:200});
    };
    const runtime=buildMainnetPaymentRuntime({
        dataDir:join(root,"payments"),walletCatalogPath,
        nowProvider:()=>now,fetchImpl,
        apiKeyProvider:()=>"TEST-ONLY"
    });
    runtime.initialize();
    t.after(()=>runtime.shutdown());
    const descriptor={
        roomId:ROOM,roomCreatedAt:NOW-20000,
        network:"mainnet",asset:"TON",
        stakeLedgerRelation:"ONE_PLAYER_STAKE_AND_PRINCIPAL_PER_PAYMENT",
        requiredPlayers:PLAYERS.map((playerId,i)=>({
            roomId:ROOM,playerId,paymentReference:"WW-MAIN-GATE-"+i,
            expectedSender:wallet(120+i),amountAtomic:1000000000
        }))
    };
    function pay(count){
        now=NOW+10000;
        const reserved=runtime.walletPool.getReservationForRoom(ROOM);
        transactions=descriptor.requiredPlayers.slice(0,count).map((p,i)=>({
            hash:createHash("sha256").update(p.paymentReference).digest("hex"),
            account:reserved.address,now:NOW/1000+10,emulated:false,
            block_ref:{workchain:0,shard:"8000000000000000",seqno:200+i},
            mc_block_seqno:9000+i,
            description:{aborted:false,compute_ph:{success:true},action:{success:true}},
            in_msg:{source:p.expectedSender,destination:reserved.address,
                value:"1000000000",bounced:false,
                message_content:{decoded:{type:"text_comment",
                    comment:"WW1:"+p.paymentReference}}
            }
        }));
    }
    return {runtime,descriptor,pay};
}
function completeInspection(runtime){
    const adapter={
        _sequenceStateDir:join(runtime.networkDataDir,"outbound-sequences"),
        supportsDurableTransferRetry:()=>true
    };
    const nativeTon={network:"mainnet",globalId:-239};
    const observer={
        _chain:{network:"mainnet",globalId:-239},
        findOutgoingTransfer:async()=>null,
        verifyIndexedRecipientCredit:async()=>null
    };
    const independent={_network:"mainnet",verifyTransfer:async()=>null};
    const refund={
        networkName:"MAINNET",globalId:-239,_observation:observer,
        canExecute:()=>true,canPrepareRefundTransfer:()=>true
    };
    const releaseRuntime={
        ...runtime,
        outgoingRefundProvider:refund,
        refundLifecycle:{
            _networkName:"MAINNET",_globalId:-239,
            _outgoingProvider:refund,_mainnetOutgoingEnabled:true
        }
    };
    const payout={
        _network:"mainnet",_globalId:-239,
        _pool:runtime.walletPool,_ledger:runtime.ledger,_adapter:adapter,
        _outgoingObserver:observer,_independentVerifier:independent,
        submit:async()=>null,reconcileAndSettle:async()=>null
    };
    const pendingRefundRecovery={
        _identity:{network:"mainnet",globalId:-239},
        _refunds:runtime.refundStore,_chain:observer,_independent:independent
    };
    const pendingPayoutRecovery={
        _identity:{network:"mainnet",globalId:-239},
        _store:runtime.ledgerStore,_transport:payout
    };
    return {runtime:releaseRuntime,roomWalletAdapter:adapter,tonService:nativeTon,
        outgoingRefundProvider:refund,payoutTransport:payout,
        pendingRefundRecovery,pendingPayoutRecovery};
}

test("Mainnet preparation-only app always fails financial readiness (no submitter)",t=>{
    const {runtime}=withRuntime(t);
    assert.equal(assessMainnetFinancialReleaseReadiness({runtime}).ready,false);
    assert.equal(assessMainnetFinancialReleaseReadiness({runtime}).reason,
        "MAINNET_SHARED_DURABLE_SEQNO_UNAVAILABLE");
    assert.equal(runtime.getCapabilities().livePaymentAcceptanceEnabled,false);
    assert.equal(runtime.getCapabilities().settlementEnabled,false);
    assert.equal(runtime.outgoingRefundProvider,null);
});

test("full offline Mainnet readiness requires exact shared runtime, outbox and independent finality",t=>{
    const {runtime}=withRuntime(t);
    const all=completeInspection(runtime);
    assert.deepEqual(assessMainnetFinancialReleaseReadiness(all),{
        ready:true,reason:null
    });
    const scenarios=[
        [{runtime:{...all.runtime,network:"testnet"}},"MAINNET_RUNTIME_NOT_INITIALIZED"],
        [{runtime:{...all.runtime,initialized:false}},"MAINNET_RUNTIME_NOT_INITIALIZED"],
        [{runtime:{...all.runtime,ledger:{network:"testnet"}}},"MAINNET_LEDGER_OR_INCOMING_UNAVAILABLE"],
        [{roomWalletAdapter:{...all.roomWalletAdapter,
            _sequenceStateDir:join(runtime.networkDataDir,"other")}},
            "MAINNET_SHARED_DURABLE_SEQNO_UNAVAILABLE"],
        [{tonService:{network:"testnet",globalId:-3}},"MAINNET_NATIVE_RPC_IDENTITY_MISMATCH"],
        [{outgoingRefundProvider:null},"MAINNET_REFUND_EXECUTOR_UNAVAILABLE"],
        [{outgoingRefundProvider:{...all.outgoingRefundProvider,canPrepareRefundTransfer:()=>false}},
            "MAINNET_REFUND_EXECUTOR_UNAVAILABLE"],
        [{runtime:{...all.runtime,refundLifecycle:{
            ...all.runtime.refundLifecycle,_mainnetOutgoingEnabled:false
        }}},"MAINNET_REFUND_LIFECYCLE_NOT_AUTHORIZED"],
        [{payoutTransport:{...all.payoutTransport,_adapter:{}}},
            "MAINNET_PAYOUT_EXECUTOR_UNAVAILABLE"],
        [{payoutTransport:{...all.payoutTransport,_pool:{network:"mainnet"}}},
            "MAINNET_PAYOUT_EXECUTOR_UNAVAILABLE"],
        [{payoutTransport:{...all.payoutTransport,_independentVerifier:{_network:"testnet",
            verifyTransfer:async()=>null}}},"MAINNET_DUAL_FINALITY_UNAVAILABLE"],
        [{payoutTransport:{...all.payoutTransport,_outgoingObserver:{
            ...all.payoutTransport._outgoingObserver,
            _chain:{network:"testnet",globalId:-3}
        }}},"MAINNET_DUAL_FINALITY_UNAVAILABLE"],
        [{pendingRefundRecovery:null},"MAINNET_DURABLE_RECOVERY_UNAVAILABLE"],
        [{pendingPayoutRecovery:{...all.pendingPayoutRecovery,
            _identity:{network:"testnet",globalId:-3}}},"MAINNET_DURABLE_RECOVERY_UNAVAILABLE"]
    ];
    for(const [change,reason] of scenarios){
        const result=assessMainnetFinancialReleaseReadiness({...all,...change});
        assert.deepEqual(result,{ready:false,reason},JSON.stringify(change,(k,v)=>typeof v==="function"?"function":v));
    }
});

test("Mainnet Page5 and payment observation remain shut when readiness changes or throws",async t=>{
    const {runtime,descriptor,pay}=withRuntime(t);
    const configured=completeInspection(runtime);
    let active=false;
    const readiness=()=>active
        ?assessMainnetFinancialReleaseReadiness(configured)
        :{ready:false};
    const session=new RoomPaymentSessionAdapter({
        paymentService:runtime.paymentService,coordinator:runtime.coordinator,
        ledger:runtime.ledger,manifestStore:runtime.manifestStore,
        nowProvider:()=>NOW+10000,
        mainnetPreparationEnabled:true,
        mainnetFinancialReadinessProvider:readiness
    });
    session.prepareRoom(descriptor);
    const getStatus=()=>session.getGameStartGateStatus(ROOM,PLAYERS);
    assert.deepEqual(getStatus(),{
        eligible:false,reason:"mainnet_settlement_not_enabled"
    });
    pay(3);
    await assert.rejects(session.observeRoomPayments({roomId:ROOM}),
        /mainnet settlement is not yet enabled/);
    assert.deepEqual(runtime.paymentService.listPaymentIntentsForRoom(ROOM)
        .map(x=>x.state),["PENDING","PENDING","PENDING"]);
    active=true;
    assert.equal(getStatus().eligible,false,"even ready finance cannot bypass 3/3 payment gate");
    const report=await session.observeRoomPayments({roomId:ROOM});
    assert.equal(report.report.counts.settled,3);
    assert.equal(getStatus().eligible,true,"settled 3/3 and complete ready finance can authorize only an offline gate");
    active=false;
    assert.deepEqual(getStatus(),{
        eligible:false,reason:"mainnet_settlement_not_enabled"
    });
    await assert.rejects(session.observeRoomPayments({roomId:ROOM}),
        /mainnet settlement is not yet enabled/);
    const throwing=new RoomPaymentSessionAdapter({
        paymentService:runtime.paymentService,coordinator:runtime.coordinator,
        ledger:runtime.ledger,manifestStore:runtime.manifestStore,
        nowProvider:()=>NOW+10000,
        mainnetPreparationEnabled:true,
        mainnetFinancialReadinessProvider:()=>{throw Error("preflight crashed");}
    });
    throwing.prepareRoom(descriptor);
    assert.deepEqual(throwing.getGameStartGateStatus(ROOM,PLAYERS),{
        eligible:false,reason:"mainnet_settlement_not_enabled"
    });
});
