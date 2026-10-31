import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
    buildPaymentRuntime,buildMainnetPaymentRuntime,assertTestnetNetworkIdentity
} from "../payment/runtime/PaymentRuntimeFactory.js";
import {RoomPaymentSessionAdapter} from "../payment/runtime/RoomPaymentSessionAdapter.js";

const NOW=1800000000000;
const wallet=n=>"0:"+n.toString(16).padStart(64,"0");
const roomId="mainnet-shared-runtime-room";

function fixture(callback) {
    const root=mkdtempSync(join(tmpdir(),"wheelwin-mainnet-shared-runtime-"));
    try {
        const dir=join(root,"fixture");
        mkdirSync(dir,{recursive:true});
        const catalogPath=join(dir,"synthetic-public-mainnet-wallets.json");
        writeFileSync(catalogPath,JSON.stringify(Array.from({length:64},(_,i)=>({
            roomNumber:i+1,network:"mainnet",address:wallet(i+1)
        }))));
        const result=callback({root,catalogPath});
        if (result && typeof result.then==="function") {
            return result.finally(()=>rmSync(root,{recursive:true,force:true}));
        }
        rmSync(root,{recursive:true,force:true});
        return result;
    } catch (error) {
        rmSync(root,{recursive:true,force:true});
        throw error;
    }
}
function descriptor(room=roomId) {
    return {
        roomId:room,roomCreatedAt:NOW-1000,network:"mainnet",asset:"TON",
        stakeLedgerRelation:"ONE_PLAYER_STAKE_AND_PRINCIPAL_PER_PAYMENT",
        requiredPlayers:["Olga","Bob","Lena"].map((playerId,index)=>({
            roomId:room,
            paymentReference:"WW-MAINNET-PLAYER-"+index,
            playerId,
            expectedSender:wallet(120+index),
            amountAtomic:1000000000
        }))
    };
}
function newRuntime({root,catalogPath,calls}) {
    return buildMainnetPaymentRuntime({
        dataDir:join(root,"payments"),
        walletCatalogPath:catalogPath,
        nowProvider:()=>NOW,
        apiKeyProvider:()=>"TEST-ONLY-NO-LIVE",
        fetchImpl:async(...args)=>{
            calls.push(args);
            throw new Error("Mainnet network must not be queried by preparation");
        }
    });
}

test("same Testnet runtime initializes explicit Mainnet 64-wallet preparation with no chain calls",()=>{
    fixture(({root,catalogPath})=>{
        const calls=[];
        const runtime=newRuntime({root,catalogPath,calls});
        assert.equal(runtime.network,"mainnet");
        assert.equal(runtime.globalId,-239);
        assert.equal(runtime.networkDataDir,join(root,"payments","mainnet"));
        assert.equal(runtime.outgoingRefundProvider,null);
        assert.equal(runtime.initialized,false);
        const recovery=runtime.initialize();
        assert.equal(runtime.initialized,true);
        assert.equal(recovery.refundRecovery.length,0);
        assert.equal(runtime.walletPool.listWallets().length,64);
        assert.equal(runtime.walletPool.getWalletByRoomNumber(1).network,"mainnet");
        const caps=runtime.getCapabilities();
        assert.equal(caps.network,"mainnet");
        assert.equal(caps.networkName,"MAINNET");
        assert.equal(caps.globalId,-239);
        assert.equal(caps.incomingFinalityVerificationEnabled,true);
        assert.equal(caps.settlementEnabled,false);
        assert.equal(caps.livePaymentAcceptanceEnabled,false);
        assert.equal(caps.outgoingRefundTransfersEnabled,false);
        assert.equal(caps.outgoingRefundDisabledReason,"MAINNET_OUTGOING_NOT_YET_ENABLED");
        assert.equal(caps.roomLifetimeMs,480000);
        assert.equal(runtime.observationService.hasBackgroundWork(),false);
        const setup=descriptor();
        const prepared=runtime.sessionAdapter.prepareRoom(setup);
        assert.equal(prepared.payments.length,3);
        assert.ok(prepared.payments.every(p=>p.network==="mainnet"
            && p.destinationWalletAddress===wallet(1)
            && p.state==="PENDING"));
        const snap=runtime.financialSnapshot(roomId);
        assert.equal(snap.network,"mainnet");
        assert.equal(snap.globalId,-239);
        assert.equal(snap.intents.length,3);
        assert.equal(snap.ledger.length,3);
        assert.equal(snap.receipts.length,0);
        assert.equal(snap.refunds.length,0);
        assert.ok(snap.ledger.every(row=>row.network==="mainnet"
            && row.kind==="PLAYER_STAKE"));
        const roster=setup.requiredPlayers.map(p=>p.playerId);
        assert.deepEqual(runtime.paymentGate.getGameStartGateStatus(roomId,roster),{
            eligible:false,reason:"mainnet_settlement_not_enabled"
        });
        assert.equal(calls.length,0);
        runtime.shutdown();
    });
});

