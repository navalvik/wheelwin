import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GAME_STATES } from "../engines/gameState/GameStates.js";
import { RecoveryDataPersistence } from "../persistence/RecoveryDataPersistence.js";
import { RecoveryCheckpointManager } from "../recovery/RecoveryCheckpointManager.js";
import { computeConfigurationHash } from "../recovery/configurationHash.js";

const gameId = "checkpoint-writer-lifecycle-game";
const roomId = "checkpoint-writer-lifecycle-room";
const players = [0, 1, 2].map((playerIndex) => ({
    playerId: `player-${playerIndex}`,
    playerIndex,
    nickname: `Player ${playerIndex}`,
    sectorCount: 3,
    color: "blue",
    colorSector2: "red",
    icon: "wheel",
    sectorArrangement: [0, 1, 2],
    age: 18
}));
const configuration = { gameId, metadata: { roomId } };
const logger = { info() {}, warn() {}, error() {} };
const persistence = new RecoveryDataPersistence({
    dataDir: mkdtempSync(join(tmpdir(), "wheelwin-checkpoint-writer-")),
    logger
});
const writer = Object.create(RecoveryCheckpointManager.prototype);
writer._recoveryDataPersistence = persistence;
writer._logger = logger;

function payload(gameState, overrides = {}) {
    return {
        recoveryContractVersion: 1,
        recoveryRecordId: gameId,
        roomId,
        gameId,
        gameMode: "FRIENDS",
        configuration,
        configurationHash: computeConfigurationHash(configuration),
        configurationVersion: 1,
        traceSeed: "checkpoint-writer-test",
        gameState,
        gameStatus: gameState === GAME_STATES.RESULT ? "COMPLETED" : "RUNNING",
        serverTimestampAtCheckpoint: Date.now(),
        players,
        phaseStartedAt: 100,
        clockStartedAt: 100,
        clockPaused: false,
        clockTotalPausedMs: 0,
        awaitingResultActivation: false,
        resultPhaseStarted: gameState === GAME_STATES.RESULT,
        winnerId: gameState === GAME_STATES.RESULT ? "player-1" : null,
        physicsFinalAngle: gameState === GAME_STATES.RESULT ? 1.25 : null,
        physicsFinalTriangleAngle: gameState === GAME_STATES.RESULT ? 2.5 : null,
        physicsSimulationState: gameState === GAME_STATES.RESULT ? "STOPPED" : "CREATED",
        ...overrides
    };
}

const created = writer._persistCheckpoint(
    gameId,
    GAME_STATES.PRE_GAME_READY,
    1,
    payload(GAME_STATES.PRE_GAME_READY)
);
assert.equal(created.status, "created", "CREATE checkpoint must persist");

const updated = writer._persistCheckpoint(
    gameId,
    GAME_STATES.READY,
    2,
    payload(GAME_STATES.READY, { serverTimestampAtCheckpoint: Date.now() + 1 })
);
assert.equal(updated.status, "updated", "UPDATE checkpoint must advance the record");
assert.equal(
    persistence.loadRecoveryRecord(gameId).payload.gameState,
    GAME_STATES.READY
);

const terminalPayload = payload(GAME_STATES.RESULT);
const terminal = writer._persistCheckpoint(
    gameId,
    GAME_STATES.RESULT,
    3,
    terminalPayload
);
assert.equal(terminal.status, "updated", "RESULT must persist as terminal");

const savedTerminal = persistence.loadRecoveryRecord(gameId);
assert.equal(savedTerminal.status, "TERMINAL");
assert.equal(savedTerminal.immutable, true);
assert.equal(savedTerminal.payload.gameState, GAME_STATES.RESULT);
assert.deepEqual(persistence.validateRecoveryRecord(savedTerminal), {
    valid: true,
    errors: []
});

const repeatedTerminal = writer._persistCheckpoint(
    gameId,
    GAME_STATES.RESULT,
    3,
    payload(GAME_STATES.RESULT, { serverTimestampAtCheckpoint: Date.now() + 2 })
);
assert.equal(repeatedTerminal.status, "updated");
assert.equal(repeatedTerminal.reason, "terminal_idempotent_noop");

const changedTerminal = writer._persistCheckpoint(
    gameId,
    GAME_STATES.RESULT,
    3,
    payload(GAME_STATES.RESULT, { physicsFinalAngle: 99 })
);
assert.equal(changedTerminal.status, "conflict");
assert.equal(changedTerminal.reason, "terminal_record_conflict_no_overwrite");
assert.equal(
    persistence.loadRecoveryRecord(gameId).payload.physicsFinalAngle,
    terminalPayload.physicsFinalAngle,
    "a conflicting RESULT must not overwrite the terminal checkpoint"
);

console.log("RecoveryCheckpointManager CREATE → UPDATE → RESULT regression passed");
