import { durableWriteJson } from '../DurableJson.js';
/**
 * Native Wallet V4 outbound transport, reusing the historical RoomWalletAdapter.
 * Optional fee quotes may be read from the Testnet RPC for diagnostics; they
 * never gate a transfer. One pre-broadcast durable claim prevents
 * restart/concurrent replay from ever sending the same payout again.
 * No escrow/game contract, Jetton, Mainnet or blockchain finality claim.
 */
import {mkdirSync,openSync,writeSync,fsyncSync,closeSync,readFileSync,existsSync} from "node:fs";
import {join} from "node:path";
import {RoomWalletAdapter} from "../roomWallet/RoomWalletAdapter.js";
import {PayoutPlan} from "../ledger/PayoutPlan.js";
import {buildRecipientGasCharge} from "../roomWallet/RoomWalletFinancialPolicy.js";
import {deriveTonAddressIdentity} from "../incoming/TonAddressIdentity.js";

const SAFE_PAYOUT_ID=/^payout_[a-f0-9]{32}$/;
const RETAINED_NANO=0n; // frozen recipient fee charge funds source-side TON gas
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
        const ownerGross=BigInt(principalAtomic)-winnerGross;
        assert(ownerGross>0n,"PAYOUT_OWNER_NONPOSITIVE");
        const quote=async (address,amountNano)=>{
            const result=await this._adapter.estimateOutboundTransferFee({
                roomNumber:wallet.roomNumber,destination:canonical(address),
                amountNano,bounce:false
            });
            assert(result?.ok===true && typeof result.totalNano==="bigint"
                && result.totalNano>=0n,"PAYOUT_TESTNET_FEE_QUOTE_UNAVAILABLE");
            // Same recipient-pays-gas charge and safety margin as refunds.
            // Persist the frozen charge BEFORE broadcast; never re-estimate on replay.
            const charge = buildRecipientGasCharge({
                feeEstimateTotalNano: result.totalNano
            }).recipientGasChargeNano;
            assert(charge < amountNano, "PAYOUT_GAS_EXCEEDS_RECIPIENT_SHARE");
            return feeToNumber(charge);
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
        if (query.plan?.allocation?.ruleId ===
            "APPROVED_WINNER_95_OWNER_5_RECIPIENT_PAYS_GAS_RULE") {
            return this._reconcileRecipientFunded(query);
        }
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
    /** Confirm one recipient without waiting for the other recipient's transfer. */
    async _verifyRecipientLeg(query, transfer, claimTimestamp) {
        if (!this._outgoingObserver?.findOutgoingTransfer
            || !this._outgoingObserver?.verifyIndexedRecipientCredit
            || !this._independentVerifier?.verifyTransfer) return null;
        const outgoing = await this._outgoingObserver.findOutgoingTransfer({
            sourceWalletAddress:query.roomWalletAddress,
            destinationIdentity:transfer.address, amountAtomic:transfer.netAtomic,
            minCreatedAtMs:claimTimestamp
        });
        if (!outgoing?.transactionId || outgoing.ambiguous) return null;
        const indexed = await this._outgoingObserver.verifyIndexedRecipientCredit({
            sourceWalletAddress:query.roomWalletAddress,
            destinationIdentity:transfer.address,
            transactionId:outgoing.transactionId, amountAtomic:transfer.netAtomic,
            minCreatedAtMs:claimTimestamp
        });
        if (indexed?.status !== "MASTERCHAIN_INDEXED_RECIPIENT_CREDIT_OBSERVED"
            || indexed.globalId !== -3 || indexed.sourceFinality !== "finalized"
            || indexed.recipientFinality !== "finalized"
            || indexed.sourceTransactionId !== outgoing.transactionId
            || !indexed.recipientTransactionId
            || indexed.amountAtomic !== transfer.netAtomic
            || !Number.isSafeInteger(indexed.sourceMcBlockSeqno)
            || !Number.isSafeInteger(indexed.recipientMcBlockSeqno)
            || !Number.isSafeInteger(indexed.latestIndexedMcBlockSeqno)
            || indexed.latestIndexedMcBlockSeqno <= indexed.sourceMcBlockSeqno
            || indexed.latestIndexedMcBlockSeqno <= indexed.recipientMcBlockSeqno
            || canonical(indexed.destinationAddress) !== canonical(transfer.address)) return null;
        const proof = await this._independentVerifier.verifyTransfer({
            sourceTransactionId:indexed.sourceTransactionId,
            recipientTransactionId:indexed.recipientTransactionId,
            messageHash:indexed.messageHash,
            sourceWalletAddress:query.roomWalletAddress,
            destinationAddress:transfer.address, amountAtomic:transfer.netAtomic
        });
        if (proof?.status !== "INDEPENDENT_INDEXED_CREDIT_OBSERVED"
            || proof.provider !== "tonapi-testnet"
            || proof.sourceTransactionId !== indexed.sourceTransactionId
            || proof.recipientTransactionId !== indexed.recipientTransactionId
            || proof.messageHash !== indexed.messageHash
            || proof.amountAtomic !== transfer.netAtomic
            || canonical(proof.sourceWalletAddress) !== canonical(query.roomWalletAddress)
            || canonical(proof.destinationAddress) !== canonical(transfer.address)
            || !Number.isSafeInteger(proof.actualFeeAtomic)
            || proof.actualFeeAtomic < 0) return null;
        return {transactionId:proof.sourceTransactionId,
            actualFeeAtomic:proof.actualFeeAtomic, settledAtMs:Date.now()};
    }

    /** The 95/5 scheme settles Winner first and never fabricates an Owner payment. */
    async _reconcileRecipientFunded(query) {
        const wallet = this._reservation(query.roomId, query.roomWalletAddress);
        const winner = query.plan.transfers.find(t=>t.recipientRole==="WINNER");
        const owner = query.plan.transfers.find(t=>t.recipientRole==="OWNER");
        PayoutPlan.fromJSON(query.plan);
        const path = join(this._dir,query.payoutId+".jsonl");
        if (!existsSync(path)) return Object.freeze({
            status:"NO_BROADCAST_ATTEMPT_RECORDED",payoutId:query.payoutId,autoSettlement:false
        });
        const records = readFileSync(path,"utf8").trim().split("\n").map(row=>JSON.parse(row));
        const initial=records[0];
        assert(initial.payoutId===query.payoutId && initial.roomId===query.roomId
            && initial.roomNumber===wallet.roomNumber
            && initial.winnerAmountAtomic===winner.netAtomic
            && initial.ownerAmountAtomic===owner.netAtomic
            && initial.winnerAddress===canonical(winner.address)
            && initial.ownerAddress===canonical(owner.address),
            "PAYOUT_JOURNAL_IDENTITY_MISMATCH");
        const legs=this._ledger.listPayoutObligations(query.roomId)
            .filter(o=>o.payoutId===query.payoutId);
        let win=legs.find(o=>o.role==="WINNER");
        if (!win?.settled) {
            const proof=await this._verifyRecipientLeg(query,winner,initial.timestamp);
            if (!proof) return Object.freeze({
                status:"WINNER_CONFIRMATION_PENDING",payoutId:query.payoutId,autoSettlement:false
            });
            this._ledger.settlePayout({payoutId:query.payoutId,
                recipientId:winner.recipientId,executionResult:proof});
        }
        const ownerLeg=legs.find(o=>o.role==="OWNER");
        if (ownerLeg?.waived) return Object.freeze({
            status:"WINNER_SETTLED_OWNER_COMMISSION_WAIVED",payoutId:query.payoutId,
            autoSettlement:true
        });
        if (ownerLeg?.settled) return Object.freeze({
            status:"BOTH_PAYOUTS_SETTLED_FROM_DUAL_FINALITY",payoutId:query.payoutId,
            autoSettlement:true
        });
        // An Owner transfer that may have been broadcast can never be waived.
        const ownerProof=await this._verifyRecipientLeg(query,owner,initial.timestamp);
        if (ownerProof) {
            this._ledger.settlePayout({payoutId:query.payoutId,
                recipientId:owner.recipientId,executionResult:ownerProof});
            return Object.freeze({status:"BOTH_PAYOUTS_SETTLED_FROM_DUAL_FINALITY",
                payoutId:query.payoutId,autoSettlement:true});
        }
        const evidence=records.find(row=>row.role==="OWNER"
            && row.state==="OWNER_FUNDS_INSUFFICIENT");
        if (evidence && !existsSync(join(this._dir,query.payoutId+".OWNER.json"))) {
            // This record was persisted BEFORE any Owner broadcast attempt.
            this._ledger.waiveOwnerCommission({
                payoutId:query.payoutId,roomId:query.roomId,
                evidence:{reason:"INSUFFICIENT_BALANCE_AFTER_WINNER",
                    balanceAtomic:evidence.balanceAtomic,
                    requiredAtomic:evidence.requiredAtomic}
            });
            return Object.freeze({status:"WINNER_SETTLED_OWNER_COMMISSION_WAIVED",
                payoutId:query.payoutId,autoSettlement:true});
        }
        return Object.freeze({status:"WINNER_SETTLED_OWNER_CONFIRMATION_PENDING",
            payoutId:query.payoutId,autoSettlement:true});
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
        const historic = plan.allocation?.ruleId === "APPROVED_WINNER_95_OWNER_4_9_GAS_RESERVE_0_1_RULE";
        assert(plan.roomId===roomId && plan.payoutId===payoutId
            && Number.isSafeInteger(plan.gasReserveAtomic)
            && plan.gasReserveAtomic >= 0
            && Array.isArray(plan.transfers)&&plan.transfers.length===2
            && winner?.netAtomic>0&&owner?.netAtomic>0
            && (historic
                ? (winner.reservedFeeAtomic===0 && owner.reservedFeeAtomic===0)
                : (winner.reservedFeeAtomic>0 && owner.reservedFeeAtomic>0
                    && winner.netAtomic===winner.grossAtomic-winner.reservedFeeAtomic
                    && owner.netAtomic===owner.grossAtomic-owner.reservedFeeAtomic))
            && canonical(winner.address)===canonical(winnerWallet)
            && canonical(owner.address)===canonical(ownerWallet)
            && winner.grossAtomic+owner.grossAtomic
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
        // Winner is always attempted first; the Owner share is NOT reserved
        // against the Winner transfer when recipient-funded fees are frozen.
        const amounts=[{role:"WINNER",transfer:winner,reserve:historic
            ? BigInt(owner.netAtomic+plan.gasReserveAtomic) : 0n},
            {role:"OWNER",transfer:owner,reserve:historic
                ? BigInt(plan.gasReserveAtomic) : 0n}];
        for(const {role,transfer,reserve} of amounts){
            if (role === "OWNER" && !historic) {
                const journal=readFileSync(path,"utf8").trim().split("\n")
                    .map(line=>JSON.parse(line));
                if (journal.some(row=>row.role==="OWNER"
                    && row.state==="OWNER_FUNDS_INSUFFICIENT")) {
                    return Object.freeze({status:"OWNER_COMMISSION_WAIVER_PENDING_CONFIRMATION",
                        payoutId});
                }
                // Check funding only AFTER independent Winner chain evidence.
                // A failed Owner balance check is not an unconfirmed broadcast.
                if (typeof this._adapter.canFundTransfer==="function") {
                    const funding=await this._adapter.canFundTransfer({
                        roomNumber:wallet.roomNumber,
                        amountNano:BigInt(owner.netAtomic),
                        sourceReserveNano:BigInt(owner.reservedFeeAtomic)
                    });
                    if (!funding.ok) {
                        const balanceAtomic=feeToNumber(funding.balanceNano);
                        const requiredAtomic=feeToNumber(funding.requiredNano);
                        logEvent(path,{role:"OWNER",state:"OWNER_FUNDS_INSUFFICIENT",
                            balanceAtomic,requiredAtomic,timestamp:Date.now()},false);
                        return Object.freeze({status:"OWNER_COMMISSION_WAIVER_PENDING_CONFIRMATION",
                            payoutId});
                    }
                }
            }
            // Exclusive per-leg intent is published before calling the signer.
            // A durable adapter retries only the exact persisted message. Older
            // attempts without that payload remain observation-only.
            try { durableWriteJson(join(this._dir, payoutId + '.' + role + '.json'),
                {payoutId, role, amountAtomic:transfer.netAtomic, destination:canonical(transfer.address), state:'SUBMISSION_UNKNOWN'}, {exclusive:true}); }
            catch (error) {
                if (error.code !== 'EEXIST') throw error;
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
            && credit.globalId === -3
            && credit.sourceFinality === "finalized"
            && credit.recipientFinality === "finalized"
            && Number.isSafeInteger(credit.sourceMcBlockSeqno)
            && Number.isSafeInteger(credit.recipientMcBlockSeqno)
            && Number.isSafeInteger(credit.latestIndexedMcBlockSeqno)
            && credit.latestIndexedMcBlockSeqno > credit.sourceMcBlockSeqno
            && credit.latestIndexedMcBlockSeqno > credit.recipientMcBlockSeqno;
    }
}
