import { readFileSync } from "node:fs";

import { dirname, join } from "node:path";

import { fileURLToPath } from "node:url";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

// ---------------------------------------------------------------------------
// R17.9T.6-F — Telegram WebApp SDK bootstrap wiring.
//
// Verifies that the Vite HTML entry loads the official Telegram WebApp
// script synchronously in <head>, BEFORE the application module script,
// so window.Telegram.WebApp.initData exists when socket.js executes.
// ---------------------------------------------------------------------------

const clientRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const html = readFileSync(join(clientRoot, "index.html"), "utf8");

// 1. Exactly one official Telegram WebApp SDK script is present.

const sdkMatches = html.match(/<script[^>]*telegram-web-app\.js[^>]*><\/script>/g) ?? [];

assert(
    sdkMatches.length === 1,
    `index.html must contain exactly one telegram-web-app.js script (found ${sdkMatches.length})`
);

assert(
    /src="https:\/\/telegram\.org\/js\/telegram-web-app\.js\?63"/.test(sdkMatches[0]),
    "the official Telegram WebApp script URL (?63) must be used"
);

// 2. The SDK script must be synchronous: no async/defer attributes.

assert(
    !/\basync\b/.test(sdkMatches[0]) && !/\bdefer\b/.test(sdkMatches[0]),
    "Telegram WebApp script must not use async/defer"
);

// 3. The SDK script must appear BEFORE the application module script.

const sdkIndex = html.indexOf("telegram-web-app.js");

const moduleIndex = html.indexOf("/src/main.jsx");

assert(
    sdkIndex !== -1 && moduleIndex !== -1 && sdkIndex < moduleIndex,
    "Telegram WebApp script must load before the application module script"
);

// 4. No vendored/duplicated Telegram SDK copies anywhere in index.html.

assert(
    (html.match(/telegram-web-app/g) ?? []).length === 1,
    "no duplicate or vendored Telegram WebApp scripts allowed"
);

process.stdout.write("telegramWebAppBootstrap tests passed" + String.fromCharCode(10));