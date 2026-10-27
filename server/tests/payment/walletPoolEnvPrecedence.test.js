import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WalletPoolRegistry } from "../../payment/WalletPoolRegistry.js";

test("Railway Testnet wallet catalog takes precedence over a stale local catalog", () => {
    const dir = mkdtempSync(join(tmpdir(), "wheelwin-wallet-source-"));
    const file = join(dir, "wallets.json");
    const previousTestnet = process.env.ROOM_WALLETS_TESTNET_JSON;
    const previousFallback = process.env.ROOM_WALLETS_JSON;
    const catalog = (offset) => Array.from({ length: 64 }, (_, index) => ({
        walletId: `room-wallet-${index + 1}`,
        roomNumber: index + 1,
        network: "testnet",
        workchain: 0,
        address: `0:${(index + offset).toString(16).padStart(64, "0")}`
    }));
    try {
        writeFileSync(file, JSON.stringify(catalog(1)));
        process.env.ROOM_WALLETS_TESTNET_JSON = JSON.stringify(catalog(100));
        process.env.ROOM_WALLETS_JSON = JSON.stringify(catalog(200));
        const pool = new WalletPoolRegistry({ catalogPath: file, network: "testnet" });
        pool.initialize();
        assert.equal(pool.listWallets().length, 64);
        assert.equal(pool.getWallet("room-wallet-1").address, catalog(100)[0].address);
        assert.notEqual(pool.getWallet("room-wallet-1").address, catalog(1)[0].address);
    } finally {
        if (previousTestnet === undefined) delete process.env.ROOM_WALLETS_TESTNET_JSON;
        else process.env.ROOM_WALLETS_TESTNET_JSON = previousTestnet;
        if (previousFallback === undefined) delete process.env.ROOM_WALLETS_JSON;
        else process.env.ROOM_WALLETS_JSON = previousFallback;
        rmSync(dir, { recursive: true, force: true });
    }
});
