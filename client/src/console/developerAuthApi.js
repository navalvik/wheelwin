/**
 * R6.1 — Developer auth API + local session storage.
 * Completely independent of gameplay sockets / player identity.
 */

import { resolveBackendUrl } from "../config/backendUrl.js";

const STORAGE_KEY = "wheelwin.developerAuth.session";

export function getConsoleApiBase() {

    return resolveBackendUrl();

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

    const body = await parseJson(response);

    if (body?.appEnvironment && !body?.environment) {

        return {
            ...body,
            environment: body.appEnvironment
        };

    }

    return body;

}

export async function fetchEnvironmentSummary(accessToken) {

    const response = await fetch(`${getConsoleApiBase()}/console/environment/summary`, {
        method: "GET",
        headers: {
            Accept: "application/json",
            Authorization: `Bearer ${accessToken}`
        }
    });

    const body = await parseJson(response);

    if (!response.ok) {

        throw new Error(body?.error || "Failed to load environment summary");

    }

    return body;

}

export async function fetchEnvironmentStatus(accessToken) {

    const response = await fetch(`${getConsoleApiBase()}/console/environment`, {
        method: "GET",
        headers: {
            Accept: "application/json",
            Authorization: `Bearer ${accessToken}`
        }
    });

    const body = await parseJson(response);

    if (!response.ok) {

        throw new Error(body?.error || "Failed to load environment status");

    }

    return body;

}

