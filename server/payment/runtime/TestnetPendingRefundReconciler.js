/**
 * Restart-safe read-only completion of already attempted native GRAM refunds.
 *
 * Never sends or signs. Only historical transactions strictly after the
 * durable obligation, finalized at BOTH Toncenter accounts and independently
 * matched at TonAPI Testnet, may close a persisted obligation.
 *
 * A PENDING refund is never submitted by this worker. Incomplete evidence,
 * unrecognized source wallet, multiple matching transfers or provider outage
 * leaves the obligation untouched for a later pass.
 */
import {tonAddressIdentitiesEqual} from "../incoming/TonAddressIdentity.js";

const ELIGIBLE=new Set(["SUBMISSION_UNKNOWN","SUBMITTED","RECONCILIATION_REQUIRED"]);
export class TestnetPendingRefundReconciler {
    constructor({refundStore,intentStore,toncenterObserver,independentVerifier,
        nowProvider=Date.now,maxPerPass=5,logger=null}={}){
        if(typeof refundStore?.listPending!=="function"
            ||typeof refundStore?.completeFromVerifiedHistory!=="function"
            ||typeof intentStore?.listForRoom!=="function"
            ||typeof toncenterObserver?.findOutgoingTransfer!=="function"
            ||typeof toncenterObserver?.verifyIndexedRecipientCredit!=="function"
            ||typeof independentVerifier?.verifyTransfer!=="function"
            ||typeof nowProvider!=="function"
            ||!Number.isSafeInteger(maxPerPass)||maxPerPass<1||maxPerPass>10)
            throw new TypeError("REFUND_RECONCILER_CONFIG_INVALID");
        this._refunds=refundStore;
        this._intents=intentStore;
        this._chain=toncenterObserver;
        this._independent=independentVerifier;
        this._now=nowProvider;
        this._max=maxPerPass;
        this._cursor=0;
        this._active=false;
        this._logger=logger;
    }
    async runPass(){
        if(this._active)return Object.freeze({
            status:"RECONCILIATION_IN_PROGRESS",scanned:0,results:Object.freeze([])
        });
        this._active=true;
        try {
            const todo=this._refunds.listPending().filter(x=>ELIGIBLE.has(x.state)
                &&x.networkName==="TESTNET"&&x.globalId===-3);
            if(!todo.length){
                this._cursor=0;
                return Object.freeze({status:"NO_SUBMITTED_REFUNDS",
                    scanned:0,results:Object.freeze([])});
            }
            const count=Math.min(todo.length,this._max),results=[];
            for(let i=0;i<count;i++){
                const obligation=todo[(this._cursor+i)%todo.length];
                let status="REFUND_FINALITY_PENDING";
                try{
                    const intents=this._intents.listForRoom(obligation.roomId);
                    const intent=intents.find(x=>x.paymentReference===obligation.paymentIntentId);
                    if(!intent||intent.transactionId!==obligation.incomingTransactionId
                        ||!tonAddressIdentitiesEqual(intent.expectedSender,obligation.refundDestination)
                        ||!tonAddressIdentitiesEqual(intent.destinationWalletAddress,
                            intent.destinationWalletAddress)
                        ||typeof intent.destinationWalletAddress!=="string"){
                        status="REFUND_SOURCE_UNVERIFIED";
                    }else{
                        const source=intent.destinationWalletAddress;
                        const amount=obligation.transferAmountAtomic??obligation.amountAtomic;
                        const tx=await this._chain.findOutgoingTransfer({
                            sourceWalletAddress:source,destinationIdentity:obligation.refundDestination,
                            amountAtomic:amount,minCreatedAtMs:obligation.createdAtMs
                        });
                        if(tx?.ambiguous===true) status="REFUND_AMBIGUOUS_OUTGOING_HOLD";
                        else if(tx?.transactionId && (!obligation.outgoingTransactionId
                            ||tx.transactionId===obligation.outgoingTransactionId)){
                            const indexed=await this._chain.verifyIndexedRecipientCredit({
                                sourceWalletAddress:source,
                                destinationIdentity:obligation.refundDestination,
                                transactionId:tx.transactionId,
                                amountAtomic:amount,minCreatedAtMs:obligation.createdAtMs
                            });
                            if(indexed?.status==="MASTERCHAIN_INDEXED_RECIPIENT_CREDIT_OBSERVED"
                                &&indexed.globalId===-3
                                &&indexed.sourceFinality==="finalized"
                                &&indexed.recipientFinality==="finalized"
                                &&indexed.sourceTransactionId===tx.transactionId
                                &&indexed.amountAtomic===amount
                                &&tonAddressIdentitiesEqual(indexed.destinationAddress,
                                    obligation.refundDestination)){
                                const verified=await this._independent.verifyTransfer({
                                    sourceTransactionId:indexed.sourceTransactionId,
                                    recipientTransactionId:indexed.recipientTransactionId,
                                    messageHash:indexed.messageHash,
                                    sourceWalletAddress:source,
                                    destinationAddress:obligation.refundDestination,
                                    amountAtomic:amount
                                });
                                if(verified?.status==="INDEPENDENT_INDEXED_CREDIT_OBSERVED"
                                    &&verified.provider==="tonapi-testnet"
                                    &&verified.sourceTransactionId===indexed.sourceTransactionId
                                    &&verified.recipientTransactionId===indexed.recipientTransactionId
                                    &&verified.messageHash===indexed.messageHash
                                    &&verified.amountAtomic===amount
                                    &&tonAddressIdentitiesEqual(verified.sourceWalletAddress,source)
                                    &&tonAddressIdentitiesEqual(verified.destinationAddress,
                                        obligation.refundDestination)
                                    &&indexed.sourceBlockRef?.workchain===0
                                    &&typeof indexed.sourceBlockRef.shard==="string"
                                    &&Number.isSafeInteger(indexed.sourceBlockRef.seqno)){
                                    const finalizedEvidence=Object.freeze({
                                        networkName:"TESTNET",globalId:-3,
                                        transactionId:tx.transactionId,
                                        amountAtomic:amount,
                                        destination:obligation.refundDestination,
                                        finalized:true,observedAtMs:this._now(),
                                        blockId:`0:${indexed.sourceBlockRef.shard}:${indexed.sourceBlockRef.seqno}`
                                    });
                                    this._refunds.completeFromVerifiedHistory(
                                        obligation.obligationId,{
                                            outgoingTransactionId:tx.transactionId,
                                            finalizedEvidence
                                        });
                                    status="REFUND_COMPLETE_TWO_SOURCES";
                                }
                            }
                        }
                    }
                }catch{
                    this._logger?.warn?.("Testnet refund finality read-only recovery pending");
                    status="REFUND_RECONCILIATION_RETRY_LATER";
                }
                results.push(Object.freeze({obligationId:obligation.obligationId,status}));
            }
            this._cursor=(this._cursor+count)%todo.length;
            return Object.freeze({status:"READ_ONLY_REFUND_PASS_COMPLETE",
                scanned:count,results:Object.freeze(results)});
        }finally{this._active=false;}
    }
}
