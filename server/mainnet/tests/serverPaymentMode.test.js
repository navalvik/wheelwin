import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMainnetBootstrap } from "../MainnetBootstrap.js";
import {
    initializeMainnetServerRuntime,
    resolveServerPaymentMode
} from "../ServerPaymentMode.js";

function walletCatalog() {
    return JSON.stringify(Array.from({ length: 64 }, (_, index) => ({
        walletId: `synthetic-mainnet-${index + 1}`,
        roomNumber: index + 1,
        address: `0:${String(index + 1).padStart(64, "0")}`,
        network: "mainnet"
    })));
}

function mainnetEnv(dataDir) {
    return {
        TON_NETWORK: "mainnet",
        MAINNET_TONCENTER_API_KEY: "offline-test-key",
        MAINNET_ROOM_WALLET_DATA_DIR: dataDir,
        MAINNET_ROOM_WALLETS_JSON: walletCatalog()
    };
}

test("server payment mode accepts only explicit Testnet or Mainnet", () => {
    assert.equal(resolveServerPaymentMode({ TON_NETWORK: "testnet" }), "testnet");
    assert.equal(resolveServerPaymentMode({ TON_NETWORK: " MAINNET " }), "mainnet");
    for (const TON_NETWORK of [undefined, "", "devnet", "production"]) {
        assert.throws(() => resolveServerPaymentMode({ TON_NETWORK }),
            /TON_NETWORK_MUST_BE_TESTNET_OR_MAINNET/);
    }
});

test("main server Mainnet initialization uses only the Mainnet bootstrap and remains read-only", (t) => {
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-server-mainnet-mode-"));
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    let rpcCalls = 0;
    const bootstrap = initializeMainnetServerRuntime({
        env: mainnetEnv(dataDir),
        fetchImpl: async () => { rpcCalls += 1; throw new Error("unexpected RPC"); },
        createBootstrap: options => createMainnetBootstrap(options)
    });

    assert.equal(bootstrap.config.network, "mainnet");
    assert.equal(bootstrap.config.globalId, -239);
    assert.equal(bootstrap.config.walletCount, 64);
    assert.equal(bootstrap.paymentRuntime.network, "mainnet");
    assert.equal(bootstrap.paymentRuntime.liveOperationsEnabled, false);
    assert.equal(rpcCalls, 0);
    assert.equal(bootstrap.paymentRuntime.stateDirectories.gameplay.startsWith(dataDir), true);
});

test("server app selects Mainnet bootstrap before the Testnet runtime branch", () => {
    const app = readFileSync(new URL("../../app.js", import.meta.url), "utf8");
    const modeSelection = app.indexOf("const paymentMode = resolveServerPaymentMode(process.env)");
    const mainnetBranch = app.indexOf('if (paymentMode === "mainnet")', modeSelection);
    const mainnetBootstrap = app.indexOf("initializeMainnetServerRuntime({", mainnetBranch);
    const testnetBranch = app.indexOf("} else {", mainnetBootstrap);
    const testnetRuntime = app.indexOf("buildPaymentRuntime({", testnetBranch);

    assert.ok(modeSelection >= 0);
    assert.ok(mainnetBranch > modeSelection);
    assert.ok(mainnetBootstrap > mainnetBranch);
    assert.ok(testnetBranch > mainnetBootstrap);
    assert.ok(testnetRuntime > testnetBranch);
    assert.match(app.slice(mainnetBranch, testnetBranch),
        /configurePaymentGate\(\s*mainnetBootstrap\.paymentRuntime\.gameStartPaymentGate\s*\)/);
    assert.match(app.slice(mainnetBranch, testnetBranch), /_paymentRuntimeReady = true/);
    assert.match(app.slice(mainnetBranch, testnetBranch), /paidGameStart=disabled/);
    const initializationFailure = app.indexOf("} catch (error) {", testnetRuntime);
    assert.match(app.slice(initializationFailure, initializationFailure + 900),
        /configurePaymentGate\?\.\(null\)/);
});
