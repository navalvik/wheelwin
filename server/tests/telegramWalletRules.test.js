/**
 * R6.x — Native TON wallet validation (Address.parseFriendly).
 */

import assert from "node:assert/strict";

import { Address } from "@ton/core";

import {
    isValidTelegramWallet,
    normalizeTelegramWallet,
    parseTonWallet
} from "../models/TelegramWalletRules.js";

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

    assert.equal(
        wallet.slice(0, 2),
        prefix,
        `fixture ${prefix} must use expected prefix`
    );

    assert.equal(
        isValidTelegramWallet(wallet),
        true,
        `valid ${prefix} wallet must be accepted`
    );

    const parsed = parseTonWallet(wallet);

    assert.equal(parsed.valid, true, `parseTonWallet accepts ${prefix}`);

    assert.equal(
        normalizeTelegramWallet(`  ${wallet}  `),
        VALID.EQ,
        `${prefix} normalizes to bounceable EQ form`
    );

}

assert.equal(isValidTelegramWallet("EQ123"), false);

assert.equal(isValidTelegramWallet("ABCDEF"), false);

assert.equal(isValidTelegramWallet(""), false);

assert.equal(isValidTelegramWallet(null), false);

assert.equal(isValidTelegramWallet(123), false);

assert.equal(isValidTelegramWallet("not-a-wallet"), false);

assert.equal(
    isValidTelegramWallet("EQ" + "A".repeat(46)),
    false,
    "48 random characters rejected without valid checksum"
);

assert.equal(
    parseTonWallet("EQ123").valid,
    false
);

console.log("telegramWalletRules.test.js: all assertions passed");
