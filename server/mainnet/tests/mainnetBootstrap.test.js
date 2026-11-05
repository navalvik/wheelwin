import assert from "node:assert/strict";
import { Address } from "@ton/core";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { resolveDefaultRoomWalletPaymentDataDir } from "../../payment/runtime/PaymentRuntimeFactory.js";
import {
    loadMainnetRuntimeConfig,
    MAINNET_GLOBAL_ID,
    MAINNET_TONCENTER_BASE_URL
} from "../config/MainnetRuntimeConfig.js";
import { createMainnetBootstrap } from "../MainnetBootstrap.js";

function walletCatalog() {
    return JSON.stringify(Array.from({ length: 64 }, (_, index) => ({
        walletId: `mainnet-wallet-${index + 1}`,
        roomNumber: index + 1,
        address: `0:${String(index + 1).padStart(64, "0")}`,
        network: "mainnet"
    })));
}

function env(overrides = {}) {
    return {
        TON_NETWORK: "mainnet",
        MAINNET_TONCENTER_API_KEY: "synthetic-mainnet-api-key",
        MAINNET_ROOM_WALLET_DATA_DIR: join(tmpdir(), "wheelwin-mainnet-offline-a"),
        MAINNET_ROOM_WALLETS_JSON: walletCatalog(),
        ...overrides
    };
}

test("Mainnet config requires explicit Mainnet identity and isolated credentials", () => {
    const config = loadMainnetRuntimeConfig(env());
    assert.equal(config.network, "mainnet");
    assert.equal(config.globalId, MAINNET_GLOBAL_ID);
    assert.equal(config.toncenterBaseUrl, MAINNET_TONCENTER_BASE_URL);
    assert.equal(config.walletCatalog.length, 64);
    assert.equal(JSON.stringify(config).includes("synthetic-mainnet-api-key"), false);
    assert.equal(config.apiKeyProvider(), "synthetic-mainnet-api-key");
});

test("Mainnet config fails closed for missing or non-Mainnet network selection", () => {
    assert.throws(() => loadMainnetRuntimeConfig(env({ TON_NETWORK: undefined })),
        /MAINNET_TON_NETWORK_MUST_BE_EXPLICIT/);
    assert.throws(() => loadMainnetRuntimeConfig(env({ TON_NETWORK: "testnet" })),
        /MAINNET_TON_NETWORK_MUST_BE_EXPLICIT/);
});

test("Mainnet config never falls back to Testnet API credentials or catalogs", () => {
    for (const key of ["TON_API_KEY", "ROOM_WALLETS_TESTNET_JSON", "ROOM_WALLETS_TESTNET_JSON_PATH", "ROOM_WALLETS_JSON"]) {
        assert.throws(() => loadMainnetRuntimeConfig(env({ [key]: "must-not-be-used" })),
            /TESTNET_CREDENTIAL_OR_CATALOG_PRESENT_IN_MAINNET_RUNTIME/);
    }
    assert.throws(() => loadMainnetRuntimeConfig(env({ MAINNET_TONCENTER_API_KEY: "" })),
        /MAINNET_CONFIG_MAINNET_TONCENTER_API_KEY_REQUIRED/);
});

test("Mainnet catalog requires exactly 64 unique, explicitly tagged valid wallets", () => {
    const tooShort = JSON.parse(walletCatalog()).slice(0, 63);
    assert.throws(() => loadMainnetRuntimeConfig(env({ MAINNET_ROOM_WALLETS_JSON: JSON.stringify(tooShort) })),
        /MAINNET_WALLET_CATALOG_MUST_CONTAIN_64_ENTRIES/);
    const wrongNetwork = JSON.parse(walletCatalog());
    wrongNetwork[0].network = "testnet";
    assert.throws(() => loadMainnetRuntimeConfig(env({ MAINNET_ROOM_WALLETS_JSON: JSON.stringify(wrongNetwork) })),
        /MAINNET_WALLET_CATALOG_ENTRY_INVALID/);
    const duplicate = JSON.parse(walletCatalog());
    duplicate[1].address = duplicate[0].address;
    assert.throws(() => loadMainnetRuntimeConfig(env({ MAINNET_ROOM_WALLETS_JSON: JSON.stringify(duplicate) })),
        /MAINNET_WALLET_CATALOG_DUPLICATE_IDENTITY/);
    const testnetTagged = JSON.parse(walletCatalog());
    testnetTagged[0].address = Address.parse(testnetTagged[0].address).toString({ testOnly: true });
    assert.throws(() => loadMainnetRuntimeConfig(env({ MAINNET_ROOM_WALLETS_JSON: JSON.stringify(testnetTagged) })),
        /MAINNET_WALLET_ADDRESS_INVALID/);
});

test("Mainnet storage root cannot equal Testnet default when its override is absent", () => {
    const testnetDefault = resolve(resolveDefaultRoomWalletPaymentDataDir({}));
    assert.throws(() => loadMainnetRuntimeConfig(env({
        MAINNET_ROOM_WALLET_DATA_DIR: testnetDefault,
        ROOM_WALLET_DATA_DIR: undefined,
        RAILWAY_VOLUME_MOUNT_PATH: undefined,
        RAILWAY_ENVIRONMENT_ID: undefined
    })), /MAINNET_DATA_DIR_MUST_BE_ISOLATED/);

    const mountedDefaultEnv = { RAILWAY_VOLUME_MOUNT_PATH: join(tmpdir(), "wheelwin-testnet-volume") };
    const mountedTestnetDefault = resolve(resolveDefaultRoomWalletPaymentDataDir(mountedDefaultEnv));
    assert.throws(() => loadMainnetRuntimeConfig(env({
        ...mountedDefaultEnv,
        MAINNET_ROOM_WALLET_DATA_DIR: mountedTestnetDefault,
        ROOM_WALLET_DATA_DIR: undefined
    })), /MAINNET_DATA_DIR_MUST_BE_ISOLATED/);
});

