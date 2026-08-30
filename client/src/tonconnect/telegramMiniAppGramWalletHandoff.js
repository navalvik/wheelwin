/**
 * R18-S16 — Telegram Mini App → Gram Wallet TESTNET handoff.
 *
 * @tonconnect/ui launches HTTP-bridge wallets with window.open(_self|_blank).
 * In a Telegram Mini App WebView that unloads the dApp (pagehide) before the
 * TonConnect ConnectEvent can return. Official Telegram API:
 * WebApp.openLink(httpsUrl) opens an external browser and does not close the
 * Mini App (core.telegram.org/bots/webapps).
 *
 * This module does not mock CONNECTED, does not emit WALLET_CONNECT_REPORT,
 * and does not change wallet registry / ADDRESS_MISMATCH.
 */

export const GRAM_WALLET_UNIVERSAL_ORIGIN = "https://connect.gramwallet.io";

export const GRAM_WALLET_DEEP_LINK_SCHEME = "gramwallet-tc:";

export const HANDOFF_METHOD = Object.freeze({
    TELEGRAM_OPEN_LINK: "telegram_openLink",
    WINDOW_OPEN: "window_open",
    ANCHOR_CLICK: "anchor_click",
    NONE: "none"
});

const KNOWN_TMA_PLATFORMS = new Set([
    "android",
    "ios",
    "macos",
    "tdesktop",
    "weba",
    "web",
    "unigram"
]);

const INSTALL_FLAG = "__WHEELWIN_GRAM_WALLET_HANDOFF_INSTALLED__";

function asUrlString(url) {

    if (url == null) {

        return "";

    }

    if (typeof url === "string") {

        return url.trim();

    }

    try {

        return String(url);

    } catch {

        return "";

    }

}

/**
 * @param {unknown} url
 * @returns {boolean}
 */
export function isGramWalletLaunchUrl(url) {

    const raw = asUrlString(url);

    if (!raw) {

        return false;

    }

    if (/^gramwallet-tc:/i.test(raw)) {

        return true;

    }

    try {

        const parsed = new URL(raw);

        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {

            return false;

        }

        const host = parsed.hostname.toLowerCase();

        return host === "connect.gramwallet.io"
            || host === "gramwallet.io"
            || host === "www.gramwallet.io";

    } catch {

        return false;

    }

}

/**
 * Rewrite Gram Wallet custom-scheme deeplinks to the HTTPS universal origin.
 * Query string is preserved (TonConnect v, id, r, ret, trace_id).
 *
 * @param {unknown} url
 * @returns {string|null} https URL, or null when not a Gram Wallet launch URL
 */
export function rewriteGramWalletLaunchUrl(url) {

    const raw = asUrlString(url);

    if (!isGramWalletLaunchUrl(raw)) {

        return null;

    }

    if (/^gramwallet-tc:/i.test(raw)) {

        const queryIndex = raw.indexOf("?");
        const query = queryIndex >= 0 ? raw.slice(queryIndex) : "";

        return `${GRAM_WALLET_UNIVERSAL_ORIGIN}/${query}`;

    }

    try {

        const parsed = new URL(raw);

        if (
            parsed.protocol === "https:"
            && parsed.hostname.toLowerCase() === "connect.gramwallet.io"
        ) {

            return raw;

        }

        parsed.protocol = "https:";
        parsed.hostname = "connect.gramwallet.io";
        parsed.port = "";

        return parsed.toString();

    } catch {

        return null;

    }

}

/**
 * @param {object} [globalObject]
 * @returns {boolean}
 */
export function isTelegramMiniAppEnvironment(globalObject = globalThis) {

    const win = globalObject?.window ?? globalObject;

    try {

        if (typeof win?.TelegramWebviewProxy?.postEvent === "function") {

            return true;

        }

        const webApp = win?.Telegram?.WebApp;

        if (!webApp) {

            return false;

        }

        if (typeof webApp.initData === "string" && webApp.initData.length > 0) {

            return true;

        }

        const platform = typeof webApp.platform === "string"
            ? webApp.platform.toLowerCase()
            : "";

        return KNOWN_TMA_PLATFORMS.has(platform);

    } catch {

        return false;

    }

}

