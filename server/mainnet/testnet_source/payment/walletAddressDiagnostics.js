/**
 * Read-only Page4 payment diagnostics for Railway logs.
 * Only public TON addresses, authorized intent metadata and transaction
 * identities are emitted. Never stringify wallets, request bodies, API
 * headers, payment providers, private keys, mnemonics or secret material.
 *
 * These messages are admin diagnostics, not client-visible game events.
 */
function field(value, fallback = "unknown") {
    const text = value === null || value === undefined || value === ""
        ? fallback : String(value);
    return text.replace(/[\r\n\t|\x00-\x1f]/g, "_").slice(0, 260);
}

/** Four stable, searchable lines when Page4 is prepared (one room, 3 players). */
export function formatPage4WalletBindingLogs({
    roomId, reservation, intents, nicknames = {}
} = {}) {
    if (typeof roomId !== "string" || !roomId.trim()
        || !Array.isArray(intents) || intents.length === 0) return [];
    const walletId = reservation?.walletId ?? intents[0]?.destinationWalletId;
    const walletAddress = reservation?.address ?? intents[0]?.destinationWalletAddress;
    const room = field(roomId);
    const lines = [
        `PAGE4_WALLET_BINDING | roomId=${room} | walletId=${field(walletId)} | walletAddress=${field(walletAddress)} | requiredPlayers=${intents.length}`
    ];
    for (const intent of intents) {
        // Never include an object's unknown properties (including secrets).
        lines.push(`PAGE4_PLAYER_WALLET | roomId=${room} | playerId=${field(intent.playerId)} | nickname=${field(nicknames[intent.playerId])} | senderAddress=${field(intent.expectedSender)} | destinationWalletId=${field(intent.destinationWalletId)} | destinationWalletAddress=${field(intent.destinationWalletAddress)} | amountAtomic=${field(intent.amountAtomic)} | paymentReference=${field(intent.paymentReference)}`);
    }
    return lines;
}

/** One line for each distinct, genuinely observed blockchain transfer. */
export function formatPage4ObservedTransferLog({
    roomId, walletId, transfer, decision
} = {}) {
    if (!transfer || typeof transfer !== "object") return null;
    const reasons = Array.isArray(decision?.mismatchReasons)
        ? decision.mismatchReasons
            .map(item => `${field(item.paymentReference)}:${field(item.reason)}`)
            .join(",") : "";
    return `PAGE4_INCOMING_TX | roomId=${field(roomId)} | walletId=${field(walletId)} | transactionId=${field(transfer.providerTransactionIdentity?.transactionId ?? transfer.transactionId)} | senderAddress=${field(transfer.senderAddress)} | destinationWalletAddress=${field(transfer.destinationWalletAddress)} | amountAtomic=${field(transfer.amountAtomic)} | paymentReference=${field(transfer.paymentReference, "NONE")} | matchStatus=${field(decision?.status)} | mismatchReasons=${field(reasons, "NONE")}`;
}
