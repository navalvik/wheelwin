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
        { LanguageProvider },
        { AuthoritativeSessionProvider },
        { EngineBridgeProvider }
    ] = await Promise.all([
        vite.ssrLoadModule(resolve(clientRoot, "src/pages/Page4Payment.jsx")),
        vite.ssrLoadModule(resolve(clientRoot, "src/context/PlayerIdentityContext.jsx")),
        vite.ssrLoadModule(resolve(clientRoot, "src/context/LanguageContext.jsx")),
        vite.ssrLoadModule(resolve(clientRoot, "src/context/AuthoritativeSessionContext.jsx")),
        vite.ssrLoadModule(resolve(clientRoot, "src/context/EngineBridgeContext.jsx"))
    ]);

    const html = renderToString(createElement(
        LanguageProvider,
        null,
        createElement(
            EngineBridgeProvider,
            null,
            createElement(
                PlayerIdentityProvider,
                null,
                createElement(
                    AuthoritativeSessionProvider,
                    null,
                    createElement(Page4Payment)
                )
            )
        )
    ));

    assert.match(html, /PAYMENT/,
        "Page4 renders the payment page heading");
    assert.match(html, /Payments are unavailable\. Do not send GRAM to any room wallet\./,
        "Page4 explains why payment is unavailable");
    assert.doesNotMatch(html, /Room wallet:|Transfer comment:|CHECK PAYMENT|CONNECT TESTNET WALLET/,
        "Page4 does not expose the old raw payment details and separate actions");
} finally {
    await vite.close();
}

process.stdout.write("page4Payment.render.test.js: all assertions passed\n");
