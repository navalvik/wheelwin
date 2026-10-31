import assert from "node:assert/strict";
import { RecoveryEngine } from "../engines/RecoveryEngine.js";
import { RecoverySnapshotCache } from "../gameplay/RecoverySnapshotCache.js";
import { RecoveryCheckpointManager } from "../recovery/RecoveryCheckpointManager.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";

/**
 * ROOM Dgvu regression: the native TON runtime deliberately does not
 * inject the removed legacy PaymentEngine into RecoveryEngine.
 * A RESULT snapshot must nevertheless be captured and stamped for Page6.
 *
 * A separate failure in RecoveryCheckpointManager referenced an unimported
 * computePayloadChecksum, preventing terminal recovery data persistence.
 * This test exercises that code path without invoking chain or payout logic.
 */
const gameId = "dgvu-regression-game";
const roomId = "dgvu-regression-room";
const playerId = "dgvu-regression-player";
const expiresAt = 1234567890123;

const config = {
    gameId,
    traceSeed: "dgvu-regression-seed",
    configurationVersion: 1,
    metadata: { roomId },
    players: [{ playerId }]
};
const logger = {
    info() {},
    warn() {},
    error() {}
};
const eventBus = {
    subscribe() {},
    unsubscribe() {},
    emit() {}
};
const gameStateEngine = {
    getState: () => GAME_STATES.RESULT,
    getDebugSnapshot: () => ({ previousState: GAME_STATES.BRAKE }),
    getHistory: () => []
};
const physicsEngine = {
    getSimulation: () => ({
        runtime: {
            angle: 1,
            triangleAngle: 2,
            angularVelocity: 0,
            triangleAngularVelocity: 0,
            angularAcceleration: 0,
            selfTestActive: false,
            speedActive: false,
            brakeActive: false,
            brakeDurationMs: 1000,
            brakeElapsedMs: 1000,
            state: "STOPPED"
        }
    })
};
const recoveryEngine = new RecoveryEngine({
    logger,
    eventBus,
    gameCatalog: {
        getInputRules: () => ({ maxPressCycles: 3 }),
        getCatalogVersion: () => "test"
    },
    configurationEngine: { getConfiguration: () => config },
    gameStateEngine,
    gameClock: {
        getClock: () => ({ currentPhase: GAME_STATES.RESULT, startedAt: 1 }),
        getElapsed: () => 0,
        getRemaining: () => 0
    },
    physicsEngine,
    inputAuthority: {
        hasGame: () => true,
        getAcceptedCommands: () => [],
        getPlayerInputState: (_, id) => ({ playerId: id, pressCount: 0 })
    },
    winnerEngine: { getResult: () => ({ winningPlayerId: playerId }) }
    // Deliberately no legacy paymentEngine.
});
recoveryEngine.initialize();

const snapshot = recoveryEngine.buildRecoverySnapshot(gameId);
assert.equal(snapshot.gameState.currentState, GAME_STATES.RESULT);
assert.equal(snapshot.payment, null);
assert.equal(snapshot.winner.winningPlayerId, playerId);

const cache = new RecoverySnapshotCache({
    logger,
    eventBus,
    recoveryEngine,
    resultSessionLifecycle: {
        getSession: () => ({ roomId, gameId, expiresAt })
    }
});
cache._handleGameStateChanged({
    gameId,
    currentState: GAME_STATES.RESULT
});
assert.ok(cache.get(gameId)?.snapshot, "RESULT snapshot must be cached without legacy PaymentEngine");

cache._handleOpenPage6({ gameId, roomId });
await Promise.resolve();
const retained = cache.get(gameId);
assert.equal(retained.page6Opened, true, "OPEN_PAGE6 authority must survive gameplay teardown");
assert.equal(retained.resultSessionExpiresAt, expiresAt);

const checkpoints = new RecoveryCheckpointManager({
    logger,
    recoveryDataPersistence: {
        loadRecoveryRecord: () => null,
        createRecoveryRecord() {}
    },
    gameManager: { getGame: () => ({ gameId, roomId }) },
    gameStateEngine,
    configurationEngine: { getConfiguration: () => config },
    roomManager: { getRoom: () => null }
});
const checkpointAttempt = checkpoints.checkpoint(gameId, GAME_STATES.RESULT);
assert.notEqual(checkpointAttempt.status, "failed",
    "Checkpoint must not throw ReferenceError for unimported checksum helper");
assert.equal(checkpointAttempt.status, "skipped",
    "Incomplete mock room should skip after successfully computing configuration checksum");
assert.notEqual(checkpointAttempt.reason, "exception:computePayloadChecksum is not defined");

recoveryEngine.shutdown();
console.log("Dgvu recovery snapshot and checkpoint checksum regressions passed");
