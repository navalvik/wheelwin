import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {IncomingReceiptStore} from "../payment/incoming/IncomingReceiptStore.js";
import {IncomingReceiptAccounting} from "../payment/incoming/IncomingReceiptAccounting.js";
import {RefundObligationStore} from "../payment/refund/RefundObligationStore.js";
import {HistoricalIncomingReceiptReconciler} from "../payment/runtime/HistoricalIncomingReceiptReconciler.js";
import {requireToncenterChainConfig} from "../payment/toncenter/ToncenterConstants.js";

const address=n=>"0:"+n.toString(16).padStart(64,"0");
const room="expired-room-A",otherRoom="next-room-B";
const sourceWallet=address(4),payer=address(101),nextPayer=address(102),unknown=address(103);
const incomingAt=1550000,now=2000000;
function setup(t,network,{creditNetwork=network,independentNetwork=network}={}) {
    const dir=mkdtempSync(join(tmpdir(),"ww-historical-mainnet-parity-"));
    t.after(()=>rmSync(dir,{recursive:true,force:true}));
    const chain=requireToncenterChainConfig(network);
    const intents=[
        {roomId:room,playerId:"Olga",network,asset:"TON",
            paymentReference:"refund_olga_room_a",destinationWalletId:"room-wallet-4",
            destinationWalletAddress:sourceWallet,expectedSender:payer,
            amountAtomic:1000000000,createdAt:1000000,expiresAt:1480000,state:"EXPIRED"},
        {roomId:otherRoom,playerId:"Bob",network,asset:"TON",
            paymentReference:"paid_bob_room_b",destinationWalletId:"room-wallet-4",
            destinationWalletAddress:sourceWallet,expectedSender:nextPayer,
            amountAtomic:1000000000,createdAt:1600000,expiresAt:2080000,state:"EXPIRED"}
    ];
    const records=[
        {network,accountId:sourceWallet,transactionId:"late-a",transactionTime:incomingAt,
            sourceAddress:payer,destinationAddress:sourceWallet,amountAtomic:"1000000000",
            asset:"TON",comment:"refund_olga_room_a"},
        {network,accountId:sourceWallet,transactionId:"payment-b",transactionTime:1700000,
            sourceAddress:nextPayer,destinationAddress:sourceWallet,amountAtomic:"1000000000",
            asset:"TON",comment:"paid_bob_room_b"},
        {network,accountId:sourceWallet,transactionId:"unknown",transactionTime:1750000,
            sourceAddress:unknown,destinationAddress:sourceWallet,amountAtomic:"1000000000",
            asset:"TON",comment:null}
    ];
    const intentStore={
        listForRoom:id=>intents.filter(i=>i.roomId===id),
        list:()=>intents
    };
    const receiptStore=new IncomingReceiptStore({dataDir:dir,network});
    receiptStore.initialize();
    const refundStore=new RefundObligationStore({dataDir:join(dir,"refunds")});
    refundStore.initialize();
    refundStore.recordClosedRoom({roomId:room,roomNumber:4,
        closureReason:"setup_expired",closedAtMs:1480000,
        networkName:network.toUpperCase(),globalId:chain.globalId});
    const receiptAccounting=new IncomingReceiptAccounting({
        store:receiptStore,intentStore,refundStore,network,nowProvider:()=>now
    });
    const fromSource=new Map(records.map(row=>[row.sourceAddress,"outgoing-"+row.transactionId]));
    const toRecipient=new Map(records.map(row=>["outgoing-"+row.transactionId,row.transactionId]));
    const worker=new HistoricalIncomingReceiptReconciler({
        network,runtime:{
            network,intentStore,receiptStore,refundStore,receiptAccounting,
            walletPool:{resolveReservationOwnerAt:({transactionTime})=>{
                if(transactionTime<1600000)
                    return {status:"UNKNOWN",roomId:null,candidates:[]};
                if(transactionTime<1750000)
                    return {status:"OWNED",roomId:otherRoom,candidates:[otherRoom]};
                return {status:"AMBIGUOUS",roomId:null,candidates:[room,otherRoom]};
            }}
        },
        incomingProvider:{
            baseUrl:chain.baseUrl,
            async listIncomingTransactions(){return {
                resultWindowComplete:true,rowsReturned:records.length,records
            };}
        },
        chainObserver:{
            _chain:requireToncenterChainConfig(creditNetwork),
            async findOutgoingTransfer(query){
                return {transactionId:fromSource.get(query.sourceWalletAddress)};
            },
            async verifyIndexedRecipientCredit(query){
                return {status:"MASTERCHAIN_INDEXED_RECIPIENT_CREDIT_OBSERVED",
                    globalId:requireToncenterChainConfig(creditNetwork).globalId,
                    sourceFinality:"finalized",recipientFinality:"finalized",
                    sourceTransactionId:query.transactionId,
                    recipientTransactionId:toRecipient.get(query.transactionId),
                    amountAtomic:query.amountAtomic,
                    messageHash:"hash-"+query.transactionId};
            }
        },
        independentVerifier:{
            _network:independentNetwork,
            async verifyTransfer(query){
                return {...query,status:"INDEPENDENT_INDEXED_CREDIT_OBSERVED",
                    provider:"tonapi-"+independentNetwork};
            }
        },
        nowProvider:()=>now
    });
    return {worker,receiptStore,refundStore,dir};
}

