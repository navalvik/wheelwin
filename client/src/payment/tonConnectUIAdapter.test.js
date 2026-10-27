import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { getTonConnectUI } from "./tonConnectUIAdapter.js";

test("official TON Connect bundle is version-pinned and manifest is locally published", () => {
    const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
    assert.match(html, /@tonconnect\/ui@3\.0\.2\/dist\/tonconnect-ui\.min\.js/);
    assert.doesNotMatch(html, /@tonconnect\/ui@latest/);
    const manifest = JSON.parse(readFileSync(
        new URL("../../public/tonconnect-manifest.json", import.meta.url), "utf8"
    ));
    assert.equal(manifest.name, "WheelWin");
    assert.equal(manifest.url, "https://wheelwin-nine.vercel.app");
    assert.equal(manifest.iconUrl, "https://wheelwin-nine.vercel.app/icon.png");
});

test("TON Connect is initialized only once across Page4 remounts, without sending money", () => {
    const previous = globalThis.window;
    let creations = 0;
    let transactions = 0;
    const instances = [];
    try {
        globalThis.window = { TON_CONNECT_UI: {
            TonConnectUI: class {
                constructor(options) {
                    creations++;
                    assert.equal(options.analytics.mode, "off");
                    assert.match(options.manifestUrl, /tonconnect-manifest\.json$/);
                    instances.push(this);
                }
                sendTransaction() { transactions++; }
            }
        } };
        const first = getTonConnectUI();
        const second = getTonConnectUI();
        assert.equal(first, second);
        assert.equal(first, instances[0]);
        assert.equal(creations, 1);
        assert.equal(transactions, 0);
    } finally {
        if (previous === undefined) delete globalThis.window;
        else globalThis.window = previous;
    }
});
