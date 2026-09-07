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
 * Canonical form is bounceable URL-safe friendly (workchain + account hash).
 */
export function canonicalizeTonWalletAddress(rawWallet) {

    const trimmed = extractTonWalletAddressInput(rawWallet);

    if (!trimmed) {

        return null;

    }

    try {

        const parsed = Address.parseFriendly(trimmed);

        return parsed.address.toString({
            bounceable: true,
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

    const canonicalLeft = canonicalizeTonWalletAddress(left);

    const canonicalRight = canonicalizeTonWalletAddress(right);

    return Boolean(canonicalLeft && canonicalRight && canonicalLeft === canonicalRight);

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

    const result = Boolean(left && right && left === right);

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
