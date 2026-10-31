import { durableWriteJson } from '../DurableJson.js';
/**
 * Native Wallet V4 outbound transport, reusing the historical RoomWalletAdapter.
 * Optional fee quotes may be read from the Testnet RPC for diagnostics; they
 * never gate a transfer. One pre-broadcast durable claim prevents
 * restart/concurrent replay from ever sending the same payout again.
 * No escrow/game contract, Jetton, Mainnet or blockchain finality claim.
 */
import {mkdirSync,openSync,writeSync,fsyncSync,closeSync,readFileSync,existsSync} from "node:fs";
import {createHash} from "node:crypto";
import {join,resolve} from "node:path";
import {RoomWalletAdapter} from "../roomWallet/RoomWalletAdapter.js";
import {PayoutPlan} from "../ledger/PayoutPlan.js";
import {deriveTonAddressIdentity} from "../incoming/TonAddressIdentity.js";
import {requireToncenterChainConfig} from "../toncenter/ToncenterConstants.js";

const SAFE_PAYOUT_ID=/^payout_[a-f0-9]{32}$/;
const RETAINED_NANO=0n; // estimate is not a send gate; plan carries the exact 0.05% reserve
function assert(ok,reason) {if(!ok)throw new Error(reason);}
function canonical(address) {
    const value=deriveTonAddressIdentity(address);
    assert(value.startsWith("0:"),"PAYOUT_TESTNET_ADDRESS_INVALID");
    return value;
}
function feeToNumber(value) {
    assert(value<=BigInt(Number.MAX_SAFE_INTEGER),"PAYOUT_FEE_OVERFLOW");
    return Number(value);
}
function logEvent(path,record,exclusive) {
    if (exclusive) return durableWriteJson(path, record, {exclusive:true, indent:0});
    const fd=openSync(path,exclusive?"wx":"a",0o600);
    try {writeSync(fd,JSON.stringify(record)+"\n");fsyncSync(fd);}finally{closeSync(fd);}
}

