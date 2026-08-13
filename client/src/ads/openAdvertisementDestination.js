/**
 * R14.5 / R14.6 — Open advertisement destination via WheelWin redirect.
 * Client must not open advertiser URLs directly.
 */

import { resolveBackendUrl } from "../config/backendUrl.js";

const FORBIDDEN_SCHEMES = [
    "javascript:",
    "data:",
    "file:",
    "vbscript:",
    "blob:"
];

export const ADVERTISEMENT_CLICK_PATH_PREFIX = "/advertisements/click";

export function buildAdvertisementClickPath(advertisementId) {

    if (typeof advertisementId !== "string" || !advertisementId.trim()) {

        return null;

    }

    const id = advertisementId.trim();

    if (
        id.includes("..")
        || id.includes("/")
        || id.includes("\\")
        || id.includes("\0")
    ) {

        return null;

    }

    return `${ADVERTISEMENT_CLICK_PATH_PREFIX}/${encodeURIComponent(id)}`;

}

export function isWheelWinAdvertisementClickPath(url) {

    if (typeof url !== "string") {

        return false;

    }

    try {

        if (url.startsWith(ADVERTISEMENT_CLICK_PATH_PREFIX + "/")) {

            return true;

        }

        if (typeof window !== "undefined" && window.location?.origin) {

            const absolute = new URL(url, window.location.origin);

            return absolute.pathname.startsWith(
                ADVERTISEMENT_CLICK_PATH_PREFIX + "/"
            );

        }

    } catch {

        return false;

    }

    return false;

}

export function isTelegramAdvertisementUrl(url) {

    return /^https:\/\/t\.me\//i.test(String(url || "").trim());

}

export function isSafeAdvertisementDestination(url) {

    if (typeof url !== "string") {

        return false;

    }

    const trimmed = url.trim();

    if (!trimmed) {

        return false;

    }

    if (isWheelWinAdvertisementClickPath(trimmed)) {

        return true;

    }

    const lower = trimmed.toLowerCase();

    for (const scheme of FORBIDDEN_SCHEMES) {

        if (lower.startsWith(scheme)) {

            return false;

        }

    }

    return /^https?:\/\//i.test(trimmed);

}

function resolveOpenableUrl(url) {

    const trimmed = String(url).trim();

    if (isWheelWinAdvertisementClickPath(trimmed)) {

        if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {

            return trimmed;

        }

        const base = resolveBackendUrl().replace(/\/$/, "");
        const path = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;

        return `${base}${path}`;

    }

    return trimmed;

}

/**
 * @param {string|null|undefined} url WheelWin click path preferred
 * @param {{ open?: Function, telegramWebApp?: object|null }=} options
 * @returns {boolean}
 */
export function openAdvertisementDestination(url, options = {}) {

    if (!isSafeAdvertisementDestination(url)) {

        return false;

    }

    const trimmed = resolveOpenableUrl(url);
    const openFn = options.open
        ?? (typeof window !== "undefined" ? window.open.bind(window) : null);
    const telegramWebApp = options.telegramWebApp !== undefined
        ? options.telegramWebApp
        : (typeof window !== "undefined"
            ? window.Telegram?.WebApp ?? null
            : null);

    // Prefer Telegram openLink for Mini App contexts (including click redirect).
    try {

        if (typeof telegramWebApp?.openLink === "function") {

            telegramWebApp.openLink(trimmed);

            return true;

        }

    } catch {

        // Fall through to window.open.

    }

    if (typeof openFn !== "function") {

        return false;

    }

    try {

        openFn(trimmed, "_blank", "noopener,noreferrer");

        return true;

    } catch {

        return false;

    }

}
