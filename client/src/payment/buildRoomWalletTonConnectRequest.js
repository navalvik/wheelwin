/**
 * Exactly one native Testnet GRAM payment to the room wallet assigned by
 * the server. The on-chain text memo is needed by the existing WW1 matcher.
 * No escrow, stateInit, Jetton or additional transfer.
 */
import { Address, beginCell } from "@ton/core";
import { Buffer } from "buffer";

export const TON_TESTNET_CHAIN = "-3";

function canonical(address) {
    if (typeof address !== "string") throw new Error("Wallet address missing");
    const parsed = Address.parse(address);
    if (parsed.workChain !== 0) throw new Error("Only Testnet workchain 0 supported");
    return parsed.toRawString().toLowerCase();
}

export function payerMatchesConnectedWallet(authorizedSender, wallet) {
    try {
        return canonical(authorizedSender) === canonical(wallet?.account?.address)
            && String(wallet?.account?.chain) === TON_TESTNET_CHAIN;
    } catch {
        return false;
    }
}

export function buildRoomWalletTonConnectRequest(payment, nowMs = Date.now()) {
    if (payment?.paymentAcceptanceEnabled !== true
        || payment?.status !== "AWAITING_PAYMENT"
        || payment?.network !== "testnet"
        || payment?.asset !== "TON"
        || !Number.isSafeInteger(payment.amountAtomic)
        || payment.amountAtomic <= 0
        || typeof payment.paymentReference !== "string"
        || !/^[A-Za-z0-9_-]{1,64}$/.test(payment.paymentReference)
        || !Number.isSafeInteger(payment.expiresAt)
        || !Number.isSafeInteger(nowMs)
        || nowMs >= payment.expiresAt) {
        throw new Error("No active authoritative Testnet payment request");
    }
    const destination = canonical(payment.destinationWalletAddress);
    if (destination === canonical(payment.payerAddress)) {
        throw new Error("Room wallet cannot equal payer wallet");
    }
    const expiration = Math.min(
        Math.floor(payment.expiresAt / 1000),
        Math.floor(nowMs / 1000) + 300
    );
    if (expiration <= Math.floor(nowMs / 1000)) {
        throw new Error("Payment session expired");
    }
    const memo = "WW1:" + payment.paymentReference;
    const payload = beginCell().storeUint(0, 32)
        .storeStringTail(memo).endCell().toBoc();
    return Object.freeze({
        network: TON_TESTNET_CHAIN,
        validUntil: expiration,
        messages: Object.freeze([Object.freeze({
            address: destination,
            amount: String(payment.amountAtomic),
            payload: Buffer.from(payload).toString("base64")
        })])
    });
}