for(const network of ["testnet","mainnet"]){
    test(network+" historical late payment: reclaim only the first room payer, never Bob in the next room",async t=>{
        const h=setup(t,network);
        const report=await h.worker.recoverRoom(room);
        assert.equal(report.status,"HISTORICAL_RECEIPTS_CHECKED");
        assert.equal(report.captured,1);
        assert.deepEqual(h.receiptStore.listForRoom(room).map(r=>r.providerTransactionId),["late-a"]);
        assert.equal(h.receiptStore.listUnresolved().length,1);
        assert.equal(h.refundStore.list().length,1,
            "only uniquely attributable expired-room money becomes a refund");
        assert.equal(h.refundStore.list()[0].networkName,network.toUpperCase());
        assert.equal(h.refundStore.list()[0].globalId,
            requireToncenterChainConfig(network).globalId);
        await h.worker.recoverRoom(room);
        assert.equal(h.refundStore.list().length,1,"replay never adds a second refund");
        const restarted=new IncomingReceiptStore({dataDir:h.dir,network});
        restarted.initialize();
        assert.deepEqual(restarted.listForRoom(room).map(r=>r.providerTransactionId),["late-a"]);
    });
}

test("Mainnet historical recovery refuses Testnet Toncenter and independent TonAPI providers",t=>{
    const h=setup(t,"mainnet");
    assert.throws(()=>new HistoricalIncomingReceiptReconciler({
        runtime:{network:"mainnet"},
        network:"testnet",incomingProvider:{},chainObserver:{},independentVerifier:{}
    }),/HISTORICAL_INCOMING_RUNTIME_NETWORK_MISMATCH/);
    for(const options of [
        {incomingProvider:{baseUrl:"https://testnet.toncenter.com"},
            chainObserver:h.worker.chainObserver,independentVerifier:h.worker.independentVerifier},
        {incomingProvider:h.worker.incomingProvider,
            chainObserver:{...h.worker.chainObserver,_chain:requireToncenterChainConfig("testnet")},
            independentVerifier:h.worker.independentVerifier},
        {incomingProvider:h.worker.incomingProvider,
            chainObserver:h.worker.chainObserver,
            independentVerifier:{...h.worker.independentVerifier,_network:"testnet"}}
    ]) {
        assert.throws(()=>new HistoricalIncomingReceiptReconciler({
            runtime:h.worker.runtime,network:"mainnet",...options
        }),/HISTORICAL_INCOMING_MAINNET_PROVIDERS_MISMATCH/);
    }
});

test("Mainnet historical recovery does not accept a Testnet masterchain watermark",async t=>{
    const h=setup(t,"mainnet");
    h.worker.chainObserver.verifyIndexedRecipientCredit=async query=>({
        status:"MASTERCHAIN_INDEXED_RECIPIENT_CREDIT_OBSERVED",
        globalId:-3,sourceFinality:"finalized",recipientFinality:"finalized",
        sourceTransactionId:query.transactionId,recipientTransactionId:"late-a",
        amountAtomic:query.amountAtomic,messageHash:"wrong-chain"
    });
    const result=await h.worker.recoverRoom(room);
    assert.equal(result.captured,0);
    assert.equal(h.receiptStore.listForRoom(room).length,0);
    assert.equal(h.refundStore.list().length,0);
});

test("Mainnet historical recovery refuses wrong independent provider for one late receipt",async t=>{
    const h=setup(t,"mainnet");
    h.worker.independentVerifier.verifyTransfer=async query=>({
        ...query,status:"INDEPENDENT_INDEXED_CREDIT_OBSERVED",provider:"tonapi-testnet"
    });
    const result=await h.worker.recoverRoom(room);
    assert.equal(result.captured,0);
    assert.equal(h.refundStore.list().length,0);
});
