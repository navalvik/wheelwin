import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaymentIntent } from "../payment/PaymentIntent.js";
import { IncomingReceiptStore } from "../payment/incoming/IncomingReceiptStore.js";
import { IncomingReceiptAccounting } from "../payment/incoming/IncomingReceiptAccounting.js";
import { RefundObligationStore } from "../payment/refund/RefundObligationStore.js";
import { ToncenterTransactionsClient } from "../payment/toncenter/ToncenterTransactionsClient.js";
import { ToncenterIncomingProvider } from "../payment/toncenter/ToncenterIncomingProvider.js";
import { mapToncenterTransactionsResponse } from "../payment/toncenter/ToncenterTransactionsMapper.js";
import { ToncenterIndexedFinalityEvidenceProvider } from "../payment/toncenter/ToncenterIndexedFinalityEvidenceProvider.js";
import { RoomPaymentObservationService } from "../payment/toncenter/RoomPaymentObservationService.js";
import { requireToncenterChainConfig } from "../payment/toncenter/ToncenterConstants.js";

const now = 1800000000000;
const roomId = "receipt-parity-room";
const account = "0:" + "a".repeat(64);
const payers = ["b","c","d"].map(char => "0:" + char.repeat(64));
const outsider = "0:" + "e".repeat(64);
const players = ["Olga","Bob","Lena"];
const refs = ["OLGA_RECEIPT","BOB_RECEIPT","LENA_RECEIPT"];

function intents(network) {
    return players.map((playerId, index) => new PaymentIntent({
        paymentReference:refs[index],roomId,playerId,network,asset:"TON",
        expectedSender:payers[index],destinationWalletId:"room-wallet-9",
        destinationWalletAddress:account,amountAtomic:1000000000,
        createdAt:now-20000,expiresAt:now+460000,roomDeadlineMs:now+460000
    }));
}

function transaction({hash,source,value,reference,seqno}) {
    return {
        hash,account,now:now/1000-5,emulated:false,
        block_ref:{workchain:0,shard:"8000000000000000",seqno},
        mc_block_seqno:9100+seqno,
        description:{aborted:false,compute_ph:{success:true},action:{success:true}},
        in_msg:{source,destination:account,value:String(value),bounced:false,
            message_content:{decoded:{type:"text_comment",comment:"WW1:"+reference}}}
    };
}

function observationService(network,rows) {
    const chain=requireToncenterChainConfig(network);
    const requests=[];
    const client=new ToncenterTransactionsClient({
        baseUrl:chain.baseUrl,apiKeyProvider:()=>"OFFLINE-SYNTHETIC-KEY",
        fetchImpl:async(url,init)=>{
            requests.push({path:new URL(url).pathname,method:init.method});
            const data=new URL(url).pathname.endsWith("masterchainInfo")
                ? {last:{global_id:chain.globalId,seqno:20000}}
                : {transactions:rows,address_book:{}};
            return new Response(JSON.stringify(data),{status:200});
        }
    });
    const provider=new ToncenterIncomingProvider({
        client,mapper:(data,window)=>mapToncenterTransactionsResponse(
            data,{...window,network})
    });
    const service=new RoomPaymentObservationService({
        provider,network,nowProvider:()=>now,
        settlementEvidenceProvider:new ToncenterIndexedFinalityEvidenceProvider({
            client,network,nowProvider:()=>now
        })
    });
    return {service,requests};
}

function rows() {
    return [
        ...players.map((_,i)=>transaction({
            hash:"native-"+i,source:payers[i],value:1000000000,
            reference:refs[i],seqno:200+i
        })),
        transaction({hash:"olga-second-transfer",source:payers[0],
            value:500000000,reference:refs[0],seqno:203}),
        transaction({hash:"unknown-sender",source:outsider,
            value:250000000,reference:refs[0],seqno:204})
    ];
}
async function withStores(network,run) {
    const root=mkdtempSync(join(tmpdir(),"wheelwin-native-receipts-"));
    try {
        const directory=join(root,network); // Same network directory as runtime
        const store=new IncomingReceiptStore({dataDir:directory,network});
        store.initialize();
        const refundStore=new RefundObligationStore({dataDir:join(directory,"refunds")});
        refundStore.initialize();
        const requirements=intents(network);
        const accounting=new IncomingReceiptAccounting({
            store,refundStore,network,nowProvider:()=>now,
            intentStore:{listForRoom:()=>requirements}
        });
        await run({root,directory,store,refundStore,requirements,accounting});
    } finally {rmSync(root,{recursive:true,force:true});}
}

