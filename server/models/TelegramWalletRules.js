/**
 * R6.x — TON wallet address validation via official @ton/core parser.
 * No prefix, length, or regex gates — Address.parseFriendly is the authority.
 */

import { Address } from "@ton/core";

/**
 * @param {unknown} rawWallet
 * @returns {{ valid: true, address: import("@ton/core").Address } | { valid: false }}
 */
export function parseTonWallet(rawWallet) {

    if (typeof rawWallet !== "string") {

        return { valid: false };

    }

    const trimmed = rawWallet.trim();

    if (!trimmed) {

        return { valid: false };

    }

    try {

        const parsed = Address.parseFriendly(trimmed);

        return {
            valid: true,
            address: parsed.address
        };

    } catch {

        // Official Address.parse also accepts raw 0:... forms (TON Connect / chain).
        try {

            return {
                valid: true,
                address: Address.parse(trimmed)
            };

        } catch {

            return { valid: false };

        }

    }

}

/**
 * Normalize a wallet to bounceable url-safe friendly form, or null if invalid.
 */
export function normalizeTelegramWallet(rawWallet) {

    const parsed = parseTonWallet(rawWallet);

    if (!parsed.valid) {

        return null;

    }

    return parsed.address.toString({
        bounceable: true,
        urlSafe: true
    });

}

export function isValidTelegramWallet(rawWallet) {

    return parseTonWallet(rawWallet).valid === true;

}
