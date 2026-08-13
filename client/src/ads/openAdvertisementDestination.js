/**
 * R14.5 — Open advertisement destination (no tracking).
 * Telegram links stay Telegram-compatible; other https/http open externally.
 */

const FORBIDDEN_SCHEMES = [
    "javascript:",
    "data:",
    "file:",
    "vbscript:",
    "blob:"
];

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

    const lower = trimmed.toLowerCase();

    for (const scheme of FORBIDDEN_SCHEMES) {

        if (lower.startsWith(scheme)) {

            return false;

        }

    }

    return /^https?:\/\//i.test(trimmed);

}

/**
 * @param {string|null|undefined} url
 * @param {{ open?: Function, telegramWebApp?: object|null }=} options
 * @returns {boolean} true when an open was attempted
 */
export function openAdvertisementDestination(url, options = {}) {

    if (!isSafeAdvertisementDestination(url)) {

        return false;

    }

    const trimmed = String(url).trim();
    const openFn = options.open
        ?? (typeof window !== "undefined" ? window.open.bind(window) : null);
    const telegramWebApp = options.telegramWebApp !== undefined
        ? options.telegramWebApp
        : (typeof window !== "undefined"
            ? window.Telegram?.WebApp ?? null
            : null);

    try {

        if (isTelegramAdvertisementUrl(trimmed)) {

            if (typeof telegramWebApp?.openTelegramLink === "function") {

                telegramWebApp.openTelegramLink(trimmed);

                return true;

            }

            if (typeof telegramWebApp?.openLink === "function") {

                telegramWebApp.openLink(trimmed);

                return true;

            }

        } else if (typeof telegramWebApp?.openLink === "function") {

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
