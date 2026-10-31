import test from "node:test";
import assert from "node:assert/strict";
import { getPage4NetworkPresentation } from "./page4NetworkPresentation.js";

test("Page4 retains original Testnet labels for confirmed Testnet payment sessions", () => {
    assert.deepEqual(getPage4NetworkPresentation("testnet"), {
        label: "TESTNET",
        selectWallet: "SELECT TESTNET WALLET",
        mismatch: "Select the Testnet wallet entered on Page3 before confirming."
    });
});

test("Page4 shows Mainnet wallet instructions for a server-confirmed Mainnet session", () => {
    assert.deepEqual(getPage4NetworkPresentation("mainnet"), {
        label: "MAINNET",
        selectWallet: "SELECT MAINNET WALLET",
        mismatch: "Select the Mainnet wallet entered on Page3 before confirming."
    });
});

test("Page4 fails neutral instead of mislabeling missing or malformed network as Testnet", () => {
    for (const network of [undefined, null, "", "MAINNET", "unknown", -239]) {
        assert.deepEqual(getPage4NetworkPresentation(network), {
            label: "NETWORK UNVERIFIED",
            selectWallet: "SELECT REGISTERED WALLET",
            mismatch: "Select the wallet entered on Page3 before confirming."
        });
    }
});
