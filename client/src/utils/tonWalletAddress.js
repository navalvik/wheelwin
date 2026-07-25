/**
 * Normalize a TON Connect account address for the session-wallet report.
 *
 * Browser-safe: no @ton/core / Buffer. Server canonicalizes authoritatively.
 */
export function toSessionWalletAddress(rawAddress) {

    if (typeof rawAddress !== "string") {

        return null;

    }

    const trimmed = rawAddress.trim();

    if (!trimmed) {

        return null;

    }

    // EQ bounceable form already matches session wallets — pass through.
    if (trimmed.startsWith("EQ") && trimmed.length >= 48) {

        return trimmed;

    }

    // Other forms (UQ / raw): send as-is; server owns Address.parse.
    return trimmed;

}
