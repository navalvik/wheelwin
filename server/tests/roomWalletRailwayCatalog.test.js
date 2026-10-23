import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WalletPoolRegistry, readRoomWalletCatalog } from "../payment/WalletPoolRegistry.js";

function catalog() {
    return Array.from({ length: 64 }, (_, i) => ({
        walletId: `testnet-room-wallet-${i + 1}`,
        roomNumber: i + 1,
        address: `EQ-test-wallet-${i + 1}`,
        network: "testnet",
        secretKey: "MUST_NOT_APPEAR_IN_MEMORY",
        mnemonic: "MUST_NOT_APPEAR_IN_MEMORY"
    }));
}

test("Railway Testnet variable supplies 64 wallets without a checked-in catalog", () => {
    const dir = mkdtempSync(join(tmpdir(), "wheelwin-env-wallets-"));
    const previous = process.env.ROOM_WALLETS_TESTNET_JSON;
    try {
        process.env.ROOM_WALLETS_TESTNET_JSON = JSON.stringify(catalog());
        const pool = new WalletPoolRegistry({
            catalogPath: join(dir, "missing-private-wallet-file.json"),
            network: "testnet"
        });
        pool.initialize();
        assert.equal(pool.listWallets().length, 64);
        assert.equal(readRoomWalletCatalog().length, 64);
        assert.equal(pool.getAvailableCount(), 64);
        assert.equal(JSON.stringify(pool.listWallets()).includes("MUST_NOT_APPEAR"), false);
        pool.reserve({ roomId: "room-a", network: "testnet" });
        assert.equal(pool.getReservedCount(), 1);
        assert.equal(pool.getAvailableCount(), 63);
    } finally {
        if (previous === undefined) delete process.env.ROOM_WALLETS_TESTNET_JSON;
        else process.env.ROOM_WALLETS_TESTNET_JSON = previous;
        rmSync(dir, { recursive: true, force: true });
    }
});

test("Malformed Railway Testnet catalog fails closed", () => {
    const previous = process.env.ROOM_WALLETS_TESTNET_JSON;
    try {
        process.env.ROOM_WALLETS_TESTNET_JSON = JSON.stringify(catalog().slice(0, 63));
        const pool = new WalletPoolRegistry({ network: "testnet" });
        assert.throws(() => pool.initialize(), /exactly 64 wallets/);
    } finally {
        if (previous === undefined) delete process.env.ROOM_WALLETS_TESTNET_JSON;
        else process.env.ROOM_WALLETS_TESTNET_JSON = previous;
    }
});

test("Mainnet registry never consumes the Testnet or generic Railway catalog", () => {
    const previousTestnet = process.env.ROOM_WALLETS_TESTNET_JSON;
    const previousGeneric = process.env.ROOM_WALLETS_JSON;
    const previousMainnet = process.env.ROOM_WALLETS_MAINNET_JSON;
    const dir = mkdtempSync(join(tmpdir(), "wheelwin-mainnet-isolation-"));
    try {
        process.env.ROOM_WALLETS_TESTNET_JSON = JSON.stringify(catalog());
        process.env.ROOM_WALLETS_JSON = JSON.stringify(catalog());
        delete process.env.ROOM_WALLETS_MAINNET_JSON;
        const pool = new WalletPoolRegistry({
            network: "mainnet",
            catalogPath: join(dir, "missing-mainnet-catalog.json")
        });
        assert.throws(() => pool.initialize(), /catalog unavailable/);
    } finally {
        for (const [key, value] of [
            ["ROOM_WALLETS_TESTNET_JSON", previousTestnet],
            ["ROOM_WALLETS_JSON", previousGeneric],
            ["ROOM_WALLETS_MAINNET_JSON", previousMainnet]
        ]) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        rmSync(dir, { recursive: true, force: true });
    }
});

test("Wrong network or room number outside the 64-wallet pool fails closed", () => {
    const previous = process.env.ROOM_WALLETS_TESTNET_JSON;
    try {
        const wrongNetwork = catalog();
        wrongNetwork[2] = { ...wrongNetwork[2], network: "mainnet" };
        process.env.ROOM_WALLETS_TESTNET_JSON = JSON.stringify(wrongNetwork);
        assert.throws(
            () => new WalletPoolRegistry({ network: "testnet" }).initialize(),
            /network mismatch/
        );

        const wrongRoomNumber = catalog();
        wrongRoomNumber[63] = { ...wrongRoomNumber[63], roomNumber: 65 };
        process.env.ROOM_WALLETS_TESTNET_JSON = JSON.stringify(wrongRoomNumber);
        assert.throws(
            () => new WalletPoolRegistry({ network: "testnet" }).initialize(),
            /room number exceeds pool size/
        );
    } finally {
        if (previous === undefined) delete process.env.ROOM_WALLETS_TESTNET_JSON;
        else process.env.ROOM_WALLETS_TESTNET_JSON = previous;
    }
});

