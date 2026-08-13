/**
 * Resolve the WheelWin backend base URL for Socket.IO / HTTP.
 *
 * Priority:
 * 1. VITE_SOCKET_URL (explicit override for any host)
 * 2. Same hostname as the page, port 3001 (LAN / multi-device)
 * 3. http://localhost:3001 (non-browser / fallback)
 *
 * Never hardcodes a LAN IP — uses window.location.hostname when available.
 */
export function resolveBackendUrl() {

    const configured = import.meta.env?.VITE_SOCKET_URL;

    if (typeof configured === "string" && configured.trim() !== "") {

        return configured.trim().replace(/\/$/, "");

    }

    if (typeof window !== "undefined" && window.location?.hostname) {

        const protocol = window.location.protocol === "https:"
            ? "https:"
            : "http:";

        const port = import.meta.env?.VITE_SOCKET_PORT || "3001";

        return `${protocol}//${window.location.hostname}:${port}`;

    }

    return "http://localhost:3001";

}
