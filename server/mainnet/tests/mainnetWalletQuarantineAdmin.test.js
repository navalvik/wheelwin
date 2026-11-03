import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerDeveloperConsoleRoutes } from "../../console/registerDeveloperConsoleRoutes.js";
import { MainnetWalletQuarantineAdminService } from "../admin/MainnetWalletQuarantineAdminService.js";

const address = n => `0:${String(n).padStart(64, "0")}`;

function fixture({ residueAddress = null, sweepEnabled = false, live = true,
    reservedByRoomId = null, blocking = 0, receipts = [], observations = [],
    activeRoom = null, history = [], balance = "1000000000" } = {}) {
    const directory = mkdtempSync(join(tmpdir(), "wheelwin-mainnet-admin-"));
    const wallet = { network: "mainnet", walletId: "mainnet-room-2", roomNumber: 2,
        address: address(2), reservedByRoomId };
    let quarantined = false;
    const pool = {
        network: "mainnet",
        listWallets: () => Array.from({ length: 64 }, (_, index) => ({
            network: "mainnet", walletId: `mainnet-room-${index + 1}`,
            roomNumber: index + 1, address: address(index + 1),
            reservedByRoomId: index + 1 === 2 ? wallet.reservedByRoomId : null,
            secretKey: "must-not-be-returned"
        })),
        getWalletByRoomNumber: n => n === 2 ? wallet : null,
        listQuarantinedWallets: () => quarantined ? [{ roomNumber: 2, walletId: wallet.walletId,
            address: wallet.address, network: "mainnet", reservedByRoomId: wallet.reservedByRoomId,
            reason: "ADMIN_MANUAL_HOLD" }] : [],
        isQuarantined: () => quarantined,
        listReservationHistoryForWallet: () => history,
        manuallyQuarantine: () => { quarantined = true; return { roomNumber: 2,
            quarantined: true, reservedByRoomId: wallet.reservedByRoomId }; },
        manuallyReleaseQuarantine: ({ verifiedSafe }) => {
            assert.equal(verifiedSafe, true); quarantined = false; return { roomNumber: 2, released: true };
        }
    };
    const calls = { addresses: [], sweeps: [], financialWrites: 0 };
    const runtime = {
        network: "mainnet", globalId: -239, liveOperationsEnabled: live,
        stateDirectories: { outgoing: join(directory, "outgoing-seqno") },
        client: { network: "mainnet", globalId: -239,
            async getAddressInformation(value) {
                calls.addresses.push(value);
                return { ok: true, result: { balance, state: "active" } };
            } },
        incomingLedger: { network: "mainnet", globalId: -239,
            listAllIntents: () => [], listReceipts: () => receipts,
            listObservations: () => observations },
        financialLedger: { network: "mainnet", globalId: -239,
            countWalletBlockingObligations: () => blocking,
            listRefunds: () => [], getOutcome: () => null, listPayouts: () => [],
            createPayout() { calls.financialWrites += 1; } },
        outgoingAdapter: {
            async getWalletAddress() { return wallet.address; },
            async sendAllBalance(request) { calls.sweeps.push(request); return { ok: true, code: "SUBMITTED_UNCONFIRMED" }; }
        }
    };
    const env = { TON_NETWORK: "mainnet",
        ...(residueAddress ? { MAINNET_TON_RESIDUES_EXPECTED_ADDRESS: residueAddress } : {}),
        ...(sweepEnabled ? { MAINNET_ADMIN_WALLET_SWEEP_ENABLED: "true" } : {}) };
    const service = new MainnetWalletQuarantineAdminService({
        getRuntime: () => runtime, getWalletPool: () => pool,
        getRoomManager: () => ({ getRoom: id => activeRoom === id ? { roomId: id } : null }),
        getAdapter: selected => selected.outgoingAdapter,
        isInitialized: () => true, env
    });
    return { service, runtime, pool, wallet, calls, env, directory,
        cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test("Mainnet status reads only the selected Mainnet wallet and leaves residues unconfigured", async t => {
    const f = fixture(); t.after(f.cleanup);
    const result = await f.service.status(2);
    assert.equal(result.network, "mainnet");
    assert.equal(result.wallets.length, 64);
    assert.deepEqual(result.wallets.map(item => item.roomNumber),
        Array.from({ length: 64 }, (_, index) => index + 1));
    assert.equal(result.wallets.some(item => "secretKey" in item), false);
    assert.equal(result.wallets[1].address, f.wallet.address);
    assert.equal(result.selected.address, f.wallet.address);
    assert.equal(result.selected.balanceNano, "1000000000");
    assert.equal(result.residues.address, null);
    assert.equal(result.residues.error, "MAINNET_TON_RESIDUES_ADDRESS_NOT_CONFIGURED");
    assert.equal(result.sweepEnabled, false);
    assert.deepEqual(f.calls.addresses, [f.wallet.address]);
    await assert.rejects(f.service.status(65), /WALLET_NUMBER_MUST_BE_1_TO_64/);
});

test("manual quarantine affects only the Mainnet pool and does not write financial ledgers", t => {
    const f = fixture(); t.after(f.cleanup);
    const result = f.service.quarantine({ roomNumber: 2, confirmation: "QUARANTINE 2", note: "review" });
    assert.equal(result.quarantined, true);
    assert.equal(f.pool.isQuarantined(2), true);
    assert.equal(f.calls.financialWrites, 0);
    assert.throws(() => f.service.quarantine({ roomNumber: 2, confirmation: "QUARANTINE 3" }),
        /QUARANTINE_CONFIRMATION_REQUIRED/);
});

test("active rooms, unresolved receipts, and financial obligations block release and sweep", async t => {
    const residue = address(9);
    const pendingReceipt = { destinationAddress: address(2), transactionId: "tx-pending", status: "AMBIGUOUS" };
    const f = fixture({ residueAddress: residue, sweepEnabled: true, balance: "0",
        history: [{ roomId: "closed-room", walletId: "mainnet-room-2", network: "mainnet" }],
        receipts: [pendingReceipt] }); t.after(f.cleanup);
    f.pool.manuallyQuarantine(2);
    await assert.rejects(f.service.release({ roomNumber: 2, confirmation: "RELEASE 2" }),
        /WALLET_HAS_OPEN_FINANCIAL_OBLIGATIONS/);
    await assert.rejects(f.service.sweep({ roomNumber: 2, confirmation: "SWEEP 2 TO TON_RESIDUES" }),
        /WALLET_HAS_OPEN_FINANCIAL_OBLIGATIONS/);
    assert.equal(f.calls.sweeps.length, 0);

    const active = fixture({ residueAddress: residue, sweepEnabled: true,
        reservedByRoomId: "active-room", activeRoom: "active-room" }); t.after(active.cleanup);
    await assert.rejects(active.service.sweep({ roomNumber: 2, confirmation: "SWEEP 2 TO TON_RESIDUES" }),
        /WALLET_HAS_OPEN_FINANCIAL_OBLIGATIONS/);
    assert.equal(active.calls.sweeps.length, 0);
});

test("an unreserved, financially settled, empty Mainnet wallet can be released", async t => {
    const f = fixture({ balance: "0" }); t.after(f.cleanup);
    f.pool.manuallyQuarantine(2);
    const result = await f.service.release({ roomNumber: 2, confirmation: "RELEASE 2" });
    assert.equal(result.released, true);
    assert.equal(f.pool.isQuarantined(2), false);
    assert.deepEqual(f.calls.addresses, [f.wallet.address]);
});

test("manual Mainnet sweep uses the runtime adapter once and requires explicit Mainnet residue config", async t => {
    const f = fixture({ residueAddress: address(9), sweepEnabled: true }); t.after(f.cleanup);
    const state = await f.service.status(2);
    assert.equal(state.sweepEnabled, true);
    const result = await f.service.sweep({ roomNumber: 2, confirmation: "SWEEP 2 TO TON_RESIDUES" });
    assert.equal(result.code, "SUBMITTED_UNCONFIRMED");
    assert.deepEqual(f.calls.sweeps, [{ roomNumber: 2, destination: address(9) }]);
    assert.equal(f.pool.isQuarantined(2), true);
    assert.equal(f.calls.financialWrites, 0);

    const missing = fixture({ sweepEnabled: true }); t.after(missing.cleanup);
    await assert.rejects(missing.service.sweep({ roomNumber: 2,
        confirmation: "SWEEP 2 TO TON_RESIDUES" }), /MAINNET_TON_RESIDUES_ADDRESS_NOT_CONFIGURED/);
    assert.equal(missing.calls.sweeps.length, 0);
});

test("Mainnet sweep remains disabled when live operations are disabled", async t => {
    const f = fixture({ residueAddress: address(9), sweepEnabled: true, live: false }); t.after(f.cleanup);
    await assert.rejects(f.service.sweep({ roomNumber: 2,
        confirmation: "SWEEP 2 TO TON_RESIDUES" }), /MAINNET_ADMIN_SWEEP_DISABLED/);
    assert.equal(f.calls.sweeps.length, 0);
});

test("Mainnet administration refuses a non-Mainnet server mode or wallet pool", async t => {
    const f = fixture(); t.after(f.cleanup);
    f.env.TON_NETWORK = "testnet";
    await assert.rejects(f.service.status(2), /MAINNET_PAYMENT_RUNTIME_UNAVAILABLE/);
    f.env.TON_NETWORK = "mainnet";
    f.pool.network = "testnet";
    await assert.rejects(f.service.status(2), /MAINNET_WALLET_POOL_UNAVAILABLE/);
    assert.deepEqual(f.calls.addresses, []);
});

test("quarantine console routes reject requests without configured Administrator auth", async () => {
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
    const response = { status(code) { statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await handlers[0]({ headers: {}, query: {} }, response, () => assert.fail("unauthenticated request passed"));
    assert.equal(statusCode, 403);
    assert.equal(response.body.error, "ADMINISTRATOR_LOGIN_REQUIRED");
});
