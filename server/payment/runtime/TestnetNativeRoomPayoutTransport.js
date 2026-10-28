import { durableWriteJson } from '../DurableJson.js';
/**
 * Native Wallet V4 outbound transport, reusing the historical RoomWalletAdapter.
 * Fee quotes come from the Testnet RPC. One pre-broadcast durable claim
 * prevents restart/concurrent replay from ever sending the same payout again.
 * No escrow/game contract, Jetton, Mainnet or blockchain finality claim.
 */
import {mkdirSync,openSync,writeSync,fsyncSync,closeSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {RoomWalletAdapter} from "../roomWallet/RoomWalletAdapter.js";
import {buildRecipientGasCharge,ROOM_WALLET_POLICY} from "../roomWallet/RoomWalletFinancialPolicy.js";
import {deriveTonAddressIdentity} from "../incoming/TonAddressIdentity.js";

const SAFE_PAYOUT_ID=/^payout_[a-f0-9]{32}$/;
const RETAINED_NANO=0n;
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
        outgoingObserver=null,independentVerifier=null,ledger=null}={}) {
        assert(walletPool && typeof dataDir==="string" && dataDir,"PAYOUT_RUNTIME_UNAVAILABLE");
        assert(adapter || (walletResolver && tonService),"PAYOUT_WALLET_ADAPTER_MISSING");
        this._pool=walletPool;
        this._outgoingObserver=outgoingObserver;
        this._independentVerifier=independentVerifier;
        this._ledger=ledger;
        this._adapter=adapter ?? new RoomWalletAdapter({
            walletResolver,tonService,logger,gasReserveNano:RETAINED_NANO
        });
        this._dir=join(dataDir,"testnet-native-payout-attempts");
        mkdirSync(this._dir,{recursive:true,mode:0o700});
    }
    _reservation(roomId,claimedAddress) {
        const wallet=this._pool.getReservationForRoom(roomId);
        assert(wallet && wallet.reservedByRoomId===roomId
            && wallet.roomNumber!==1
            && canonical(wallet.address)===canonical(claimedAddress),
            "PAYOUT_ROOM_WALLET_MISMATCH");
        return wallet;
    }
    async quote({roomId,roomWallet,winnerWallet,ownerWallet,principalAtomic}) {
        const wallet=this._reservation(roomId,roomWallet);
        assert(Number.isSafeInteger(principalAtomic)&&principalAtomic>0,
            "PAYOUT_PRINCIPAL_INVALID");
        const winnerGross=BigInt(principalAtomic)*95n/100n;
        const ownerGross=BigInt(principalAtomic)-winnerGross-RETAINED_NANO;
        assert(ownerGross>0n,"PAYOUT_OWNER_NONPOSITIVE");
        const quote=async (address,amountNano)=>{
            const result=await this._adapter.estimateOutboundTransferFee({
                roomNumber:wallet.roomNumber,destination:canonical(address),
                amountNano,bounce:false
            });
            assert(result?.ok===true && typeof result.totalNano==="bigint"
                && result.totalNano>=0n,"PAYOUT_TESTNET_FEE_QUOTE_UNAVAILABLE");
            return feeToNumber(buildRecipientGasCharge({
                feeEstimateTotalNano:result.totalNano,
                marginBps:ROOM_WALLET_POLICY.recipientGasMarginBps,
                marginFloorNano:ROOM_WALLET_POLICY.recipientGasMarginFloorNano
            }).recipientGasChargeNano);
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
                    &&(!hasMasterchainCheck || (value.globalId===-3
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
        if(observed.status!=="BOTH_MASTERCHAIN_INDEXED_CREDITS_OBSERVED_UNFINALIZED")
            return Object.freeze({...observed,autoSettlement:false});
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
                ||proof.provider!=="tonapi-testnet"
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
        assert(plan.roomId===roomId && plan.payoutId===payoutId
            && plan.safetyMarginAtomic===Number(RETAINED_NANO)
            && Array.isArray(plan.transfers)&&plan.transfers.length===2
            && winner?.netAtomic>0&&owner?.netAtomic>0
            && canonical(winner.address)===canonical(winnerWallet)
            && canonical(owner.address)===canonical(ownerWallet)
            && winner.netAtomic+owner.netAtomic
                +winner.reservedFeeAtomic+owner.reservedFeeAtomic
                +plan.safetyMarginAtomic===plan.principalAtomic,
            "PAYOUT_PLAN_NOT_AUTHORIZED");
        const path=join(this._dir,payoutId+".jsonl");
        const initial={journalVersion:2,payoutId,roomId,roomNumber:wallet.roomNumber,
            winnerAddress:canonical(winner.address),ownerAddress:canonical(owner.address),
            winnerAmountAtomic:winner.netAtomic,ownerAmountAtomic:owner.netAtomic,
            state:"SUBMISSION_UNKNOWN",timestamp:Date.now()};
        // The claim is durable BEFORE either transaction can be submitted.
        try{logEvent(path,initial,true);}catch(e){
            if(e?.code!=="EEXIST") throw e;
            const original = JSON.parse(readFileSync(path,'utf8').split('\n')[0]);
            for (const key of ['payoutId','roomId','roomNumber','winnerAddress','ownerAddress','winnerAmountAtomic','ownerAmountAtomic']) assert(original[key] === initial[key], 'PAYOUT_JOURNAL_IDENTITY_MISMATCH');
            if (!resume || original.journalVersion !== 2) return Object.freeze({status:'ALREADY_ATTEMPTED_NEEDS_RECONCILIATION',payoutId});
        }
        const amounts=[{role:"WINNER",transfer:winner,reserve:BigInt(owner.netAtomic+
            owner.reservedFeeAtomic)+RETAINED_NANO},
            {role:"OWNER",transfer:owner,reserve:RETAINED_NANO}];
        for(const {role,transfer,reserve} of amounts){
            // Exclusive per-leg intent is published before calling the signer.
            // Existing claims are never retried, including ambiguous crashes.
            try { durableWriteJson(join(this._dir, payoutId + '.' + role + '.json'),
                {payoutId, role, amountAtomic:transfer.netAtomic, destination:canonical(transfer.address), state:'SUBMISSION_UNKNOWN'}, {exclusive:true}); }
            catch (error) {
                if (error.code !== 'EEXIST') throw error;
                if (role === 'WINNER') {
                    const journal = readFileSync(path,'utf8').trim().split('\n').map(line => JSON.parse(line));
                    const accepted = journal.some(row => row.role === 'WINNER' && row.state === 'SUBMITTED_UNCONFIRMED');
                    if (!accepted) {
                        const observed = await this._outgoingObserver?.findOutgoingTransfer?.({sourceWalletAddress:wallet.address,
                            destinationIdentity:winner.address, amountAtomic:winner.netAtomic, minCreatedAtMs:journal[0].timestamp});
                        if (!observed?.transactionId || observed.ambiguous) return {status:'SUBMISSION_UNKNOWN',role,payoutId};
                    }
                }
                continue;
            }
            let receipt;
            try {
                receipt=await this._adapter.sendTransfer({
                    roomNumber:wallet.roomNumber,destination:transfer.address,
                    amountNano:BigInt(transfer.netAtomic),bounce:false,
                    sourceReserveNano:reserve
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
        }
        // Blockchain finality is separately required before ledger settlement.
        return Object.freeze({status:"SUBMITTED_UNCONFIRMED",payoutId});
    }
}
