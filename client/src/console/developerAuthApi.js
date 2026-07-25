/**
 * R6.1 — Developer auth API + local session storage.
 * Completely independent of gameplay sockets / player identity.
 */

const STORAGE_KEY = "wheelwin.developerAuth.session";

export function getConsoleApiBase() {

    return import.meta.env.VITE_SOCKET_URL || "http://localhost:3001";

}

export function loadStoredDeveloperSession() {

    try {

        const raw = window.localStorage.getItem(STORAGE_KEY);

        if (!raw) {

            return null;

        }

        const parsed = JSON.parse(raw);

        if (!parsed?.accessToken || !parsed?.expiresAt) {

            return null;

        }

        return parsed;

    } catch {

        return null;

    }

}

export function storeDeveloperSession(session) {

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));

}

export function clearStoredDeveloperSession() {

    window.localStorage.removeItem(STORAGE_KEY);

}

async function parseJson(response) {

    try {

        return await response.json();

    } catch {

        return null;

    }

}

export async function fetchDeveloperAuthStatus() {

    const response = await fetch(`${getConsoleApiBase()}/console/auth/status`, {
        method: "GET",
        headers: { Accept: "application/json" }
    });

    return parseJson(response);

}

export async function loginDeveloper({ username, password }) {

    const response = await fetch(`${getConsoleApiBase()}/console/auth/login`, {
        method: "POST",
        headers: {
            Accept: "application/json",
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ username, password })
    });

    const body = await parseJson(response);

    if (!response.ok) {

        throw new Error(body?.error || "Login failed");

    }

    return body;

}

export async function refreshDeveloperSession(refreshToken) {

    const response = await fetch(`${getConsoleApiBase()}/console/auth/refresh`, {
        method: "POST",
        headers: {
            Accept: "application/json",
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ refreshToken })
    });

    const body = await parseJson(response);

    if (!response.ok) {

        throw new Error(body?.error || "Session renewal failed");

    }

    return body;

}

export async function logoutDeveloper({ accessToken, refreshToken }) {

    try {

        await fetch(`${getConsoleApiBase()}/console/auth/logout`, {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                ...(accessToken
                    ? { Authorization: `Bearer ${accessToken}` }
                    : {})
            },
            body: JSON.stringify({ refreshToken })
        });

    } catch {

        // Network failure still clears local session.

    }

}

export function toClientSession(serverSession) {

    return {
        accessToken: serverSession.accessToken,
        refreshToken: serverSession.refreshToken,
        expiresAt: serverSession.expiresAt,
        refreshExpiresAt: serverSession.refreshExpiresAt,
        username: serverSession.user?.username,
        role: serverSession.user?.role,
        environment: serverSession.user?.environment,
        readOnly: serverSession.user?.readOnly !== false
    };

}

export function isSessionExpired(session, skewMs = 5_000) {

    if (!session?.expiresAt) {

        return true;

    }

    return session.expiresAt <= Date.now() + skewMs;

}
