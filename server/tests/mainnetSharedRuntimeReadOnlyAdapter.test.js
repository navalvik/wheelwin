import test from "node:test";
import assert from "node:assert/strict";
import { PaymentIntent } from "../payment/PaymentIntent.js";
import { ToncenterTransactionsClient } from "../payment/toncenter/ToncenterTransactionsClient.js";
import { MAINNET_TONCENTER_URL } from "../mainnet/MainnetReadOnlyPreflight.js";
import {
    assertTestnetNetworkIdentity, buildPaymentRuntime,
    buildReadOnlyMainnetPaymentAdapter
} from "../payment/runtime/PaymentRuntimeFactory.js";

const wallet = "0:" + "a".repeat(64);
const senders = ["b","c","d"].map(ch => "0:" + ch.repeat(64));
const names = ["Olga", "Bob", "Lena"];
const refs = ["REF_OLGA", "REF_BOB", "REF_LENA"];
const roomId = "runtime-parity-room-001";
const unixSec = Math.floor(Date.now()/1000);
const nowMs = unixSec*1000;
const env = Object.freeze({
    TON_NETWORK:"mainnet", ROOM_WALLET_PAYMENTS_ENABLED:"false"
});

function requirements() {
    return names.map((playerId,i) => new PaymentIntent({
        roomId, playerId, paymentReference:refs[i],
        network:"mainnet",asset:"TON",
        destinationWalletId:"7",destinationWalletAddress:wallet,
        expectedSender:senders[i], amountAtomic:1000000000,
        createdAt:nowMs-30000,expiresAt:nowMs+480000,
        roomDeadlineMs:nowMs+480000
    }));
}
function indexedTransaction(i) {
    return {
        hash:"mainnet-payment-"+i,
        account:wallet, now:unixSec,emulated:false,
        block_ref:{workchain:0,shard:"8000000000000000",seqno:5500+i},
        mc_block_seqno:9500+i,
        description:{aborted:false,compute_ph:{success:true},action:{success:true}},
        in_msg:{
            source:senders[i],destination:wallet,value:"1000000000",
            message_content:{decoded:{type:"text_comment",comment:"WW1:"+refs[i]}}
        }
    };
}
function makeClient({globalId=-239, rows=[0,1,2].map(indexedTransaction)}={}) {
    const calls=[];
    const client=new ToncenterTransactionsClient({
        baseUrl:MAINNET_TONCENTER_URL,
        apiKeyProvider:()=>"MOCK-RUNTIME-ADAPTER-ONLY",
        fetchImpl:async(url,request)=>{
            const u=new URL(url);
            calls.push({path:u.pathname,account:u.searchParams.get("account"),
                method:request.method});
            return new Response(JSON.stringify(
                u.pathname.endsWith("masterchainInfo")
                    ? {last:{global_id:globalId,seqno:10500}}
                    : {transactions:rows,address_book:{}}
            ),{status:200});
        }
    });
    return {calls,client};
}
function makeAdapter(options={}) {
    const {client,calls}=makeClient(options);
    const adapter=buildReadOnlyMainnetPaymentAdapter({
        env,client,nowProvider:()=>nowMs,
        resolveActiveRoomWallet:()=>({
            roomNumber:7,address:wallet,reservedByRoomId:roomId
        })
    });
    return {adapter,calls};
}
const query=()=>{
    return {
        roomId,walletAddress:wallet,paymentIntents:requirements(),
        floorMs:nowMs-30000,ceilingMs:nowMs+5000,limit:10
    };
};

test("Mainnet adapter is opt-in only: existing Testnet runtime never accepts Mainnet",()=>{
    assert.deepEqual(assertTestnetNetworkIdentity("testnet"),
        {network:"testnet",globalId:-3});
    assert.throws(()=>assertTestnetNetworkIdentity("mainnet"),/Testnet/);
    assert.throws(()=>buildPaymentRuntime({network:"mainnet"}),/Testnet/);
    const {adapter,calls}=makeAdapter();
    assert.equal(calls.length,0);
    assert.equal(adapter.network,"mainnet");
    assert.equal(adapter.globalId,-239);
    assert.equal(adapter.roomLifetimeMs,480000);
    assert.equal(Object.isFrozen(adapter),true);
});

test("shared Mainnet observer reads three players once, but game and settlement remain DENIED",async()=>{
    const {adapter,calls}=makeAdapter();
    const report=await adapter.observeRoomPayments(query());
    assert.deepEqual(calls.map(c=>c.path),[
        "/api/v3/masterchainInfo","/api/v3/transactions"
    ]);
    assert.ok(calls.every(c=>c.method==="GET"));
    assert.equal(calls[1].account,wallet);
    assert.equal(report.observations.length,3);
    assert.equal(report.observations.filter(x=>x.status==="matched").length,3);
    assert.equal(report.paymentConfirmation,false);
    assert.equal(report.canConfirmPayments,false);
    assert.equal(report.settlementEvidenceAvailable,false);
    const gate=adapter.getGameStartGateStatus(roomId,names);
    assert.equal(gate.eligible,false);
    assert.match(gate.reason,/mainnet_proof_and_settlement_not_released/);
    assert.equal(Object.isFrozen(gate),true);
    const caps=adapter.getCapabilities();
    assert.equal(Object.isFrozen(caps),true);
    assert.equal(caps.network,"mainnet");
    assert.equal(caps.networkName,"MAINNET");
    assert.equal(caps.globalId,-239);
    for(const key of ["settlementEnabled","incomingFinalityVerificationEnabled",
        "outgoingRefundTransfersEnabled","outgoingPayoutTransfersEnabled",
        "livePaymentAcceptanceEnabled"]) assert.equal(caps[key],false,key);
    for(const name of ["initialize","shutdown","prepareRoom","submitRefund",
        "settlePayment","settlePayout","planPayout","refundLifecycle",
        "paymentService","walletPool","intentStore","ledger","signAndBroadcast"]) {
        assert.equal(adapter[name],undefined,name);
    }
});

