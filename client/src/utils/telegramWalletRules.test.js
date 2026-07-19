import {
    isValidTelegramWallet,
    normalizeTelegramWallet,
    TELEGRAM_WALLET_MIN_LENGTH,
    TELEGRAM_WALLET_PREFIX
} from "./telegramWalletRules.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

const validWallet = `${TELEGRAM_WALLET_PREFIX}${"A".repeat(
    TELEGRAM_WALLET_MIN_LENGTH - TELEGRAM_WALLET_PREFIX.length
)}`;

assert(isValidTelegramWallet(validWallet), "valid EQ wallet accepted");

assert(
    normalizeTelegramWallet(` ${validWallet} `) === validWallet,
    "trim whitespace"
);

assert(!isValidTelegramWallet("bad"), "invalid rejected");

console.log("telegramWalletRules.test.js: all assertions passed");
