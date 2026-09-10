/**
 * R9 — TonConnect manifest URL resolution for Testnet/Mainnet separation.
 *
 * Selection logic:
 * - Testnet: hostname contains "nine" or "testnet" → tonconnect-manifest.json
 * - Mainnet: all other hosts → tonconnect-manifest.mainnet.json
 *
 * This approach uses hostname-based detection to separate environments
 * without requiring Vercel environment variables or hardcoded guessed
 * production domains beyond the documented Mainnet Vercel project name.
 */
export function resolveTonConnectManifestUrl() {

    if (typeof window === "undefined") {

        return "/tonconnect-manifest.json";

    }

    const hostname = window.location.hostname;

    const isTestnet = hostname.includes("nine") || hostname.includes("testnet");

    return isTestnet
        ? `${window.location.origin}/tonconnect-manifest.json`
        : `${window.location.origin}/tonconnect-manifest.mainnet.json`;

}