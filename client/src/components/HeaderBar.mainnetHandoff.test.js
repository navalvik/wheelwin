/**
 * R19-S110 — Focused behavioral test for the Testnet → Mainnet Telegram
 * Mini App handoff in `client/src/components/HeaderBar.jsx`.
 *
 * The Node test harness has no JSX loader (client/scripts/loaderHooks.js only
 * appends `.js` for extensionless relative imports), so the handoff source
 * block is extracted VERBATIM from the component file — between the stable
 * code markers `const MAINNET_MINI_APP_DEEP_LINK` and `const isTestnet =` —
 * and evaluated with a fake `window`. This executes the real production
 * decision logic, not a copy.
 *
 * Contract under test:
 * 1. Telegram WebApp runtime (openTelegramLink available) → the Telegram
 *    native Main Mini App deep link is used; window.location.replace is NOT
 *    called.
 * 2. Non-Telegram runtime → the existing direct Mainnet URL fallback via
 *    window.location.replace is used.
 * 3. The authoritative Mainnet bot is used with a NON-EMPTY `startapp` launch
 *    marker: https://t.me/wheel_win_bot?startapp=mainnet
 * 4. Fail-safe: Telegram present but openTelegramLink unavailable (older
 *    client) → browser fallback, never a crash.
 * 5. No Testnet initData / tgWebAppData is forwarded, copied, or
 *    reconstructed by the handoff code.
 */

import { readFileSync } from "node:fs";

import assert from "node:assert/strict";

import { dirname, join } from "node:path";

import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));

const componentSource = readFileSync(
    join(currentDir, "HeaderBar.jsx"),
    "utf8"
);

const HANDOFF_BEGIN_MARKER = "const MAINNET_MINI_APP_DEEP_LINK";

const HANDOFF_END_MARKER = "return (";

const beginIndex = componentSource.indexOf(HANDOFF_BEGIN_MARKER);

assert.notEqual(
    beginIndex,
    -1,
    "HeaderBar.jsx must declare MAINNET_MINI_APP_DEEP_LINK"
);

const endIndex = componentSource.indexOf(HANDOFF_END_MARKER, beginIndex);

assert.notEqual(
    endIndex,
    -1,
    "HeaderBar.jsx must keep the JSX return after the handoff block"
);

assert(
    endIndex > beginIndex,
    "HeaderBar.jsx handoff block must precede the JSX return"
);

const handoffSource = componentSource.slice(beginIndex, endIndex);

function evaluateHandoff(windowObject) {

    const factory = new Function(
        "window",
        `${handoffSource}
return {
    handleMainnetClick,
    MAINNET_MINI_APP_DEEP_LINK,
    MAINNET_WEB_URL
};`
    );

    return factory(windowObject);

}

function createFakeWindow({ withTelegramApi = false } = {}) {

    const calls = {
        openTelegramLink: [],
        locationReplace: []
    };

    const windowObject = {
        location: {
            replace: (url) => {

                calls.locationReplace.push(url);

            }
        }
    };

    if (withTelegramApi) {

        windowObject.Telegram = {
            WebApp: {
                openTelegramLink: (url) => {

                    calls.openTelegramLink.push(url);

                }
            }
        };

    }

    return { windowObject, calls };

}

// 1. Telegram WebApp runtime: Telegram-native Main Mini App handoff.

{

    const { windowObject, calls } = createFakeWindow({ withTelegramApi: true });

    const {
        handleMainnetClick,
        MAINNET_MINI_APP_DEEP_LINK
    } = evaluateHandoff(windowObject);

    handleMainnetClick();

    assert.deepEqual(
        calls.openTelegramLink,
        ["https://t.me/wheel_win_bot?startapp=mainnet"],
        "Telegram runtime must hand off via WebApp.openTelegramLink with the explicit Main Mini App launch marker"
    );

    assert.deepEqual(
        calls.locationReplace,
        [],
        "Telegram runtime must NOT navigate with window.location.replace"
    );

    assert.equal(
        MAINNET_MINI_APP_DEEP_LINK,
        "https://t.me/wheel_win_bot?startapp=mainnet",
        "The Mainnet deep link must use the operator-confirmed bot with an explicit non-empty startapp marker"
    );

}

// 2. Non-Telegram runtime: existing direct Mainnet URL fallback.

{

    const { windowObject, calls } = createFakeWindow();

    const {
        handleMainnetClick,
        MAINNET_WEB_URL
    } = evaluateHandoff(windowObject);

    handleMainnetClick();

    assert.deepEqual(
        calls.locationReplace,
        ["https://wheelwin-main.vercel.app"],
        "Non-Telegram runtime must keep the direct Mainnet URL fallback"
    );

    assert.deepEqual(
        calls.openTelegramLink,
        [],
        "Non-Telegram runtime must not attempt the Telegram handoff"
    );

    assert.equal(
        MAINNET_WEB_URL,
        "https://wheelwin-main.vercel.app",
        "The plain-browser fallback URL must remain the Mainnet origin"
    );

}

// 3. Fail-safe: Telegram present but openTelegramLink unavailable.

{

    const windowObject = {
        Telegram: {
            WebApp: {
                // openTelegramLink intentionally missing (older client).
                initData: ""
            }
        },
        location: {
            replace: (url) => {

                windowObject.lastReplace = url;

            }
        }
    };

    const { handleMainnetClick } = evaluateHandoff(windowObject);

    handleMainnetClick();

    assert.equal(
        windowObject.lastReplace,
        "https://wheelwin-main.vercel.app",
        "Missing Telegram API must fail safe to the browser fallback"
    );

}

// 4. Fail-safe: openTelegramLink present but not a function (hostile shape).

{

    const windowObject = {
        Telegram: {
            WebApp: {
                openTelegramLink: "not-a-function"
            }
        },
        location: {
            replace: (url) => {

                windowObject.lastReplace = url;

            }
        }
    };

    const { handleMainnetClick } = evaluateHandoff(windowObject);

    handleMainnetClick();

    assert.equal(
        windowObject.lastReplace,
        "https://wheelwin-main.vercel.app",
        "Non-function openTelegramLink must fail safe to the browser fallback"
    );

}

// 5. No Testnet initData / tgWebAppData forwarding or reconstruction.

assert.equal(
    /initData|tgWebAppData/.test(handoffSource),
    false,
    "The handoff block must not reference initData or tgWebAppData"
);

assert.equal(
    handoffSource.includes("wheelwin-nine"),
    false,
    "The handoff block must not reference the Testnet origin"
);

process.stdout.write("HeaderBar.mainnetHandoff tests passed" + String.fromCharCode(10));