function resolveWebApp(options, globalObject) {

    if (options.telegramWebApp !== undefined) {

        return options.telegramWebApp;

    }

    const win = globalObject?.window ?? globalObject;

    return win?.Telegram?.WebApp ?? null;

}

/**
 * Open a Gram Wallet TonConnect URL from Telegram Mini App without navigating
 * the Mini App document. Non-Gram / non-TMA callers fall through to window.open.
 *
 * @param {unknown} url
 * @param {object} [options]
 * @returns {{ handled: boolean, method: string, url: string|null }}
 */
export function launchGramWalletHandoff(url, options = {}) {

    const globalObject = options.globalObject ?? globalThis;
    const webApp = resolveWebApp(options, globalObject);
    const raw = asUrlString(url);

    if (!raw) {

        return { handled: false, method: HANDOFF_METHOD.NONE, url: null };

    }

    const inMiniApp = isTelegramMiniAppEnvironment(globalObject);
    const gramUrl = isGramWalletLaunchUrl(raw);
    const httpsUrl = gramUrl ? rewriteGramWalletLaunchUrl(raw) : null;

    if (inMiniApp && gramUrl && httpsUrl && typeof webApp?.openLink === "function") {

        try {

            webApp.openLink(httpsUrl);

        } catch {

            // Still treat as handled: never fall through to window.open(_self).
        }

        return {
            handled: true,
            method: HANDOFF_METHOD.TELEGRAM_OPEN_LINK,
            url: httpsUrl
        };

    }

    if (inMiniApp && gramUrl) {

        return {
            handled: true,
            method: HANDOFF_METHOD.NONE,
            url: httpsUrl
        };

    }

    const openWindow = options.openWindow
        ?? ((href, target, features) => {

            const win = globalObject?.window ?? globalObject;

            if (typeof win?.open !== "function") {

                return null;

            }

            return win.open(href, target, features);

        });

    try {

        const opened = openWindow(raw, "_blank", "noopener,noreferrer");

        if (opened) {

            return {
                handled: true,
                method: HANDOFF_METHOD.WINDOW_OPEN,
                url: raw
            };

        }

    } catch {

        // Fall through to optional anchor.
    }

    if (typeof options.createAnchorClick === "function") {

        try {

            options.createAnchorClick(raw);

            return {
                handled: true,
                method: HANDOFF_METHOD.ANCHOR_CLICK,
                url: raw
            };

        } catch {

            return { handled: false, method: HANDOFF_METHOD.NONE, url: raw };

        }

    }

    return { handled: false, method: HANDOFF_METHOD.NONE, url: raw };

}

function createHandledWindowStub() {

    return {
        closed: false,
        closedByHandoff: true,
        close() {

            this.closed = true;

        },
        opener: null,
        location: { href: "about:blank" }
    };

}

/**
 * Patch window.open so @tonconnect/ui redirectToWallet cannot navigate the
 * Mini App document to gramwallet-tc:// or connect.gramwallet.io.
 *
 * @param {object} [globalObject]
 * @returns {boolean} true when the patch was installed on this call
 */
export function installTelegramMiniAppGramWalletHandoff(globalObject = globalThis) {

    const win = globalObject?.window ?? globalObject;

    if (!win || typeof win.open !== "function") {

        return false;

    }

    if (win[INSTALL_FLAG] === true) {

        return false;

    }

    const originalOpen = win.open.bind(win);

    win.open = function wheelwinGramWalletHandoffOpen(url, target, features) {

        const result = launchGramWalletHandoff(url, {
            globalObject,
            telegramWebApp: resolveWebApp({}, globalObject),
            // Interceptor must not recurse into this patched open().
            openWindow: () => null
        });

        if (result.handled && result.method === HANDOFF_METHOD.TELEGRAM_OPEN_LINK) {

            return createHandledWindowStub();

        }

        if (
            result.handled
            && isTelegramMiniAppEnvironment(globalObject)
            && isGramWalletLaunchUrl(url)
        ) {

            return createHandledWindowStub();

        }

        return originalOpen(url, target, features);

    };

    win[INSTALL_FLAG] = true;

    return true;

}
