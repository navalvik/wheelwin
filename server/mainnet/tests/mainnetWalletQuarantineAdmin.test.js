import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMainnetBootstrap } from "../MainnetBootstrap.js";
import { MainnetWalletQuarantineAdminService } from "../admin/MainnetWalletQuarantineAdminService.js";
import { registerDeveloperConsoleRoutes } from "../../console/registerDeveloperConsoleRoutes.js";

const address = n => `0:${String(n).padStart(64, "0")}`;

function setup(t, { balance = "0", envOverrides = {} } = {}) {
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-mainnet-admin-"));
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    const env = {
        TON_NETWORK: "mainnet",
        MAINNET_TONCENTER_API_KEY: "offline-only-key",
        MAINNET_ROOM_WALLET_DATA_DIR: dataDir,
        MAINNET_ROOM_WALLETS_JSON: JSON.stringify(Array.from({ length: 64 }, (_, index) => ({
            walletId: `mainnet-room-${index + 1}`,
            roomNumber: index + 1,
            address: address(index + 1),
            network: "mainnet"
        }))),
        ...envOverrides
    };
    const bootstrap = createMainnetBootstrap({ env, fetchImpl: async () => {
        throw new Error("unexpected RPC");
    } });
    bootstrap.initialize();
    const calls = [];
    const service = new MainnetWalletQuarantineAdminService({
        getRuntime: () => bootstrap.paymentRuntime,
        getWalletPool: () => bootstrap.walletPool,
        getClient: () => ({ async getAddressInformation(walletAddress) {
            calls.push(walletAddress);
            return { ok: true, result: { balance, state: "active" } };
        } }),
        getRoomManager: () => ({ getRoom: () => null }),
        getAdapter: () => null,
        isInitialized: () => true,
        env
    });
    return { service, bootstrap, calls, env };
}

test("Mainnet wallet status reads the selected address and omits secrets", async t => {
    const h = setup(t);
    const result = await h.service.status(2);
    assert.equal(result.network, "mainnet");
    assert.equal(result.wallets.length, 64);
    assert.equal(result.selected.address, address(2));
    assert.equal(result.selected.balanceNano, "0");
    assert.equal(result.residues.address, null);
    assert.equal(result.sweepEnabled, false);
    assert.ok(result.wallets.every(wallet => !Object.hasOwn(wallet, "secretKey")));
    assert.deepEqual(h.calls, [address(2)]);
    await assert.rejects(h.service.status(65), /WALLET_NUMBER_MUST_BE_1_TO_64/);
});

test("manual quarantine and release operate on the copied runtime wallet pool", async t => {
    const h = setup(t);
    const held = h.service.quarantine({ roomNumber: 2, confirmation: "QUARANTINE 2", note: "review" });
    assert.equal(held.quarantined, true);
    assert.equal(h.bootstrap.walletPool.isQuarantined(2), true);
    const released = await h.service.release({ roomNumber: 2, confirmation: "RELEASE 2" });
    assert.equal(released.released, true);
    assert.equal(h.bootstrap.walletPool.isQuarantined(2), false);
    assert.throws(() => h.service.quarantine({ roomNumber: 2, confirmation: "QUARANTINE 3" }),
        /QUARANTINE_CONFIRMATION_REQUIRED/);
});

test("reserved wallet stays held and Mainnet sweep remains unavailable offline", async t => {
    const h = setup(t, { envOverrides: {
        MAINNET_ADMIN_WALLET_SWEEP_ENABLED: "true",
        MAINNET_TON_RESIDUES_EXPECTED_ADDRESS: address(63)
    } });
    const pool = h.bootstrap.walletPool;
    pool.reserve({ roomId: "active-room", network: "mainnet", walletId: "mainnet-room-2" });
    pool.manuallyQuarantine(2);
    await assert.rejects(h.service.release({ roomNumber: 2, confirmation: "RELEASE 2" }),
        /WALLET_HAS_OPEN_FINANCIAL_OBLIGATIONS/);
    const status = await h.service.status(2);
    assert.equal(status.sweepEnabled, false);
    await assert.rejects(h.service.sweep({ roomNumber: 2,
        confirmation: "SWEEP 2 TO TON_RESIDUES" }), /MAINNET_ADMIN_SWEEP_DISABLED/);
});

test("administrator routes require Administrator authentication", async () => {
    const routes = new Map();
    const app = { use() {}, get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
        post(path, ...handlers) { routes.set(`POST ${path}`, handlers); },
        put() {}, patch() {}, delete() {} };
    registerDeveloperConsoleRoutes(app, {}, {
        authService: { isEnabled: () => false, allowsOpenAccess: () => true },
        walletQuarantineService: { async status() { assert.fail("unauthenticated request reached service"); } }
    });
    const handlers = routes.get("GET /console/wallets/quarantine");
    assert.equal(handlers.length, 2);
    let statusCode = null;
    const response = { status(code) { statusCode = code; return this; },
        json(body) { this.body = body; return this; } };
    await handlers[0]({ headers: {}, query: {} }, response,
        () => assert.fail("unauthenticated request passed"));
    assert.equal(statusCode, 403);
    assert.equal(response.body.error, "ADMINISTRATOR_LOGIN_REQUIRED");
});