test("Mainnet accounting preview calls the same Testnet payout calculator but never creates a transfer",()=>{
    const {adapter,calls}=makeAdapter();
    const result=adapter.previewPayoutAccounting({
        payoutId:"preview-only",roomId,network:"mainnet",asset:"TON",
        principalAtomic:3000000000,
        winner:{recipientId:names[0],address:senders[0]},
        owner:{recipientId:"owner",address:senders[1]},
        nowMs
    });
    assert.deepEqual(
        [result.winnerAtomic,result.ownerAtomic,result.gasReserveAtomic],
        [2850000000,147000000,3000000]
    );
    assert.equal(result.reconciles,true);
    assert.equal(result.status,"ACCOUNTING_PREVIEW_ONLY");
    assert.equal(result.settlementAuthorized,false);
    assert.equal(result.gameStartAuthorized,false);
    assert.equal(result.payoutAuthorized,false);
    assert.equal(result.refundAuthorized,false);
    assert.equal(adapter.getGameStartGateStatus().eligible,false);
    assert.equal(calls.length,0);
    assert.equal(adapter.submitPayout,undefined);
    assert.equal(adapter.submitRefund,undefined);
});

test("Mainnet read-only entry cannot accept injected signer, settlement evidence or alternate network",()=>{
    const {client}=makeClient();
    const base={
        env,client,resolveActiveRoomWallet:()=>({
            roomNumber:7,address:wallet,reservedByRoomId:roomId
        })
    };
    for(const forbidden of [
        {refundSubmitter:{signAndBroadcast:()=>{throw Error("unsafe");}}},
        {refundSubmitterFactory:()=>{throw Error("unsafe");}},
        {settlementEvidenceProvider:{}},
        {signer:{}},{paymentsEnabled:true},{network:"testnet"}
    ]) {
        assert.throws(()=>buildReadOnlyMainnetPaymentAdapter({
            ...base,...forbidden
        }),/MAINNET_READ_ONLY_ADAPTER_OPTIONS_INVALID/);
    }
    assert.throws(()=>buildReadOnlyMainnetPaymentAdapter({
        ...base,env:{TON_NETWORK:"testnet",ROOM_WALLET_PAYMENTS_ENABLED:"false"}
    }),/MAINNET_INCOMING_NETWORK_MISMATCH/);
    assert.throws(()=>buildReadOnlyMainnetPaymentAdapter({
        ...base,env:{TON_NETWORK:"mainnet",ROOM_WALLET_PAYMENTS_ENABLED:"true"}
    }),/MAINNET_INCOMING_PAYMENTS_NOT_ALLOWED/);
    assert.throws(()=>buildReadOnlyMainnetPaymentAdapter({
        ...base,resolveActiveRoomWallet:null
    }),/MAINNET_INCOMING_ACTIVE_ROOM_RESOLVER_REQUIRED/);
});

test("wrong Mainnet identity or unreserved wallet blocks read before transactions",async()=>{
    const wrong=makeClient({globalId:-3});
    const adapter=buildReadOnlyMainnetPaymentAdapter({
        env,client:wrong.client,resolveActiveRoomWallet:()=>({
            roomNumber:7,address:wallet,reservedByRoomId:roomId
        })
    });
    await assert.rejects(adapter.observeRoomPayments(query()),
        /MAINNET_INCOMING_CHAIN_IDENTITY_INVALID/);
    assert.deepEqual(wrong.calls.map(x=>x.path),["/api/v3/masterchainInfo"]);

    const isolated=makeClient();
    const unreserved=buildReadOnlyMainnetPaymentAdapter({
        env,client:isolated.client,resolveActiveRoomWallet:()=>null
    });
    await assert.rejects(unreserved.observeRoomPayments(query()),
        /MAINNET_INCOMING_WALLET_NOT_ACTIVE/);
    assert.equal(isolated.calls.length,0);
});

test("payout previews for wrong network, zero principal and no recipients fail closed",()=>{
    const {adapter}=makeAdapter();
    const template={
        payoutId:"preview",roomId,network:"mainnet",asset:"TON",
        principalAtomic:3000000000,
        winner:{recipientId:"Olga",address:senders[0]},
        owner:{recipientId:"owner",address:senders[1]},
        nowMs
    };
    assert.throws(()=>adapter.previewPayoutAccounting({...template,network:"testnet"}),
        /MAINNET_READ_ONLY_PAYOUT_INPUT_INVALID/);
    assert.throws(()=>adapter.previewPayoutAccounting({...template,asset:"NOT_TON"}),
        /MAINNET_READ_ONLY_PAYOUT_INPUT_INVALID/);
    assert.throws(()=>adapter.previewPayoutAccounting({...template,principalAtomic:0}),
        /principalAtomic/);
    assert.throws(()=>adapter.previewPayoutAccounting({...template,owner:null}),
        /owner recipient is required/);
    assert.equal(adapter.getGameStartGateStatus().eligible,false);
});
