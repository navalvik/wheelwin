/**
 * R18.S125 — Operator Explorer reference helpers (DISPLAY-ONLY).
 *
 * Verifies that the explorer reference builders produce operator-facing
 * tonviewer URLs from the EXISTING R7.66A network presets and fail safe
 * (null) on invalid input. Pure functions: no network access, no secrets,
 * and by construction these helpers can never influence authorization.
 *
 * Mock data only. No live TON access. No secrets.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
    buildOperatorExplorerAddressUrl,
    buildOperatorExplorerTransactionUrl,
    resolveOperatorExplorerBaseUrl
} from "../payment/ton/networks/explorerReference.js";
import { mainnet } from "../payment/ton/networks/mainnet.js";
import { testnet } from "../payment/ton/networks/testnet.js";

const TX_HASH = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

test("resolveOperatorExplorerBaseUrl uses the existing mainnet preset", () => {

    assert.equal(
        resolveOperatorExplorerBaseUrl("mainnet"),
        mainnet.explorerBaseUrl
    );

    assert.equal(mainnet.explorerBaseUrl, "https://tonviewer.com");

});

test("resolveOperatorExplorerBaseUrl uses the existing testnet preset", () => {

    assert.equal(
        resolveOperatorExplorerBaseUrl("testnet"),
        testnet.explorerBaseUrl
    );

    assert.equal(
        testnet.explorerBaseUrl,
        "https://testnet.tonviewer.com"
    );

});

test("resolveOperatorExplorerBaseUrl fails safe on unknown networks", () => {

    assert.equal(resolveOperatorExplorerBaseUrl(null), null);
    assert.equal(resolveOperatorExplorerBaseUrl(""), null);
    assert.equal(resolveOperatorExplorerBaseUrl("stagenet"), null);
    assert.equal(resolveOperatorExplorerBaseUrl(42), null);

});

test("buildOperatorExplorerTransactionUrl builds the mainnet transaction link", () => {

    assert.equal(
        buildOperatorExplorerTransactionUrl("mainnet", TX_HASH),
        `https://tonviewer.com/transaction/${TX_HASH}`
    );

});

test("buildOperatorExplorerTransactionUrl builds the testnet transaction link", () => {

    assert.equal(
        buildOperatorExplorerTransactionUrl("testnet", TX_HASH),
        `https://testnet.tonviewer.com/transaction/${TX_HASH}`
    );

});

test("buildOperatorExplorerTransactionUrl normalizes case and rejects invalid hashes", () => {

    const upper = TX_HASH.toUpperCase();

    assert.equal(
        buildOperatorExplorerTransactionUrl("mainnet", upper),
        `https://tonviewer.com/transaction/${TX_HASH}`
    );

    assert.equal(
        buildOperatorExplorerTransactionUrl("mainnet", `0x${TX_HASH}`),
        null
    );

    assert.equal(
        buildOperatorExplorerTransactionUrl("mainnet", "not-a-hash"),
        null
    );

    assert.equal(
        buildOperatorExplorerTransactionUrl("mainnet", null),
        null
    );

    assert.equal(
        buildOperatorExplorerTransactionUrl("mainnet", TX_HASH.slice(1)),
        null
    );

});

test("buildOperatorExplorerTransactionUrl fails safe on unknown network", () => {

    assert.equal(
        buildOperatorExplorerTransactionUrl("stagenet", TX_HASH),
        null
    );

});

test("buildOperatorExplorerAddressUrl accepts user-friendly and raw addresses", () => {

    const friendly = "EQAh7qNgZDv2F3p13B_5BTk5CiqQxrRn1TluPfq3A4vOJpOS";

    assert.equal(
        buildOperatorExplorerAddressUrl("mainnet", friendly),
        `https://tonviewer.com/address/${friendly}`
    );

    const raw = `0:${TX_HASH}`;

    assert.equal(
        buildOperatorExplorerAddressUrl("mainnet", raw),
        `https://tonviewer.com/address/${encodeURIComponent(raw)}`
    );

});

test("buildOperatorExplorerAddressUrl rejects non-address input", () => {

    assert.equal(
        buildOperatorExplorerAddressUrl("mainnet", "not-an-address"),
        null
    );

    assert.equal(
        buildOperatorExplorerAddressUrl("mainnet", null),
        null
    );

    assert.equal(
        buildOperatorExplorerAddressUrl("stagenet", "EQAh7qNgZDv2F3p13B_5BTk5CiqQxrRn1TluPfq3A4vOJpOS"),
        null
    );

});

test("helpers are pure — no fetch/XMLHttpRequest involvement is possible", () => {

    const source = `${buildOperatorExplorerTransactionUrl.toString()}`
        + buildOperatorExplorerAddressUrl.toString()
        + resolveOperatorExplorerBaseUrl.toString();

    assert.match(source, /return `/);

    assert.doesNotMatch(source, /fetch|XMLHttpRequest|http\.request|https\.request/);

});