export class TestnetNativeRoomPayoutTransport {
    constructor({walletPool,walletResolver,tonService,dataDir,logger=null,adapter=null,
        outgoingObserver=null,independentVerifier=null,ledger=null,network="testnet"}={}) {
        const chain=requireToncenterChainConfig(network);
        assert(walletPool && typeof dataDir==="string" && dataDir,"PAYOUT_RUNTIME_UNAVAILABLE");
        // Mainnet must use an explicitly selected, network-bound pool and
        // a caller-injected Wallet V4 adapter; never implicitly create a
        // Mainnet sender from a possibly Testnet-configured TON service.
        if (network==="mainnet") {
            assert(walletPool.network==="mainnet","PAYOUT_MAINNET_WALLET_POOL_REQUIRED");
            assert(adapter!==null,"PAYOUT_MAINNET_EXPLICIT_ADAPTER_REQUIRED");
            // Refunds and winner/owner payouts must share ONE persistent
            // per-network seqno outbox. A private adapter queue is not enough
            // to protect two separate room sessions after a restart.
            assert(adapter.supportsDurableTransferRetry?.()===true
                && typeof adapter._sequenceStateDir==="string"
                && resolve(adapter._sequenceStateDir)===resolve(dataDir,"outbound-sequences"),
                "PAYOUT_MAINNET_SHARED_DURABLE_SEQNO_REQUIRED");
        }
        this._network=chain.network;
        this._globalId=chain.globalId;
        assert(adapter || (walletResolver && tonService),"PAYOUT_WALLET_ADAPTER_MISSING");
        this._pool=walletPool;
        this._outgoingObserver=outgoingObserver;
        this._independentVerifier=independentVerifier;
        this._ledger=ledger;
        this._adapter=adapter ?? new RoomWalletAdapter({
            walletResolver,tonService,logger,gasReserveNano:RETAINED_NANO
        });
        this._dir=join(dataDir,network==="mainnet" ? "mainnet-native-payout-attempts" : "testnet-native-payout-attempts");
        mkdirSync(this._dir,{recursive:true,mode:0o700});
    }
    _reservation(roomId,claimedAddress) {
        const wallet=this._pool.getReservationForRoom(roomId);
        assert(wallet && wallet.reservedByRoomId===roomId
            && (this._network!=="testnet" || wallet.roomNumber!==1)
            && (this._network!=="mainnet" || wallet.network==="mainnet")
            && canonical(wallet.address)===canonical(claimedAddress),
            "PAYOUT_ROOM_WALLET_MISMATCH");
        return wallet;
    }
    async quote({roomId,roomWallet,winnerWallet,ownerWallet,principalAtomic}) {
        const wallet=this._reservation(roomId,roomWallet);
        assert(Number.isSafeInteger(principalAtomic)&&principalAtomic>0,
            "PAYOUT_PRINCIPAL_INVALID");
        const winnerGross=BigInt(principalAtomic)*95n/100n;
        const ownerGross=BigInt(principalAtomic)*99n/2000n;
        assert(ownerGross>0n,"PAYOUT_OWNER_NONPOSITIVE");
        const quote=async (address,amountNano)=>{
            const result=await this._adapter.estimateOutboundTransferFee({
                roomNumber:wallet.roomNumber,destination:canonical(address),
                amountNano,bounce:false
            });
            assert(result?.ok===true && typeof result.totalNano==="bigint"
                && result.totalNano>=0n,"PAYOUT_TESTNET_FEE_QUOTE_UNAVAILABLE");
            // Source-side estimate is diagnostic only; never charge the
            // recipient or use a quote as a payout gate.
            return feeToNumber(result.totalNano);
        };
        return Object.freeze({
            winner:Object.freeze({feeAtomic:await quote(winnerWallet,winnerGross),quotedAtMs:Date.now()}),
            owner:Object.freeze({feeAtomic:await quote(ownerWallet,ownerGross),quotedAtMs:Date.now()})
        });
    }
    async reconcile({roomId,payoutId,roomWalletAddress,winnerWallet,ownerWallet,plan}) {
        assert(typeof payoutId==="string"&&SAFE_PAYOUT_ID.test(payoutId),
            "PAYOUT_IDENTIFIER_INVALID");
        const wallet=this._reservation(roomId,roomWalletAddress);
        const winner=plan?.transfers?.find(x=>x.recipientRole==="WINNER");
        const owner=plan?.transfers?.find(x=>x.recipientRole==="OWNER");
        assert(plan?.roomId===roomId&&plan.payoutId===payoutId
            &&(this._network!=="mainnet" || plan.network==="mainnet")
            &&winner?.netAtomic>0&&owner?.netAtomic>0
            &&canonical(winner.address)===canonical(winnerWallet)
            &&canonical(owner.address)===canonical(ownerWallet),
            "PAYOUT_RECONCILIATION_PLAN_INVALID");
        const claimPath=join(this._dir,payoutId+".jsonl");
        let record;
        try {
            const line=readFileSync(claimPath,"utf8").split("\n")[0];
            record=JSON.parse(line);
        } catch {
            return Object.freeze({status:"NO_BROADCAST_ATTEMPT_RECORDED",payoutId});
        }
        assert(record?.payoutId===payoutId&&record.roomId===roomId
            &&record.roomNumber===wallet.roomNumber
            &&record.winnerAddress===canonical(winner.address)
            &&record.ownerAddress===canonical(owner.address)
            &&record.winnerAmountAtomic===winner.netAtomic
            &&record.ownerAmountAtomic===owner.netAtomic
            &&Number.isSafeInteger(record.timestamp)
            &&record.timestamp>0,
            "PAYOUT_JOURNAL_IDENTITY_MISMATCH");
        if(typeof this._outgoingObserver?.findOutgoingTransfer!=="function")
            return Object.freeze({status:"OUTGOING_OBSERVATION_UNAVAILABLE",payoutId});
        // Read-only. Reconnect/restart cannot cause a new outgoing transfer.
        const [win,out]=await Promise.all([
            this._outgoingObserver.findOutgoingTransfer({
                sourceWalletAddress:wallet.address,
                destinationIdentity:winner.address,amountAtomic:winner.netAtomic,
                minCreatedAtMs:record.timestamp
            }),
            this._outgoingObserver.findOutgoingTransfer({
                sourceWalletAddress:wallet.address,
                destinationIdentity:owner.address,amountAtomic:owner.netAtomic,
                minCreatedAtMs:record.timestamp
            })
        ]);
        if(win?.ambiguous||out?.ambiguous)
            return Object.freeze({status:"AMBIGUOUS_OUTGOING_TRANSFERS",payoutId});
        if(!win||!out||!win.transactionId||!out.transactionId
            ||win.transactionId===out.transactionId)
            return Object.freeze({status:"PAYOUT_OUTGOING_CONFIRMATION_PENDING",payoutId,
                winnerObserved:Boolean(win?.transactionId),
                ownerObserved:Boolean(out?.transactionId)});
        // When possible, correlate each room outgoing message with its
        // destination wallet's incoming message. This is observational,
        // NOT independently finalized; the ledger stays unpaid.
        if(typeof this._outgoingObserver.observeRecipientCredit==="function"){
            const hasMasterchainCheck=typeof this._outgoingObserver.verifyIndexedRecipientCredit==="function";
            const observer=hasMasterchainCheck
                ? this._outgoingObserver.verifyIndexedRecipientCredit.bind(this._outgoingObserver)
                : this._outgoingObserver.observeRecipientCredit.bind(this._outgoingObserver);
            const legs=[{role:"winner",transfer:winner,sourceTx:win.transactionId},
                {role:"owner",transfer:owner,sourceTx:out.transactionId}];
            const credited=await Promise.allSettled(legs.map(({transfer,sourceTx})=>
                observer({
                    sourceWalletAddress:wallet.address,
                    destinationIdentity:transfer.address,
                    transactionId:sourceTx,
                    amountAtomic:transfer.netAtomic,
                    minCreatedAtMs:record.timestamp
                })
            ));
            const accepted=credited.map((result,index)=>{
                if(result.status!=="fulfilled")return false;
                const value=result.value, leg=legs[index];
                return value?.status===(hasMasterchainCheck
                    ? "MASTERCHAIN_INDEXED_RECIPIENT_CREDIT_OBSERVED"
                    : "RECIPIENT_CREDIT_OBSERVED_UNFINALIZED")
                    &&(!hasMasterchainCheck || (value.globalId===this._globalId
                        &&value.sourceFinality==="finalized"
                        &&value.recipientFinality==="finalized"
                        &&Number.isSafeInteger(value.sourceMcBlockSeqno)
                        &&Number.isSafeInteger(value.recipientMcBlockSeqno)
                        &&Number.isSafeInteger(value.latestIndexedMcBlockSeqno)
                        &&value.latestIndexedMcBlockSeqno>value.sourceMcBlockSeqno
                        &&value.latestIndexedMcBlockSeqno>value.recipientMcBlockSeqno))
                    &&value.sourceTransactionId===leg.sourceTx
                    &&typeof value.recipientTransactionId==="string"
                    &&value.recipientTransactionId.length>0
                    &&value.amountAtomic===leg.transfer.netAtomic
                    &&canonical(value.destinationAddress)===canonical(leg.transfer.address);
            });
            if(accepted.every(Boolean))return Object.freeze({
                status:hasMasterchainCheck
                    ? "BOTH_MASTERCHAIN_INDEXED_CREDITS_OBSERVED_UNFINALIZED"
                    : "BOTH_RECIPIENT_CREDITS_OBSERVED_UNFINALIZED",
                payoutId,
                winnerTransactionId:win.transactionId,
                ownerTransactionId:out.transactionId,
                winnerRecipientTransactionId:credited[0].value.recipientTransactionId,
                ownerRecipientTransactionId:credited[1].value.recipientTransactionId,
                winnerMessageHash:credited[0].value.messageHash ?? null,
                ownerMessageHash:credited[1].value.messageHash ?? null
            });
            return Object.freeze({
                status:"RECIPIENT_CREDIT_CONFIRMATION_PENDING",payoutId,
                winnerCredited:accepted[0],ownerCredited:accepted[1]
            });
        }
        // A room-wallet outgoing transaction alone never proves that the
        // recipient was credited or the settlement is final.
        return Object.freeze({
            status:"BOTH_OUTGOING_MATCHES_FOUND_UNFINALIZED",payoutId,
            winnerTransactionId:win.transactionId,
            ownerTransactionId:out.transactionId
        });
    }
    /**
     * Idempotent ledger closing requires THREE independent conditions:
     *   1. Both legs are historically finalized on TON Center source+recipient.
     *   2. An independent Testnet indexer confirms the same two message hashes,
     *      destination credits, and source transaction fees.
     *   3. A previously persisted outgoing claim and ledger plan match exactly.
     *
     * No second source or missing fee => keep both obligations OPEN.
     * Never signs, sends, or guesses actual chain fees.
     */
    async reconcileAndSettle(query) {
        const observed=await this.reconcile(query);
        if(observed.status!=="BOTH_MASTERCHAIN_INDEXED_CREDITS_OBSERVED_UNFINALIZED") {
            // The WINNER obligation must not be held hostage by the OWNER
            // fee leg. This read-only path needs the same TWO finalized,
            // recipient-matched sources used for the usual 2/2 settlement.
            // An ambiguous or missing journal, unknown network, or absent
            // independent verifier still fails closed.
            if(["PAYOUT_OUTGOING_CONFIRMATION_PENDING",
                "RECIPIENT_CREDIT_CONFIRMATION_PENDING",
                "BOTH_OUTGOING_MATCHES_FOUND_UNFINALIZED"].includes(observed.status)) {
                const winner=await this._settleFinalizedWinnerWhileOwnerPending(query);
                if(winner?.settled) return Object.freeze({
                    status:"WINNER_SETTLED_OWNER_UNCONFIRMED",
                    payoutId:query.payoutId,autoSettlement:true,
                    ownerSettled:false,winnerReplay:winner.replay===true
                });
            }
            return Object.freeze({...observed,autoSettlement:false});
        }
        if(typeof this._independentVerifier?.verifyTransfer!=="function"
            ||typeof this._ledger?.settlePayout!=="function")
            return Object.freeze({status:"INDEPENDENT_FINALITY_VERIFIER_UNAVAILABLE",
                payoutId:query.payoutId,autoSettlement:false});
        const roles=[
            {role:"WINNER",hash:observed.winnerTransactionId,
                recipientTxHash:observed.winnerRecipientTransactionId,
                messageHash:observed.winnerMessageHash},
            {role:"OWNER",hash:observed.ownerTransactionId,
                recipientTxHash:observed.ownerRecipientTransactionId,
                messageHash:observed.ownerMessageHash}
        ];
        const transfers=query.plan?.transfers ?? [];
        const verified=[];
        for(const leg of roles){
            const transfer=transfers.find(t=>t.recipientRole===leg.role);
            if(!transfer||!leg.messageHash) return Object.freeze({
                status:"PAYOUT_INDEPENDENT_CHECK_PENDING",payoutId:query.payoutId,autoSettlement:false});
            const proof=await this._independentVerifier.verifyTransfer({
                sourceTransactionId:leg.hash,
                recipientTransactionId:leg.recipientTxHash,
                messageHash:leg.messageHash,
                sourceWalletAddress:query.roomWalletAddress,
                destinationAddress:transfer.address,
                amountAtomic:transfer.netAtomic
            });
            if(proof?.status!=="INDEPENDENT_INDEXED_CREDIT_OBSERVED"
                ||proof.provider!==(this._network==="mainnet"?"tonapi-mainnet":"tonapi-testnet")
                ||proof.sourceTransactionId!==leg.hash
                ||proof.recipientTransactionId!==leg.recipientTxHash
                ||proof.messageHash!==leg.messageHash
                ||proof.amountAtomic!==transfer.netAtomic
                ||canonical(proof.destinationAddress)!==canonical(transfer.address)
                ||canonical(proof.sourceWalletAddress)!==canonical(query.roomWalletAddress)
                ||!Number.isSafeInteger(proof.actualFeeAtomic)
                ||proof.actualFeeAtomic<0)
                return Object.freeze({status:"PAYOUT_INDEPENDENT_CHECK_PENDING",
                    payoutId:query.payoutId,autoSettlement:false});
            verified.push({transfer,proof});
        }
        // After *both* legs were independently verified, append settlements.
        // If the process crashes between the two append operations, the
        // ledger's payoutId:recipientId idempotency key finishes on retry.
        const results=verified.map(({transfer,proof})=>
            this._ledger.settlePayout({
                payoutId:query.payoutId,recipientId:transfer.recipientId,
                executionResult:{
                    transactionId:proof.sourceTransactionId,
                    actualFeeAtomic:proof.actualFeeAtomic,
                    settledAtMs:Date.now()
                }
            })
        );
        return Object.freeze({status:"BOTH_PAYOUTS_SETTLED_FROM_DUAL_FINALITY",
            payoutId:query.payoutId,autoSettlement:true,
            replay:results.every(r=>r.replay===true)});
    }
    /**
     * Settle ONLY the winner when both history providers prove an indexed
     * recipient credit. The owner is a separate, still-open obligation.
     * Read-only: never signs, broadcasts, or infers that the owner was paid.
     */
    async _settleFinalizedWinnerWhileOwnerPending(query) {
        if(typeof this._outgoingObserver?.findOutgoingTransfer!=="function"
            ||typeof this._outgoingObserver?.verifyIndexedRecipientCredit!=="function"
            ||typeof this._independentVerifier?.verifyTransfer!=="function"
            ||typeof this._ledger?.settlePayout!=="function")
            return Object.freeze({settled:false});
        const winner=query.plan?.transfers?.find(x=>x.recipientRole==="WINNER");
        if(!winner?.address || !Number.isSafeInteger(winner.netAtomic)
            ||winner.netAtomic<=0 ||canonical(winner.address)!==canonical(query.winnerWallet))
            return Object.freeze({settled:false});
        const journalPath=join(this._dir,query.payoutId+".jsonl");
        let journal;
        try {journal=JSON.parse(readFileSync(journalPath,"utf8").split("\n")[0]);}
        catch {return Object.freeze({settled:false});}
        const wallet=this._reservation(query.roomId,query.roomWalletAddress);
        if(journal?.payoutId!==query.payoutId ||journal.roomId!==query.roomId
            ||journal.roomNumber!==wallet.roomNumber
            ||journal.winnerAddress!==canonical(winner.address)
            ||journal.winnerAmountAtomic!==winner.netAtomic
            ||!Number.isSafeInteger(journal.timestamp)||journal.timestamp<=0)
            return Object.freeze({settled:false});
        const outgoing=await this._outgoingObserver.findOutgoingTransfer({
            sourceWalletAddress:wallet.address,destinationIdentity:winner.address,
            amountAtomic:winner.netAtomic,minCreatedAtMs:journal.timestamp
        });
        if(!outgoing?.transactionId||outgoing.ambiguous)return Object.freeze({settled:false});
        const credit=await this._outgoingObserver.verifyIndexedRecipientCredit({
            sourceWalletAddress:wallet.address,destinationIdentity:winner.address,
            transactionId:outgoing.transactionId,amountAtomic:winner.netAtomic,
            minCreatedAtMs:journal.timestamp
        });
        if(credit?.status!=="MASTERCHAIN_INDEXED_RECIPIENT_CREDIT_OBSERVED"
            ||credit.globalId!==this._globalId
            ||credit.sourceTransactionId!==outgoing.transactionId
            ||typeof credit.recipientTransactionId!=="string"
            ||credit.recipientTransactionId.length===0
            ||typeof credit.messageHash!=="string"||!credit.messageHash
            ||credit.amountAtomic!==winner.netAtomic
            ||canonical(credit.destinationAddress)!==canonical(winner.address)
            ||credit.sourceFinality!=="finalized"||credit.recipientFinality!=="finalized"
            ||!Number.isSafeInteger(credit.sourceMcBlockSeqno)
            ||!Number.isSafeInteger(credit.recipientMcBlockSeqno)
            ||!Number.isSafeInteger(credit.latestIndexedMcBlockSeqno)
            ||credit.latestIndexedMcBlockSeqno<=credit.sourceMcBlockSeqno
            ||credit.latestIndexedMcBlockSeqno<=credit.recipientMcBlockSeqno)
            return Object.freeze({settled:false});
        const proof=await this._independentVerifier.verifyTransfer({
            sourceTransactionId:outgoing.transactionId,
            recipientTransactionId:credit.recipientTransactionId,
            messageHash:credit.messageHash,
            sourceWalletAddress:wallet.address,
            destinationAddress:winner.address,amountAtomic:winner.netAtomic
        });
        if(proof?.status!=="INDEPENDENT_INDEXED_CREDIT_OBSERVED"
            ||proof.provider!==(this._network==="mainnet"?"tonapi-mainnet":"tonapi-testnet")
            ||proof.sourceTransactionId!==outgoing.transactionId
            ||proof.recipientTransactionId!==credit.recipientTransactionId
            ||proof.messageHash!==credit.messageHash
            ||proof.amountAtomic!==winner.netAtomic
            ||canonical(proof.destinationAddress)!==canonical(winner.address)
            ||canonical(proof.sourceWalletAddress)!==canonical(wallet.address)
            ||!Number.isSafeInteger(proof.actualFeeAtomic)
            ||proof.actualFeeAtomic<0)
            return Object.freeze({settled:false});
        const result=this._ledger.settlePayout({
            payoutId:query.payoutId,recipientId:winner.recipientId,
            executionResult:{
                transactionId:proof.sourceTransactionId,
                actualFeeAtomic:proof.actualFeeAtomic,settledAtMs:Date.now()
            }
        });
        return Object.freeze({settled:true,replay:result.replay===true});
    }
    /**
     * Read-only *diagnostic*, not a terminal payout or permission to recycle.
     * A quote + one RPC balance observation cannot independently prove the
     * OWNER transfer is impossible. Missing durable records or an attempted
     * owner message always produce HOLD, never an "unpaid" settlement.
     */
    async assessOwnerCommissionGasShortfall(query) {
        const hold=reason=>Object.freeze({
            status:"OWNER_GAS_SHORTFALL_ASSESSMENT_HOLD",reason,
            payoutId:query?.payoutId??null,terminal:false,walletReleasable:false
        });
        if(typeof query?.payoutId!=="string"||!SAFE_PAYOUT_ID.test(query.payoutId)
            ||query?.plan?.payoutId!==query.payoutId
            ||query.plan.roomId!==query.roomId
            ||query.plan.network!==this._network
            ||!Array.isArray(query.plan.transfers)||query.plan.transfers.length!==2)
            return hold("PAYOUT_ASSESSMENT_PLAN_INVALID");
        let wallet;
        try {wallet=this._reservation(query.roomId,query.roomWalletAddress);}
        catch {return hold("PAYOUT_ASSESSMENT_WALLET_MISMATCH");}
        const obligations=this._ledger?.listPayoutObligations?.(query.roomId);
        if(!Array.isArray(obligations)||obligations.length!==2
            ||obligations.some(x=>x.payoutId!==query.payoutId))
            return hold("PAYOUT_ASSESSMENT_LEDGER_INCOMPLETE");
        const winner=obligations.find(x=>x.role==="WINNER");
        const owner=obligations.find(x=>x.role==="OWNER");
        if(winner?.settled!==true||owner?.settled!==false
            ||!Number.isSafeInteger(owner.netAtomic)||owner.netAtomic<=0
            ||query.plan.transfers.find(x=>x.recipientRole==="OWNER")?.netAtomic
                !==owner.netAtomic)
            return hold("PAYOUT_ASSESSMENT_WINNER_UNFINALIZED_OR_OWNER_CLOSED");

        try {
            if(canonical(query.plan.transfers.find(x=>x.recipientRole==="OWNER")?.address)
                !==canonical(query.ownerWallet))
                return hold("PAYOUT_ASSESSMENT_OWNER_ADDRESS_MISMATCH");
        } catch {return hold("PAYOUT_ASSESSMENT_OWNER_ADDRESS_MISMATCH");}
        const intent=join(this._dir,query.payoutId+".OWNER.json");
        const outbox=typeof this._adapter?._sequenceStateDir==="string"
            ?join(this._adapter._sequenceStateDir,"transfers",
                createHash("sha256").update(query.payoutId+":OWNER").digest("hex")+".json")
            :null;
        if(this._adapter?.supportsDurableTransferRetry?.()!==true||!outbox)
            return hold("PAYOUT_ASSESSMENT_DURABLE_OUTBOX_REQUIRED");
        // A previously claimed or signed owner BOC may still land on-chain.
        if(existsSync(intent)||existsSync(outbox))
            return hold("PAYOUT_ASSESSMENT_OWNER_ATTEMPT_AMBIGUOUS");
        const journal=join(this._dir,query.payoutId+".jsonl");
        if(!existsSync(journal))return hold("PAYOUT_ASSESSMENT_JOURNAL_MISSING");
        try {
            const first=JSON.parse(readFileSync(journal,"utf8").split("\n")[0]);
            const winTransfer=query.plan.transfers.find(x=>x.recipientRole==="WINNER");
            const ownerTransfer=query.plan.transfers.find(x=>x.recipientRole==="OWNER");
            if(first.payoutId!==query.payoutId||first.roomId!==query.roomId
                ||first.roomNumber!==wallet.roomNumber
                ||first.winnerAddress!==canonical(winTransfer.address)
                ||first.ownerAddress!==canonical(ownerTransfer.address)
                ||first.ownerAmountAtomic!==owner.netAtomic)
                return hold("PAYOUT_ASSESSMENT_JOURNAL_MISMATCH");
        }catch {return hold("PAYOUT_ASSESSMENT_JOURNAL_UNREADABLE");}
        if(typeof this._adapter.canFundTransfer!=="function")
            return hold("PAYOUT_ASSESSMENT_RPC_UNAVAILABLE");
        let funding;
        try {
            funding=await this._adapter.canFundTransfer({
                roomNumber:wallet.roomNumber,amountNano:BigInt(owner.netAtomic),
                sourceReserveNano:0n
            });
            if(funding?.roomNumber!==wallet.roomNumber
                ||canonical(funding.address)!==canonical(wallet.address)
                ||typeof funding.balanceNano!=="bigint"||funding.balanceNano<0n)
                return hold("PAYOUT_ASSESSMENT_RPC_INVALID");
        } catch {return hold("PAYOUT_ASSESSMENT_RPC_UNAVAILABLE");}

        const due=BigInt(owner.netAtomic);
        // The approved terminal path stops here unless OWNER principal is
        // itself underfunded, or is exactly equal to the wallet balance.
        if(funding.balanceNano>due)
            return hold("PAYOUT_ASSESSMENT_OUTSIDE_APPROVED_SCOPE");

        // Below the owner principal, a fee quote is unnecessary: no exact
        // OWNER transfer could be sent even if the fee were zero. For an
        // equality balance, require an independently obtained POSITIVE fee
        // estimate, since only the source-side fee causes the shortfall.
        let estimatedFeeNano=null;
        if(funding.balanceNano===due) {
            if(typeof this._adapter.estimateOutboundTransferFee!=="function")
                return hold("PAYOUT_ASSESSMENT_FEE_ESTIMATE_UNAVAILABLE");
            try {
                const quote=await this._adapter.estimateOutboundTransferFee({
                    roomNumber:wallet.roomNumber,destination:query.ownerWallet,
                    amountNano:due,bounce:false
                });
                if(quote?.ok!==true||quote.roomNumber!==wallet.roomNumber
                    ||typeof quote.totalNano!=="bigint"||quote.totalNano<=0n
                    ||quote.amountNano!==due
                    ||canonical(quote.destination)!==canonical(query.ownerWallet))
                    return hold("PAYOUT_ASSESSMENT_FEE_ESTIMATE_INVALID");
                estimatedFeeNano=quote.totalNano;
            } catch {return hold("PAYOUT_ASSESSMENT_FEE_ESTIMATE_UNAVAILABLE");}
        }
        const shortfall=due-funding.balanceNano+(estimatedFeeNano??0n);
        return Object.freeze({
            status:"OWNER_GAS_SHORTFALL_CANDIDATE_READ_ONLY",
            payoutId:query.payoutId,network:this._network,
            ownerDueAtomic:owner.netAtomic,
            balanceAtomic:funding.balanceNano.toString(),
            estimatedFeeAtomic:estimatedFeeNano?.toString()??null,
            estimatedShortfallAtomic:shortfall.toString(),
            // This is not a second independent balance/finality source.
            terminal:false,walletReleasable:false
        });
    }
    /**
     * Two independently operated sources must agree on a balance below the
     * OWNER TRANSFER AMOUNT ITSELF. A fee quote is deliberately excluded from
     * the terminal-candidate threshold: an inaccurate fee forecast cannot
     * justify writing off somebody's money.
     *
     * Both observations are taken after the winner ledger settlement. Even
     * this corroboration is READ ONLY: it is not a durable, seqno-locked
     * terminal decision or authority to recycle the wallet.
     */
    async corroborateOwnerPrincipalShortfall(query) {
        const hold=reason=>Object.freeze({
            status:"OWNER_PRINCIPAL_SHORTFALL_HOLD",reason,
            payoutId:query?.payoutId??null,terminal:false,walletReleasable:false
        });
        const start=Date.now();
        const first=await this.assessOwnerCommissionGasShortfall(query);
        if(first?.status!=="OWNER_GAS_SHORTFALL_CANDIDATE_READ_ONLY")
            return hold(first?.reason??"OWNER_PRINCIPAL_SHORTFALL_NOT_CANDIDATE");
        const due=BigInt(first.ownerDueAtomic);
        const amount=BigInt(first.balanceAtomic);
        if(amount>due)return hold("OWNER_PRINCIPAL_STILL_FUNDED");
        if(typeof this._independentVerifier?.observeAccountBalance!=="function")
            return hold("OWNER_INDEPENDENT_BALANCE_SOURCE_MISSING");
        let second;
        try {
            second=await this._independentVerifier.observeAccountBalance({
                address:query.roomWalletAddress
            });
        } catch {return hold("OWNER_INDEPENDENT_BALANCE_READ_FAILED");}
        const now=Date.now();
        if(second?.status!=="INDEPENDENT_ACCOUNT_BALANCE_OBSERVED"
            ||second.network!==this._network
            ||second.provider!==(this._network==="mainnet"?"tonapi-mainnet":"tonapi-testnet")
            ||!Number.isSafeInteger(second.observedAtMs)
            ||second.observedAtMs<start||second.observedAtMs>now
            ||now-start>10_000
            ||typeof second.balanceAtomic!=="string"
            ||!/^(0|[1-9][0-9]*)$/.test(second.balanceAtomic))
            return hold("OWNER_INDEPENDENT_BALANCE_UNVERIFIED");
        try {
            if(canonical(second.address)!==canonical(query.roomWalletAddress)
                ||BigInt(second.balanceAtomic)!==amount)
                return hold("OWNER_BALANCE_SOURCES_DISAGREE");
        } catch {return hold("OWNER_INDEPENDENT_BALANCE_IDENTITY_INVALID");}
        // Re-query the original RPC after TonAPI replies. Both providers can
        // legitimately lag, and a wallet balance can change during two reads.
        // Any disagreement (even within the eligible shortfall range) holds.
        let third;
        try {
            third=await this._adapter.canFundTransfer({
                roomNumber:this._reservation(query.roomId,query.roomWalletAddress).roomNumber,
                amountNano:due,sourceReserveNano:0n
            });
            if(typeof third?.balanceNano!=="bigint"
                ||third.balanceNano!==amount
                ||canonical(third.address)!==canonical(query.roomWalletAddress)
                ||third.roomNumber!==this._reservation(query.roomId,query.roomWalletAddress).roomNumber
                ||Date.now()-start>10_000)
                return hold("OWNER_BALANCE_CHANGED_DURING_INDEPENDENT_CHECK");
        } catch {return hold("OWNER_BALANCE_RECHECK_UNAVAILABLE");}
        // A concurrent OWNER claim can appear while the two providers query.
        // Recheck after the last RPC. This is not an atomic release barrier.
        const intent=join(this._dir,query.payoutId+".OWNER.json");
        const seqDir=this._adapter?._sequenceStateDir;
        const outbox=typeof seqDir==="string"
            ?join(seqDir,"transfers",createHash("sha256")
                .update(query.payoutId+":OWNER").digest("hex")+".json"):null;
        if(existsSync(intent)||!outbox||existsSync(outbox))
            return hold("OWNER_OUTBOUND_CLAIM_RACE_OR_AMBIGUITY");
        return Object.freeze({
            status:"OWNER_PRINCIPAL_SHORTFALL_CORROBORATED_READ_ONLY",
            payoutId:query.payoutId,
            network:this._network,
            ownerDueAtomic:first.ownerDueAtomic,
            toncenterBalanceAtomic:first.balanceAtomic,
            tonapiBalanceAtomic:second.balanceAtomic,
            tonapiObservedAtMs:second.observedAtMs,
            estimatedFeeAtomic:first.estimatedFeeAtomic,
            // Never use an unaudited read-only observation to mark the owner
            // paid, waive their commission or release a wallet.
            terminal:false,walletReleasable:false
        });
    }
    /** Durable one-shot unpaid OWNER decision. Exclusive OWNER intent file
     * is the exact same arbitration point used by submit(): a concurrent
     * sender wins OR the terminal claim wins, never both.
     *
     * Only a verified, post-winner, two-source deficiency in the principal
     * itself may close the OWNER obligation without an on-chain transfer.
     */
    async finalizeOwnerPrincipalShortfall(query) {
        const hold=reason=>Object.freeze({status:"OWNER_SHORTFALL_TERMINAL_HOLD",
            reason,payoutId:query?.payoutId??null});
        if(typeof query?.payoutId!=="string"||!SAFE_PAYOUT_ID.test(query.payoutId))
            return hold("OWNER_TERMINAL_PAYOUT_ID_INVALID");
        const owner=query?.plan?.transfers?.find(x=>x.recipientRole==="OWNER");
        if(!owner?.address||!Number.isSafeInteger(owner.netAtomic)||owner.netAtomic<=0
            ||query?.plan?.payoutId!==query.payoutId
            ||query?.plan?.roomId!==query.roomId
            ||query.plan.network!==this._network)
            return hold("OWNER_TERMINAL_PLAN_INVALID");
        const rolePath=join(this._dir,query.payoutId+".OWNER.json");
        const seqDir=this._adapter?._sequenceStateDir;
        if(this._adapter?.supportsDurableTransferRetry?.()!==true
            ||typeof seqDir!=="string"
            ||typeof this._ledger?.terminateOwnerCommissionUnpaid!=="function")
            return hold("OWNER_TERMINAL_DURABILITY_UNAVAILABLE");
        let wallet;
        try {wallet=this._reservation(query.roomId,query.roomWalletAddress);}
        catch{return hold("OWNER_TERMINAL_WALLET_MISMATCH");}
        const signedPath=join(seqDir,"transfers",createHash("sha256")
            .update(query.payoutId+":OWNER").digest("hex")+".json");
        const finishExisting=()=>{
            let record;
            try {record=JSON.parse(readFileSync(rolePath,"utf8"));}
            catch {return hold("OWNER_TERMINAL_RECORD_UNREADABLE");}
            if(record?.state!=="OWNER_COMMISSION_UNPAID_GAS_SHORTAGE_TERMINAL"
                ||record.payoutId!==query.payoutId||record.role!=="OWNER"
                ||record.roomId!==query.roomId
                ||record.roomNumber!==wallet.roomNumber
                ||record.amountAtomic!==owner.netAtomic
                ||canonical(record.destination)!==canonical(owner.address)
                ||existsSync(signedPath))
                return hold("OWNER_TERMINAL_RECORD_CONFLICT_OR_SIGNED_BOC");
            try {
                const booked=this._ledger.terminateOwnerCommissionUnpaid({
                    payoutId:query.payoutId,recipientId:owner.recipientId,
                    evidence:record.evidence
                });
                return Object.freeze({
                    status:"OWNER_COMMISSION_UNPAID_GAS_SHORTAGE_TERMINAL",
                    payoutId:query.payoutId,ownerPaid:false,
                    unpaidAtomic:owner.netAtomic,
                    replay:booked.replay===true
                });
            } catch {return hold("OWNER_TERMINAL_LEDGER_VALIDATION_FAILED");}
        };
        if(existsSync(rolePath))return finishExisting();
        if(existsSync(signedPath))
            return hold("OWNER_TERMINAL_PREVIOUS_BOC_AMBIGUOUS");
        const evidence=await this.corroborateOwnerPrincipalShortfall(query);
        if(evidence.status!=="OWNER_PRINCIPAL_SHORTFALL_CORROBORATED_READ_ONLY")
            return hold(evidence.reason??"OWNER_TERMINAL_EVIDENCE_INCOMPLETE");
        // Atomic EEXIST arbitration with the actual V4 OWNER pre-send claim.
        try {
            durableWriteJson(rolePath,{
                payoutId:query.payoutId,roomId:query.roomId,
                roomNumber:wallet.roomNumber,role:"OWNER",
                amountAtomic:owner.netAtomic,destination:canonical(owner.address),
                state:"OWNER_COMMISSION_UNPAID_GAS_SHORTAGE_TERMINAL",
                evidence,timestamp:Date.now()
            },{exclusive:true});
        } catch(error) {
            if(error?.code==="EEXIST")
                return hold("OWNER_TERMINAL_CONCURRENT_CLAIM");
            throw error;
        }
        // An interruption after role claim but before ledger append is
        // replayed via finishExisting without sending a new transaction.
        return finishExisting();
    }

