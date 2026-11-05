import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMainnetBootstrap } from "../MainnetBootstrap.js";
import { resolveFinancialArchiveRuntimeBinding } from "../payment/MainnetForensicFinancialSnapshot.js";

function catalog() {
    return JSON.stringify(Array.from({ length: 64 }, (_, index) => ({
        walletId: `mainnet-archive-${index + 1}`,
        roomNumber: index + 1,
        address: `0:${String(index + 500).padStart(64, "0")}`,
        network: "mainnet"
    })));
}

test("Mainnet archive binding consumes the source runtime snapshot and selects Mainnet prefix", t => {
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-mainnet-archive-"));
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    const bootstrap = createMainnetBootstrap({ env: {
        TON_NETWORK: "mainnet",
        MAINNET_TONCENTER_API_KEY: "offline-only-key",
        MAINNET_ROOM_WALLETS_JSON: catalog(),
        MAINNET_ROOM_WALLET_DATA_DIR: dataDir
    }, fetchImpl: async () => { throw new Error("unexpected RPC"); } });
    bootstrap.initialize();
    const archive = resolveFinancialArchiveRuntimeBinding({
        paymentMode: "mainnet",
        archiveConfig: { prefix: "testnet", bucket: "synthetic" },
        mainnetRuntime: bootstrap.paymentRuntime
    });
    assert.equal(archive.config.prefix, "mainnet");
    const snapshot = archive.financialSnapshotProvider("archive-room");
    assert.equal(snapshot.network, "mainnet");
    assert.equal(snapshot.globalId, -239);
    assert.equal(snapshot.roomId, "archive-room");
    assert.ok(Array.isArray(snapshot.intents));
    assert.ok(Array.isArray(snapshot.ledger));
    assert.ok(Array.isArray(snapshot.refunds));
    assert.equal(Object.hasOwn(snapshot, "walletCatalog"), false);
});

test("archive binding rejects a missing runtime for the selected network", () => {
    assert.throws(() => resolveFinancialArchiveRuntimeBinding({
        paymentMode: "mainnet", archiveConfig: {}, mainnetRuntime: null
    }), /MAINNET_FINANCIAL_SNAPSHOT_UNAVAILABLE/);
    assert.throws(() => resolveFinancialArchiveRuntimeBinding({
        paymentMode: "unknown", archiveConfig: {}
    }), /PAYMENT_MODE_UNSUPPORTED_FOR_ARCHIVE/);
});
