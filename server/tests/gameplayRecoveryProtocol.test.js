import assert from "node:assert/strict";

import { resolveRecoveryRoute } from "../socket/gameplayRecoveryProtocol.js";

const activeGameplay = resolveRecoveryRoute({
    setupActive: true,
    gameId: "game-live",
    gameState: "SPEED"
});

assert.equal(activeGameplay.route, "GAMEPLAY_SNAPSHOT");
assert.equal(activeGameplay.phase, "SPEED");

const cachedGameplay = resolveRecoveryRoute({
    setupActive: true,
    gameId: "game-cached",
    hasCachedSnapshot: true
});

assert.equal(cachedGameplay.route, "GAMEPLAY_SNAPSHOT");
assert.equal(cachedGameplay.phase, "RESULT_CACHE");

const page6Result = resolveRecoveryRoute({
    setupActive: true,
    gameId: "game-result",
    gameState: "RESULT",
    page6Active: true
});

assert.equal(page6Result.route, "GAMEPLAY_SNAPSHOT");
assert.equal(page6Result.successRoute, "PAGE6_RESULT");

const missingPage6Snapshot = resolveRecoveryRoute({
    setupActive: true,
    gameId: "game-result",
    page6Active: true
});

assert.equal(missingPage6Snapshot.route, "FAIL");

const openPage5 = resolveRecoveryRoute({
    setupActive: true,
    gameId: "game-started",
    gameStartPhase: "OPEN_PAGE5"
});

assert.equal(openPage5.route, "PRE_GAME_SUCCESS");
assert.equal(openPage5.successRoute, "GAME_START_REPLAY");
assert.equal(openPage5.phase, "OPEN_PAGE5");

const paymentSetup = resolveRecoveryRoute({ setupActive: true });

assert.equal(paymentSetup.route, "PRE_GAME_SUCCESS");
assert.equal(paymentSetup.phase, "SETUP");

const verifiedPage4 = resolveRecoveryRoute({
    setupActive: true,
    gameId: "pending-game",
    paymentStageActive: true
});

assert.equal(verifiedPage4.route, "PRE_GAME_SUCCESS");
assert.equal(verifiedPage4.phase, "ENTRY_PAYMENT");

console.log("gameplayRecoveryProtocol.test.js: all assertions passed");
