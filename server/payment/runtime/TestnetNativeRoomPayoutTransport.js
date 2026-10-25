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
const RETAINED_NANO=10_000_000n;
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
    const fd=openSync(path,exclusive?"wx":"a",0o600);
    try {writeSync(fd,JSON.stringify(record)+"\n");fsyncSync(fd);}finally{closeSync(fd);}
}

export class TestnetNativeRoomPayoutTransport {
    constructor({walletPool,walletResolver,tonService,dataDir,logger=null,adapter=null,
        outgoingObserver=null}={}) {
        assert(walletPool && typeof dataDir==="string" && dataDir,"PAYOUT_RUNTIME_UNAVAILABLE");
        assert(adapter || (walletResolver && tonService),"PAYOUT_WALLET_ADAPTER_MISSING");
        this._pool=walletPool;
        this._outgoingObserver=outgoingObserver;
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
                ownerRecipientTransactionId:credited[1].value.recipientTransactionId
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
    async submit({roomId,payoutId,roomWalletAddress,winnerWallet,ownerWallet,plan}) {
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
        const initial={payoutId,roomId,roomNumber:wallet.roomNumber,
            winnerAddress:canonical(winner.address),ownerAddress:canonical(owner.address),
            winnerAmountAtomic:winner.netAtomic,ownerAmountAtomic:owner.netAtomic,
            state:"SUBMISSION_UNKNOWN",timestamp:Date.now()};
        // The claim is durable BEFORE either transaction can be submitted.
        try{logEvent(path,initial,true);}catch(e){
            if(e?.code==="EEXIST")return Object.freeze({
                status:"ALREADY_ATTEMPTED_NEEDS_RECONCILIATION",payoutId});
            throw e;
        }
        const amounts=[{role:"WINNER",transfer:winner,reserve:BigInt(owner.netAtomic+
            owner.reservedFeeAtomic)+RETAINED_NANO},
            {role:"OWNER",transfer:owner,reserve:RETAINED_NANO}];
        for(const {role,transfer,reserve} of amounts){
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
