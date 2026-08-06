import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    beginTonDeployDebug,
    pushTonDeployDebugStage,
    resetTonDeployDebugForTests
} from "../diagnostics/DeployPipelineForensics.js";
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
resetTonDeployDebugForTests();

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
    projectionService: {
        buildRoomDetail: () => null
    },
    roomLobbyBridge: {
        getTonConnectDiagnostics: () => null
    },
    playerManager: {
        getPlayer: () => null
    }
});

function emit(type, payload) {

    eventBus.emit({
        source: EVENT_SOURCES.ROOM_MANAGER,
        type,
        payload
    });

}

emit(EVENT_TYPES.ROOM_CREATED, {
    roomId: "ROOMTEST1",
    createdAt: Date.now() - 5000
});

emit(EVENT_TYPES.SETUP_SESSION_STARTED, { roomId: "ROOMTEST1" });

emit(EVENT_TYPES.SETUP_SESSION_EXPIRED, { roomId: "ROOMTEST1" });

emit(EVENT_TYPES.ROOM_DESTROYED, { roomId: "ROOMTEST1", playerCount: 0 });

const listed = archive.listRecords({ roomId: "ROOMTEST1" });

assert.equal(listed.total, 1, "one archived record");
assert.equal(
    listed.records[0].lifecycleResult,
    LIFECYCLE_RESULTS.SETUP_EXPIRED,
    "setup expiry maps to SETUP_EXPIRED"
);

const full = archive.getRecord(listed.records[0].sessionId);

assert.ok(full, "full record readable");
assert.equal(full.lifecycleResult, LIFECYCLE_RESULTS.SETUP_EXPIRED);
assert.ok(Array.isArray(full.timeline) && full.timeline.length > 0);
assert.ok(full.downloadFilename.includes("SETUP_EXPIRED"));
assert.ok(full.downloadFilename.includes("NO_GAME"));
assert.equal(full.tonDeployDebug, null, "no deploy debug without attempt");

const download = archive.getDownloadBuffer(listed.records[0].sessionId);

assert.ok(download?.buffer?.length > 0, "download buffer present");

// R7.51.30 — tonDeployDebug must land in ROOM_DESTROYED JSON for matching room.
beginTonDeployDebug({
    roomId: "ROOMDEPLOY",
    gameId: "game_deploy",
    escrowAddress: "EQescrow",
    valueTon: "0.05"
});
pushTonDeployDebugStage("WALLET_CREATED", {
    deployerAddress: "EQdeployer",
    deployerWalletId: 698983191
});
pushTonDeployDebugStage("SEQNO_READ", { seqno: 1 });
pushTonDeployDebugStage("FAILED", {
    errorName: "Error",
    errorMessage: "TonCenter HTTP 500",
    tonCenterStatus: 500,
    tonCenterResponse: "{\"ok\":false,\"error\":\"Failed to unpack Message\",\"code\":500}",
    tonCenterEndpoint: "https://testnet.toncenter.com/api/v2/jsonRPC"
});

emit(EVENT_TYPES.ROOM_CREATED, {
    roomId: "ROOMDEPLOY",
    createdAt: Date.now() - 1000
});

emit(EVENT_TYPES.ROOM_DESTROYED, { roomId: "ROOMDEPLOY", playerCount: 3 });

const deployListed = archive.listRecords({ roomId: "ROOMDEPLOY" });

assert.equal(deployListed.total, 1, "deploy room archived");

const deployRecord = archive.getRecord(deployListed.records[0].sessionId);

assert.ok(deployRecord.tonDeployDebug, "tonDeployDebug present on record");
assert.equal(deployRecord.tonDeployDebug.roomId, "ROOMDEPLOY");
assert.equal(deployRecord.tonDeployDebug.seqno, 1);
assert.equal(deployRecord.tonDeployDebug.errorMessage, "TonCenter HTTP 500");
assert.equal(deployRecord.tonDeployDebug.tonCenterStatus, 500);
assert.match(
    deployRecord.tonDeployDebug.tonCenterResponse,
    /Failed to unpack Message/
);
assert.equal(
    deployRecord.finalSnapshot?.tonDeployDebug?.currentStage,
    "FAILED",
    "finalSnapshot includes tonDeployDebug"
);
assert.ok(
    !JSON.stringify(deployRecord).includes("mnemonic"),
    "no mnemonic in archive JSON"
);

// R7.57 — unified blockchainLifecycle from deploy debug + settlement events.
assert.ok(deployRecord.blockchainLifecycle, "blockchainLifecycle present");
assert.ok(
    deployRecord.blockchainLifecycle.deploy.stages.includes("BEGIN_DEPLOY"),
    "deploy stages include BEGIN_DEPLOY"
);
assert.ok(
    deployRecord.blockchainLifecycle.deploy.stages.includes("FAILED"),
    "deploy stages include FAILED from tonDeployDebug"
);
assert.ok(
    deployRecord.blockchainLifecycle.deploy.stages.includes("DEPLOY_RESULT"),
    "deploy stages include DEPLOY_RESULT"
);
assert.equal(deployRecord.blockchainLifecycle.deploy.status, "FAILED");
assert.equal(
    deployRecord.blockchainLifecycle.deploy.error,
    "TonCenter HTTP 500"
);
assert.equal(
    deployRecord.finalSnapshot?.blockchainLifecycle?.deploy?.status,
    "FAILED"
);

