import { Address } from "@ton/core";

function validWorkchainZeroAddress(value) {
    if (typeof value !== "string" || !value.trim()) return false;
    try {
        return Address.parse(value.trim()).workChain === 0;
    } catch {
        return false;
    }
}

export function normalizeMainnetPaymentRequest(payload, {
    roomId,
    playerId,
    paymentAcceptanceEnabled,
    now = Date.now()
} = {}) {
    if (paymentAcceptanceEnabled !== true
        || payload?.roomId !== roomId
        || payload?.playerId !== playerId
        || payload?.network !== "mainnet"
        || payload?.asset !== "TON"
        || typeof payload?.paymentReference !== "string"
        || !/^[A-Za-z0-9_-]{1,64}$/.test(payload.paymentReference)
        || typeof payload?.amountAtomic !== "string"
        || !/^[1-9][0-9]*$/.test(payload.amountAtomic)
        || !Number.isSafeInteger(now)
        || !Number.isSafeInteger(payload?.expiresAt)
        || now >= payload.expiresAt
        || !validWorkchainZeroAddress(payload?.payerAddress)
        || !validWorkchainZeroAddress(payload?.destinationWalletAddress ?? payload?.destination)) {
        return null;
    }

    const amountAtomic = Number(payload.amountAtomic);
    if (!Number.isSafeInteger(amountAtomic) || amountAtomic <= 0) return null;

    return Object.freeze({
        roomId,
        playerId,
        paymentReference: payload.paymentReference,
        payerAddress: payload.payerAddress.trim(),
        destinationWalletAddress: (payload.destinationWalletAddress ?? payload.destination).trim(),
        amountAtomic,
        asset: "TON",
        network: "mainnet",
        expiresAt: payload.expiresAt,
        paymentAcceptanceEnabled: true
    });
}
