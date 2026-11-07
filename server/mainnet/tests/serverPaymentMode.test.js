import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMainnetBootstrap } from "../MainnetBootstrap.js";
import {
    formatMainnetRuntimeStartupLine,
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

test("Mainnet startup diagnostic reports isolated source runtime capabilities", () => {
    const config = { globalId: -239, walletCount: 64 };
    const disabledRuntime = { getCapabilities: () => ({ livePaymentAcceptanceEnabled: false }) };
    assert.equal(formatMainnetRuntimeStartupLine({ config,
        paymentRuntime: disabledRuntime, liveOperationsEnabled: false }),
    "MainnetPaymentRuntime (globalId=-239 | wallets=64 | storage=isolated | liveOperations=disabled | paidGameStart=disabled)");
    const enabledRuntime = { paymentGate: { getGameStartGateStatus() {} },
        getCapabilities: () => ({ livePaymentAcceptanceEnabled: true }) };
    assert.equal(formatMainnetRuntimeStartupLine({ config,
        paymentRuntime: enabledRuntime, liveOperationsEnabled: true }),
    "MainnetPaymentRuntime (globalId=-239 | wallets=64 | storage=isolated | liveOperations=enabled | paidGameStart=enabled (3/3 gated))");
});

test("Mainnet server initialization selects the copied runtime and remains offline", t => {
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-server-mainnet-mode-"));
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    let rpcCalls = 0;
    const bootstrap = initializeMainnetServerRuntime({
        env: mainnetEnv(dataDir),
        fetchImpl: async () => { rpcCalls++; throw new Error("unexpected RPC"); },
        createBootstrap: options => createMainnetBootstrap(options)
    });
    assert.equal(bootstrap.config.network, "mainnet");
    assert.equal(bootstrap.config.globalId, -239);
    assert.equal(bootstrap.config.walletCount, 64);
    assert.equal(bootstrap.paymentRuntime.network, "mainnet");
    assert.equal(bootstrap.paymentRuntime.globalId, -239);
    assert.equal(bootstrap.paymentRuntime.getCapabilities().gameStartGateEnforced, true);
    assert.equal(bootstrap.paymentRuntime.getCapabilities().livePaymentAcceptanceEnabled, false);
    assert.equal(bootstrap.paymentRuntime.networkDataDir, join(dataDir, "mainnet"));
    assert.equal(rpcCalls, 0);
});

test("app composes the copied source runtime for Mainnet and excludes the retired runtime APIs", () => {
    const app = readFileSync(new URL("../../app.js", import.meta.url), "utf8");
    const modeSelection = app.indexOf("const paymentMode = resolveServerPaymentMode(process.env)");
    const mainnetBranch = app.indexOf('if (paymentMode === "mainnet")', modeSelection);
    const testnetBranch = app.indexOf("} else {", mainnetBranch);
    assert.ok(modeSelection >= 0 && mainnetBranch > modeSelection && testnetBranch > mainnetBranch);
    const branch = app.slice(mainnetBranch, testnetBranch);
    assert.match(branch, /initializeMainnetServerRuntime\(/);
    assert.match(branch, /new MainnetPage4PaymentApplicationBinding\(/);
    assert.match(branch, /configurePaymentGate\(paymentRuntime\.paymentGate\)/);
    assert.match(branch, /paymentRuntime\.refundLifecycle\.recover\(\)/);
    assert.match(app, /mainnetRuntime: this\._mainnetPaymentRuntime/);
    assert.doesNotMatch(branch, /new MainnetPaymentRuntime\(/);
    assert.doesNotMatch(branch, /financialLedger|incomingLedger|incomingPayments/);
});

test("production start entrypoint routes Telegram auth through the network token resolver", () => {
    const serverPackage = JSON.parse(readFileSync(
        new URL("../../package.json", import.meta.url), "utf8"
    ));
    const app = readFileSync(new URL("../../app.js", import.meta.url), "utf8");

    assert.equal(serverPackage.scripts.start, "node app.js");
    assert.match(app, /resolveTelegramBotToken\(process\.env\)/,
        "shared Testnet/Mainnet app must resolve the bot token from the runtime network");
    assert.match(app, /telegramAuth:\s*telegramAuthConfig/,
        "the selected token must reach SocketGateway Mini App validation");
});
