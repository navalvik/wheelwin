import {
    isValidTelegramWallet,
    normalizeTelegramWallet,
    TELEGRAM_WALLET_MIN_LENGTH,
    TELEGRAM_WALLET_PREFIX
} from "../models/TelegramWalletRules.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

const validWallet = `${TELEGRAM_WALLET_PREFIX}${"A".repeat(
    TELEGRAM_WALLET_MIN_LENGTH - TELEGRAM_WALLET_PREFIX.length
)}`;

assert(
    validWallet.length === TELEGRAM_WALLET_MIN_LENGTH,
    "fixture wallet length"
);

assert(isValidTelegramWallet(validWallet), "EQ + 48 chars must be accepted");

assert(
    normalizeTelegramWallet(`  ${validWallet}  `) === validWallet,
    "leading/trailing whitespace must be trimmed"
);

assert(!isValidTelegramWallet("UQ" + "A".repeat(46)), "non-EQ prefix rejected");

assert(
    !isValidTelegramWallet("EQ" + "A".repeat(45)),
    "EQ under 48 chars rejected"
);

assert(!isValidTelegramWallet(""), "empty rejected");

assert(!isValidTelegramWallet(null), "null rejected");

assert(!isValidTelegramWallet(123), "non-string rejected");

console.log("telegramWalletRules.test.js: all assertions passed");
