import test from "node:test";
import assert from "node:assert/strict";
import { TestnetWinnerPayoutCoordinator } from "../../payment/runtime/TestnetWinnerPayoutCoordinator.js";
import { RoomPayoutCalculator } from "../../payment/ledger/RoomPayoutCalculator.js";

const A="0:"+"a".repeat(64), B="0:"+"b".repeat(64);
const C="0:"+"c".repeat(64), D="0:"+"d".repeat(64), ROOM="0:"+"e".repeat(64);
const players=["Olga","Lena","Bob"];
function harness({ allPaid=true, fees=true, submit=true, dataDir=null }={}) {
    const calls=[],sent=[],plans=new Map();
    const intents=players.map((playerId,index)=>({
        roomId:"room-xyz",playerId,
        amountAtomic:1_000_000_000,asset:"TON",network:"testnet",
        transactionId:allPaid || index<2 ? "transaction-"+index : null,
        state:allPaid || index<2 ? "SETTLED" : "PENDING",
        expectedSender:[A,B,C][index]
    }));
    const ledger={
        countOpenObligations:()=>2,
        getConfirmedPrincipalAtomic:()=>allPaid?3_000_000_000:2_000_000_000,
        planPayout(args){
            calls.push(args);
            if(plans.has(args.payoutId))return {replay:true,plan:plans.get(args.payoutId)};
            const p=RoomPayoutCalculator.computePlan({
                ...args,principalAtomic:3_000_000_000,asset:"TON",network:"testnet"
            }).toJSON();
            plans.set(args.payoutId,p);
            return {replay:false,plan:p};
        }
    };
    const c=new TestnetWinnerPayoutCoordinator({
        paymentRuntime:{
            networkDataDir:dataDir,
            paymentService:{listPaymentIntentsForRoom:()=>intents},
            ledger,
            walletPool:{getReservationForRoom:()=>({
                reservedByRoomId:"room-xyz",roomNumber:2,address:ROOM
            })}
        },
        roomManager:{getRoom:()=>({players})},
        playerManager:{getIdentity:id=>({wallet:({Olga:A,Lena:B,Bob:C})[id]})},
        contextResolver:{resolveRoomByGameId:()=> "room-xyz"},
        winnerEngine:{getResult:()=>({winnerPlayerId:"Lena"})},
        ownerWalletProvider:()=>D,
        feeQuotesProvider:fees?{quote:async()=>({
            winner:{feeAtomic:4_000_000},owner:{feeAtomic:2_000_000}
        })}:null,
        payoutSubmitter:submit?{submit:async payload=>{
            sent.push(payload);return {status:"SUBMITTED_UNCONFIRMED"};
        }}:null
    });
    return {c,calls,sent};
}
test("result binds exact 3 settled payments, winner wallet, full 95% and 4.9% transfers",async()=>{
    const {c,calls,sent}=harness();
    const result=await c.onGameResult({gameId:"game-123"});
    assert.equal(result.status,"SUBMITTED_UNCONFIRMED");
    assert.equal(calls.length,1);
    assert.equal(calls[0].networkFees,undefined);
    assert.equal(calls[0].winner.address,B);
    assert.equal(calls[0].owner.address,D);
    assert.equal(sent.length,1);
    assert.equal(sent[0].plan.principalAtomic,3_000_000_000);
    assert.equal(sent[0].plan.gasReserveAtomic,3_000_000);
    assert.equal(sent[0].plan.transfers.find(x=>x.recipientRole==="WINNER").grossAtomic,2_850_000_000);
    assert.equal(sent[0].plan.transfers.find(x=>x.recipientRole==="OWNER").grossAtomic,147_000_000);
});
test("second result and reconnect cannot call payout submitter twice",async()=>{
    const {c,calls,sent}=harness();
    await c.onGameResult({gameId:"game-123"});
    const result=await c.onGameResult({gameId:"game-123"});
    assert.equal(result.status,"ALREADY_PLANNED_NEEDS_RECONCILIATION");
    assert.equal(sent.length,1);
    assert.equal(calls.length,2);
});
test("no 3/3 settled -> no payout plan and absolutely no outgoing call",async()=>{
    const {c,calls,sent}=harness({allPaid:false});
    await assert.rejects(()=>c.onGameResult({gameId:"game-123"}),/PAYOUT_THREE_SETTLED_PAYMENTS_REQUIRED/);
    assert.equal(calls.length,0);
    assert.equal(sent.length,0);
});
test("absence of fee quotes does not block the full winner payout",async()=>{
    const {c,calls,sent}=harness({fees:false});
    const result=await c.onGameResult({gameId:"game-123"});
    assert.equal(result.status,"SUBMITTED_UNCONFIRMED");
    assert.equal(calls.length,1);
    assert.equal(sent.length,1);
    assert.equal(sent[0].plan.transfers[0].netAtomic,2_850_000_000);
});
test("a planned payout without executor remains an obligation, not a completed transfer",async()=>{
    const {c,calls,sent}=harness({submit:false});
    const result=await c.onGameResult({gameId:"game-123"});
    assert.equal(result.status,"PAYOUT_PLANNED_EXECUTOR_UNAVAILABLE");
    assert.equal(calls.length,1);
    assert.equal(sent.length,0);
});

test('restart pays a durably captured result without live room or player objects', async t => {
    const {mkdtempSync, rmSync} = await import('node:fs');
    const {tmpdir} = await import('node:os');
    const {join} = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'ww-result-recovery-'));
    t.after(() => rmSync(dir, {recursive:true, force:true}));
    const original = harness({dataDir:dir, submit:false});
    assert.equal((await original.c.onGameResult({gameId:'game-123'})).status, 'PAYOUT_PLANNED_EXECUTOR_UNAVAILABLE');
    const recovered = [];
    const restarted = new TestnetWinnerPayoutCoordinator({paymentRuntime:original.c._payment,
        feeQuotesProvider:{quote:async()=>({winner:{feeAtomic:2000000},owner:{feeAtomic:2000000}})},
        payoutSubmitter:{resumeUnattempted:async x => {recovered.push(x); return {status:'SUBMITTED_UNCONFIRMED'};}}
    });
    const result = await restarted.recoverPendingResults();
    assert.equal(result[0].status, 'SUBMITTED_UNCONFIRMED');
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].winnerWallet, B);
    assert.equal(recovered[0].plan.gasReserveAtomic, 3_000_000);
});
