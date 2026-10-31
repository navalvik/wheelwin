import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,existsSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {keyPairFromSeed} from "@ton/crypto";
import {WalletContractV4} from "@ton/ton";
import {RoomWalletAdapter} from "../payment/roomWallet/RoomWalletAdapter.js";
import {createTestnetNativeRefundCapabilities} from "../payment/roomWallet/TestnetNativeRefundCapabilities.js";
import {TestnetOutgoingRefundProvider} from "../payment/refund/TestnetOutgoingRefundProvider.js";
import {TestnetNativeRoomPayoutTransport} from "../payment/runtime/TestnetNativeRoomPayoutTransport.js";
import {RoomPayoutCalculator} from "../payment/ledger/RoomPayoutCalculator.js";

const WINNER="0:"+"a".repeat(64),OWNER="0:"+"b".repeat(64);
const PAYER="0:"+"c".repeat(64);
const PAYOUT_ID="payout_"+"e".repeat(32);
const REFUND_ID="rfd_"+"d".repeat(32);

function setup(t) {
    const root=mkdtempSync(join(tmpdir(),"wheelwin-shared-outbound-mainnet-"));
    t.after(()=>rmSync(root,{recursive:true,force:true}));
    const dataDir=join(root,"mainnet");
    const keys=keyPairFromSeed(Buffer.alloc(32,17));
    const address=WalletContractV4.create({workchain:0,publicKey:keys.publicKey}).address.toString();
    const state={
        activeRoom:"expired-room-A",seqno:7,now:1800000000000,
        broadcasted:[],ambiguousRefund:true
    };
    const walletPool={
        network:"mainnet",
        getReservationForRoom:roomId=>roomId===state.activeRoom?{
            roomNumber:1,network:"mainnet",address,reservedByRoomId:roomId
        }:null
    };
    const tonService={
        getSeqno:async()=>state.seqno,
        estimateExternalMessageFee:async()=>({totalFeeNano:1000000n}),
        broadcastTransaction:async boc=>{
            state.broadcasted.push(boc);
            if(state.ambiguousRefund)throw Error("SIMULATED_RPC_RESPONSE_LOST");
            state.seqno+=1;
            return {hash:"mock-chain-transaction-"+state.seqno};
        }
    };
    const makeAdapter=()=>new RoomWalletAdapter({
        walletResolver:async()=>({roomNumber:1,network:"mainnet",workchain:0,address,
            publicKey:keys.publicKey,secretKey:keys.secretKey}),
        tonService,sequenceStateDir:join(dataDir,"outbound-sequences"),
        now:()=>state.now,sleep:async ms=>{state.now+=ms;},
        seqnoConfirmTimeoutMs:10,seqnoConfirmPollMs:5
    });
    const observer={
        async findOutgoingTransfer({destinationIdentity,amountAtomic}){
            if(destinationIdentity===WINNER && state.broadcasted.length>=2)
                return {transactionId:"winner-outgoing",sourceAddress:address,
                    destinationAddress:WINNER,amountAtomic};
            if(destinationIdentity===OWNER && state.broadcasted.length>=3)
                return {transactionId:"owner-outgoing",sourceAddress:address,
                    destinationAddress:OWNER,amountAtomic};
            return null;
        },
        async observeRecipientCredit(){return null;},
        async verifyIndexedRecipientCredit({destinationIdentity,transactionId,amountAtomic}){
            const isWinner=destinationIdentity===WINNER;
            if((isWinner && state.broadcasted.length<2)
                ||(!isWinner && state.broadcasted.length<3))return null;
            return {
                status:"MASTERCHAIN_INDEXED_RECIPIENT_CREDIT_OBSERVED",
                sourceTransactionId:transactionId,
                recipientTransactionId:isWinner?"winner-incoming":"owner-incoming",
                messageHash:isWinner?"winner-message":"owner-message",
                destinationAddress:destinationIdentity,amountAtomic,
                globalId:-239,sourceFinality:"finalized",recipientFinality:"finalized",
                sourceMcBlockSeqno:21,recipientMcBlockSeqno:22,
                latestIndexedMcBlockSeqno:30
            };
        }
    };
    return {root,dataDir,state,address,walletPool,makeAdapter,observer};
}
function refundCapabilities(h,adapter) {
    return createTestnetNativeRefundCapabilities({
        network:"mainnet",walletPool:h.walletPool,
        roomWalletAdapter:adapter,dataDir:h.dataDir
    });
}
function payoutTransport(h,adapter) {
    return new TestnetNativeRoomPayoutTransport({
        network:"mainnet",walletPool:h.walletPool,
        adapter,dataDir:h.dataDir,outgoingObserver:h.observer
    });
}
function payoutPlan() {
    return RoomPayoutCalculator.computePlan({
        payoutId:PAYOUT_ID,roomId:"successful-room-B",
        asset:"TON",network:"mainnet",principalAtomic:3000000000,
        winner:{recipientId:"Olga",address:WINNER},
        owner:{recipientId:"WheelWin",address:OWNER},nowMs:1800000000000
    }).toJSON();
}
const payoutArgs={
    roomId:"successful-room-B",payoutId:PAYOUT_ID,
    winnerWallet:WINNER,ownerWallet:OWNER
};