test("Unknown reserved wallet in durable snapshot blocks startup without silently releasing it", () => {
    const dir = mkdtempSync(join(tmpdir(), "wheelwin-unknown-reservation-"));
    try {
        const pool = new WalletPoolRegistry({
            catalogJson: JSON.stringify(catalog()), network: "testnet"
        });
        pool.initialize();
        pool.reserve({ roomId: "room-with-unsettled-payment", network: "testnet" });
        const snapshotPath = pool.persistSnapshot(dir);
        const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
        const reserved = snapshot.reservations.find(w => w.reservedByRoomId !== null);
        assert.ok(reserved, "fixture must contain a reserved wallet");
        reserved.walletId = "unknown-wallet-id";
        writeFileSync(snapshotPath, JSON.stringify(snapshot), "utf8");

        const restarted = new WalletPoolRegistry({
            catalogJson: JSON.stringify(catalog()), network: "testnet"
        });
        assert.throws(
            () => restarted.initialize({ snapshotDir: dir }),
            /unknown or duplicate wallet identity/,
            "startup must fail closed instead of losing an unresolved reservation"
        );
        assert.equal(restarted.getReservedCount(), 0,
            "failed startup must not create a valid-looking reservation");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("64 concurrent rooms receive unique wallets and the 65th is rejected", () => {
    const pool = new WalletPoolRegistry({
        catalogJson: JSON.stringify(catalog()), network: "testnet"
    });
    pool.initialize();
    const assigned = new Set();
    for (let i = 0; i < 64; i++) {
        const roomId = `concurrent-room-${i + 1}`;
        const { wallet } = pool.reserve({ roomId, network: "testnet" });
        assert.equal(wallet.reservedByRoomId, roomId);
        assert.equal(assigned.has(wallet.walletId), false, "room wallet reused across active rooms");
        assigned.add(wallet.walletId);
    }
    assert.equal(assigned.size, 64);
    assert.equal(pool.getReservedCount(), 64);
    assert.equal(pool.getAvailableCount(), 0);
    assert.throws(
        () => pool.reserve({ roomId: "concurrent-room-65", network: "testnet" }),
        /exhaust|available|wallet/i,
        "a 65th room must not share an active wallet"
    );
    assert.equal(pool.getReservedCount(), 64);
});

test("64 active wallet reservations survive restart and cannot be reassigned", () => {
    const dir = mkdtempSync(join(tmpdir(), "wheelwin-wallet-restart-"));
    try {
        const catalogJson = JSON.stringify(catalog());
        const before = new WalletPoolRegistry({ catalogJson, network: "testnet" });
        before.initialize();
        const original = new Map();
        for (let i = 1; i <= 64; i++) {
            const roomId = `room-${i}`;
            const { wallet } = before.reserve({ roomId, network: "testnet" });
            original.set(roomId, wallet.walletId);
        }
        before.persistSnapshot(dir);

        const after = new WalletPoolRegistry({ catalogJson, network: "testnet" });
        after.initialize({ snapshotDir: dir });
        assert.equal(after.getReservedCount(), 64);
        assert.equal(after.getAvailableCount(), 0);
        for (const [roomId, walletId] of original) {
            assert.equal(after.getReservationForRoom(roomId)?.walletId, walletId,
                "restart must preserve exact room-to-wallet identity");
        }
        assert.throws(
            () => after.reserve({ roomId: "room-65", network: "testnet" }),
            /exhaust|available|wallet/i,
            "restart must not recycle an active room wallet"
        );
        assert.equal(after.getReservedCount(), 64);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("Unresolved refund blocks wallet recycling until obligations are cleared", () => {
    const dir = mkdtempSync(join(tmpdir(), "wheelwin-wallet-refund-hold-"));
    try {
        const catalogJson = JSON.stringify(catalog());
        const pool = new WalletPoolRegistry({ catalogJson, network: "testnet" });
        pool.initialize();
        const { wallet } = pool.reserve({ roomId: "expired-room", network: "testnet" });
        assert.throws(
            () => pool.release({ roomId: "expired-room", unresolvedObligations: 1 }),
            /recycl|obligation|blocked|unresolved/i,
            "pending refund must prevent wallet reuse"
        );
        assert.equal(pool.getReservationForRoom("expired-room")?.walletId, wallet.walletId);
        pool.persistSnapshot(dir);

        const restarted = new WalletPoolRegistry({ catalogJson, network: "testnet" });
        restarted.initialize({ snapshotDir: dir });
        assert.equal(restarted.getReservationForRoom("expired-room")?.walletId, wallet.walletId);
        assert.throws(
            () => restarted.reserve({ roomId: "new-room", walletId: wallet.walletId, network: "testnet" }),
            /already reserved|conflict|wallet/i,
            "wallet with pending refund must stay unavailable after restart"
        );
        const released = restarted.release({ roomId: "expired-room", unresolvedObligations: 0 });
        assert.equal(released.released, true);
        const reassigned = restarted.reserve({ roomId: "new-room", walletId: wallet.walletId, network: "testnet" });
        assert.equal(reassigned.wallet.walletId, wallet.walletId);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("Incomplete wallet snapshot cannot make an occupied wallet available", () => {
    const dir = mkdtempSync(join(tmpdir(), "wheelwin-partial-wallet-snapshot-"));
    try {
        const catalogJson = JSON.stringify(catalog());
        const pool = new WalletPoolRegistry({ catalogJson, network: "testnet" });
        pool.initialize();
        pool.reserve({ roomId: "unsettled-room", network: "testnet" });
        const snapshotPath = pool.persistSnapshot(dir);
        const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
        snapshot.reservations = snapshot.reservations.filter(w => w.reservedByRoomId === null);
        writeFileSync(snapshotPath, JSON.stringify(snapshot), "utf8");
        const restarted = new WalletPoolRegistry({ catalogJson, network: "testnet" });
        assert.throws(() => restarted.initialize({ snapshotDir: dir }),
            /catalog identity mismatch/,
            "partial snapshot must not silently lose a live reservation");
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Duplicate wallet identities in snapshot are rejected before recovery", () => {
    const dir = mkdtempSync(join(tmpdir(), "wheelwin-duplicate-wallet-snapshot-"));
    try {
        const catalogJson = JSON.stringify(catalog());
        const pool = new WalletPoolRegistry({ catalogJson, network: "testnet" });
        pool.initialize();
        const snapshotPath = pool.persistSnapshot(dir);
        const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
        snapshot.reservations[1].walletId = snapshot.reservations[0].walletId;
        writeFileSync(snapshotPath, JSON.stringify(snapshot), "utf8");
        const restarted = new WalletPoolRegistry({ catalogJson, network: "testnet" });
        assert.throws(() => restarted.initialize({ snapshotDir: dir }),
            /unknown or duplicate wallet identity/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Snapshot cannot restore a reservation against a changed wallet address", () => {
    const dir = mkdtempSync(join(tmpdir(), "wheelwin-wallet-identity-drift-"));
    try {
        const catalogJson = JSON.stringify(catalog());
        const pool = new WalletPoolRegistry({ catalogJson, network: "testnet" });
        pool.initialize();
        pool.reserve({ roomId: "active-room", network: "testnet" });
        const snapshotPath = pool.persistSnapshot(dir);
        const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
        const reserved = snapshot.reservations.find(w => w.reservedByRoomId === "active-room");
        reserved.address = "EQ-different-wallet";
        writeFileSync(snapshotPath, JSON.stringify(snapshot), "utf8");
        const restarted = new WalletPoolRegistry({ catalogJson, network: "testnet" });
        assert.throws(() => restarted.initialize({ snapshotDir: dir }),
            /wallet identity differs from catalog/,
            "wallet address mismatch must block recovery");
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Conflicting room owners fail before any snapshot reservation is restored", () => {
    const dir = mkdtempSync(join(tmpdir(), "wheelwin-conflicting-room-owners-"));
    try {
        const catalogJson = JSON.stringify(catalog());
        const pool = new WalletPoolRegistry({ catalogJson, network: "testnet" });
        pool.initialize();
        pool.reserve({ roomId: "room-a", network: "testnet" });
        pool.reserve({ roomId: "room-b", network: "testnet" });
        const snapshotPath = pool.persistSnapshot(dir);
        const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
        const second = snapshot.reservations.find(w => w.reservedByRoomId === "room-b");
        second.reservedByRoomId = "room-a";
        writeFileSync(snapshotPath, JSON.stringify(snapshot), "utf8");
        const restarted = new WalletPoolRegistry({ catalogJson, network: "testnet" });
        assert.throws(() => restarted.initialize({ snapshotDir: dir }),
            /conflicting active reservations/);
        assert.equal(restarted.getReservedCount(), 0,
            "invalid snapshot must not partially restore wallet reservations");
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Reordered catalog preserves every active reservation by wallet identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "wheelwin-wallet-reordered-catalog-"));
    try {
        const originalCatalog = catalog();
        const before = new WalletPoolRegistry({
            catalogJson: JSON.stringify(originalCatalog), network: "testnet"
        });
        before.initialize();
        const expected = new Map();
        for (let i = 1; i <= 64; i++) {
            const roomId = `reordered-room-${i}`;
            expected.set(roomId, before.reserve({ roomId, network: "testnet" }).wallet.walletId);
        }
        before.persistSnapshot(dir);
        const after = new WalletPoolRegistry({
            catalogJson: JSON.stringify([...originalCatalog].reverse()), network: "testnet"
        });
        after.initialize({ snapshotDir: dir });
        assert.equal(after.getReservedCount(), 64);
        assert.equal(after.getAvailableCount(), 0);
        for (const [roomId, walletId] of expected) {
            assert.equal(after.getReservationForRoom(roomId)?.walletId, walletId);
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
