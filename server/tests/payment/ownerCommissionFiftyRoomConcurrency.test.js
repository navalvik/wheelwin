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

const COUNT=50;
const address=i=>"0:"+i.toString(16).padStart(64,"0");
const payoutId=i=>"payout_"+i.toString(16).padStart(32,"0");
const roomId=i=>"room-50-load-"+i;
const ownerAddress=address(900);
const FINISHED_AT=1_800_000_000_000;
const makeEvidence=(id,network,remaining)=>({
    status:"OWNER_PRINCIPAL_SHORTFALL_CORROBORATED_READ_ONLY",
    payoutId:id,network,ownerDueAtomic:148_500_000,
    toncenterBalanceAtomic:String(remaining),
    tonapiBalanceAtomic:String(remaining),
    tonapiObservedAtMs:FINISHED_AT,
    estimatedFeeAtomic:remaining===148_500_000?"1000000":null,
    terminal:false,walletReleasable:false
});

for(const network of ["testnet","mainnet"]) {
    test(network+": 50 independent three-player payout outcomes survive restart and never contaminate rooms",async t=>{
        const root=mkdtempSync(join(tmpdir(),"wheelwin-owner-50-load-"));
        t.after(()=>rmSync(root,{recursive:true,force:true}));
        const intents=new PaymentIntentStore({dataDir:root});
        intents.initialize();
        const makeLedger=()=>{
            const ledger=new RoomLedger({
                store:new LedgerStore({dataDir:root}),
                intentStore:intents,
                currency:CurrencyMapping.nativeTon({network})
            });
            ledger.initialize();
            return ledger;
        };
        const ledger=makeLedger();
        const plans=Array.from({length:COUNT},(_,i)=>RoomPayoutCalculator.computePlan({
            payoutId:payoutId(i),roomId:roomId(i),asset:"TON",network,
            principalAtomic:3_000_000_000,nowMs:FINISHED_AT,
            winner:{recipientId:"Olga",address:address(i+1)},
            owner:{recipientId:"WheelWin",address:ownerAddress}
        }).toJSON());
        // Interleave creation as separate room games sharing one durable store.
        await Promise.all(plans.map(async (plan,i)=>{
            await Promise.resolve();
            ledger.store.append({
                idempotencyKey:plan.payoutId+":plan",
                roomId:roomId(i),kind:"PAYOUT_PLAN",
                amountAtomic:plan.principalAtomic,
                asset:"TON",network,
                metadata:{payoutId:plan.payoutId,plan}
            });
        }));
        ledger.initialize();
        assert.equal(plans.length,50);
        for(let i=0;i<COUNT;i++) {
            assert.equal(ledger.listPayoutObligations(roomId(i)).length,2);
            assert.equal(countUnsettledRoomFinancialObligations({
                roomId:roomId(i),ledger,refundStore:{list:()=>[]}
            }),2,"never release a room before winner settlement");
        }

        // Every odd room stops just before terminal, to ensure that one room's
        // successful ledger append cannot unlock its neighbor.
        await Promise.all(plans.map(async (plan,i)=>{
            await Promise.resolve();
            ledger.settlePayout({
                payoutId:plan.payoutId,recipientId:"Olga",
                executionResult:{
                    transactionId:"winner-finalized-"+i,
                    actualFeeAtomic:900_000
                }
            });
            if(i%2===0)ledger.terminateOwnerCommissionUnpaid({
                payoutId:plan.payoutId,recipientId:"WheelWin",
                evidence:makeEvidence(plan.payoutId,network,
                    i%4===0?148_500_000:140_000_000)
            });
        }));
        const restarted=makeLedger();
        for(let i=0;i<COUNT;i++) {
            const expected=i%2===0?0:1;
            assert.equal(restarted.countOpenObligations(roomId(i)),expected);
            assert.equal(countUnsettledRoomFinancialObligations({
                roomId:roomId(i),ledger:restarted,refundStore:{list:()=>[]}
            }),expected);
            const obligations=restarted.listPayoutObligations(roomId(i));
            assert.equal(obligations.find(x=>x.role==="WINNER").settled,true);
            assert.equal(obligations.find(x=>x.role==="OWNER").settled,false);
            assert.equal(obligations.find(x=>x.role==="OWNER").terminal,i%2===0);
        }
        await Promise.all(plans.map(async (plan,i)=>{
            if(i%2===0)return;
            await Promise.resolve();
            restarted.terminateOwnerCommissionUnpaid({
                payoutId:plan.payoutId,recipientId:"WheelWin",
                evidence:makeEvidence(plan.payoutId,network,
                    i%4===1?140_000_000:148_500_000)
            });
        }));
        const final=makeLedger();
        for(let i=0;i<COUNT;i++) {
            const entries=final.store.listForRoom(roomId(i)).map(x=>x.toRecord());
            const terminal=entries.filter(x=>x.kind===
                "OWNER_COMMISSION_UNPAID_GAS_SHORTAGE_TERMINAL");
            const settled=entries.filter(x=>x.kind==="PAYOUT_SETTLEMENT");
            assert.equal(terminal.length,1);
            assert.equal(terminal[0].metadata.payoutId,payoutId(i));
            assert.equal(terminal[0].metadata.paymentStatus,"UNPAID");
            assert.equal(settled.length,1);
            assert.equal(settled[0].metadata.role,"WINNER");
            assert.equal(final.countOpenObligations(roomId(i)),0);
            assert.equal(countUnsettledRoomFinancialObligations({
                roomId:roomId(i),ledger:final,refundStore:{list:()=>[]}
            }),0);
            const snapshot={
                network,
                outcome:{kind:"PAYOUT"},
                outstandingObligations:0,
                intents:[{state:"SETTLED"},{state:"SETTLED"},{state:"SETTLED"}],
                refunds:[],unresolvedReceipts:[],ledger:entries
            };
            const gate=evaluateFinalForensicArchive({
                snapshot,
                sessionRecord:{finishedAt:FINISHED_AT,
                    lifecycleResult:"GAME_COMPLETED"}
            });
            assert.equal(gate.ready,true);
            assert.equal(gate.reason,
                "FINAL_WINNER_PAID_OWNER_COMMISSION_UNPAID_GAS_SHORTFALL");
        }
        // Duplicate retry after all 50 outcomes were durably indexed.
        const duplicates=await Promise.all(plans.map(async(plan,i)=>{
            await Promise.resolve();
            return final.terminateOwnerCommissionUnpaid({
                payoutId:plan.payoutId,recipientId:"WheelWin",
                evidence:makeEvidence(plan.payoutId,network,
                    i%2===0?(i%4===0?148_500_000:140_000_000):
                        (i%4===1?140_000_000:148_500_000))
            });
        }));
        assert.ok(duplicates.every(x=>x.replay===true && x.paid===false));
        assert.equal(final.store.list().filter(x=>
            x.kind==="OWNER_COMMISSION_UNPAID_GAS_SHORTAGE_TERMINAL").length,COUNT);
    });
}
