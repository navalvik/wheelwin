import assert from "node:assert/strict";

import { buildGameStateSyncPayload } from "../socket/gameplayGameStateProtocol.js";
import { buildClientRecoveryPayload } from "../socket/gameplayRecoveryProtocol.js";
import { buildPhysicsSyncPayload } from "../socket/gameplayPhysicsProtocol.js";

const liveState = buildGameStateSyncPayload({
    gameId: "game-sync-metadata",
    currentState: "BRAKE",
    previousState: "SPEED",
    timestamp: 12345,
    revision: 5
});
assert.equal(liveState.revision, 5);
assert.equal(liveState.gameId, "game-sync-metadata");

const physics = buildPhysicsSyncPayload({
    gameId: "game-sync-metadata",
    timestamp: 4321,
    angle: 1.25
});
assert.equal(physics.simulationTimeMs, 4321);
assert.equal(physics.simulationTime, 4321);

const recovery = buildClientRecoveryPayload({
    playerId: "player-1",
    roomId: "room-1",
    snapshot: {
        gameId: "game-sync-metadata",
        gameState: {
            currentState: "BRAKE",
            revision: 5,
            history: [{ state: "READY" }, { state: "BRAKE" }]
        },
        physics: {
            angle: 0.25,
            snapshot: {
                runtime: { simulationTimeMs: 4321 }
            }
        }
    }
});
assert.equal(recovery.gameStateRevision, 5);
assert.equal(recovery.physics.simulationTimeMs, 4321);
assert.equal(recovery.gameState, "BRAKE");

console.log("gameplaySyncMonotonicMetadata.test.js: all assertions passed");
