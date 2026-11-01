import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventBus } from "../../events/EventBus.js";
import { RoomManager } from "../../managers/RoomManager.js";
import { loadMainnetRuntimeConfig } from "../config/MainnetRuntimeConfig.js";
import { MainnetFinancialLedger } from "../payment/MainnetFinancialLedger.js";
import { MainnetRefundLifecycle } from "../payment/MainnetRefundLifecycle.js";
import { MainnetWalletPoolRegistry } from "../wallet/MainnetWalletPoolRegistry.js";

const NOW = 1_800_000_000_000;
const SOURCE = `0:${"a".repeat(64)}`;
const PAYER = index => `0:${String(index + 1).padStart(64, "0")}`;

function createIncomingLedger(roomId, count, wallet) {
    const intents = Array.from({ length: 3 }, (_, index) => ({
        paymentReference: `page4-ref-${roomId}-${index}`,
        roomId,
        playerId: `player-${index}`,
        destinationWalletId: wallet.walletId,
        destinationWalletAddress: wallet.address,
        expectedSender: PAYER(index),
        amountAtomic: "1000000000",
        state: index < count ? "SETTLED" : "PENDING",
        confirmedTransactionId: index < count ? `incoming-${roomId}-${index}` : null
    }));
    const receipts = intents.slice(0, count).map((intent, index) => ({
        network: "mainnet", globalId: -239, status: "CONFIRMED", roomId,
        transactionId: intent.confirmedTransactionId,
        paymentReference: intent.paymentReference,
        playerId: intent.playerId,
        amountAtomic: intent.amountAtomic,
        sourceAddress: intent.expectedSender,
        destinationAddress: wallet.address
    }));
    return {
        network: "mainnet", globalId: -239,
        listReceipts: id => id === roomId ? receipts : [],
        listRoomIntents: id => id === roomId ? intents : []
    };
}

function createRoomManager() {
    const logger = { info() {}, warn() {}, error() {}, decisionTrace() {} };
    const eventBus = new EventBus({ logger, eventBusConfig: { logEvents: false, showDebugPanel: false } });
    eventBus.initialize();
    const manager = new RoomManager({ logger, eventBus, roomConfig: { maxPlayers: 3 } });
    manager.initialize();
    manager.attachSetupSessionLifecycle({ createForRoom: () => ({}), abortForRoom() {} });
    return { manager, eventBus };
}

function financialHarness(t) {
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-mainnet-room-close-"));
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    const walletCatalog = JSON.stringify(Array.from({ length: 64 }, (_, index) => ({
        walletId: `mainnet-wallet-${index + 1}`, roomNumber: index + 1,
        address: `0:${String(index + 10).padStart(64, "0")}`, network: "mainnet"
    })));
    const config = loadMainnetRuntimeConfig({ TON_NETWORK: "mainnet",
        MAINNET_TONCENTER_API_KEY: "offline-test-key", MAINNET_ROOM_WALLET_DATA_DIR: dataDir,
        MAINNET_ROOM_WALLETS_JSON: walletCatalog });
    const financialLedger = new MainnetFinancialLedger({ config, nowProvider: () => NOW }).initialize();
    const walletPool = new MainnetWalletPoolRegistry({ config });
    walletPool.initialize({ snapshotDir: join(dataDir, "wallet-registry") });
    return { dataDir, config, financialLedger, walletPool };
}

function lifecycleFor(h, incomingLedger, page5Reached, reservedWalletRoomNumberResolver = () => 31) {
    const lifecycle = new MainnetRefundLifecycle({
        financialLedger: h.financialLedger,
        incomingLedger,
        adapter: { async sendTransfer() { throw new Error("no transfer expected"); },
            async estimateOutboundTransferFee() { throw new Error("no fee quote expected"); } },
        outgoingObserver: { async findOutgoingTransfer() {}, async verifyIndexedRecipientCredit() {} },
        nowProvider: () => NOW
    });
    lifecycle.configurePage5StateResolver(() => page5Reached);
    lifecycle.configureReservedWalletRoomNumberResolver(reservedWalletRoomNumberResolver);
    return lifecycle;
}

