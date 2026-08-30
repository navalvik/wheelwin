/**
 * R18-S16 — UNIT TEST: Gram Wallet Telegram Mini App handoff decision.
 * Does not mock a successful TonConnect CONNECTED session.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
    GRAM_WALLET_UNIVERSAL_ORIGIN,
    HANDOFF_METHOD,
    installTelegramMiniAppGramWalletHandoff,
    isGramWalletLaunchUrl,
    isTelegramMiniAppEnvironment,
    launchGramWalletHandoff,
    rewriteGramWalletLaunchUrl
} from "./telegramMiniAppGramWalletHandoff.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN_SOURCE = readFileSync(join(HERE, "../main.jsx"), "utf8");
const PAGE4_SOURCE = readFileSync(
    join(HERE, "../pages/Page4Payment.jsx"),
    "utf8"
);

const GRAM_HTTPS = `${GRAM_WALLET_UNIVERSAL_ORIGIN}/?v=2&id=deadbeef`;
const GRAM_DEEP = "gramwallet-tc://?v=2&id=deadbeef&ret=back";
const TELEGRAM_WALLET = "https://t.me/wallet?attach=wallet";

function miniAppGlobal({ openLink, platform = "tdesktop", initData = "query_id=1" } = {}) {

    const opened = [];

    const webApp = {
        initData,
        platform,
        openLink: openLink ?? ((url) => {

            opened.push(url);

        })
    };

    const nativeOpenCalls = [];

    const win = {
        Telegram: { WebApp: webApp },
        open(url, target, features) {

            nativeOpenCalls.push({ url, target, features });

            return { closed: false };

        }
    };

    return { globalObject: { window: win }, win, webApp, opened, nativeOpenCalls };

}

test("UNIT: Gram Wallet HTTPS and deeplink are recognized", () => {

    assert.equal(isGramWalletLaunchUrl(GRAM_HTTPS), true);
    assert.equal(isGramWalletLaunchUrl(GRAM_DEEP), true);
    assert.equal(isGramWalletLaunchUrl("https://connect.gramwallet.io"), true);
    assert.equal(isGramWalletLaunchUrl(TELEGRAM_WALLET), false);
    assert.equal(isGramWalletLaunchUrl("https://app.tonkeeper.com/ton-connect"), false);
    assert.equal(isGramWalletLaunchUrl("https://walletbot.me/tonconnect-bridge/bridge"), false);

});

test("UNIT: Gram Wallet deeplink rewrites to connect.gramwallet.io preserving query", () => {

    const rewritten = rewriteGramWalletLaunchUrl(GRAM_DEEP);

    assert.ok(rewritten.startsWith(`${GRAM_WALLET_UNIVERSAL_ORIGIN}/?`));
    assert.ok(rewritten.includes("v=2"));
    assert.ok(rewritten.includes("id=deadbeef"));
    assert.equal(rewriteGramWalletLaunchUrl(TELEGRAM_WALLET), null);

});

test("UNIT: Mini App is detected from initData / platform / WebviewProxy", () => {

    assert.equal(
        isTelegramMiniAppEnvironment({
            window: { Telegram: { WebApp: { initData: "user=%7B%7D", platform: "unknown" } } }
        }),
        true
    );
    assert.equal(
        isTelegramMiniAppEnvironment({
            window: { Telegram: { WebApp: { initData: "", platform: "tdesktop" } } }
        }),
        true
    );
    assert.equal(
        isTelegramMiniAppEnvironment({
            window: {
                TelegramWebviewProxy: { postEvent() {} },
                Telegram: { WebApp: { initData: "" } }
            }
        }),
        true
    );
    assert.equal(
        isTelegramMiniAppEnvironment({
            window: { Telegram: { WebApp: { initData: "", platform: "unknown" } } }
        }),
        false
    );
    assert.equal(isTelegramMiniAppEnvironment({ window: {} }), false);

});

test("UNIT: Mini App Gram Wallet handoff uses WebApp.openLink not window.open", () => {

    const openedLinks = [];
    const { globalObject, nativeOpenCalls } = miniAppGlobal({
        openLink: (url) => openedLinks.push(url)
    });

    const result = launchGramWalletHandoff(GRAM_HTTPS, {
        globalObject,
        telegramWebApp: globalObject.window.Telegram.WebApp,
        openWindow: () => {

            throw new Error("window.open must not run for Mini App Gram Wallet");

        }
    });

    assert.equal(result.handled, true);
    assert.equal(result.method, HANDOFF_METHOD.TELEGRAM_OPEN_LINK);
    assert.equal(openedLinks.length, 1);
    assert.equal(openedLinks[0], GRAM_HTTPS);
    assert.equal(nativeOpenCalls.length, 0);

});

test("UNIT: Mini App gramwallet-tc deeplink is opened as HTTPS via openLink", () => {

    const openedLinks = [];
    const { globalObject } = miniAppGlobal({
        openLink: (url) => openedLinks.push(url)
    });

    const result = launchGramWalletHandoff(GRAM_DEEP, { globalObject });

    assert.equal(result.method, HANDOFF_METHOD.TELEGRAM_OPEN_LINK);
    assert.equal(openedLinks.length, 1);
    assert.ok(openedLinks[0].startsWith("https://connect.gramwallet.io/"));
    assert.ok(openedLinks[0].includes("id=deadbeef"));

});

test("UNIT: Telegram Wallet t.me links are not claimed by Gram handoff", () => {

    const openedLinks = [];
    const windowOpens = [];
    const { globalObject } = miniAppGlobal({
        openLink: (url) => openedLinks.push(url)
    });

    const result = launchGramWalletHandoff(TELEGRAM_WALLET, {
        globalObject,
        openWindow: (url, target) => {

            windowOpens.push({ url, target });

            return { closed: false };

        }
    });

    assert.equal(result.method, HANDOFF_METHOD.WINDOW_OPEN);
    assert.equal(openedLinks.length, 0);
    assert.equal(windowOpens.length, 1);
    assert.equal(windowOpens[0].url, TELEGRAM_WALLET);

});

test("UNIT: ordinary browser Gram Wallet still uses window.open", () => {

    const windowOpens = [];
    const result = launchGramWalletHandoff(GRAM_HTTPS, {
        globalObject: { window: { Telegram: { WebApp: { initData: "" } } } },
        telegramWebApp: { openLink() { throw new Error("openLink must not run"); } },
        openWindow: (url, target) => {

            windowOpens.push({ url, target });

            return { closed: false };

        }
    });

    assert.equal(result.method, HANDOFF_METHOD.WINDOW_OPEN);
    assert.equal(windowOpens.length, 1);
    assert.equal(windowOpens[0].target, "_blank");

});

test("UNIT: window.open interceptor blocks Mini App _self Gram navigation", () => {

    const openedLinks = [];
    const { globalObject, win, nativeOpenCalls } = miniAppGlobal({
        openLink: (url) => openedLinks.push(url)
    });

    const installed = installTelegramMiniAppGramWalletHandoff(globalObject);

    assert.equal(installed, true);

    const stub = win.open(GRAM_DEEP, "_self", "noopener noreferrer");

    assert.equal(openedLinks.length, 1);
    assert.ok(openedLinks[0].startsWith("https://connect.gramwallet.io/"));
    assert.equal(nativeOpenCalls.length, 0);
    assert.equal(stub.closedByHandoff, true);

    const other = win.open("https://example.com", "_blank");

    assert.equal(nativeOpenCalls.length, 1);
    assert.equal(nativeOpenCalls[0].url, "https://example.com");
    assert.equal(other.closedByHandoff, undefined);

});

test("UNIT: production wiring installs handoff before TonConnectUIProvider", () => {

    const polyfill = MAIN_SOURCE.indexOf("./polyfills/browserPolyfills");
    const install = MAIN_SOURCE.indexOf(
        "./tonconnect/installTelegramMiniAppGramWalletHandoff.js"
    );
    const provider = MAIN_SOURCE.indexOf("@tonconnect/ui-react");

    assert.ok(polyfill !== -1 && install !== -1 && provider !== -1);
    assert.ok(
        polyfill < install && install < provider,
        "Gram Wallet TMA handoff must load after polyfills and before TonConnect UI"
    );
    assert.match(
        PAGE4_SOURCE,
        /launchGramWalletHandoff/
    );
    assert.match(
        PAGE4_SOURCE,
        /telegramMiniAppGramWalletHandoff/
    );

});
