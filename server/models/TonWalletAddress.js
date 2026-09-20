import { Address } from "@ton/core";

/**
 * Unwrap a TON address field without coercing objects via String().
 * Accepts a friendly/raw string or `{ address: string }`. Anything else is null.
 */
export function extractTonWalletAddressInput(rawWallet) {

    if (typeof rawWallet === "string") {

        const trimmed = rawWallet.trim();

        return trimmed || null;

    }

    if (
        rawWallet
        && typeof rawWallet === "object"
        && typeof rawWallet.address === "string"
    ) {

        const trimmed = rawWallet.address.trim();

        return trimmed || null;

    }

    return null;

}

/**
 * P6.2 / R6.x — Compare a TON Connect address to a session wallet.
 * Server-authoritative; official @ton/core parser only (no prefix / length gates).
 * Canonical form preserves the friendly bounceable/non-bounceable and
 * testnet-only flags supplied by the caller. Account equality below remains
 * flag-independent because those flags are presentation/network metadata.
 */
export function canonicalizeTonWalletAddress(rawWallet) {

    const trimmed = extractTonWalletAddressInput(rawWallet);

    if (!trimmed) {

        return null;

    }

    try {

        const parsed = Address.parseFriendly(trimmed);

        return parsed.address.toString({
            bounceable: parsed.isBounceable,
            testOnly: parsed.isTestOnly,
            urlSafe: true
        });

    } catch {

        try {

            return Address.parse(trimmed).toString({
                bounceable: true,
                urlSafe: true
            });

        } catch {

            return null;

        }

    }

}

/**
 * Fail-closed account equality: both sides must parse to the same workchain + hash.
 * Friendly-format differences (EQ / UQ / kQ / 0Q, URL-safe) do not mismatch.
 */
export function tonWalletAccountsEqual(left, right) {

    const leftInput = extractTonWalletAddressInput(left);
    const rightInput = extractTonWalletAddressInput(right);

    if (!leftInput || !rightInput) {

        return false;

    }

    try {

        return Address.parse(leftInput).equals(Address.parse(rightInput));

    } catch {

        return false;

    }

}

/**
 * Operator-facing identity: canonical friendly, application network, raw account id.
 * Does not use the friendly `testOnly` bit as identity. Network is explicit and separate.
 */
export function describeTonWalletIdentity(rawWallet, network = null) {

    const net = network == null || String(network).trim() === ""
        ? null
        : String(network).trim().toLowerCase();

    const canonical = canonicalizeTonWalletAddress(rawWallet);

    if (!canonical) {

        return Object.freeze({
            address: extractTonWalletAddressInput(rawWallet),
            network: net,
            accountId: null
        });

    }

    let accountId = null;

    try {

        accountId = Address.parse(canonical).toRawString();

    } catch {

        accountId = null;

    }

    return Object.freeze({
        address: canonical,
        network: net,
        accountId
    });

}

export function sessionWalletsMatch(sessionWallet, connectedWallet) {

    const left = canonicalizeTonWalletAddress(sessionWallet);

    const right = canonicalizeTonWalletAddress(connectedWallet);

    const result = tonWalletAccountsEqual(sessionWallet, connectedWallet);

    // R6.3 TEMP DEBUG — remove after runtime trace
    console.log("[R6.3 TRACE] sessionWalletsMatch", {
        LEFT: sessionWallet,
        RIGHT: connectedWallet,
        "canonical LEFT": left,
        "canonical RIGHT": right,
        RESULT: result
    });

    if (!left || !right) {

        return false;

    }

    return left === right;

}
