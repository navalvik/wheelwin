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
        /new MainnetPage4PaymentApplicationBinding\(/);
    assert.match(app.slice(mainnetBranch, testnetBranch),
        /configurePaymentGate\(\s*mainnetBootstrap\.paymentRuntime\.gameStartPaymentGate\s*\)/);
    assert.match(app.slice(mainnetBranch, testnetBranch),
        /refundLifecycle\.configurePage5StateResolver\([\s\S]*?getLifecycle\(roomId\).*?phase === "OPEN_PAGE5"/);
    assert.match(app.slice(mainnetBranch, testnetBranch),
        /configureReservedWalletRoomNumberResolver\([\s\S]*?walletPool\.getReservationForRoomHistory\(roomId\).*?roomNumber/);
    assert.match(app.slice(mainnetBranch, testnetBranch),
        /configureCurrentWalletReservationResolver\([\s\S]*?walletPool\.getWalletByRoomNumber\(roomNumber\)/);
    assert.match(app.slice(mainnetBranch, testnetBranch), /recordPage5Started\(roomId\)/);
    assert.match(app.slice(mainnetBranch, testnetBranch), /EVENT_TYPES\.GAME_START_BOOTSTRAP_READY/);
    assert.match(app.slice(mainnetBranch, testnetBranch),
        /new MainnetWinnerPayoutCoordinator\([\s\S]*?winnerEngine: this\._engines\.winnerEngine/);
    assert.match(app.slice(mainnetBranch, testnetBranch),
        /EVENT_TYPES\.GAME_RESULT_READY,[\s\S]*?this\._mainnetGameResultReadyHandler/);
    assert.match(app.slice(mainnetBranch, testnetBranch),
        /_mainnetWinnerPayoutCoordinator\.onGameResult\(\{ gameId \}\)/);
    assert.match(app.slice(mainnetBranch, testnetBranch),
        /_mainnetWinnerPayoutCoordinator\.recoverPendingResults\(\)/);
    assert.match(app.slice(mainnetBranch, testnetBranch), /hasPage5Started\(roomId\)/);
    assert.match(app.slice(mainnetBranch, testnetBranch),
        /new MainnetPendingRefundReconciler\([\s\S]*?financialLedger:[\s\S]*?refundLifecycle:[\s\S]*?maxPerPass: 2/);
    assert.match(app.slice(mainnetBranch, testnetBranch),
        /refundLifecycle\.recover\(\)[\s\S]*?new MainnetPendingRefundReconciler\([\s\S]*?reconcileMainnetRefunds\(\)[\s\S]*?setInterval\(reconcileMainnetRefunds, 60_000\)/);
    assert.match(app.slice(mainnetBranch, testnetBranch),
        /new MainnetPendingPayoutReconciler\([\s\S]*?financialLedger:[\s\S]*?payoutLifecycle:[\s\S]*?maxPerPass: 2/);
    assert.match(app.slice(mainnetBranch, testnetBranch),
        /_mainnetWinnerPayoutCoordinator\.recoverPendingResults\(\)[\s\S]*?new MainnetPendingPayoutReconciler\([\s\S]*?reconcileMainnetPayouts\(\)[\s\S]*?setInterval\(reconcileMainnetPayouts, 60_000\)/);
    assert.ok(app.indexOf("new MainnetPendingPayoutReconciler(")
        < app.indexOf("const archivePaymentMode"),
    "payout recovery wiring must not depend on R2 initialization");
    assert.ok(app.indexOf("new MainnetPendingRefundReconciler(")
        < app.indexOf("const archivePaymentMode"),
    "refund recovery wiring must not depend on R2 initialization");
    assert.ok(app.indexOf("new MainnetHistoricalIncomingReceiptReconciler(")
        < app.indexOf("const archivePaymentMode"),
    "late incoming receipt recovery must not depend on R2 initialization");
    assert.ok(app.indexOf("new MainnetWalletReleaseReconciler(")
        < app.indexOf("const archivePaymentMode"),
    "wallet release recovery must not depend on R2 initialization");
    assert.match(app.slice(mainnetBranch, app.indexOf("const archivePaymentMode")),
        /releaseForMainnetOutcome|new MainnetWalletReleaseReconciler\([\s\S]*?financialLedger:[\s\S]*?roomManager:/);
    assert.match(app.slice(mainnetBranch, app.indexOf("const archivePaymentMode")),
        /reconcileMainnetWalletReleases\(\)[\s\S]*?setInterval\(reconcileMainnetWalletReleases, 60_000\)/);
    assert.match(app.slice(mainnetBranch, app.indexOf("const archivePaymentMode")),
        /refundLifecycle:\s*mainnetBootstrap\.paymentRuntime\.refundLifecycle/);
    assert.match(app.slice(mainnetBranch, app.indexOf("const archivePaymentMode")),
        /reconcileMainnetHistoricalReceipts\(\)[\s\S]*?setInterval\(\s*reconcileMainnetHistoricalReceipts,\s*60_000\s*\)/);
    assert.doesNotMatch(app.slice(app.indexOf("const reconcileMainnetArchives"),
        app.indexOf("this._mainnetForensicHistoryTimer = setInterval")), /_mainnetHistoryReconciler\.runPass\(\)/,
    "R2 archive polling must not own historical receipt reconciliation");
    assert.match(app, /clearInterval\(this\._mainnetRefundReconciliationTimer\)/);
    assert.match(app, /this\._mainnetRefundReconciler\?\.stop\(\)/);
    assert.match(app, /clearInterval\(this\._mainnetHistoryReconciliationTimer\)/);
    assert.match(app, /this\._mainnetHistoryReconciler\?\.stop\(\)/);
    assert.match(app, /clearInterval\(this\._mainnetWalletReleaseTimer\)/);
    assert.match(app, /this\._mainnetWalletReleaseReconciler\?\.stop\(\)/);
    assert.match(app, /clearInterval\(this\._mainnetPayoutReconciliationTimer\)/);
    assert.match(app, /this\._mainnetPayoutReconciler\?\.stop\(\)/);
    assert.match(app.slice(mainnetBranch, testnetBranch),
        /roomManager\.attachRefundLifecycle\(\s*mainnetBootstrap\.paymentRuntime\.refundLifecycle\s*\)/);
    assert.match(app.slice(mainnetBranch, testnetBranch), /_paymentRuntimeReady = true/);
    assert.match(app.slice(mainnetBranch, testnetBranch), /paidGameStart=disabled/);
    const initializationFailure = app.indexOf("} catch (error) {", testnetRuntime);
    assert.match(app.slice(initializationFailure, initializationFailure + 1500),
        /configurePaymentGate\?\.\(null\)/);
});
