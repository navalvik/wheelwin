/**
 * R6.x — Client mirror of native TON wallet validation.
 */

import assert from "node:assert/strict";

import { Address } from "@ton/core";

import {
    isValidTelegramWallet,
    normalizeTelegramWallet,
    parseTonWallet
} from "./telegramWalletRules.js";

const ZERO = Address.parse(
    "0:0000000000000000000000000000000000000000000000000000000000000000"
);

const VALID = Object.freeze({
    EQ: ZERO.toString({ bounceable: true, urlSafe: true, testOnly: false }),
    UQ: ZERO.toString({ bounceable: false, urlSafe: true, testOnly: false }),
    kQ: ZERO.toString({ bounceable: true, urlSafe: true, testOnly: true }),
    "0Q": ZERO.toString({ bounceable: false, urlSafe: true, testOnly: true })
});

for (const [prefix, wallet] of Object.entries(VALID)) {

    assert.equal(wallet.slice(0, 2), prefix);

    assert.equal(isValidTelegramWallet(wallet), true, `accept ${prefix}`);

    assert.equal(parseTonWallet(wallet).valid, true);

    assert.equal(
        normalizeTelegramWallet(` ${wallet} `),
        VALID.EQ,
        `${prefix} → bounceable`
    );

}

assert.equal(isValidTelegramWallet("EQ123"), false);

assert.equal(isValidTelegramWallet("ABCDEF"), false);

assert.equal(isValidTelegramWallet(""), false);

assert.equal(isValidTelegramWallet(null), false);

assert.equal(isValidTelegramWallet("not-a-wallet"), false);

assert.equal(isValidTelegramWallet("EQ" + "A".repeat(46)), false);

console.log("telegramWalletRules.test.js: all assertions passed");
