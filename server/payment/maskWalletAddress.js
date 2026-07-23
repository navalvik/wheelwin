/**
 * P6.8B — Mask a TON wallet for logs (never log the full owner wallet).
 */
export function maskWalletAddress(wallet) {

    if (typeof wallet !== "string" || wallet.length < 10) {

        return "****";

    }

    return `${wallet.slice(0, 4)}...${wallet.slice(-4)}`;

}
