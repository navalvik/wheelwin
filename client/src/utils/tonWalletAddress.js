import { Address } from "@ton/core";

/**
 * Convert a TON Connect account address to the EQ session-wallet form.
 */
export function toSessionWalletAddress(rawAddress) {

    if (typeof rawAddress !== "string" || !rawAddress.trim()) {

        return null;

    }

    try {

        return Address.parse(rawAddress.trim()).toString({
            bounceable: true,
            urlSafe: true
        });

    } catch {

        return rawAddress.trim();

    }

}
