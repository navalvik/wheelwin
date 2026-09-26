import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventBus } from "../events/EventBus.js";
import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import {
    LIFECYCLE_RESULTS,
    SessionHistoryArchiveManager
} from "../history/SessionHistoryArchiveManager.js";
import { LoggingManager } from "../logging/LoggingManager.js";
import { LOG_LEVELS } from "../logging/levels.js";
import { LoggerService } from "../services/LoggerService.js";

SessionHistoryArchiveManager.resetForTests();
LoggingManager.resetForTests();

const directory = mkdtempSync(join(tmpdir(), "wheelwin-history-"));
const loggingManager = LoggingManager.getInstance();

loggingManager.initialize({
    level: LOG_LEVELS.INFO,
    enableConsole: false,
    enableFile: false,
    format: "console"
});

const logger = new LoggerService({ loggingManager });
logger.initialize();

const eventBus = new EventBus({
    logger,
    eventBusConfig: { logEvents: false, showDebugPanel: false }
});
eventBus.initialize();

const archive = SessionHistoryArchiveManager.getInstance();
archive.initialize({
    eventBus,
    directory,
    projectionService: { buildRoomDetail: () => null },
    roomLobbyBridge: { getTonConnectDiagnostics: () => null },
    playerManager: { getPlayer: () => null }
});

function emit(type, payload) {
    eventBus.emit({
        source: EVENT_SOURCES.ROOM_MANAGER,
        type,
        payload
    });
}

// Setup-expiry archive.
emit(EVENT_TYPES.ROOM_CREATED, { roomId: "ROOM_SETUP", createdAt: Date.now() - 5000 });
emit(EVENT_TYPES.SETUP_SESSION_STARTED, { roomId: "ROOM_SETUP" });
emit(EVENT_TYPES.SETUP_SESSION_EXPIRED, { roomId: "ROOM_SETUP" });
emit(EVENT_TYPES.ROOM_DESTROYED, { roomId: "ROOM_SETUP", playerCount: 0 });

let listed = archive.listRecords({ roomId: "ROOM_SETUP" });
assert.equal(listed.total, 1);
let record = archive.getRecord(listed.records[0].sessionId);
assert.equal(record.lifecycleResult, LIFECYCLE_RESULTS.SETUP_EXPIRED);
assert.ok(record.downloadFilename.includes("SETUP_EXPIRED"));
assert.ok(record.blockchainLifecycle.settlement);
assert.ok(record.blockchainLifecycle.paymentConfirmation);
assert.equal(record.blockchainLifecycle.paymentConfirmation.events.length, 0);

// Completed game archive: Room Wallet payment evidence + settlement evidence.
emit(EVENT_TYPES.ROOM_CREATED, { roomId: "ROOM_WALLET", createdAt: Date.now() - 3000 });
emit(EVENT_TYPES.GAME_CREATED, { roomId: "ROOM_WALLET", gameId: "game_wallet_1" });

for (const [playerIndex, paidMask] of [[0, 1], [1, 3], [2, 7]]) {
    const playerId = `p${playerIndex}`;
    emit(EVENT_TYPES.PAYMENT_TRANSACTION_CONFIRMED, {
        roomId: "ROOM_WALLET",
        gameId: "game_wallet_1",
        playerId,
        playerIndex,
        transactionId: `tx_${playerIndex}`,
        paymentReference: `ref_${playerIndex}`,
        amount: 1,
        expectedGram: 1,
        sender: `EQSender${playerIndex}`,
        paidMask,
        paidMaskBit: 1 << playerIndex,
        timestamp: Date.now()
    });
    emit(EVENT_TYPES.PAYMENT_BLOCKCHAIN_CONFIRMED, {
        roomId: "ROOM_WALLET",
        gameId: "game_wallet_1",
        playerId,
        playerIndex,
        txHash: `tx_${playerIndex}`,
        paymentReference: `ref_${playerIndex}`,
        amount: 1,
        expectedGram: 1,
        sender: `EQSender${playerIndex}`,
        paidMask,
        paidMaskBit: 1 << playerIndex,
        confirmedAt: Date.now()
    });
}

emit(EVENT_TYPES.SETTLEMENT_STARTED, {
    roomId: "ROOM_WALLET",
    gameId: "game_wallet_1",
    winnerWallet: "EQWinnerWallet",
    winnerAmount: 2.85,
    organizerAmount: 0.15
});
emit(EVENT_TYPES.SETTLEMENT_SUBMITTED, {
    roomId: "ROOM_WALLET",
    gameId: "game_wallet_1",
    status: "PREPARING"
});
emit(EVENT_TYPES.SETTLEMENT_CONFIRMED, {
    roomId: "ROOM_WALLET",
    gameId: "game_wallet_1",
    transactionHash: "settle_tx_abc"
});
emit(EVENT_TYPES.SETTLEMENT_COMPLETED, {
    roomId: "ROOM_WALLET",
    gameId: "game_wallet_1",
    winnerAmount: 2.85,
    organizerAmount: 0.15,
    settlementTxHash: "settle_tx_abc"
});
emit(EVENT_TYPES.SESSION_FINISHED, {
    roomId: "ROOM_WALLET",
    gameId: "game_wallet_1",
    reason: "session_ended"
});
emit(EVENT_TYPES.ROOM_DESTROYED, { roomId: "ROOM_WALLET", playerCount: 3 });

listed = archive.listRecords({ roomId: "ROOM_WALLET" });
assert.equal(listed.total, 1);
record = archive.getRecord(listed.records[0].sessionId);
assert.equal(listed.records[0].lifecycleResult, LIFECYCLE_RESULTS.GAME_COMPLETED);

const lifecycle = record.blockchainLifecycle;
assert.equal(lifecycle.settlement.status, "SETTLEMENT_COMPLETED");
assert.equal(lifecycle.settlement.winnerWallet, "EQWinnerWallet");
assert.equal(lifecycle.settlement.winnerAmount, 2.85);
assert.equal(lifecycle.settlement.commissionAmount, 0.15);
assert.equal(lifecycle.settlement.transactionHash, "settle_tx_abc");
assert.equal(lifecycle.paymentConfirmation.paidMask, 7);
assert.equal(lifecycle.paymentConfirmation.events.length, 6);
assert.ok(lifecycle.paymentConfirmation.events.every((event) => !("contractAddress" in event)));
assert.ok(!JSON.stringify(record).includes("GameEscrow"));
assert.ok(!JSON.stringify(record).includes("contractAddress"));
assert.ok(!JSON.stringify(record).includes("tonDeployDebug"));

const download = archive.getDownloadBuffer(listed.records[0].sessionId);
assert.ok(download?.buffer?.length > 0);

archive.shutdown();
eventBus.shutdown();
logger.shutdown();
SessionHistoryArchiveManager.resetForTests();
LoggingManager.resetForTests();
rmSync(directory, { recursive: true, force: true });

console.log("sessionHistoryArchive.test.js: all assertions passed");
