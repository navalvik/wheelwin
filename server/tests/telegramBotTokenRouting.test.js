import assert from "node:assert/strict";
import { resolveTelegramBotToken } from "../auth/resolveTelegramBotToken.js";

assert.equal(resolveTelegramBotToken({
    TON_NETWORK: "testnet",
    TELEGRAM_BOT_TOKEN: "testnet-token",
    TELEGRAM_MAINNET_BOT_TOKEN: "mainnet-token"
}), "testnet-token");

assert.equal(resolveTelegramBotToken({
    TON_NETWORK: "mainnet",
    TELEGRAM_BOT_TOKEN: "testnet-token",
    TELEGRAM_MAINNET_BOT_TOKEN: "mainnet-token"
}), "mainnet-token");

assert.equal(resolveTelegramBotToken({
    TON_NETWORK: "mainnet",
    TELEGRAM_BOT_TOKEN: "testnet-token"
}), null, "Mainnet must not fall back to the Testnet token");

assert.equal(resolveTelegramBotToken({
    TON_NETWORK: "testnet",
    TELEGRAM_MAINNET_BOT_TOKEN: "mainnet-token"
}), null, "Testnet must not use the Mainnet token");

assert.equal(resolveTelegramBotToken({
    TON_NETWORK: "unknown",
    TELEGRAM_BOT_TOKEN: "testnet-token",
    TELEGRAM_MAINNET_BOT_TOKEN: "mainnet-token"
}), null, "unknown networks must not select a Telegram token");

console.log("Telegram bot token routing checks passed.");
