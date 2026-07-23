import { Address } from "@ton/core";

import { normalizeTelegramWallet } from "./TelegramWalletRules.js";

/**
 * P6.2 — Compare a TON Connect address to a session wallet (EQ form).
 * Server-authoritative; does not trust client equality claims.
 */
export function canonicalizeTonWalletAddress(rawWallet) {

    if (typeof rawWallet !== "string") {

        return null;

    }

    const trimmed = rawWallet.trim();

    if (!trimmed) {

        return null;

    }

    const telegramForm = normalizeTelegramWallet(trimmed);

    if (telegramForm) {

        return telegramForm;

    }

    try {

        return Address.parse(trimmed).toString({
            bounceable: true,
            urlSafe: true
        });

    } catch {

        return null;

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