test("one shared durable WalletV4 adapter blocks next session payout after ambiguous refund; restart resumes safely",async t=>{
    const h=setup(t);
    const adapter=h.makeAdapter();
    const caps=refundCapabilities(h,adapter);
    const quote=await caps.signer.quoteRefund({
        roomId:"expired-room-A",roomNumber:52,from:h.address,to:PAYER,
        amountAtomic:1000000000
    });
    assert.equal(quote.transferAmountAtomic+quote.gasChargeAtomic,1000000000);
    const descriptor=await caps.signer.signTransfer({
        roomId:"expired-room-A",roomNumber:52,from:h.address,to:PAYER,
        amountAtomic:quote.transferAmountAtomic,
        grossAmountAtomic:1000000000,gasChargeAtomic:quote.gasChargeAtomic,
        idempotencyKey:"MAINNET:expired-room-A:Olga",
        obligationId:REFUND_ID,denomination:"TON",networkName:"MAINNET",globalId:-239
    });
    assert.equal(descriptor.roomNumber,1,"game room #52 must resolve to wallet slot #1");
    const first=await caps.broadcaster.broadcast({
        sourceWalletAddress:h.address,signedTransfer:descriptor
    });
    assert.equal(first.status,"UNKNOWN");
    assert.equal(h.state.broadcasted.length,1);
    assert.ok(existsSync(join(h.dataDir,"mainnet-native-refund-broadcast-claims")));
    const restartedCaps=refundCapabilities(h,h.makeAdapter());
    const duplicate=await restartedCaps.broadcaster.broadcast({
        sourceWalletAddress:h.address,signedTransfer:descriptor
    });
    assert.equal(duplicate.reason,"REFUND_ALREADY_ATTEMPTED");
    assert.equal(h.state.broadcasted.length,1);

    // An erroneous wallet recycle cannot bypass the wallet-global durable seqno
    // hold, even though a DIFFERENT game and a DIFFERENT payout are requested.
    h.state.activeRoom="successful-room-B";
    const payout=payoutPlan();
    const payoutBeforeRestart=payoutTransport(h,adapter);
    const blocked=await payoutBeforeRestart.submit({
        ...payoutArgs,roomWalletAddress:h.address,plan:payout
    });
    assert.equal(blocked.status,"SUBMISSION_UNKNOWN");
    assert.equal(blocked.role,"WINNER");
    assert.equal(h.state.broadcasted.length,1);

    // After process restart the SAME network outbox persists. A verified chain
    // seqno advancement allows only the next distinct payout's signed message.
    h.state.ambiguousRefund=false;
    h.state.seqno=8;
    const newAdapter=h.makeAdapter();
    const restartedPayout=payoutTransport(h,newAdapter);
    assert.equal(restartedPayout._adapter,newAdapter);
    const reconciled=await restartedPayout.resumeUnattempted({
        ...payoutArgs,roomWalletAddress:h.address,plan:payout
    });
    assert.equal(reconciled.status,"BOTH_MASTERCHAIN_INDEXED_CREDITS_OBSERVED_UNFINALIZED");
    assert.equal(h.state.broadcasted.length,3);
    assert.notEqual(h.state.broadcasted[0],h.state.broadcasted[1]);
    assert.notEqual(h.state.broadcasted[1],h.state.broadcasted[2]);
    const repeated=await restartedPayout.submit({
        ...payoutArgs,roomWalletAddress:h.address,plan:payout
    });
    assert.equal(repeated.status,"ALREADY_ATTEMPTED_NEEDS_RECONCILIATION");
    assert.equal(h.state.broadcasted.length,3);
});

test("Mainnet refund signing requires Mainnet identity, cannot use Testnet wallet or a separate outbox",async t=>{
    const h=setup(t);
    const adapter=h.makeAdapter();
    const caps=refundCapabilities(h,adapter);
    await assert.rejects(caps.signer.signTransfer({
        networkName:"TESTNET",globalId:-3,denomination:"TON"
    }),/REFUND_NETWORK_INVALID/);
    assert.throws(()=>createTestnetNativeRefundCapabilities({
        network:"mainnet",walletPool:h.walletPool,dataDir:h.dataDir,
        roomWalletAdapter:{...adapter,_sequenceStateDir:join(h.dataDir,"different-outbox")}
    }),/REFUND_MAINNET_SHARED_DURABLE_SEQNO_REQUIRED/);
    const original=h.walletPool.network;
    h.walletPool.network="testnet";
    assert.throws(()=>refundCapabilities(h,adapter),/REFUND_MAINNET_WALLET_POOL_REQUIRED/);
    h.walletPool.network=original;
    assert.equal(h.state.broadcasted.length,0);
});

test("Mainnet refund and payout can use exactly one adapter instance and same outbox",t=>{
    const h=setup(t);
    const adapter=h.makeAdapter();
    const caps=refundCapabilities(h,adapter);
    const payout=payoutTransport(h,adapter);
    assert.equal(payout._adapter,adapter);
    assert.equal(caps.signer!==null,true);
    assert.equal(caps.broadcaster!==null,true);
    assert.equal(adapter.supportsDurableTransferRetry(),true);
    assert.equal(adapter._sequenceStateDir,join(h.dataDir,"outbound-sequences"));
    assert.equal(h.state.broadcasted.length,0);
});
