/**
 * Focused tests for the local Testnet Room Wallet file-path configuration
 * source (ROOM_WALLETS_TESTNET_JSON_PATH).
 *
 * Uses deterministic dummy fixtures only. The real wallet catalog file is
 * never read by these tests and no secret material is printed.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import test from "node:test";

import {
    createRoomWalletRegistryFromEnv,
    loadRoomWalletRuntimeConfig
} from "../payment/roomWallet/RoomWalletRuntimeResolver.js";
import { createDummyRoomWalletCatalog } from "./helpers/dummyRoomWallet.js";

const SERVER_PROJECT_ROOT = resolve(
    dirname(fileURLToPath(import.meta.url)),
    ".."
);

const TEMP_ROOT = mkdtempSync(join(tmpdir(), "roomwallet-path-config-"));

const SECRET_MARKER = "room-wallet-secret-marker-never-print";

function tempFile(fileName) {
    return join(TEMP_ROOT, fileName);
}

test.after(() => {
    rmSync(TEMP_ROOT, { recursive: true, force: true });
});

test("1. direct ROOM_WALLETS_TESTNET_JSON takes precedence over the file path", () => {
    const direct = createDummyRoomWalletCatalog(64);

    const config = loadRoomWalletRuntimeConfig({
        TON_NETWORK: "testnet",
        ROOM_WALLETS_TESTNET_JSON: JSON.stringify(direct),
        // Nonexistent path proves the file source is never touched while the
        // direct variable is present.
        ROOM_WALLETS_TESTNET_JSON_PATH: tempFile("does-not-exist.json")
    });

    assert.equal(config.entries.length, 64);
    assert.equal(config.entries[0].address, direct[0].address);
    assert.equal(config.entries[63].address, direct[63].address);
});

test("2. file-path fallback loads the catalog via a relative path from the server project root", () => {
    const wallets = createDummyRoomWalletCatalog(64);
    const filePath = tempFile("catalog-relative.json");
    writeFileSync(filePath, JSON.stringify(wallets), "utf8");

    const config = loadRoomWalletRuntimeConfig({
        TON_NETWORK: "testnet",
        ROOM_WALLETS_TESTNET_JSON_PATH: relative(SERVER_PROJECT_ROOT, filePath)
    });

    assert.equal(config.entries.length, 64);
    assert.equal(config.entries[16].address, wallets[16].address);
});

test("3. file-path fallback loads the catalog via an absolute path", () => {
    const wallets = createDummyRoomWalletCatalog(64);
    const filePath = tempFile("catalog-absolute.json");
    writeFileSync(filePath, JSON.stringify(wallets), "utf8");

    const config = loadRoomWalletRuntimeConfig({
        TON_NETWORK: "testnet",
        ROOM_WALLETS_TESTNET_JSON_PATH: filePath
    });

    assert.equal(config.entries.length, 64);
    assert.equal(config.entries[0].address, wallets[0].address);
});

test("4. missing direct and file-path sources keep the existing configuration error", () => {
    assert.throws(
        () => loadRoomWalletRuntimeConfig({ TON_NETWORK: "testnet" }),
        /ROOM_WALLETS_TESTNET_JSON.*required.*testnet.*ROOM_WALLETS_JSON.*compatibility/i
    );
});

test("5. missing file produces a clear configuration error", () => {
    const missingPath = tempFile("missing-catalog.json");

    assert.throws(
        () => loadRoomWalletRuntimeConfig({
            TON_NETWORK: "testnet",
            ROOM_WALLETS_TESTNET_JSON_PATH: missingPath
        }),
        /ROOM_WALLETS_TESTNET_JSON_PATH file not found/
    );
});

test("6. malformed JSON file produces a clear configuration error without exposing file contents", () => {
    const filePath = tempFile("catalog-malformed.json");
    writeFileSync(
        filePath,
        `{ "leaked": "${SECRET_MARKER}" not-json`,
        "utf8"
    );

    let thrown = null;

    try {
        loadRoomWalletRuntimeConfig({
            TON_NETWORK: "testnet",
            ROOM_WALLETS_TESTNET_JSON_PATH: filePath
        });
    } catch (error) {
        thrown = error;
    }

    assert.ok(thrown, "expected a configuration error");
    assert.match(thrown.message, /Room Wallet catalog file is not valid JSON/);
    assert.ok(!thrown.message.includes(SECRET_MARKER));
});

test("7. legacy ROOM_WALLETS_JSON compatibility fallback still works", () => {
    const wallets = createDummyRoomWalletCatalog(64);

    const config = loadRoomWalletRuntimeConfig({
        TON_NETWORK: "testnet",
        ROOM_WALLETS_JSON: JSON.stringify(wallets)
    });

    assert.equal(config.entries.length, 64);
    assert.equal(config.entries[0].address, wallets[0].address);
});

test("8. Mainnet ignores the Testnet file-path source and keeps its required-variable error", () => {
    const filePath = tempFile("catalog-mainnet-ignore.json");
    writeFileSync(filePath, JSON.stringify(createDummyRoomWalletCatalog(64)), "utf8");

    assert.throws(
        () => loadRoomWalletRuntimeConfig({
            TON_NETWORK: "mainnet",
            ROOM_WALLETS_TESTNET_JSON_PATH: filePath
        }),
        /ROOM_WALLETS_MAINNET_JSON.*required/
    );
});

test("9. startup entry point builds the registry from the file-path source", () => {
    const wallets = createDummyRoomWalletCatalog(64);
    const filePath = tempFile("catalog-registry.json");
    writeFileSync(filePath, JSON.stringify(wallets), "utf8");

    const registry = createRoomWalletRegistryFromEnv({
        TON_NETWORK: "testnet",
        ROOM_WALLETS_TESTNET_JSON_PATH: filePath
    });

    assert.equal(registry.require(1).address, wallets[0].address);
    assert.equal(registry.require(1).publicKey, undefined);
    assert.equal(registry.require(1).secretKey, undefined);
});
