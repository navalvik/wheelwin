export const TELEGRAM_WALLET_PREFIX = "EQ";

export const TELEGRAM_WALLET_MIN_LENGTH = 48;

/**
 * Client-side mirror of server TelegramWalletRules (temporary C5.8B gate).
 */
export function normalizeTelegramWallet(rawWallet) {

    if (typeof rawWallet !== "string") {

        return null;

    }

    const wallet = rawWallet.trim();

    if (!wallet.startsWith(TELEGRAM_WALLET_PREFIX)) {

        return null;

    }

    if (wallet.length < TELEGRAM_WALLET_MIN_LENGTH) {

        return null;

    }

    return wallet;

}

export function isValidTelegramWallet(rawWallet) {

    return normalizeTelegramWallet(rawWallet) !== null;

}
