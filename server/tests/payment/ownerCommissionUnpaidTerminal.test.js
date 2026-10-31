import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {PaymentIntentStore} from "../../payment/PaymentIntentStore.js";
import {LedgerStore,RoomLedger,CurrencyMapping,RoomPayoutCalculator}
    from "../../payment/ledger/index.js";
import {countUnsettledRoomFinancialObligations}
    from "../../payment/runtime/countUnsettledRoomFinancialObligations.js";
import {evaluateFinalForensicArchive}
    from "../../forensic/FinalForensicArchiveGate.js";

const ROOM="room-unpaid-gas-terminal",PAYOUT="payout_"+"c".repeat(32);
const WINNER="0:"+"b".repeat(64),OWNER="0:"+"d".repeat(64);
function harness(t,network) {
    const dir=mkdtempSync(join(tmpdir(),"wheelwin-owner-terminal-ledger-"));
    t.after(()=>rmSync(dir,{recursive:true,force:true}));
    const intents=new PaymentIntentStore({dataDir:dir});intents.initialize();
    const construct=()=>{
        const ledger=new RoomLedger({
            store:new LedgerStore({dataDir:dir}),intentStore:intents,
            currency:CurrencyMapping.nativeTon({network})
        });
        ledger.initialize();
        return ledger;
    };
    const plan=RoomPayoutCalculator.computePlan({
        payoutId:PAYOUT,roomId:ROOM,asset:"TON",network,
        principalAtomic:3_000_000_000,nowMs:1_800_000_000_000,
        winner:{recipientId:"Olga",address:WINNER},
        owner:{recipientId:"WheelWin",address:OWNER}
    }).toJSON();
    const ledger=construct();
    ledger.store.append({
        idempotencyKey:PAYOUT+":plan",roomId:ROOM,kind:"PAYOUT_PLAN",
        amountAtomic:3_000_000_000,asset:"TON",network,
        metadata:{payoutId:PAYOUT,plan}
    });
    ledger.initialize();
    const evidence={
        status:"OWNER_PRINCIPAL_SHORTFALL_CORROBORATED_READ_ONLY",
        payoutId:PAYOUT,network,ownerDueAtomic:148_500_000,
        toncenterBalanceAtomic:"140000000",tonapiBalanceAtomic:"140000000",
        tonapiObservedAtMs:1_800_000_000_000,
        estimatedFeeAtomic:"1000000",terminal:false,walletReleasable:false
    };
    return {ledger,construct,plan,evidence};
}
for(const network of ["testnet","mainnet"]){
    test(network+": winner confirmed, owner explicitly UNPAID, safely release ledger and archive one final decision",t=>{
        const h=harness(t,network);
        assert.equal(h.ledger.countOpenObligations(ROOM),2);
        h.ledger.settlePayout({payoutId:PAYOUT,recipientId:"Olga",executionResult:{
            transactionId:"winner-onchain-finalized",actualFeeAtomic:1000000
        }});
        assert.equal(h.ledger.countOpenObligations(ROOM),1);
        const recorded=h.ledger.terminateOwnerCommissionUnpaid({
            payoutId:PAYOUT,recipientId:"WheelWin",evidence:h.evidence
        });
        assert.equal(recorded.terminal,true);
        assert.equal(recorded.paid,false);
        assert.equal(recorded.unpaidAtomic,148_500_000);
        const obligations=h.ledger.listPayoutObligations(ROOM);
        assert.equal(obligations.find(x=>x.role==="WINNER").settled,true);
        assert.equal(obligations.find(x=>x.role==="OWNER").settled,false);
        assert.equal(obligations.find(x=>x.role==="OWNER").terminal,true);
        assert.equal(h.ledger.countOpenObligations(ROOM),0);
        assert.equal(countUnsettledRoomFinancialObligations({
            roomId:ROOM,ledger:h.ledger,refundStore:{list:()=>[]}
        }),0);
        const snapshot={
            network,outcome:{kind:"PAYOUT"},refunds:[],unresolvedReceipts:[],
            intents:[{state:"SETTLED"},{state:"SETTLED"},{state:"SETTLED"}],
            ledger:h.ledger.store.listForRoom(ROOM).map(x=>x.toRecord()),
            outstandingObligations:0
        };
        const archive=evaluateFinalForensicArchive({snapshot,
            sessionRecord:{finishedAt:1_800_000_000_000,lifecycleResult:"GAME_COMPLETED"}});
        assert.equal(archive.ready,true);
        assert.equal(archive.reason,"FINAL_WINNER_PAID_OWNER_COMMISSION_UNPAID_GAS_SHORTFALL");
        assert.equal(snapshot.ledger.filter(x=>x.kind==="PAYOUT_SETTLEMENT").length,1);
        assert.equal(snapshot.ledger.filter(x=>x.kind==="OWNER_COMMISSION_UNPAID_GAS_SHORTAGE_TERMINAL").length,1);
        assert.throws(()=>h.ledger.settlePayout({
            payoutId:PAYOUT,recipientId:"WheelWin",
            executionResult:{transactionId:"fake-owner",actualFeeAtomic:100000}
        }),/owner commission was durably closed as unpaid/);
        const restarted=h.construct();
        assert.equal(restarted.countOpenObligations(ROOM),0);
        const replay=restarted.terminateOwnerCommissionUnpaid({
            payoutId:PAYOUT,recipientId:"WheelWin",evidence:h.evidence
        });
        assert.equal(replay.replay,true);
        assert.equal(restarted.store.listForRoom(ROOM)
            .filter(x=>x.kind==="OWNER_COMMISSION_UNPAID_GAS_SHORTAGE_TERMINAL").length,1);
    });
}
test("principal fully present but zero gas is a durable unpaid terminal, not a paid owner",t=>{
    const h=harness(t,"mainnet");
    h.ledger.settlePayout({payoutId:PAYOUT,recipientId:"Olga",
        executionResult:{transactionId:"winner-final",actualFeeAtomic:700000}});
    const evidence={...h.evidence,
        toncenterBalanceAtomic:"148500000",tonapiBalanceAtomic:"148500000"};
    const result=h.ledger.terminateOwnerCommissionUnpaid({
        payoutId:PAYOUT,recipientId:"WheelWin",evidence
    });
    assert.equal(result.terminal,true);
    assert.equal(result.paid,false);
    assert.equal(h.ledger.listPayoutObligations(ROOM).find(x=>x.role==="OWNER").settled,false);
    assert.equal(h.ledger.countOpenObligations(ROOM),0);
});

test("owner terminal cannot be fabricated while winner pending or proofs missing",t=>{
    const h=harness(t,"testnet");
    assert.throws(()=>h.ledger.terminateOwnerCommissionUnpaid({
        payoutId:PAYOUT,recipientId:"WheelWin",evidence:h.evidence
    }),/WINNER_UNVERIFIED/);
    h.ledger.settlePayout({payoutId:PAYOUT,recipientId:"Olga",
        executionResult:{transactionId:"winner-final",actualFeeAtomic:100000}});
    for(const changes of [
        {tonapiBalanceAtomic:"150000000"},
        {network:"mainnet"},
        {ownerDueAtomic:147000000},
        {status:"OWNER_GAS_SHORTFALL_CANDIDATE_READ_ONLY"},
        {terminal:true}
    ]) {
        assert.throws(()=>h.ledger.terminateOwnerCommissionUnpaid({
            payoutId:PAYOUT,recipientId:"WheelWin",evidence:{...h.evidence,...changes}
        }),/EVIDENCE_INVALID/);
    }
    assert.equal(h.ledger.countOpenObligations(ROOM),1);
});