test("RoomManager closure creates exactly the confirmed Mainnet refunds and restart restores them", t => {
    for (const confirmedCount of [0, 1, 2]) {
        const h = financialHarness(t);
        const { manager, eventBus } = createRoomManager();
        const room = manager.createRoom();
        assert.ok(room);
        for (let index = 0; index < 3; index += 1) manager.addPlayer(room.roomId, `player-${index}`);
        const reservedWalletRoomNumber = room.roomNumber + 20;
        const wallet = h.walletPool.getWalletByRoomNumber(reservedWalletRoomNumber);
        h.walletPool.reserve({ roomId: room.roomId, network: "mainnet", walletId: wallet.walletId, now: NOW });
        const incoming = createIncomingLedger(room.roomId, confirmedCount, wallet);
        const lifecycle = lifecycleFor(h, incoming, false,
            roomId => h.walletPool.getReservationForRoom(roomId)?.roomNumber ?? null);
        manager.attachRefundLifecycle(lifecycle);

        assert.equal(manager.destroyRoom(room.roomId), true);
        const obligations = h.financialLedger.listRefunds(room.roomId);
        assert.equal(obligations.length, confirmedCount, `${confirmedCount}/3 confirmed`);
        assert.ok(obligations.every(item => item.roomNumber === reservedWalletRoomNumber
            && item.sourceWalletAddress === wallet.address && item.network === "mainnet" && item.globalId === -239));
        assert.equal(h.walletPool.getReservationForRoom(room.roomId)?.walletId, wallet.walletId,
            "room closure leaves the wallet reservation intact");

        const replay = lifecycle.prepareClosedRoom({ roomId: room.roomId, roomNumber: room.roomNumber,
            closureReason: "retry", prePage5: true });
        assert.equal(replay.length, confirmedCount);
        assert.ok(replay.every(item => item.replay));

        const restoredLedger = new MainnetFinancialLedger({ config: h.config }).initialize();
        assert.equal(restoredLedger.listRefunds(room.roomId).length, confirmedCount);
        assert.equal(lifecycleFor({ ...h, financialLedger: restoredLedger }, incoming, false)
            .recover().length, confirmedCount);
        manager.shutdown();
        eventBus.shutdown();
    }
});

test("closing after authoritative OPEN_PAGE5 creates no refund outcome", t => {
    const h = financialHarness(t);
    const { manager, eventBus } = createRoomManager();
    const room = manager.createRoom();
    assert.ok(room);
    for (let index = 0; index < 3; index += 1) manager.addPlayer(room.roomId, `player-${index}`);
    const incoming = createIncomingLedger(room.roomId, 3, { walletId: "synthetic-post-page5", address: SOURCE });
    h.financialLedger.recordPage5Started(room.roomId);
    assert.equal(h.financialLedger.recordPage5Started(room.roomId).replay, true);
    // Simulate SESSION_FINISHED clearing the volatile GameStartAuthorization
    // map before RoomManager destroys the lingering Page6 room.
    manager.attachRefundLifecycle(lifecycleFor(h, incoming, false));

    assert.equal(manager.destroyRoom(room.roomId), true);
    const restored = new MainnetFinancialLedger({ config: h.config }).initialize();
    assert.equal(restored.hasPage5Started(room.roomId), true);
    assert.equal(restored.listRefunds(room.roomId).length, 0);
    assert.deepEqual(h.financialLedger.listRefunds(room.roomId), []);
    // The room remains eligible for its later Page6 payout plan.
    const payout = h.financialLedger.createPayout({
        payoutId: "payout_after_page5_close", roomId: room.roomId,
        roomNumber: room.roomNumber, sourceWalletAddress: SOURCE, principalAtomic: 3_000_000_000,
        winner: { recipientId: "winner", address: `0:${"b".repeat(64)}` },
        owner: { recipientId: "owner", address: `0:${"c".repeat(64)}` }
    });
    assert.equal(payout.roomId, room.roomId);
    manager.shutdown();
    eventBus.shutdown();
});

test("confirmed Mainnet payment fails closed when its reserved wallet number is unknown", t => {
    const h = financialHarness(t);
    const { manager, eventBus } = createRoomManager();
    const room = manager.createRoom();
    assert.ok(room);
    const incoming = createIncomingLedger(room.roomId, 1, { walletId: "unreserved-wallet", address: SOURCE });
    const lifecycle = lifecycleFor(h, incoming, false, () => null);
    manager.attachRefundLifecycle(lifecycle);

    assert.equal(manager.destroyRoom(room.roomId), false);
    assert.equal(manager.getRoom(room.roomId)?.status, "DESTROYED");
    assert.deepEqual(h.financialLedger.listRefunds(room.roomId), []);
    lifecycle.configureReservedWalletRoomNumberResolver(() => 52);
    assert.equal(manager.destroyRoom(room.roomId), true);
    assert.equal(h.financialLedger.listRefunds(room.roomId).length, 1);
    assert.equal(h.financialLedger.listRefunds(room.roomId)[0].roomNumber, 52);
    manager.shutdown();
    eventBus.shutdown();
});

test("Mainnet refund closure hook does not alter the Testnet runtime binding", () => {
    const app = readFileSync(new URL("../../app.js", import.meta.url), "utf8");
    const mainnet = app.indexOf('if (paymentMode === "mainnet")');
    const testnet = app.indexOf("} else {", mainnet);
    assert.ok(mainnet >= 0 && testnet > mainnet);
    assert.match(app.slice(mainnet, testnet), /attachRefundLifecycle\(/);
    assert.doesNotMatch(app.slice(testnet, testnet + 1800), /attachRefundLifecycle\(/);
});