for (const network of ["testnet","mainnet"]) {
    test(network+": same receipt accounting saves three payments, known excess and unknown sender",async()=>{
        await withStores(network,async({
            directory,store,refundStore,requirements,accounting
        })=>{
            const {service,requests}=observationService(network,rows());
            const observation=await service.checkRoomPayments({
                roomId,walletAddress:account,paymentIntents:requirements,
                floorMs:now-20000,ceilingMs:now+1000,
                destinationWalletId:"room-wallet-9"
            });
            assert.equal(observation.transfers.length,5);
            assert.equal(observation.observations.filter(x=>x.status==="matched").length,3);
            assert.equal(observation.settlementEvidenceAvailable,true);
            assert.ok(requests.every(x=>x.method==="GET"));
            assert.deepEqual(requests.map(x=>x.path).sort(),[
                "/api/v3/masterchainInfo","/api/v3/transactions"
            ]);
            accounting.capture({...observation});
            assert.equal(store.listForRoom(roomId).length,0,
                "a copied observation is not settlement evidence");
            accounting.capture(observation);
            accounting.capture(observation);
            assert.equal(store.listForRoom(roomId).length,5);
            assert.equal(accounting.prepareClosedRoom(roomId).length,0);
            const chain=requireToncenterChainConfig(network);
            refundStore.recordClosedRoom({
                roomId,roomNumber:9,closureReason:"setup_expired",closedAtMs:now,
                networkName:network.toUpperCase(),globalId:chain.globalId
            });
            assert.equal(accounting.prepareClosedRoom(roomId).length,4);
            assert.equal(accounting.prepareClosedRoom(roomId).length,4);
            assert.equal(refundStore.list().length,4);
            assert.deepEqual(refundStore.list().map(x=>x.amountAtomic).sort((a,b)=>a-b),
                [500000000,1000000000,1000000000,1000000000]);
            assert.ok(refundStore.list().every(x=>
                x.networkName===network.toUpperCase()&&x.globalId===chain.globalId
                && x.refundDestination!==outsider
            ));
            assert.ok(requirements.every(x=>x.state==="PENDING"),
                "capturing transfers must never mark principal settled");
            const restarted=new IncomingReceiptStore({dataDir:directory,network});
            restarted.initialize();
            assert.equal(restarted.listForRoom(roomId).length,5);
            assert.equal(restarted.get(restarted.listForRoom(roomId).find(x=>
                x.senderAddress===outsider).transactionId).playerId,null);
            const restartedAccounting=new IncomingReceiptAccounting({
                store:restarted,refundStore,network,nowProvider:()=>now,
                intentStore:{listForRoom:()=>requirements}
            });
            assert.equal(restartedAccounting.prepareClosedRoom(roomId).length,4);
            assert.equal(refundStore.list().length,4);
        });
    });
}

test("Testnet and Mainnet receipt stores refuse cross-network records",async()=>{
    await withStores("mainnet",async({store})=>{
        assert.throws(()=>new IncomingReceiptAccounting({
            store,refundStore:{},intentStore:{},network:"testnet"
        }),/RECEIPT_ACCOUNTING_NETWORK_MISMATCH/);
        assert.throws(()=>new IncomingReceiptStore({
            dataDir:"/tmp/unused",network:"unknown"
        }),/TONCENTER_NETWORK_REQUIRED/);
    });
});

test("Mainnet cannot prepare excess refunds against a Testnet closed-room record",async()=>{
    await withStores("mainnet",async({refundStore,accounting})=>{
        refundStore.recordClosedRoom({
            roomId,roomNumber:9,closureReason:"setup_expired",closedAtMs:now,
            networkName:"TESTNET",globalId:-3
        });
        assert.throws(()=>accounting.prepareClosedRoom(roomId),
            /RECEIPT_ACCOUNTING_CLOSED_ROOM_NETWORK_MISMATCH/);
    });
});
