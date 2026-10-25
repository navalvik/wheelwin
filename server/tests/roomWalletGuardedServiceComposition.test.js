import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";
import { createRoomWalletService } from "../payment/roomWallet/RoomWalletService.js";
import { composeRoomWalletSettlementRouter } from "../payment/roomWallet/roomWalletConfig.js";
import { createDummyRoomWalletCatalog } from "./helpers/dummyRoomWallet.js";

function environment() {
    return {
        TON_NETWORK: "testnet",
        ROOM_WALLETS_JSON: JSON.stringify(createDummyRoomWalletCatalog()),
        ROOM_WALLET_GUARDED_OUTBOUND_ONLY: "true",
        ROOM_WALLET_OUTGOING_CONFIRMATION_ENABLED: "true",
        ROOM_WALLET_EXPIRED_RECONCILIATION_ENABLED: "true",
        ROOM_WALLET_RESIDUAL_SWEEP_ENABLED: "false"
    };
}

function fixture(t) {
    const directory = mkdtempSync(join(tmpdir(), "ww-guarded-router-"));
    const store = new TonFinancialPersistence({ dataDir: join(directory, "finance") });
    store.initialize();
    t.after(() => {
        store.shutdown({ checkpoint: false });
        rmSync(directory, { recursive: true, force: true });
    });
    let broadcasts = 0;
    const tonService = {
        async getSeqno() { return 42; },
        async getBalance() { return 3000000000n; },
        async broadcastTransaction() {
            broadcasts++;
            throw new Error("NETWORK MUST NEVER BE USED IN ROUTER TEST");
        }
    };
    const config = {
        env: environment(),
        tonService,
        financialPersistence: store,
        signerLockDirectory: join(directory, "finance", "room-wallet-outbound-signer-locks")
    };
    return { store, config, broadcasts: () => broadcasts };
}

test("explicit guarded Testnet composes shared journal, signer and settlement adapter", t => {
    const f = fixture(t);
    const service = createRoomWalletService(f.config);
    assert.equal(service.registry.size(), 64);
    assert.ok(service.guardedPayoutCoordinator);
    assert.ok(service.settlementAdapter._guardedPayoutCoordinator);
    assert.equal(service.roomWalletAdapter._guardedOutboundOnly, true);
    assert.equal(f.broadcasts(), 0);
});

test("router's refund path fails closed on missing persisted player obligations", async t => {
    const f = fixture(t);
    const router = composeRoomWalletSettlementRouter(f.config);
    assert.equal(router.isEnabled(), true);
    const result = await router.refundPayments({
        roomNumber: 1,
        refunds: [{ playerId: "Lena", wallet: "0:" + "e".repeat(64), amountNano: "1000000000" }]
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "GUARDED_REFUND_FROZEN_PLAN_AND_EVIDENCE_REQUIRED");
    assert.equal(f.broadcasts(), 0);
});

test("router never falls back to direct payout without authoritative persisted settlement", async t => {
    const f = fixture(t);
    const router = composeRoomWalletSettlementRouter(f.config);
    const result = await router.settleContract({ gameId: "unpersisted_game" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "GUARDED_SETTLEMENT_FROZEN_PLAN_UNAVAILABLE");
    assert.equal(f.broadcasts(), 0);
});

test("guarded config on Mainnet is rejected before any signing or broadcast", t => {
    const f = fixture(t);
    assert.throws(() => createRoomWalletService({
        ...f.config, env: { ...environment(), TON_NETWORK: "mainnet" }
    }), /GUARDED_OUTBOUND_TESTNET_ONLY/);
    assert.equal(f.broadcasts(), 0);
});

test("guarded config without persistent financial store or lock directory fails closed", t => {
    const f = fixture(t);
    assert.throws(() => createRoomWalletService({
        ...f.config, financialPersistence: null
    }), /GUARDED_OUTBOUND_REQUIRES_SHARED_STORE_AND_SIGNER/);
    assert.throws(() => createRoomWalletService({
        ...f.config, signerLockDirectory: null
    }), /GUARDED_OUTBOUND_REQUIRES_SHARED_STORE_AND_SIGNER/);
    assert.equal(f.broadcasts(), 0);
});

test("historical default has no guarded coordinator or external broadcast side effects", t => {
    const f = fixture(t);
    const service = createRoomWalletService({
        ...f.config,
        env: { ...environment(), ROOM_WALLET_GUARDED_OUTBOUND_ONLY: "false" },
        financialPersistence: null,
        signerLockDirectory: null
    });
    assert.equal(service.guardedPayoutCoordinator, null);
    assert.equal(service.roomWalletAdapter._guardedOutboundOnly, false);
    assert.equal(f.broadcasts(), 0);
});


test("guarded-mode startup refuses legacy residual sweep sender", t => {
    const f = fixture(t);
    assert.throws(() => createRoomWalletService({
        ...f.config,
        env: { ...environment(), ROOM_WALLET_RESIDUAL_SWEEP_ENABLED: "true" }
    }), /GUARDED_OUTBOUND_RESIDUAL_SWEEP_NOT_MIGRATED/);
    assert.equal(f.broadcasts(), 0);
});

test("guarded mode cannot start without outgoing and expired-room workers", t => {
    const f = fixture(t);
    for (const missing of [
        "ROOM_WALLET_OUTGOING_CONFIRMATION_ENABLED",
        "ROOM_WALLET_EXPIRED_RECONCILIATION_ENABLED"
    ]) {
        assert.throws(() => createRoomWalletService({
            ...f.config, env: { ...environment(), [missing]: "false" }
        }), /GUARDED_OUTBOUND_REQUIRES_RECOVERY_WORKERS/);
    }
    assert.equal(f.broadcasts(), 0);
});
