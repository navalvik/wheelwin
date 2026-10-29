import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {RoomPayoutCalculator} from "../../payment/ledger/RoomPayoutCalculator.js";
import {PayoutPlan} from "../../payment/ledger/PayoutPlan.js";
import {TestnetNativeRoomPayoutTransport} from "../../payment/runtime/TestnetNativeRoomPayoutTransport.js";

const ROOM="0:"+"a".repeat(64), WINNER="0:"+"b".repeat(64), OWNER="0:"+"c".repeat(64);
const payoutId="payout_"+"d".repeat(32), roomId="priority-room";
function newPlan() {
    return RoomPayoutCalculator.computePlan({
        payoutId,roomId,asset:"TON",network:"testnet",
        principalAtomic:3_000_000_000,
        winner:{recipientId:"Bob",address:WINNER},
        owner:{recipientId:"WheelWin",address:OWNER},
        networkFees:{winner:{feeAtomic:1_100_000},owner:{feeAtomic:1_100_000}},
        nowMs:1_800_000_000_000
    }).toJSON();
}

test("95/5 gross splits and both recipients pay frozen gas out of their shares", () => {
    const plan=newPlan();
    const win=plan.transfers.find(t=>t.recipientRole==="WINNER");
    const owner=plan.transfers.find(t=>t.recipientRole==="OWNER");
    assert.equal(win.grossAtomic,2_850_000_000);
    assert.equal(owner.grossAtomic,150_000_000);
    assert.equal(win.netAtomic,2_848_900_000);
    assert.equal(owner.netAtomic,148_900_000);
    assert.equal(plan.gasReserveAtomic,0);
    assert.equal(win.reservedFeeAtomic+owner.reservedFeeAtomic,2_200_000);
    assert.equal(PayoutPlan.fromJSON(plan).reconcile(),true);
});

test("new payouts refuse a missing gas estimate instead of silently charging the room", () => {
    assert.throws(()=>RoomPayoutCalculator.computePlan({
        payoutId,roomId,asset:"TON",network:"testnet",principalAtomic:3_000_000_000,
        winner:{recipientId:"Bob",address:WINNER},
        owner:{recipientId:"WheelWin",address:OWNER},nowMs:1_800_000_000_000
    }),/PAYOUT_RECIPIENT_GAS_QUOTE_REQUIRED/);
});

test("winner is paid first; unfundable owner is waived only after verified winner credit", async t => {
    const dir=mkdtempSync(join(tmpdir(),"ww-recipient-gas-"));
    t.after(()=>rmSync(dir,{recursive:true,force:true}));
    const plan=newPlan();
    const win=plan.transfers.find(x=>x.recipientRole==="WINNER");
    const owner=plan.transfers.find(x=>x.recipientRole==="OWNER");
    const sends=[];
    const obligations=[
        {payoutId,role:"WINNER",recipientId:"Bob",settled:false,waived:false},
        {payoutId,role:"OWNER",recipientId:"WheelWin",settled:false,waived:false}
    ];
    const ledger={
        listPayoutObligations:()=>obligations,
        settlePayout({recipientId,executionResult}) {
            assert.ok(executionResult.transactionId);
            obligations.find(x=>x.recipientId===recipientId).settled=true;
            return {settled:true};
        },
        waiveOwnerCommission({evidence}) {
            assert.equal(obligations[0].settled,true);
            assert.equal(evidence.reason,"INSUFFICIENT_BALANCE_AFTER_WINNER");
            obligations[1].waived=true;
            return {waived:true};
        }
    };
    const observer={
        async findOutgoingTransfer({destinationIdentity}) {
            return destinationIdentity===WINNER ? {transactionId:"winner-source"} : null;
        },
        async verifyIndexedRecipientCredit({destinationIdentity,transactionId,amountAtomic}) {
            return {status:"MASTERCHAIN_INDEXED_RECIPIENT_CREDIT_OBSERVED",
                sourceTransactionId:transactionId,recipientTransactionId:"winner-credit",
                messageHash:"winner-message",destinationAddress:destinationIdentity,amountAtomic,
                globalId:-3,sourceFinality:"finalized",recipientFinality:"finalized",
                sourceMcBlockSeqno:1,recipientMcBlockSeqno:2,latestIndexedMcBlockSeqno:3};
        }
    };
    const transport=new TestnetNativeRoomPayoutTransport({
        dataDir:dir,ledger,
        walletPool:{getReservationForRoom:()=>({
            roomNumber:2,reservedByRoomId:roomId,address:ROOM})},
        outgoingObserver:observer,
        independentVerifier:{async verifyTransfer(query) {
            return {...query,status:"INDEPENDENT_INDEXED_CREDIT_OBSERVED",
                provider:"tonapi-testnet",actualFeeAtomic:100_000};
        }},
        adapter:{
            async sendTransfer(request) {sends.push(request);return {ok:true,txHash:"winner-source"};},
            async canFundTransfer({amountNano,sourceReserveNano}) {
                assert.equal(amountNano,BigInt(owner.netAtomic));
                assert.equal(sourceReserveNano,BigInt(owner.reservedFeeAtomic));
                return {ok:false,balanceNano:1_000_000n,
                    requiredNano:BigInt(owner.grossAtomic)};
            }
        }
    });
    const query={roomId,payoutId,roomWalletAddress:ROOM,
        winnerWallet:WINNER,ownerWallet:OWNER,plan};
    const sent=await transport.submit(query);
    assert.equal(sent.status,"OWNER_COMMISSION_WAIVER_PENDING_CONFIRMATION");
    assert.deepEqual(sends.map(x=>x.destination),[WINNER]);
    assert.equal(sends[0].amountNano,BigInt(win.netAtomic));
    assert.equal(sends[0].sourceReserveNano,0n);
    assert.equal(obligations[0].settled,false);
    const verified=await transport.reconcileAndSettle(query);
    assert.equal(verified.status,"WINNER_SETTLED_OWNER_COMMISSION_WAIVED");
    assert.equal(obligations[0].settled,true);
    assert.equal(obligations[1].waived,true);
    assert.equal(sends.length,1);
});