export async function switchAppEnvironment({
    accessToken,
    targetEnvironment,
    password,
    confirmationPhrase,
    finalConfirmationPhrase
}) {

    const response = await fetch(`${getConsoleApiBase()}/console/environment/switch`, {
        method: "POST",
        headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`
        },
        body: JSON.stringify({
            targetEnvironment,
            password,
            confirmationPhrase,
            finalConfirmationPhrase
        })
    });

    const body = await parseJson(response);

    if (!response.ok) {

        throw new Error(body?.error || "Environment switch failed");

    }

    return body;

}

export async function fetchSystemInformation(accessToken) {

    const response = await fetch(`${getConsoleApiBase()}/console/system`, {
        method: "GET",
        headers: {
            Accept: "application/json",
            Authorization: `Bearer ${accessToken}`
        }
    });

    const body = await parseJson(response);

    if (!response.ok) {

        throw new Error(body?.error || "Failed to load system information");

    }

    return body;

}

/**
 * R17.9G / R17.9G.1 — Runtime configuration snapshot (role-aware).
 */
export async function fetchRuntimeConfiguration(accessToken) {

    const response = await fetch(
        `${getConsoleApiBase()}/console/configuration/runtime`,
        {
            method: "GET",
            headers: {
                Accept: "application/json",
                Authorization: `Bearer ${accessToken}`
            }
        }
    );

    const body = await parseJson(response);

    if (!response.ok) {

        const error = new Error(
            body?.error || "Failed to load runtime configuration"
        );

        error.status = response.status;
        error.body = body;

        throw error;

    }

    return body;

}

/**
 * R17.9I.2 / R17.9I.3 — Audio Registry snapshot (Administrator-only).
 */
export async function fetchAudioRegistry(accessToken) {

    const response = await fetch(
        `${getConsoleApiBase()}/console/configuration/audio-registry`,
        {
            method: "GET",
            headers: {
                Accept: "application/json",
                Authorization: `Bearer ${accessToken}`
            }
        }
    );

    const body = await parseJson(response);

    if (!response.ok) {

        const error = new Error(
            body?.error || "Failed to load audio registry"
        );

        error.status = response.status;
        error.body = body;

        throw error;

    }

    return body;

}

/**
 * R17.9I.3 — Administrator-only Audio Registry mutation.
 */
export async function updateAudioRegistry(accessToken, payload) {

    const response = await fetch(
        `${getConsoleApiBase()}/console/configuration/audio-registry`,
        {
            method: "PUT",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                Authorization: `Bearer ${accessToken}`
            },
            body: JSON.stringify(payload)
        }
    );

    const body = await parseJson(response);

    if (!response.ok) {

        const detail = Array.isArray(body?.details) && body.details.length > 0
            ? ` (${body.details.join("; ")})`
            : "";

        const error = new Error(
            `${body?.error || "Failed to update audio registry"}${detail}`
        );

        error.status = response.status;
        error.body = body;

        throw error;

    }

    return body;

}

/**
 * R17.9J.2B — Administrator-only .ogg upload into client audio assets.
 * @param {string} accessToken
 * @param {string} entryId
 * @param {File|Blob} file
 */
export async function uploadAudioRegistryAsset(accessToken, entryId, file) {

    const id = encodeURIComponent(String(entryId ?? "").trim());
    const form = new FormData();

    form.append("file", file);

    const response = await fetch(
        `${getConsoleApiBase()}/console/configuration/audio-registry/${id}/upload`,
        {
            method: "POST",
            headers: {
                Accept: "application/json",
                Authorization: `Bearer ${accessToken}`
                // Content-Type set by browser with multipart boundary
            },
            body: form
        }
    );

    const body = await parseJson(response);

    if (!response.ok) {

        const error = new Error(
            body?.error || "Failed to upload audio asset"
        );

        error.status = response.status;
        error.body = body;

        throw error;

    }

    return body;

}

/**
 * R17.9G.1 — Administrator-only runtime configuration mutation.
 */
export async function updateRuntimeConfiguration(accessToken, values) {

    const response = await fetch(
        `${getConsoleApiBase()}/console/configuration/runtime`,
        {
            method: "PUT",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                Authorization: `Bearer ${accessToken}`
            },
            body: JSON.stringify({ values })
        }
    );

    const body = await parseJson(response);

    if (!response.ok) {

        const detail = Array.isArray(body?.details) && body.details.length > 0
            ? ` (${body.details.join("; ")})`
            : "";

        throw new Error(
            `${body?.error || "Failed to update runtime configuration"}${detail}`
        );

    }

    return body;

}

export async function fetchBlockchainStatus(accessToken) {

    const response = await fetch(`${getConsoleApiBase()}/console/blockchain`, {
        method: "GET",
        headers: {
            Accept: "application/json",
            Authorization: `Bearer ${accessToken}`
        }
    });

    const body = await parseJson(response);

    if (!response.ok) {

        throw new Error(body?.error || "Failed to load blockchain status");

    }

    return body;

}

/**
 * R17.9H — Read-only wallet balance monitor snapshot.
 */
export async function fetchWalletBalances(accessToken) {

    const response = await fetch(
        `${getConsoleApiBase()}/console/wallets/balances`,
        {
            method: "GET",
            headers: {
                Accept: "application/json",
                Authorization: `Bearer ${accessToken}`
            }
        }
    );

    const body = await parseJson(response);

    if (!response.ok) {

        const error = new Error(body?.error || "Failed to load wallet balances");

        error.status = response.status;
        error.body = body;

        throw error;

    }

    return body;

}

export async function fetchDeployerWalletStatus(accessToken) {

    const response = await fetch(
        `${getConsoleApiBase()}/console/ton/deployer-wallet`,
        {
            method: "GET",
            headers: {
                Accept: "application/json",
                Authorization: `Bearer ${accessToken}`
            }
        }
    );

    const body = await parseJson(response);

    if (!response.ok) {

        if (response.status === 403) {

            throw new Error(body?.message || body?.error || "Forbidden");

        }

        throw new Error(body?.error || "Failed to load deployer wallet status");

    }

    return body;

}

export async function listAdvertisements(accessToken) {

    const response = await fetch(`${getConsoleApiBase()}/console/advertisements`, {
        method: "GET",
        headers: authHeaders(accessToken)
    });

    const body = await parseJson(response);

    if (!response.ok) {

        if (response.status === 401) {

            throw new Error(
                body?.error || "Unauthorized — sign in to view advertisements"
            );

        }

        if (response.status === 403) {

            throw new Error(body?.message || body?.error || "Forbidden");

        }

        throw new Error(
            body?.error || body?.message || "Failed to load advertisements"
        );

    }

    return body;

}

export async function getAdvertisement(accessToken, id) {

    const response = await fetch(
        `${getConsoleApiBase()}/console/advertisements/${encodeURIComponent(id)}`,
        {
            method: "GET",
            headers: authHeaders(accessToken)
        }
    );

    const body = await parseJson(response);

    if (!response.ok) {

        if (response.status === 401) {

            throw new Error(body?.error || "Unauthorized");

        }

        if (response.status === 404) {

            throw new Error(body?.error || "Campaign not found");

        }

        if (response.status === 403) {

            throw new Error(body?.message || body?.error || "Forbidden");

        }

        throw new Error(
            body?.error || body?.message || "Failed to load campaign"
        );

    }

    return body;

}

function advertisementMutationError(response, body, fallback) {

    if (response.status === 401) {

        return body?.error || "Unauthorized";

    }

    if (response.status === 403) {

        return body?.message || body?.error || "Forbidden — Administrator required";

    }

    if (response.status === 404) {

        return body?.error || "Campaign not found";

    }

    return body?.message || body?.error || body?.code || fallback;

}

export async function createAdvertisement(accessToken, payload = {}) {

    const response = await fetch(`${getConsoleApiBase()}/console/advertisements`, {
        method: "POST",
        headers: jsonAuthHeaders(accessToken),
        body: JSON.stringify(payload)
    });

    const body = await parseJson(response);

    if (!response.ok) {

        throw new Error(
            advertisementMutationError(response, body, "Failed to create campaign")
        );

    }

    return body;

}

export async function uploadAdvertisement(accessToken, payload = {}) {

    const response = await fetch(
        `${getConsoleApiBase()}/console/advertisements/upload`,
        {
            method: "POST",
            headers: jsonAuthHeaders(accessToken),
            body: JSON.stringify(payload)
        }
    );

    const body = await parseJson(response);

    if (!response.ok) {

        throw new Error(
            advertisementMutationError(response, body, "Failed to upload banner")
        );

    }

    return body;

}

export async function updateAdvertisement(accessToken, id, patch = {}) {

    const response = await fetch(
        `${getConsoleApiBase()}/console/advertisements/${encodeURIComponent(id)}`,
        {
            method: "PATCH",
            headers: jsonAuthHeaders(accessToken),
            body: JSON.stringify(patch)
        }
    );

    const body = await parseJson(response);

    if (!response.ok) {

        throw new Error(
            advertisementMutationError(response, body, "Failed to update campaign")
        );

    }

    return body;

}

export async function disableAdvertisement(accessToken, id) {

    const response = await fetch(
        `${getConsoleApiBase()}/console/advertisements/${encodeURIComponent(id)}/disable`,
        {
            method: "POST",
            headers: jsonAuthHeaders(accessToken),
            body: JSON.stringify({})
        }
    );

    const body = await parseJson(response);

    if (!response.ok) {

        throw new Error(
            advertisementMutationError(response, body, "Failed to disable campaign")
        );

    }

    return body;

}

/**
 * R18.0-prep — permanently delete an advertising campaign and its banner
 * asset via the existing administrator-only console endpoint
 * (DELETE /console/advertisements/:id). History snapshot is preserved
 * server-side.
 */
export async function deleteAdvertisement(accessToken, id) {

    const response = await fetch(
        `${getConsoleApiBase()}/console/advertisements/${encodeURIComponent(id)}`,
        {
            method: "DELETE",
            headers: jsonAuthHeaders(accessToken)
        }
    );

    const body = await parseJson(response);

    if (!response.ok) {

        throw new Error(
            advertisementMutationError(response, body, "Failed to delete campaign")
        );

    }

    return body;

}

export async function renewAdvertisement(accessToken, id, payload = {}) {

    const response = await fetch(
        `${getConsoleApiBase()}/console/advertisements/${encodeURIComponent(id)}/renew`,
        {
            method: "POST",
            headers: jsonAuthHeaders(accessToken),
            body: JSON.stringify(payload)
        }
    );

    const body = await parseJson(response);

    if (!response.ok) {

        throw new Error(
            advertisementMutationError(response, body, "Failed to renew campaign")
        );

    }

    return body;

}

function authHeaders(accessToken) {

    const headers = { Accept: "application/json" };

    if (accessToken) {

        headers.Authorization = `Bearer ${accessToken}`;

    }

    return headers;

}

function jsonAuthHeaders(accessToken) {

    return {
        ...authHeaders(accessToken),
        "Content-Type": "application/json"
    };

}

export async function fetchSessionHistory(accessToken, query = {}) {

    const params = new URLSearchParams();

    for (const [key, value] of Object.entries(query)) {

        if (value == null || value === "" || value === "all") {

            continue;

        }

        params.set(key, String(value));

    }

    const suffix = params.toString() ? `?${params}` : "";

    const response = await fetch(
        `${getConsoleApiBase()}/console/history${suffix}`,
        {
            method: "GET",
            headers: authHeaders(accessToken)
        }
    );

    const body = await parseJson(response);

    if (!response.ok) {

        throw new Error(body?.error || "Failed to load session history");

    }

    return body;

}

export async function fetchSessionHistoryRecord(accessToken, sessionId) {

    const response = await fetch(
        `${getConsoleApiBase()}/console/history/${encodeURIComponent(sessionId)}`,
        {
            method: "GET",
            headers: authHeaders(accessToken)
        }
    );

    const body = await parseJson(response);

    if (!response.ok) {

        throw new Error(body?.error || "Failed to load history record");

    }

    return body;

}

export async function downloadSessionHistoryRecord(
    accessToken,
    sessionId,
    filenameOverride = null
) {

    const response = await fetch(
        `${getConsoleApiBase()}/console/history/${encodeURIComponent(sessionId)}/download`,
        {
            method: "GET",
            headers: authHeaders(accessToken)
        }
    );

    if (!response.ok) {

        let message = "Failed to download history record";

        try {

            const body = await response.json();

            message = body?.error || message;

        } catch {

            // keep default
        }

        throw new Error(message);

    }

    const disposition = response.headers.get("Content-Disposition") ?? "";
    const match = /filename="([^"]+)"/.exec(disposition);
    const filename = filenameOverride
        || match?.[1]
        || `history_${sessionId}.json`;
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");

    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(objectUrl);

    return filename;

}

export async function fetchMaintenanceStatus(accessToken) {

    const response = await fetch(`${getConsoleApiBase()}/console/maintenance`, {
        method: "GET",
        headers: {
            Accept: "application/json",
            Authorization: `Bearer ${accessToken}`
        }
    });

    const body = await parseJson(response);

    if (!response.ok) {

        throw new Error(body?.error || "Failed to load maintenance status");

    }

    return body;

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
        sessionId: serverSession.user?.sessionId ?? serverSession.sessionId ?? null,
        environment: serverSession.user?.environment,
        readOnly: serverSession.user?.readOnly === true
    };

}

export function isSessionExpired(session, skewMs = 5_000) {

    if (!session?.expiresAt) {

        return true;

    }

    return session.expiresAt <= Date.now() + skewMs;

}
