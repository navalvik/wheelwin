import { readFileSync } from "node:fs";

import { dirname, join } from "node:path";

import { fileURLToPath } from "node:url";

import { resolveBackendUrl } from "./backendUrl.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

// ---------------------------------------------------------------------------
// R18-S105 — Mainnet room-creation backend binding.
//
// The Mainnet Vercel project (wheelwin-main) is built WITHOUT
// VITE_SOCKET_URL, so resolveBackendUrl() must bind the Mainnet frontend
// host family to the authoritative Mainnet Railway backend, while leaving
// Testnet / LAN / localhost resolution unchanged and never falling back to
// the Testnet backend.
// ---------------------------------------------------------------------------

const configDir = dirname(fileURLToPath(import.meta.url));

const source = readFileSync(join(configDir, "backendUrl.js"), "utf8");

const MAINNET_BACKEND_URL = "https://positive-clarity-production-d1a1.up.railway.app";

const TESTNET_BACKEND_MARKER = "wheelwin-production";

// Window stubbing helpers. resolveBackendUrl() reads window.location at call
// time, so each scenario can swap the stub and restore the original state.

const originalWindow = globalThis.window;

function restoreWindow() {

    if (originalWindow === undefined) {

        delete globalThis.window;

    } else {

        globalThis.window = originalWindow;

    }

}

function withWindow(hostname, protocol, fn) {

    globalThis.window = { location: { hostname, protocol } };

    try {

        return fn();

    } finally {

        restoreWindow();

    }

}

function withoutWindow(fn) {

    delete globalThis.window;

    try {

        return fn();

    } finally {

        restoreWindow();

    }

}

// 1. Non-browser / Node context: localhost fallback unchanged.

assert(
    withoutWindow(() => resolveBackendUrl()) === "http://localhost:3001",
    "non-browser context must keep the http://localhost:3001 fallback"
);

// 2. Testnet frontend host: same-host :3001 resolution unchanged (no Testnet
//    regression — this is the exact pre-fix behaviour).

assert(
    withWindow(
        "wheelwin-nine.vercel.app",
        "https:",
        () => resolveBackendUrl()
    ) === "https://wheelwin-nine.vercel.app:3001",
    "Testnet frontend host must keep same-host :3001 resolution"
);

// 3. THE FIX — Mainnet frontend host resolves to the Mainnet Railway backend.

assert(
    withWindow(
        "wheelwin-main.vercel.app",
        "https:",
        () => resolveBackendUrl()
    ) === MAINNET_BACKEND_URL,
    "Mainnet frontend host must resolve to the Mainnet Railway backend"
);

// 4. Mainnet preview deployments share the binding.

for (const previewHost of [
    "wheelwin-main-git-main-team.vercel.app",
    "wheelwin-main-abc123.vercel.app"
]) {

    assert(
        withWindow(previewHost, "https:", () => resolveBackendUrl())
            === MAINNET_BACKEND_URL,
        `Mainnet preview host must resolve to the Mainnet backend (${previewHost})`
    );

}

// 5. Localhost / LAN behaviour unchanged (dev workflows).

assert(
    withWindow("localhost", "http:", () => resolveBackendUrl())
        === "http://localhost:3001",
    "localhost must keep http://localhost:3001"
);

assert(
    withWindow("192.168.1.50", "http:", () => resolveBackendUrl())
        === "http://192.168.1.50:3001",
    "LAN host must keep same-host :3001 resolution"
);

// 6. Testnet project previews are NOT routed to the Mainnet backend.

assert(
    withWindow(
        "wheelwin-nine-git-feature-team.vercel.app",
        "https:",
        () => resolveBackendUrl()
    ) === "https://wheelwin-nine-git-feature-team.vercel.app:3001",
    "Testnet preview host must keep same-host :3001 resolution"
);

// 7. Network isolation — no Testnet fallback for the Mainnet host, https only.

const mainnetResult = withWindow(
    "wheelwin-main.vercel.app",
    "https:",
    () => resolveBackendUrl()
);

assert(
    mainnetResult.startsWith("https://"),
    "Mainnet backend binding must be https"
);

assert(
    !mainnetResult.includes(TESTNET_BACKEND_MARKER),
    "Mainnet binding must never resolve to the Testnet backend"
);

// 8. VITE_SOCKET_URL remains the first-priority resolution source
//    (structural check: the env override is evaluated before the Mainnet
//    host binding; import.meta.env is not writable in the Node test runner).

const functionStart = source.indexOf("export function resolveBackendUrl()");

assert(
    functionStart !== -1,
    "backendUrl.js must export resolveBackendUrl()"
);

const functionBody = source.slice(functionStart);

const envPriorityIndex = functionBody.indexOf("VITE_SOCKET_URL");

const mainnetBindingIndex = functionBody.indexOf(
    "resolveMainnetFrontendBackendUrl("
);

assert(
    envPriorityIndex !== -1 && mainnetBindingIndex !== -1,
    "resolveBackendUrl must keep the VITE_SOCKET_URL priority and the Mainnet binding"
);

assert(
    envPriorityIndex < mainnetBindingIndex,
    "VITE_SOCKET_URL must be evaluated before the Mainnet host binding"
);

// 9. The module never references the Testnet backend URL (isolation by
//    construction — the Testnet URL can only arrive via VITE_SOCKET_URL).

assert(
    !source.includes(TESTNET_BACKEND_MARKER),
    "backendUrl.js must not reference the Testnet backend URL"
);

// 10. The Mainnet binding is the authoritative documented Mainnet Railway URL.

assert(
    source.includes(MAINNET_BACKEND_URL),
    "backendUrl.js must contain the authoritative Mainnet Railway backend URL"
);

process.stdout.write("backendUrl tests passed" + String.fromCharCode(10));