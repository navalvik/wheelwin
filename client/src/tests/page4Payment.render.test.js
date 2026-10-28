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
    assert.match(html, /WAITING_FOR_PLAYER_IDENTITY/, "Page4 waits for server identity");
    assert.match(html, /Waiting for your room and player session/, "Page4 explains missing identity");
    assert.doesNotMatch(html, /Room wallet:/, "No unverified destination is shown");
    assert.doesNotMatch(html, /CONFIRM IN TELEGRAM WALLET/, "No payment action without server intent");
} finally {
    await vite.close();
}

process.stdout.write("page4Payment.render.test.js: all assertions passed\n");
