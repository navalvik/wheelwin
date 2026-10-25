/**
 * Autonomous READ-ONLY recovery of unfinished native-Testnet winner/owner
 * payouts. Traverses persisted ledger payout plans, not the live room list:
 * a destroyed Page6 room or a process restart must not erase its debts.
 *
 * Calls only transport.reconcileAndSettle (which never signs/broadcasts).
 * Reconciliation moves ledger obligations to SETTLED only on Toncenter +
 * independent TonAPI finalized evidence. Strict per-pass cap, round-robin
 * fairness and one in-flight pass guard for up to 50 simultaneous rooms.
 */
import {LEDGER_ENTRY_KIND} from "../ledger/LedgerConstants.js";

export class TestnetPendingPayoutReconciler {
    constructor({ledgerStore,ledger,walletPool,transport,maxPerPass=5,logger=null}={}){
        if(typeof ledgerStore?.list!=="function"
            ||typeof ledger?.countOpenObligations!=="function"
            ||typeof walletPool?.getReservationForRoom!=="function"
            ||typeof transport?.reconcileAndSettle!=="function"
            ||!Number.isSafeInteger(maxPerPass)
            ||maxPerPass<1||maxPerPass>10)
            throw new TypeError("PAYOUT_RECONCILER_CONFIG_INVALID");
        this._store=ledgerStore;
        this._ledger=ledger;
        this._pool=walletPool;
        this._transport=transport;
        this._max=maxPerPass;
        this._cursor=0;
        this._running=false;
        this._logger=logger;
    }

    async runPass(){
        if(this._running)return Object.freeze({
            status:"RECONCILIATION_IN_PROGRESS",scanned:0,results:Object.freeze([])
        });
        this._running=true;
        try{
            const plans=new Map();
            for(const entry of this._store.list()){
                if(entry.kind!==LEDGER_ENTRY_KIND.PAYOUT_PLAN)continue;
                const plan=entry.metadata?.plan;
                if(!plan||typeof plan!=="object"||plan.payoutId!==entry.metadata?.payoutId
                    ||plan.roomId!==entry.roomId||!Array.isArray(plan.transfers)
                    ||plan.transfers.length!==2)continue;
                if(this._ledger.countOpenObligations(entry.roomId)===0)continue;
                plans.set(plan.payoutId,plan);
            }
            const tasks=[...plans.values()];
            if(!tasks.length){
                this._cursor=0;
                return Object.freeze({status:"NO_OPEN_PAYOUTS",
                    scanned:0,results:Object.freeze([])});
            }
            const count=Math.min(tasks.length,this._max);
            const results=[];
            for(let i=0;i<count;i++){
                const plan=tasks[(this._cursor+i)%tasks.length];
                const reservation=this._pool.getReservationForRoom(plan.roomId);
                if(!reservation||reservation.reservedByRoomId!==plan.roomId
                    ||reservation.roomNumber===1){
                    results.push(Object.freeze({payoutId:plan.payoutId,
                        status:"PAYOUT_WALLET_RESERVATION_MISSING_HOLD"}));
                    continue;
                }
                const winner=plan.transfers.find(t=>t.recipientRole==="WINNER");
                const owner=plan.transfers.find(t=>t.recipientRole==="OWNER");
                if(!winner?.address||!owner?.address){
                    results.push(Object.freeze({payoutId:plan.payoutId,
                        status:"PAYOUT_RECOVERY_PLAN_INCOMPLETE"}));
                    continue;
                }
                try{
                    const outcome=await this._transport.reconcileAndSettle({
                        roomId:plan.roomId,payoutId:plan.payoutId,
                        roomWalletAddress:reservation.address,
                        winnerWallet:winner.address,ownerWallet:owner.address,plan
                    });
                    results.push(Object.freeze({payoutId:plan.payoutId,
                        status:outcome.status}));
                }catch(error){
                    // No secret, wallet address, or network payload in logs.
                    this._logger?.warn?.("Testnet payout read-only recovery pending");
                    results.push(Object.freeze({payoutId:plan.payoutId,
                        status:"PAYOUT_RECONCILIATION_RETRY_LATER"}));
                }
            }
            this._cursor=(this._cursor+count)%tasks.length;
            return Object.freeze({status:"READ_ONLY_RECOVERY_PASS_COMPLETE",
                scanned:count,results:Object.freeze(results)});
        } finally {this._running=false;}
    }
}
