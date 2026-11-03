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

export function getMainnetPlayerPaymentStatus(status) {
    return status === "SETTLED" ? "Payment verified" : "Waiting for payments";
}

/**
 * Apply an authoritative Mainnet status update without discarding the
 * separately delivered PAYMENT_REQUEST for the same player and room.
 */
export function mergeMainnetPaymentStatus(current, payload, {
    roomId,
    playerId,
    now = Date.now()
} = {}) {
    const sameIdentity = current?.network === "mainnet"
        && current.roomId === roomId
        && current.playerId === playerId;
    const savedRequest = sameIdentity
        ? normalizeMainnetPaymentRequest({
            ...current,
            amountAtomic: String(current.amountAtomic)
        }, { roomId, playerId, paymentAcceptanceEnabled: true, now })
        : null;
    const revoked = payload?.paymentAcceptanceEnabled === false
        || payload?.status === "PAYMENT_UNAVAILABLE";

    if (revoked || !savedRequest) {
        return {
            ...payload,
            roomId,
            playerId,
            network: "mainnet",
            paymentAcceptanceEnabled: payload?.paymentAcceptanceEnabled === true,
            paymentReference: null,
            payerAddress: null,
            destinationWalletAddress: null,
            amountAtomic: null,
            expiresAt: null,
            asset: "TON",
            playerPaymentStatuses: payload?.playerPaymentStatuses ?? current?.playerPaymentStatuses ?? []
        };
    }

    return {
        ...payload,
        ...savedRequest,
        status: payload.status,
        paymentAcceptanceEnabled: payload.paymentAcceptanceEnabled ?? true,
        playerPaymentStatuses: payload.playerPaymentStatuses ?? current.playerPaymentStatuses ?? []
    };
}

/**
 * A valid payment request can open wallet selection before a wallet is
 * connected. The eventual payment callback is reachable only for a matching
 * connected wallet; initiatePayment performs its own checks as well.
 */
export function runMainnetPaymentAction({
    requestValid,
    connectedWallet,
    walletMatches,
    sending = false,
    sentToWallet = false,
    openWalletModal,
    submitPayment
}) {
    if (!requestValid || sending || sentToWallet) return "BLOCKED";
    if (!connectedWallet || !walletMatches) {
        openWalletModal();
        return "SELECT_WALLET";
    }
    submitPayment();
    return "SUBMIT";
}
