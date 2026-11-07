/**
 * Resolve the Telegram Mini App signing token for this isolated runtime.
 * Testnet keeps its existing TELEGRAM_BOT_TOKEN variable. Mainnet must use
 * its own TELEGRAM_MAINNET_BOT_TOKEN and never falls back across networks.
 */
export function resolveTelegramBotToken(env = process.env) {
    const network = String(env.TON_NETWORK ?? "testnet").trim().toLowerCase();
    const key = network === "mainnet"
        ? "TELEGRAM_MAINNET_BOT_TOKEN"
        : network === "testnet"
            ? "TELEGRAM_BOT_TOKEN"
            : null;
    if (!key) return null;
    return String(env[key] ?? "").trim() || null;
}
