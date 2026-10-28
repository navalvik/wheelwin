import { durableWriteJson } from '../DurableJson.js';
/**
 * Room Wallet V4 Testnet refund signer/broadcaster capabilities.
 *
 * The existing RefundLifecycleCoordinator persists SUBMISSION_UNKNOWN and the
 * immutable recipient-net/gas plan before requesting a broadcast. This module
 * adds a second fsynced one-time broadcast claim by obligation ID, so a crash,
 * process restart or concurrent caller cannot initiate a second transfer.
 *
 * All amounts are native TON nanotons. The player bears estimated chain fees.
 * The original settled-principal obligation remains unchanged.
 */
import {createHash} from "node:crypto";
import {mkdirSync,openSync,writeSync,fsyncSync,closeSync} from "node:fs";
import {join} from "node:path";
import {deriveTonAddressIdentity} from "../incoming/TonAddressIdentity.js";
import {buildRecipientGasCharge} from "./RoomWalletFinancialPolicy.js";

function requireValid(condition,code) {
    if(!condition) throw new Error(code);
}
function canonical(value) {
    const result=deriveTonAddressIdentity(value);
    requireValid(result.startsWith("0:"),"REFUND_ADDRESS_INVALID");
    return result;
}
function nanoNumber(value) {
    requireValid(value>=0n&&value<=BigInt(Number.MAX_SAFE_INTEGER),"REFUND_NANO_OVERFLOW");
    return Number(value);
}
function writeClaim(path,record) {
    try { durableWriteJson(path,record,{exclusive:true}); return true; }
    catch(error) { if(error.code === 'EEXIST') return false; throw error; }
}

