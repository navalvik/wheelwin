import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { FinancialObligationsReadService } from "../console/FinancialObligationsReadService.js";
import { registerDeveloperConsoleRoutes } from "../console/registerDeveloperConsoleRoutes.js";
import { createDeveloperAuthMiddleware } from "../console/auth/developerAuthMiddleware.js";
import { LEDGER_ENTRY_KIND } from "../payment/ledger/LedgerConstants.js";

const ledgerEntries = [
    {
        roomId: "room-principal",
        kind: LEDGER_ENTRY_KIND.INCOMING_PRINCIPAL,
        metadata: { transactionId: "tx-principal", paymentReference: "reference-principal" }
    },
    { roomId: "room-payout", kind: LEDGER_ENTRY_KIND.PAYOUT_PLAN },
    { roomId: "room-payout", kind: LEDGER_ENTRY_KIND.NET_PAYOUT }
];
const refundRecords = [{ roomId: "room-closed-refund", state: "PENDING" }];
const paymentIntents = [{ roomId: "room-intent", state: "MATCHED" }];
const receiptRecords = [{
    roomId: null,
    candidateRoomIds: ["room-unresolved"],
    ownershipStatus: "UNRESOLVED",
    transactionId: "tx-unresolved"
}];
const payoutObligations = [{ roomId: "room-payout", settled: false }];
const closedRoomRecords = [{ roomId: "room-closed-refund" }];

function createRuntime() {
    const listForRoom = roomId => ledgerEntries.filter(entry => entry.roomId === roomId);
    return {
        initialized: true,
        network: "testnet",
        globalId: -3,
        ledgerStore: { list: () => ledgerEntries, listForRoom },
        ledger: {
            store: { listForRoom },
            listPayoutObligations: roomId => payoutObligations.filter(item => item.roomId === roomId)
        },
        refundStore: {
            list: () => refundRecords,
            listClosedRooms: () => closedRoomRecords
        },
        receiptStore: {
            list: () => receiptRecords,
            listForRoom: roomId => receiptRecords.filter(item => item.roomId === roomId),
            listUnresolved: () => receiptRecords.filter(item => item.ownershipStatus === "UNRESOLVED")
        },
        intentStore: { list: () => paymentIntents }
    };
}

const runtime = createRuntime();
const before = JSON.stringify({ ledgerEntries, refundRecords, paymentIntents, receiptRecords, closedRoomRecords });
const service = new FinancialObligationsReadService({ getRuntime: () => runtime, now: () => 1_800_000_000_000 });
const snapshot = service.snapshot();

assert.equal(snapshot.network, "TESTNET");
assert.equal(snapshot.globalId, -3);
assert.equal(snapshot.unsettledCount, 5);
assert.equal(snapshot.roomsScanned, 5);
assert.equal(snapshot.closedRoomsScanned, 1);
assert.ok(snapshot.obligations.some(item => item.type === "REFUND"
    && item.roomId === "room-closed-refund" && item.state === "PENDING" && item.closedRoom));
assert.ok(snapshot.obligations.some(item => item.type === "PAYOUT"
    && item.roomId === "room-payout" && item.state === "UNSETTLED"));
assert.ok(snapshot.obligations.some(item => item.type === "COLLECTED_PRINCIPAL"
    && item.roomId === "room-principal" && item.state === "AWAITING_REFUND_OR_PAYOUT"));
assert.ok(snapshot.obligations.some(item => item.type === "PAYMENT_INTENT"
    && item.roomId === "room-intent" && item.state === "MATCHED"));
assert.ok(snapshot.obligations.some(item => item.type === "INCOMING_RECEIPT"
    && item.roomId === null && item.state === "UNRESOLVED_OWNERSHIP"));
assert.equal(JSON.stringify({ ledgerEntries, refundRecords, paymentIntents, receiptRecords, closedRoomRecords }), before,
    "financial stores remain unchanged");
for (const item of snapshot.obligations) {
    assert.deepEqual(Object.keys(item).sort(), ["candidateRoomIds", "closedRoom", "roomId", "state", "type"]
        .filter(key => Object.hasOwn(item, key)).sort());
    assert.equal(Object.hasOwn(item, "amountAtomic"), false);
    assert.equal(Object.hasOwn(item, "walletAddress"), false);
    assert.equal(Object.hasOwn(item, "transactionId"), false);
}

assert.throws(() => new FinancialObligationsReadService({
    getRuntime: () => ({ ...runtime, network: "mainnet", globalId: -239 })
}).snapshot(), /TESTNET_PAYMENT_RUNTIME_UNAVAILABLE/);

let snapshotCalls = 0;
const authService = {
    allowsOpenAccess: () => false,
    isEnabled: () => true,
    isAdministrator: claims => claims.role === "Administrator",
    verifyAccessToken: token => token === "admin-test-token"
        ? { username: "test-admin", role: "Administrator" }
        : token === "viewer-test-token" ? { username: "test-viewer", role: "Viewer" } : null
};
const app = express();
registerDeveloperConsoleRoutes(app, {}, {
    authService,
    authMiddleware: createDeveloperAuthMiddleware(authService),
    financialObligationsReadService: { snapshot: () => { snapshotCalls += 1; return snapshot; } }
});
const httpServer = app.listen(0, "127.0.0.1");
await once(httpServer, "listening");
try {
    const base = `http://127.0.0.1:${httpServer.address().port}/console/finance/obligations`;
    const unauthorized = await fetch(`${base}?network=testnet`);
    assert.equal(unauthorized.status, 401);
    const viewer = await fetch(`${base}?network=testnet`, {
        headers: { Authorization: "Bearer viewer-test-token" }
    });
    assert.equal(viewer.status, 403);
    assert.equal(snapshotCalls, 0, "unauthorized requests never inspect financial stores");
    const wrongNetwork = await fetch(`${base}?network=mainnet`, {
        headers: { Authorization: "Bearer admin-test-token" }
    });
    assert.equal(wrongNetwork.status, 400);
    assert.equal(snapshotCalls, 0, "the endpoint refuses Mainnet queries");
    const admin = await fetch(`${base}?network=testnet`, {
        headers: { Authorization: "Bearer admin-test-token" }
    });
    assert.equal(admin.status, 200);
    assert.equal(admin.headers.get("cache-control"), "no-store");
    assert.equal((await admin.json()).unsettledCount, 5);
    assert.equal(snapshotCalls, 1);
} finally {
    await new Promise(resolve => httpServer.close(resolve));
}

process.stdout.write("financialObligationsReadOnly.test.js: all assertions passed\n");
