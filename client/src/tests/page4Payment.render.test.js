import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createServer } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(testDirectory, "../..");
const vite = await createServer({
    root: clientRoot,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error"
});

try {
    const [
        { default: Page4Payment },
        { PlayerIdentityProvider },
        { LanguageProvider }
    ] = await Promise.all([
        vite.ssrLoadModule(resolve(clientRoot, "src/pages/Page4Payment.jsx")),
        vite.ssrLoadModule(resolve(clientRoot, "src/context/PlayerIdentityContext.jsx")),
        vite.ssrLoadModule(resolve(clientRoot, "src/context/LanguageContext.jsx"))
    ]);

    const html = renderToString(createElement(
        LanguageProvider,
        null,
        createElement(
            PlayerIdentityProvider,
            null,
            createElement(Page4Payment)
        )
    ));

    assert.match(html, /Payment status:/,
        "Page4 renders the payment status label");
    assert.match(html, /WAITING_FOR_PLAYER_IDENTITY/,
        "Page4 waits for verified room and player identity");
    assert.match(html, /Waiting for your room and player session to become available/,
        "Page4 explains missing identity without exposing a destination");
    assert.doesNotMatch(html, /Room wallet:|Payment reference:|CONFIRM IN TELEGRAM WALLET/,
        "Page4 must not expose or enable payment without authoritative session identity");
} finally {
    await vite.close();
}

process.stdout.write("page4Payment.render.test.js: all assertions passed\n");