resetTonDeployDebugForTests();

emit(EVENT_TYPES.ROOM_CREATED, {
    roomId: "ROOMCHAIN",
    createdAt: Date.now() - 2000
});

emit(EVENT_TYPES.GAME_CREATED, {
    roomId: "ROOMCHAIN",
    gameId: "game_chain_1"
});

beginTonDeployDebug({
    roomId: "ROOMCHAIN",
    gameId: "game_chain_1",
    escrowAddress: "EQLifecycleEscrow",
    valueTon: "0.05"
});
pushTonDeployDebugStage("BOC_SEND_START");
pushTonDeployDebugStage("BOC_SEND_SUCCESS");

emit(EVENT_TYPES.CONTRACT_DEPLOYING, {
    roomId: "ROOMCHAIN",
    gameId: "game_chain_1",
    contractId: "c1"
});

emit(EVENT_TYPES.GAME_CONTRACT_DEPLOYED, {
    roomId: "ROOMCHAIN",
    gameId: "game_chain_1",
    contractId: "c1",
    contractAddress: "EQLifecycleEscrow",
    deploymentTxId: "ton_oracle_seq_1"
});

emit(EVENT_TYPES.SETTLEMENT_STARTED, {
    roomId: "ROOMCHAIN",
    gameId: "game_chain_1",
    winnerWallet: "EQWinnerWallet",
    winnerAmount: 2.85,
    organizerAmount: 0.15
});

emit(EVENT_TYPES.SETTLEMENT_SUBMITTED, {
    roomId: "ROOMCHAIN",
    gameId: "game_chain_1",
    status: "PREPARING"
});

emit(EVENT_TYPES.SETTLEMENT_CONFIRMED, {
    roomId: "ROOMCHAIN",
    gameId: "game_chain_1",
    transactionHash: "settle_tx_abc"
});

emit(EVENT_TYPES.SETTLEMENT_COMPLETED, {
    roomId: "ROOMCHAIN",
    gameId: "game_chain_1",
    winnerAmount: 2.85,
    organizerAmount: 0.15,
    settlementTxHash: "settle_tx_abc"
});

emit(EVENT_TYPES.SESSION_FINISHED, {
    roomId: "ROOMCHAIN",
    gameId: "game_chain_1",
    reason: "session_ended"
});

emit(EVENT_TYPES.ROOM_DESTROYED, { roomId: "ROOMCHAIN", playerCount: 3 });

const chainListed = archive.listRecords({ roomId: "ROOMCHAIN" });

assert.equal(chainListed.total, 1, "lifecycle room archived");

const chainRecord = archive.getRecord(chainListed.records[0].sessionId);
const lifecycle = chainRecord.blockchainLifecycle;

assert.equal(
    chainListed.records[0].lifecycleResult,
    LIFECYCLE_RESULTS.GAME_COMPLETED,
    "full game maps to GAME_COMPLETED"
);

assert.ok(lifecycle.deploy.stages.includes("BEGIN_DEPLOY"));
assert.ok(lifecycle.deploy.stages.includes("BOC_SEND_START"));
assert.ok(lifecycle.deploy.stages.includes("BOC_SEND_SUCCESS"));
assert.ok(lifecycle.deploy.stages.includes("DEPLOY_RESULT"));
assert.equal(lifecycle.deploy.status, "SUCCESS");
assert.equal(lifecycle.deploy.contractAddress, "EQLifecycleEscrow");
assert.equal(lifecycle.deploy.transactionHash, "ton_oracle_seq_1");

assert.ok(lifecycle.settlement.stages.includes("SETTLEMENT_STARTED"));
assert.ok(lifecycle.settlement.stages.includes("SETTLEMENT_SUBMITTED"));
assert.ok(lifecycle.settlement.stages.includes("SETTLEMENT_CONFIRMED"));
assert.ok(lifecycle.settlement.stages.includes("SETTLEMENT_COMPLETED"));
assert.equal(lifecycle.settlement.status, "SETTLEMENT_COMPLETED");
assert.equal(lifecycle.settlement.winnerWallet, "EQWinnerWallet");
assert.equal(lifecycle.settlement.winnerAmount, 2.85);
assert.equal(lifecycle.settlement.commissionAmount, 0.15);
assert.equal(lifecycle.settlement.transactionHash, "settle_tx_abc");
assert.equal(lifecycle.settlement.error, null);

assert.ok(
    !JSON.stringify(chainRecord).includes("mnemonic"),
    "no mnemonic in R7.57 archive JSON"
);
assert.ok(
    !JSON.stringify(chainRecord).toLowerCase().includes("secretkey"),
    "no secretKey in R7.57 archive JSON"
);

archive.shutdown();
eventBus.shutdown();
logger.shutdown();
SessionHistoryArchiveManager.resetForTests();
LoggingManager.resetForTests();
resetTonDeployDebugForTests();
rmSync(directory, { recursive: true, force: true });

console.log("sessionHistoryArchive.test.js: all assertions passed");
