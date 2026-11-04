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
        { default: NoFriendsInsufficientBalanceOverlay },
        { LanguageProvider }
    ] = await Promise.all([
        vite.ssrLoadModule(resolve(clientRoot, "src/components/NoFriendsInsufficientBalanceOverlay.jsx")),
        vite.ssrLoadModule(resolve(clientRoot, "src/context/LanguageContext.jsx"))
    ]);

    for (const [minimum, stake] of [["2.6", "1"], ["26", "10"]]) {
        const html = renderToString(createElement(
            LanguageProvider,
            null,
            createElement(NoFriendsInsufficientBalanceOverlay, {
                minimumBalanceGram: minimum,
                baseStake: stake,
                onDismiss: () => {}
            })
        ));
        assert.match(html, /role="dialog"/);
        assert.match(html, /INSUFFICIENT WALLET BALANCE/);
        assert.match(html, new RegExp(`at least ${minimum} Gram to play with a base stake of ${stake} Gram`));
        assert.match(html, />OK<\/button>/);
    }
} finally {
    await vite.close();
}

process.stdout.write("noFriendsWalletBalance.render.test.js: all assertions passed\n");
