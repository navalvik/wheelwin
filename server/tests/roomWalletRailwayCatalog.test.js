import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WalletPoolRegistry } from "../payment/WalletPoolRegistry.js";

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
