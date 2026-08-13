/**
 * R17.8B — Payment-phase recovery routing (unit).
 */
import assert from "node:assert/strict";
import {
    resolveRecoveryRoute
} from "../socket/gameplayRecoveryProtocol.js";

function assertRoute(actual, expected, label) {

    assert.equal(actual.route, expected.route, `${label}: route`);
    assert.equal(actual.phase, expected.phase, `${label}: phase`);

    if (expected.skipReason !== undefined) {

        assert.equal(
            actual.skipReason,
            expected.skipReason,
            `${label}: skipReason`
        );

    }

    if (expected.reason !== undefined) {

        assert.equal(actual.reason, expected.reason, `${label}: reason`);

    }

}

// Case A — Payment / TON phase: gameId exists, game not initialized
{
    const route = resolveRecoveryRoute({
        setupActive: false,
        gameId: "game-payment",
        gameState: null,
        hasCachedSnapshot: false
    });

    assertRoute(route, {
        route: "PRE_GAME_SUCCESS",
        phase: "ENTRY_PAYMENT",
        skipReason: "GAME_NOT_INITIALIZED"
    }, "Case A payment phase");

    console.log("  Case A payment-phase SUCCESS (skip RecoveryEngine): OK");
}

// Setup-active still succeeds without RecoveryEngine
{
    const route = resolveRecoveryRoute({
        setupActive: true,
        gameId: "game-setup",
        gameState: null,
        hasCachedSnapshot: false
    });

    assertRoute(route, {
        route: "PRE_GAME_SUCCESS",
        phase: "SETUP",
        skipReason: "SETUP_ACTIVE"
    }, "Setup active");

    console.log("  Setup-active SUCCESS: OK");
}

// Case B — Gameplay after GAME_INITIALIZED
{
    const route = resolveRecoveryRoute({
        setupActive: false,
        gameId: "game-live",
        gameState: "SPEED",
        hasCachedSnapshot: false
    });

    assertRoute(route, {
        route: "GAMEPLAY_SNAPSHOT",
        phase: "SPEED",
        skipReason: null
    }, "Case B gameplay");

    assert.equal(route.successRoute, "GAMEPLAY_SNAPSHOT");

    console.log("  Case B gameplay RecoveryEngine path: OK");
}

// RESULT cache after teardown still uses snapshot path
{
    const route = resolveRecoveryRoute({
        setupActive: false,
        gameId: "game-result",
        gameState: null,
        hasCachedSnapshot: true
    });

    assertRoute(route, {
        route: "GAMEPLAY_SNAPSHOT",
        phase: "RESULT_CACHE",
        skipReason: null
    }, "RESULT cache");

    console.log("  RESULT-cache RecoveryEngine path: OK");
}

// Case C — Invalid / no session
{
    const route = resolveRecoveryRoute({
        setupActive: false,
        gameId: null,
        gameState: null,
        hasCachedSnapshot: false
    });

    assertRoute(route, {
        route: "FAIL",
        phase: "NONE",
        reason: "No active gameplay session for recovery"
    }, "Case C invalid");

    console.log("  Case C clear failure reason: OK");
}

console.log("paymentPhaseRecovery.r178b.test.js — all assertions passed");
