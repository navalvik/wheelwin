/**
 * Resolve the WheelWin backend base URL for Socket.IO / HTTP.
 *
 * Priority:
 * 1. VITE_SOCKET_URL (explicit override for any host)
 * 2. Mainnet frontend host binding (wheelwin-main*.vercel.app → Mainnet
 *    Railway backend, see resolveMainnetFrontendBackendUrl)
 * 3. Same hostname as the page, port 3001 (LAN / multi-device)
 * 4. http://localhost:3001 (non-browser / fallback)
 *
 * Never hardcodes a LAN IP — uses window.location.hostname when available.
 */

/**
 * R18-S105 — Mainnet frontend → Mainnet backend binding.
 *
 * The Mainnet Vercel project (`wheelwin-main`) is built WITHOUT
 * `VITE_SOCKET_URL`. The deployed Mainnet bundle therefore used to resolve
 * its Socket.IO target to the same host on port 3001 — a port Vercel does
 * not serve — so the Mainnet Socket.IO connection never established and
 * CREATE_ROOM could never reach the Mainnet Railway backend (no
 * `roomCreated` response → room creation impossible).
 *
 * This pin binds the Mainnet frontend host family to the authoritative
 * Mainnet Railway backend URL (public URL only; no secrets, no keys).
 *
 * Network isolation rules:
 * - `VITE_SOCKET_URL` (when set at build time) still wins — operator override.
 * - ONLY the Mainnet frontend host family maps to the Mainnet backend.
 * - Testnet / LAN / localhost behaviour is unchanged.
 * - No Testnet URL is referenced anywhere in this module and there is no
 *   Testnet fallback for Mainnet hosts.
 */
const MAINNET_BACKEND_URL = "https://positive-clarity-production-d1a1.up.railway.app";

function resolveMainnetFrontendBackendUrl(hostname) {

    const normalized = String(hostname ?? "").trim().toLowerCase();

    if (!normalized) {

        return null;

    }

    if (normalized === "wheelwin-main.vercel.app") {

        return MAINNET_BACKEND_URL;

    }

    // Vercel preview deployments of the Mainnet project (wheelwin-main-*).
    if (
        normalized.startsWith("wheelwin-main")
        && normalized.endsWith(".vercel.app")
    ) {

        return MAINNET_BACKEND_URL;

    }

    return null;

}

export function resolveBackendUrl() {

    const configured = import.meta.env?.VITE_SOCKET_URL;

    if (typeof configured === "string" && configured.trim() !== "") {

        return configured.trim().replace(/\/$/, "");

    }

    if (typeof window !== "undefined" && window.location?.hostname) {

        const mainnetBackend = resolveMainnetFrontendBackendUrl(
            window.location.hostname
        );

        if (mainnetBackend) {

            return mainnetBackend;

        }

        const protocol = window.location.protocol === "https:"
            ? "https:"
            : "http:";

        const port = import.meta.env?.VITE_SOCKET_PORT || "3001";

        return `${protocol}//${window.location.hostname}:${port}`;

    }

    return "http://localhost:3001";

}