    /**
     * Mainnet restart recovery uses the ORIGINAL Testnet resumeUnattempted()
     * only when the winner's pre-broadcast intent AND exact signed WalletV4
     * outbox have both survived. A missing ledger/journal/outbox file is not
     * evidence that no transfer was sent: NEVER manufacture a replacement.
     * An unclaimed owner leg may start only after the winner is independently
     * indexed by the existing submit() path. Ambiguous claimed legs replay
     * only their original persisted BOC under the adapter's seqno lock.
     *
     * Testnet's existing resume API and behavior are unchanged.
     */
    async resumeMainnetDurableAfterRestart(query) {
        assert(this._network==="mainnet","PAYOUT_MAINNET_RECOVERY_NETWORK_REQUIRED");
        const hold=reason=>Object.freeze({status:"PAYOUT_DURABLE_RECOVERY_HOLD",
            reason,payoutId:query?.payoutId??null});
        if(typeof query?.payoutId!=="string"||!SAFE_PAYOUT_ID.test(query.payoutId))
            return hold("PAYOUT_RECOVERY_ID_INVALID");
        const plan=query.plan;
        if(plan?.network!=="mainnet"||plan.roomId!==query.roomId
            ||plan.payoutId!==query.payoutId
            ||!Array.isArray(plan.transfers)||plan.transfers.length!==2)
            return hold("PAYOUT_RECOVERY_PLAN_INVALID");
        const winner=plan.transfers.find(x=>x.recipientRole==="WINNER");
        const owner=plan.transfers.find(x=>x.recipientRole==="OWNER");
        if(!winner?.address||!owner?.address
            ||!Number.isSafeInteger(winner.netAtomic)||winner.netAtomic<=0
            ||!Number.isSafeInteger(owner.netAtomic)||owner.netAtomic<=0)
            return hold("PAYOUT_RECOVERY_TRANSFERS_INVALID");
        let wallet;
        try {wallet=this._reservation(query.roomId,query.roomWalletAddress);}
        catch {return hold("PAYOUT_RECOVERY_WALLET_MISMATCH");}
        if(this._adapter.supportsDurableTransferRetry?.()!==true
            ||typeof this._adapter._sequenceStateDir!=="string")
            return hold("PAYOUT_RECOVERY_DURABLE_ADAPTER_MISSING");
        const journal=join(this._dir,query.payoutId+".jsonl");
        if(!existsSync(journal))
            return hold("PAYOUT_RECOVERY_JOURNAL_MISSING");
        try {
            const first=JSON.parse(readFileSync(journal,"utf8").split("\n")[0]);
            if(first.journalVersion!==3||first.durableRetry!==true
                ||first.payoutId!==query.payoutId||first.roomId!==query.roomId
                ||first.roomNumber!==wallet.roomNumber
                ||!Number.isSafeInteger(first.timestamp)
                ||canonical(first.winnerAddress)!==canonical(winner.address)
                ||canonical(first.ownerAddress)!==canonical(owner.address)
                ||first.winnerAmountAtomic!==winner.netAtomic
                ||first.ownerAmountAtomic!==owner.netAtomic)
                return hold("PAYOUT_RECOVERY_JOURNAL_MISMATCH");
            const checkLeg=(role,transfer)=>{
                const intentPath=join(this._dir,query.payoutId+"."+role+".json");
                const key=createHash("sha256")
                    .update(query.payoutId+":"+role).digest("hex");
                const signedPath=join(this._adapter._sequenceStateDir,
                    "transfers",key+".json");
                const claimed=existsSync(intentPath),signed=existsSync(signedPath);
                // One-sided persistence, including a claimed-but-unsaved BOC,
                // is an ambiguous crash window. No new message is signed.
                if(claimed!==signed)return "MISMATCH";
                if(!claimed)return "ABSENT";
                const intent=JSON.parse(readFileSync(intentPath,"utf8"));
                const outbox=JSON.parse(readFileSync(signedPath,"utf8"));
                if(intent.payoutId!==query.payoutId||intent.role!==role
                    ||intent.state!=="SUBMISSION_UNKNOWN"
                    ||intent.amountAtomic!==transfer.netAtomic
                    ||canonical(intent.destination)!==canonical(transfer.address)
                    ||outbox.transferKey!==key
                    ||outbox.roomNumber!==wallet.roomNumber
                    ||canonical(outbox.source)!==canonical(wallet.address)
                    ||canonical(outbox.destination)!==canonical(transfer.address)
                    ||outbox.amountNano!==String(transfer.netAtomic)
                    ||outbox.bounce!==false||outbox.queryId!==null
                    ||!Number.isSafeInteger(outbox.seqno)||outbox.seqno<0
                    ||!Number.isSafeInteger(outbox.validUntil)
                    ||typeof outbox.boc!=="string"||!outbox.boc
                    ||outbox.bocHash!==createHash("sha256")
                        .update(outbox.boc).digest("hex"))
                    return "MISMATCH";
                return "SIGNED";
            };
            if(checkLeg("WINNER",winner)!=="SIGNED")
                return hold("PAYOUT_RECOVERY_WINNER_PROOF_MISSING");
            const ownerPath=join(this._dir,query.payoutId+".OWNER.json");
            if(existsSync(ownerPath)) {
                const record=JSON.parse(readFileSync(ownerPath,"utf8"));
                if(record.state==="OWNER_COMMISSION_UNPAID_GAS_SHORTAGE_TERMINAL")
                    return this.finalizeOwnerPrincipalShortfall(query);
            }
            if(checkLeg("OWNER",owner)==="MISMATCH")
                return hold("PAYOUT_RECOVERY_OWNER_PROOF_MISMATCH");
        } catch {
            return hold("PAYOUT_RECOVERY_RECORD_UNREADABLE");
        }
        // Existing Testnet transport code: confirms winner before any new
        // owner claim, then enforces exactly the same signed BOC / seqno gate.
        return this.resumeUnattempted(query);
    }
    async resumeUnattempted(query) {
        await this.submit({...query, resume:true});
        return this.reconcileAndSettle(query);
    }
    async submit({roomId,payoutId,roomWalletAddress,winnerWallet,ownerWallet,plan,resume=false}) {
        assert(typeof payoutId==="string"&&SAFE_PAYOUT_ID.test(payoutId),
            "PAYOUT_IDENTIFIER_INVALID");
        const wallet=this._reservation(roomId,roomWalletAddress);
        const winner=plan?.transfers?.find(x=>x.recipientRole==="WINNER");
        const owner=plan?.transfers?.find(x=>x.recipientRole==="OWNER");
        PayoutPlan.fromJSON(plan);
        assert(plan.roomId===roomId && plan.payoutId===payoutId
            && (this._network!=="mainnet" || plan.network==="mainnet")
            && Number.isSafeInteger(plan.gasReserveAtomic)
            && plan.gasReserveAtomic > 0
            && Array.isArray(plan.transfers)&&plan.transfers.length===2
            && winner?.netAtomic>0&&owner?.netAtomic>0
            && winner.netAtomic===winner.grossAtomic
            && owner.netAtomic===owner.grossAtomic
            && winner.reservedFeeAtomic===0&&owner.reservedFeeAtomic===0
            && canonical(winner.address)===canonical(winnerWallet)
            && canonical(owner.address)===canonical(ownerWallet)
            && winner.netAtomic+owner.netAtomic
                +plan.gasReserveAtomic===plan.principalAtomic,
            "PAYOUT_PLAN_NOT_AUTHORIZED");
        const path=join(this._dir,payoutId+".jsonl");
        let initial={journalVersion:3,payoutId,roomId,roomNumber:wallet.roomNumber,
            durableRetry:this._adapter.supportsDurableTransferRetry?.()===true,
            winnerAddress:canonical(winner.address),ownerAddress:canonical(owner.address),
            winnerAmountAtomic:winner.netAtomic,ownerAmountAtomic:owner.netAtomic,
            state:"SUBMISSION_UNKNOWN",timestamp:Date.now()};
        // The claim is durable BEFORE either transaction can be submitted.
        try{logEvent(path,initial,true);}catch(e){
            if(e?.code!=="EEXIST") throw e;
            const original = JSON.parse(readFileSync(path,'utf8').split('\n')[0]);
            for (const key of ['payoutId','roomId','roomNumber','winnerAddress','ownerAddress','winnerAmountAtomic','ownerAmountAtomic']) assert(original[key] === initial[key], 'PAYOUT_JOURNAL_IDENTITY_MISMATCH');
            if (!resume || ![2,3].includes(original.journalVersion)) return Object.freeze({status:'ALREADY_ATTEMPTED_NEEDS_RECONCILIATION',payoutId});
            initial = original;
        }
        const durableRetry = initial.journalVersion === 3 && initial.durableRetry
            && this._adapter.supportsDurableTransferRetry?.() === true;
        const amounts=[{role:"WINNER",transfer:winner,reserve:BigInt(owner.netAtomic+
            plan.gasReserveAtomic)},
            {role:"OWNER",transfer:owner,reserve:BigInt(plan.gasReserveAtomic)}];
        for(const {role,transfer,reserve} of amounts){
            if(role==="OWNER" && durableRetry
                && typeof this._adapter.canFundTransfer==="function") {
                let funding;
                try {
                    funding=await this._adapter.canFundTransfer({
                        roomNumber:wallet.roomNumber,
                        amountNano:BigInt(owner.netAtomic),
                        sourceReserveNano:0n
                    });
                } catch {
                    return Object.freeze({status:"OWNER_BALANCE_READ_PENDING",role,payoutId});
                }
                if(funding?.ok===false || (typeof funding?.balanceNano==="bigint"
                    &&funding.balanceNano===BigInt(owner.netAtomic))) {
                    try {
                        await this._settleFinalizedWinnerWhileOwnerPending({
                            roomId,payoutId,roomWalletAddress,winnerWallet,ownerWallet,plan
                        });
                        const closed=await this.finalizeOwnerPrincipalShortfall({
                            roomId,payoutId,roomWalletAddress,winnerWallet,ownerWallet,plan
                        });
                        if(closed.status==="OWNER_COMMISSION_UNPAID_GAS_SHORTAGE_TERMINAL")
                            return closed;
                    } catch { /* Hold the original, unpaid OWNER obligation. */ }
                    // Avoid claiming and signing an OWNER transfer when even
                    // its principal cannot be funded. Recovery may recheck.
                    return Object.freeze({status:"OWNER_PRINCIPAL_UNDERFUNDED_HOLD",
                        role,payoutId});
                }
                if(funding?.ok!==true)
                    return Object.freeze({status:"OWNER_BALANCE_UNVERIFIED_HOLD",role,payoutId});
            }
            // Exclusive per-leg intent is published before calling the signer.
            // A durable adapter retries only the exact persisted message. Older
            // attempts without that payload remain observation-only.
            try { durableWriteJson(join(this._dir, payoutId + '.' + role + '.json'),
                {payoutId, role, amountAtomic:transfer.netAtomic, destination:canonical(transfer.address), state:'SUBMISSION_UNKNOWN'}, {exclusive:true}); }
            catch (error) {
                if (error.code !== 'EEXIST') throw error;
                if(role==="OWNER") {
                    let current;
                    try {current=JSON.parse(readFileSync(
                        join(this._dir,payoutId+".OWNER.json"),"utf8"));}
                    catch {return Object.freeze({status:"OWNER_PRE_SEND_CLAIM_UNREADABLE_HOLD",role,payoutId});}
                    if(current.state==="OWNER_COMMISSION_UNPAID_GAS_SHORTAGE_TERMINAL")
                        return this.finalizeOwnerPrincipalShortfall({
                            roomId,payoutId,roomWalletAddress,winnerWallet,ownerWallet,plan
                        });
                    if(current.state!=="SUBMISSION_UNKNOWN")
                        return Object.freeze({status:"OWNER_PRE_SEND_CLAIM_UNKNOWN_HOLD",role,payoutId});
                }
                if (role === 'WINNER') {
                    const journal = readFileSync(path,'utf8').trim().split('\n').map(line => JSON.parse(line));
                    const confirmed = await this._confirmWinnerCredit({
                        sourceWalletAddress: wallet.address,
                        winnerWallet: winner.address,
                        amountAtomic: winner.netAtomic,
                        minCreatedAtMs: journal[0].timestamp
                    });
                    if (confirmed) continue;
                    if (!durableRetry)
                        return {status:'WINNER_CONFIRMATION_PENDING',role,payoutId};
                }
                if (!durableRetry) continue;
            }
            let receipt;
            try {
                receipt=await this._adapter.sendTransfer({
                    roomNumber:wallet.roomNumber,destination:transfer.address,
                    amountNano:BigInt(transfer.netAtomic),bounce:false,
                    sourceReserveNano:reserve,
                    ...(durableRetry ? {idempotencyKey:payoutId+':'+role} : {})
                });
            } catch {
                logEvent(path,{role,state:"SUBMISSION_UNKNOWN",timestamp:Date.now()},false);
                return Object.freeze({status:"SUBMISSION_UNKNOWN",role,payoutId});
            }
            const status=receipt?.ok===true
                ? "SUBMITTED_UNCONFIRMED" : "SUBMISSION_UNKNOWN";
            logEvent(path,{role,state:status,
                txHash:receipt?.txHash??null,timestamp:Date.now()},false);
            if(status!=="SUBMITTED_UNCONFIRMED")
                return Object.freeze({status,role,payoutId});
            if (role === "WINNER") {
                const confirmed = await this._confirmWinnerCredit({
                    sourceWalletAddress: wallet.address,
                    winnerWallet: winner.address,
                    amountAtomic: winner.netAtomic,
                    minCreatedAtMs: initial.timestamp
                });
                if (!confirmed) {
                    return Object.freeze({status:"WINNER_CONFIRMATION_PENDING",role,payoutId});
                }
            }
        }
        // Blockchain finality is separately required before ledger settlement.
        return Object.freeze({status:"SUBMITTED_UNCONFIRMED",payoutId});
    }

