import { Address } from "@ton/core";

/**
 * P6.2 / R6.x — Compare a TON Connect address to a session wallet.
 * Server-authoritative; official @ton/core parser only (no prefix / length gates).
 */
export function canonicalizeTonWalletAddress(rawWallet) {

    if (typeof rawWallet !== "string") {

        return null;

    }

    const trimmed = rawWallet.trim();

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

export function sessionWalletsMatch(sessionWallet, connectedWallet) {

    const left = canonicalizeTonWalletAddress(sessionWallet);

    const right = canonicalizeTonWalletAddress(connectedWallet);

    if (!left || !right) {

        return false;

    }

    return left === right;

}
