export const TELEGRAM_WALLET_PREFIX = "EQ";

export const TELEGRAM_WALLET_MIN_LENGTH = 48;

/**
 * Temporary Telegram Wallet format gate (C5.8B).
 * Accepts addresses that start with EQ and are at least 48 characters.
 * No TON SDK / Telegram Wallet API.
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