export function createTestnetNativeRefundCapabilities({
    walletPool,roomWalletAdapter,dataDir
}={}) {
    requireValid(walletPool&&typeof walletPool.getReservationForRoom==="function",
        "REFUND_WALLET_POOL_REQUIRED");
    requireValid(roomWalletAdapter
        &&typeof roomWalletAdapter.sendTransfer==="function"
        &&typeof roomWalletAdapter.estimateOutboundTransferFee==="function",
        "REFUND_NATIVE_V4_ADAPTER_REQUIRED");
    requireValid(typeof dataDir==="string"&&dataDir.length>0,"REFUND_DATA_DIR_REQUIRED");
    const journalDir=join(dataDir,"native-refund-broadcast-claims");
    mkdirSync(journalDir,{recursive:true,mode:0o700});

    function walletFor(roomId,roomNumber,sourceWalletAddress) {
        const wallet=walletPool.getReservationForRoom(roomId);
        requireValid(wallet && wallet.reservedByRoomId===roomId
            && wallet.roomNumber!==1
            && Number.isSafeInteger(wallet.roomNumber)
            && canonical(wallet.address)===canonical(sourceWalletAddress),
            "REFUND_ROOM_WALLET_NOT_AUTHORIZED");
        // The game room number and the 64-slot wallet number are distinct.
        // Do not equate them; the reservation is authoritative.
        requireValid(Number.isSafeInteger(roomNumber)&&roomNumber>=1,
            "REFUND_ROOM_NUMBER_INVALID");
        return wallet;
    }
    const signer=Object.freeze({
        async quoteRefund({roomId,roomNumber,from,to,amountAtomic}) {
            const wallet=walletFor(roomId,roomNumber,from);
            requireValid(Number.isSafeInteger(amountAtomic)&&amountAtomic>0,
                "REFUND_GROSS_AMOUNT_INVALID");
            const destination=canonical(to);
            requireValid(destination!==canonical(from),"REFUND_SELF_TRANSFER_FORBIDDEN");
            const estimate=await roomWalletAdapter.estimateOutboundTransferFee({
                roomNumber:wallet.roomNumber,destination,
                amountNano:BigInt(amountAtomic),bounce:false
            });
            requireValid(estimate?.ok===true
                &&typeof estimate.totalNano==="bigint"&&estimate.totalNano>0n,
                "REFUND_TESTNET_FEE_ESTIMATE_UNAVAILABLE");
            const gas=buildRecipientGasCharge({
                feeEstimateTotalNano:estimate.totalNano
            }).recipientGasChargeNano;
            const net=BigInt(amountAtomic)-gas;
            requireValid(net>0n,"REFUND_GAS_EXCEEDS_PAYMENT");
            return Object.freeze({
                transferAmountAtomic:nanoNumber(net),gasChargeAtomic:nanoNumber(gas)
            });
        },
        async signTransfer({
            roomId,roomNumber,from,to,amountAtomic,grossAmountAtomic,
            gasChargeAtomic,idempotencyKey,obligationId,denomination,
            networkName,globalId
        }) {
            requireValid(networkName==="TESTNET"&&globalId===-3
                &&denomination==="TON","REFUND_NETWORK_INVALID");
            const wallet=walletFor(roomId,roomNumber,from);
            requireValid(typeof obligationId==="string"&&/^rfd_[a-f0-9]{32}$/.test(obligationId),
                "REFUND_ID_INVALID");
            requireValid(typeof idempotencyKey==="string"&&idempotencyKey,
                "REFUND_IDEMPOTENCY_MISSING");
            requireValid(Number.isSafeInteger(amountAtomic)&&amountAtomic>0
                &&Number.isSafeInteger(grossAmountAtomic)&&grossAmountAtomic>amountAtomic
                &&Number.isSafeInteger(gasChargeAtomic)&&gasChargeAtomic>0
                &&amountAtomic+gasChargeAtomic===grossAmountAtomic,
                "REFUND_DURABLE_GAS_PLAN_INVALID");
            requireValid(canonical(to)!==canonical(from),"REFUND_SELF_TRANSFER_FORBIDDEN");
            return Object.freeze({
                obligationId,idempotencyKey,
                roomId,roomNumber:wallet.roomNumber,
                source:canonical(from),destination:canonical(to),
                amountAtomic
            });
        }
    });
    const broadcaster=Object.freeze({
        async broadcast({sourceWalletAddress,signedTransfer}) {
            const descriptor=signedTransfer;
            requireValid(descriptor&&canonical(sourceWalletAddress)===descriptor.source,
                "REFUND_SIGNED_SOURCE_MISMATCH");
            const wallet=walletPool.getReservationForRoom(descriptor.roomId);
            requireValid(wallet && wallet.roomNumber===descriptor.roomNumber
                &&wallet.roomNumber!==1
                &&canonical(wallet.address)===descriptor.source,
                "REFUND_WALLET_RESERVATION_CHANGED");
            const claimName=createHash("sha256")
                .update(descriptor.obligationId).digest("hex");
            const path=join(journalDir,claimName+".json");
            if(!writeClaim(path,{
                obligationId:descriptor.obligationId,roomId:descriptor.roomId,
                source:descriptor.source,destination:descriptor.destination,
                amountAtomic:descriptor.amountAtomic,
                status:"BROADCAST_OUTCOME_UNKNOWN",claimedAtMs:Date.now()
            })) {
                return Object.freeze({
                    status:"UNKNOWN",reason:"REFUND_ALREADY_ATTEMPTED"
                });
            }
            try {
                const receipt=await roomWalletAdapter.sendTransfer({
                    roomNumber:descriptor.roomNumber,
                    destination:descriptor.destination,
                    amountNano:BigInt(descriptor.amountAtomic),
                    bounce:false,sourceReserveNano:0n
                });
                if(receipt?.ok===true &&typeof receipt.txHash==="string"&&receipt.txHash)
                    return Object.freeze({
                        status:"SUBMITTED",transactionId:receipt.txHash
                    });
                return Object.freeze({
                    status:"UNKNOWN",reason:"REFUND_BROADCAST_NEEDS_CHAIN_RECONCILIATION"
                });
            } catch {
                return Object.freeze({
                    status:"UNKNOWN",reason:"REFUND_BROADCAST_AMBIGUOUS"
                });
            }
        }
    });
    return Object.freeze({signer,broadcaster});
}
