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
    assert.match(html, /Server connection:/,
        "Page4 always displays a connection diagnostic");
    assert.match(html, /Waiting for server-authorized room identity/,
        "Page4 displays a safe fallback when identity is missing");
    assert.match(html, /PAYMENT_UNAVAILABLE/,
        "Page4 renders the disabled payment status without wallet state");
    assert.match(html, /Payment acceptance is disabled/,
        "Page4 explains why payment is unavailable");
    assert.match(html, /No wallet request or destination has been issued/,
        "Page4 does not imply that a payment session is active");
} finally {
    await vite.close();
}

process.stdout.write("page4Payment.render.test.js: all assertions passed\n");
