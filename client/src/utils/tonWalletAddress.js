/**
 * Normalize a TON Connect account address for the session-wallet report.
 *
 * R6.x — no prefix / length filtering. Official parser validates when available;
 * otherwise pass trimmed string for authoritative server canonicalization.
 */

import { parseTonWallet } from "./telegramWalletRules.js";

export function toSessionWalletAddress(rawAddress) {

    if (typeof rawAddress !== "string") {

        return null;

    }

    const trimmed = rawAddress.trim();

    if (!trimmed) {

        return null;

    }

    const parsed = parseTonWallet(trimmed);

    if (!parsed.valid) {

        return null;

    }

    return parsed.address.toString({
        bounceable: parsed.isBounceable,
        testOnly: parsed.isTestOnly,
        urlSafe: true
    });

}

export function tonWalletAccountsEqual(left, right) {

    const leftParsed = parseTonWallet(left);
    const rightParsed = parseTonWallet(right);

    return Boolean(
        leftParsed.valid
        && rightParsed.valid
        && leftParsed.address.equals(rightParsed.address)
    );

}
