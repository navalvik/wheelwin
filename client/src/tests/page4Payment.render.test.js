import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import process from "node:process";
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
    assert.match(html, /Checking payment availability\. Do not send funds to any room wallet\./,
        "Page4 waits for the server-selected payment network before naming it");
    assert.doesNotMatch(html, /Room wallet:|Transfer comment:|CHECK PAYMENT|CONNECT TESTNET WALLET/,
        "Page4 does not expose the old raw payment details and separate actions");

    const pageSource = readFileSync(resolve(clientRoot, "src/pages/Page4Payment.jsx"), "utf8");
    assert.match(pageSource, /const mainnetRequestValid = mainnetMode[\s\S]*Date\.now\(\) < payment\.expiresAt/,
        "Mainnet needs a valid, unexpired server payment request before enabling payment");
    assert.match(pageSource, /const payable = payment\.paymentAcceptanceEnabled === true[\s\S]*mainnetRequestValid/,
        "both networks require server payment acceptance and Mainnet requires its request");
    assert.match(pageSource, /socket\.on\(PAYMENT_REQUEST_EVENT, handlePaymentRequest\)/,
        "Page4 receives the personalized server payment request");
    assert.match(pageSource, /PAY WITH TON CONNECT/,
        "Mainnet exposes the existing TonConnect payment action when eligible");
    assert.match(pageSource, /payment\.paymentAcceptanceEnabled && !mainnetMode/,
        "Testnet retains its existing QR and wallet instructions");
    assert.match(pageSource, /Mainnet payments are unavailable\. Do not send TON\./,
        "Page4 clearly says Mainnet payments are unavailable");
    assert.match(pageSource, /Payments are unavailable\. Do not send GRAM to any room wallet\./,
        "the existing Testnet-unavailable message is preserved");
} finally {
    await vite.close();
}

process.stdout.write("page4Payment.render.test.js: all assertions passed\n");
