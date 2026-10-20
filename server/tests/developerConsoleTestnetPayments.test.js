import assert from "node:assert/strict";

import { DeveloperConsoleProjectionService } from "../console/DeveloperConsoleProjectionService.js";

function makeProjection(paymentRuntime) {
    return new DeveloperConsoleProjectionService({
        roomManager: { getActiveRoomCount: () => 0 },
        gameManager: { getGames: () => [] },
        playerManager: { getDebugSnapshot: () => ({ players: [] }) },
        paymentRuntime
    });
}

// Missing runtime must degrade to an explicit unavailable Testnet projection.
{
    const result = makeProjection(null).buildPaymentsOverview();
    assert.equal(result.architecture, "room-wallet");
    assert.equal(result.status, "UNAVAILABLE");
    assert.equal(result.network, "testnet");
    assert.equal(result.globalId, -3);
    assert.equal(result.wallets.total, null);
    assert.equal(result.intents.total, null);
}

// A Mainnet or unknown runtime must never leak its counters into Testnet debug.
{
    const result = makeProjection({
        network: "mainnet",
        globalId: -239,
        initialized: true,
        walletPool: { size: 64 },
        intentStore: { size: 12 },
        refundStore: { listPending: () => [{ id: "secret-like-id" }] },
        getCapabilities: () => ({ network: "mainnet", globalId: -239 })
    }).buildPaymentsOverview();

    assert.equal(result.status, "NETWORK_MISMATCH");
    assert.equal(result.network, "testnet");
    assert.equal(result.globalId, -3);
    assert.equal(result.initialized, false);
    assert.equal(result.wallets.total, null);
    assert.equal(result.intents.total, null);
    assert.equal(result.refunds.pending, null);
}

// Correct Testnet identity may expose read-only counts and state.
{
    const result = makeProjection({
        network: "testnet",
        globalId: -3,
        initialized: true,
        roomLifetimeMs: 480000,
        walletPool: { size: 64 },
        intentStore: { size: 7 },
        refundStore: { listPending: () => [{ id: "refund-1" }] },
        getCapabilities: () => ({ network: "testnet", globalId: -3 })
    }).buildPaymentsOverview();

    assert.equal(result.status, "READY");
    assert.equal(result.wallets.total, 64);
    assert.equal(result.intents.total, 7);
    assert.equal(result.refunds.pending, 1);
    assert.equal(result.roomLifetimeMs, 480000);
}

console.log("developerConsoleTestnetPayments.test.js: all passed");