    async _confirmWinnerCredit({sourceWalletAddress,winnerWallet,amountAtomic,minCreatedAtMs}) {
        if (typeof this._outgoingObserver?.findOutgoingTransfer !== "function"
            || typeof this._outgoingObserver?.verifyIndexedRecipientCredit !== "function") {
            return false;
        }
        const outgoing = await this._outgoingObserver.findOutgoingTransfer({
            sourceWalletAddress,
            destinationIdentity: winnerWallet,
            amountAtomic,
            minCreatedAtMs
        });
        if (!outgoing?.transactionId || outgoing.ambiguous) return false;
        const credit = await this._outgoingObserver.verifyIndexedRecipientCredit({
            sourceWalletAddress,
            destinationIdentity: winnerWallet,
            transactionId: outgoing.transactionId,
            amountAtomic,
            minCreatedAtMs
        });
        return credit?.status === "MASTERCHAIN_INDEXED_RECIPIENT_CREDIT_OBSERVED"
            && credit.sourceTransactionId === outgoing.transactionId
            && typeof credit.recipientTransactionId === 'string'
            && credit.recipientTransactionId.length > 0
            && credit.amountAtomic === amountAtomic
            && canonical(credit.destinationAddress) === canonical(winnerWallet)
            && credit.globalId === this._globalId
            && credit.sourceFinality === "finalized"
            && credit.recipientFinality === "finalized"
            && Number.isSafeInteger(credit.sourceMcBlockSeqno)
            && Number.isSafeInteger(credit.recipientMcBlockSeqno)
            && Number.isSafeInteger(credit.latestIndexedMcBlockSeqno)
            && credit.latestIndexedMcBlockSeqno > credit.sourceMcBlockSeqno
            && credit.latestIndexedMcBlockSeqno > credit.recipientMcBlockSeqno;
    }
}