test("Mainnet storage root cannot equal an explicitly configured Testnet root", () => {
    const testnetDir = join(tmpdir(), "wheelwin-explicit-testnet-storage");
    assert.throws(() => loadMainnetRuntimeConfig(env({
        MAINNET_ROOM_WALLET_DATA_DIR: testnetDir,
        ROOM_WALLET_DATA_DIR: testnetDir
    })), /MAINNET_DATA_DIR_MUST_BE_ISOLATED/);
});

test("normalized equivalent Mainnet and Testnet roots are rejected", () => {
    const testnetDir = join(tmpdir(), "wheelwin-normalized-testnet-storage");
    assert.throws(() => loadMainnetRuntimeConfig(env({
        MAINNET_ROOM_WALLET_DATA_DIR: `${testnetDir}${sep}alias${sep}..`,
        ROOM_WALLET_DATA_DIR: testnetDir
    })), /MAINNET_DATA_DIR_MUST_BE_ISOLATED/);
});

test("only nested roots whose concrete Mainnet and Testnet stores overlap are rejected", () => {
    const testnetDir = join(tmpdir(), "wheelwin-nested-testnet-storage");
    assert.throws(() => loadMainnetRuntimeConfig(env({
        MAINNET_ROOM_WALLET_DATA_DIR: join(testnetDir, "testnet", "payment-core"),
        ROOM_WALLET_DATA_DIR: testnetDir
    })), /MAINNET_DATA_DIR_MUST_BE_ISOLATED/);

    const nestedButSeparate = loadMainnetRuntimeConfig(env({
        MAINNET_ROOM_WALLET_DATA_DIR: join(testnetDir, "isolated-mainnet"),
        ROOM_WALLET_DATA_DIR: testnetDir
    }));
    assert.equal(nestedButSeparate.dataDir, resolve(testnetDir, "isolated-mainnet"));
});

test("separate Mainnet and Testnet storage roots remain valid", () => {
    const config = loadMainnetRuntimeConfig(env({
        MAINNET_ROOM_WALLET_DATA_DIR: join(tmpdir(), "wheelwin-mainnet-separate-storage"),
        ROOM_WALLET_DATA_DIR: join(tmpdir(), "wheelwin-testnet-separate-storage")
    }));
    assert.equal(config.network, "mainnet");
});

test("Mainnet config strips no secrets silently and rejects secret-bearing catalogs", () => {
    const catalog = JSON.parse(walletCatalog());
    catalog[0].privateKey = "do-not-load";
    assert.throws(() => loadMainnetRuntimeConfig(env({ MAINNET_ROOM_WALLETS_JSON: JSON.stringify(catalog) })),
        /MAINNET_WALLET_CATALOG_MUST_NOT_CONTAIN_SECRETS/);
});

test("Mainnet bootstrap initializes and persists only the Mainnet wallet registry", (t) => {
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-mainnet-bootstrap-"));
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    let rpcCalls = 0;
    const bootstrap = createMainnetBootstrap({
        env: env({ MAINNET_ROOM_WALLET_DATA_DIR: dataDir }),
        fetchImpl: async () => { rpcCalls += 1; throw new Error("unexpected RPC"); }
    });
    assert.equal(bootstrap.config.globalId, -239);
    assert.equal(bootstrap.config.walletCount, 64);
    const pool = bootstrap.initialize();
    assert.equal(pool.network, "mainnet");
    assert.equal(pool.listWallets().length, 64);
    assert.equal(pool.getWalletByRoomNumber(64).network, "mainnet");
    const runtime = bootstrap.paymentRuntime;
    assert.equal(runtime.network, "mainnet");
    assert.equal(runtime.globalId, -239);
    assert.equal(bootstrap.client.baseUrl, "https://toncenter.com");
    assert.equal(runtime.getCapabilities().network, "mainnet");
    assert.equal(runtime.getCapabilities().livePaymentAcceptanceEnabled, false);
    assert.equal(runtime.networkDataDir, join(dataDir, "mainnet"));
    assert.ok(existsSync(join(runtime.networkDataDir, "payment-intents")));
    assert.ok(existsSync(join(runtime.networkDataDir, "ledger")));
    assert.ok(existsSync(join(runtime.networkDataDir, "refunds")));
    assert.equal(rpcCalls, 0, "runtime initialization must not make RPC requests");
    assert.equal(bootstrap.initialize(), pool, "bootstrap is idempotent");
    assert.equal(rpcCalls, 0);
});

test("disabled payment intake mode keeps live Mainnet operations closed", (t) => {
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-mainnet-intake-disabled-"));
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    const bootstrap = createMainnetBootstrap({
        env: env({
            MAINNET_ROOM_WALLET_DATA_DIR: dataDir,
            ROOM_WALLET_PAYMENTS_ENABLED: "true",
            ROOM_WALLET_PAYMENT_INTAKE_MODE: "DISABLED"
        }),
        fetchImpl: async () => { throw new Error("unexpected RPC"); }
    });
    assert.equal(bootstrap.liveOperationsEnabled, false);
    bootstrap.initialize();
    assert.equal(bootstrap.paymentRuntime.getCapabilities().livePaymentAcceptanceEnabled, false);
});
