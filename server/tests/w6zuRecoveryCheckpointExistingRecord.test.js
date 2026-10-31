import assert from "node:assert/strict";
import { RecoveryCheckpointManager } from "../recovery/RecoveryCheckpointManager.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";

/**
 * W6Zu incident: after the checksum import fix, RESULT checkpointing with an
 * existing ACTIVE recovery record raised ReferenceError because the terminal
 * status constant was not imported. This exercises the actual existing-record
 * branch without touching game, wallet, payout or blockchain operations.
 */
const gameId = "game-w6zu-checkpoint";
const roomId = "room-w6zu-checkpoint";
const payload = {
    recoveryRecordId: gameId,
    gameId,
    roomId,
    gameMode: "FRIENDS",
    configurationHash: "valid-hash",
    players: [
        { playerId: "Olga" },
        { playerId: "Lena" },
        { playerId: "Bob" }
    ],
    gameState: GAME_STATES.RESULT,
    physicsSimulationState: "STOPPED",
    physicsFinalAngle: 1.25,
    physicsFinalTriangleAngle: 2.5,
    winnerId: "Bob"
};
let existing = {
    status: "ACTIVE",
    immutable: false,
    version: 1,
    payload: {
        ...payload,
        gameState: GAME_STATES.READY
    }
};
let writes = 0;
const manager = new RecoveryCheckpointManager({
    logger: { info() {}, warn() {}, error() {} },
    recoveryDataPersistence: {
        loadRecoveryRecord: () => existing,
        createRecoveryRecord() {
            throw new Error("Existing record must not be recreated");
        },
        updateRecoveryRecord(id, next, metadata) {
            assert.equal(id, gameId);
            assert.deepEqual(next, payload);
            assert.equal(metadata.expectedVersion, 1);
            assert.equal(metadata.status, "TERMINAL");
            writes += 1;
        }
    }
});
const updated = manager._persistCheckpoint(gameId, GAME_STATES.RESULT, 3, payload);
assert.equal(updated.status, "updated", "Existing ACTIVE record must update to RESULT");
assert.equal(writes, 1);
existing = { status: "TERMINAL", immutable: true, version: 2, payload };
const repeated = manager._persistCheckpoint(gameId, GAME_STATES.RESULT, 3, payload);
assert.equal(repeated.status, "updated", "Repeated terminal RESULT must be idempotent");
assert.equal(repeated.reason, "terminal_idempotent_noop");
assert.equal(writes, 1, "Must not rewrite immutable terminal record");
const stale = manager._persistCheckpoint(gameId, GAME_STATES.READY, 2, payload);
assert.equal(stale.status, "skipped", "Stale READY must not overwrite terminal RESULT");
assert.equal(writes, 1);
const conflict = manager._persistCheckpoint(gameId, GAME_STATES.RESULT, 3, {
    ...payload,
    physicsFinalAngle: 99
});
assert.equal(conflict.status, "conflict", "Changed outcome must not overwrite terminal RESULT");
assert.equal(writes, 1);
console.log("W6Zu terminal checkpoint regression passed");
