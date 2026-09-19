/**
 * R18-S17 C3 — TonConnect account.chain is the wallet-side network identity.
 * TON mainnet uses chain -239; TON testnet uses chain -3.
 * The server paymentNetwork is authoritative for which chain Page4 may pay on.
 * TonConnect does not switch the wallet network for us, so fail closed on a
 * known chain mismatch instead of sending an otherwise valid TON transaction
 * to the wrong network.
 */
const TON_MAINNET_CHAIN = "-239";
const TON_TESTNET_CHAIN = "-3";

export function normalizePaymentNetwork(network) {
    const normalized = String(network ?? "").trim().toLowerCase();
    return normalized === "mainnet" || normalized === "testnet"
        ? normalized
        : null;
}

export function expectedTonConnectChain(network) {
    const normalized = normalizePaymentNetwork(network);
    if (normalized === "mainnet") return TON_MAINNET_CHAIN;
    if (normalized === "testnet") return TON_TESTNET_CHAIN;
    return null;
}

export function isTonConnectChainCompatible(network, walletChain) {
    const expected = expectedTonConnectChain(network);
    if (!expected) return true;
    if (walletChain == null || String(walletChain).trim() === "") return false;
    return String(walletChain).trim() === expected;
}