test("Page4 preparation is replay-safe on Mainnet, but observing and Page5 stay blocked",async()=>{
    await fixture(async ({root,catalogPath})=>{
        const calls=[];
        const runtime=newRuntime({root,catalogPath,calls});
        runtime.initialize();
        const request=descriptor();
        runtime.sessionAdapter.prepareRoom(request);
        runtime.sessionAdapter.prepareRoom(request);
        assert.equal(runtime.financialSnapshot(roomId).ledger.length,3);
        assert.equal(runtime.financialSnapshot(roomId).intents.length,3);
        await assert.rejects(runtime.sessionAdapter.observeRoomPayments({roomId}),
            /mainnet settlement is not yet enabled/);
        assert.equal(calls.length,0);
        assert.equal(runtime.paymentGate.getGameStartGateStatus(roomId,
            request.requiredPlayers.map(p=>p.playerId)).eligible,false);
        runtime.shutdown();

        const restarted=newRuntime({root,catalogPath,calls});
        restarted.initialize();
        assert.equal(restarted.financialSnapshot(roomId).intents.length,3);
        assert.equal(restarted.financialSnapshot(roomId).ledger.length,3);
        restarted.sessionAdapter.prepareRoom(request);
        assert.equal(restarted.financialSnapshot(roomId).ledger.length,3);
        assert.equal(restarted.paymentGate.getGameStartGateStatus(roomId,
            request.requiredPlayers.map(p=>p.playerId)).eligible,false);
        assert.equal(calls.length,0);
        restarted.shutdown();
    });
});

test("Testnet public factory remains Testnet-only and previous error contract intact",()=>{
    assert.throws(()=>assertTestnetNetworkIdentity("mainnet"),/Testnet/);
    fixture(({root,catalogPath})=>{
        assert.throws(()=>buildPaymentRuntime({
            network:"mainnet",dataDir:join(root,"not-written"),walletCatalogPath:catalogPath
        }),/Testnet/);
        assert.equal(assertTestnetNetworkIdentity("testnet").globalId,-3);
    });
});

test("Mainnet entrypoint cannot accept a signer, injected finality or wrong network",()=>{
    assert.throws(()=>buildMainnetPaymentRuntime({network:"testnet"}),
        /MAINNET_RUNTIME_REQUIRES_EXPLICIT_MAINNET/);
    assert.throws(()=>buildMainnetPaymentRuntime({refundSubmitter:{}}),
        /MAINNET_RUNTIME_FINANCIAL_INJECTION_DISABLED/);
    assert.throws(()=>buildMainnetPaymentRuntime({refundSubmitterFactory:()=>({})}),
        /MAINNET_RUNTIME_FINANCIAL_INJECTION_DISABLED/);
    assert.throws(()=>buildMainnetPaymentRuntime({settlementEvidenceProvider:{}}),
        /MAINNET_RUNTIME_FINANCIAL_INJECTION_DISABLED/);
});

test("Mainnet descriptor cannot be used with Testnet payment data or unauthorized adapter",()=>{
    fixture(({root,catalogPath})=>{
        const calls=[];
        const runtime=newRuntime({root,catalogPath,calls});
        runtime.initialize();
        const wrong={...descriptor(),network:"testnet"};
        assert.throws(()=>runtime.sessionAdapter.prepareRoom(wrong),
            /descriptor asset\/network must match/);
        const direct=new RoomPaymentSessionAdapter({
            paymentService:runtime.paymentService,
            coordinator:runtime.coordinator,
            ledger:runtime.ledger,
            manifestStore:runtime.manifestStore,
            nowProvider:()=>NOW
        });
        assert.throws(()=>direct.prepareRoom(descriptor()),
            /mainnet room payments are not supported/);
        assert.equal(runtime.financialSnapshot(roomId).intents.length,0);
        assert.equal(calls.length,0);
        runtime.shutdown();
    });
});
