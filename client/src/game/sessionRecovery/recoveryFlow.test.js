/**
 * R12.5C — recoveryFlow Page6 / Result Session recovery decisions.
 */
import {
    APP_PAGES,
    canRecoverPreGame,
    hasGameplayIdentity,
    isGameplayPage,
    isPreGamePage,
    isSetupRecoveryPage,
    isTerminalRecoveryFailure,
    resolveGameplayRecoveryPage
} from "./recoveryFlow.js";

import { normalizeSessionSnapshot } from "./sessionSnapshotUtils.js";

import { GAME_STATES } from "../GameState";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

// ---------------------------------------------------------------------------
// Pre-game recovery (Setup Timer domain).
// ---------------------------------------------------------------------------

{

    assert(isPreGamePage(APP_PAGES.PLAYER_SETUP), "page 3 is pre-game");

    assert(isPreGamePage(APP_PAGES.PAYMENT), "page 6 is pre-game");

    assert(!isPreGamePage(APP_PAGES.GAMEPLAY), "page 7 is not pre-game");

    assert(isSetupRecoveryPage(APP_PAGES.LOBBY), "lobby is setup-recoverable");

    assert(
        isSetupRecoveryPage(APP_PAGES.PLAYER_SETUP),
        "prep pages are setup-recoverable"
    );

    assert(
        !isSetupRecoveryPage(APP_PAGES.GAMEPLAY),
        "gameplay is not setup-recoverable"
    );

    assert(
        canRecoverPreGame({
            currentPhase: "setup",
            phaseTimeRemaining: 120
        }),
        "legacy session fields still allow recovery when no setup mirror"
    );

    assert(
        !canRecoverPreGame({
            currentPhase: "setup",
            phaseTimeRemaining: 0
        }),
        "expired legacy timer blocks recovery"
    );

    assert(
        canRecoverPreGame(null, {
            expiresAt: Date.now() + 60_000
        }),
        "authoritative Setup Session expiresAt allows recovery"
    );

    assert(
        !canRecoverPreGame(null, {
            expiresAt: Date.now() - 1
        }),
        "authoritative Setup Session past expiresAt blocks recovery"
    );

    console.log("  pre-game: setup timer rules passed");

}

// ---------------------------------------------------------------------------
// R6.17 — Terminal recovery failures (server-authoritative wipe only).
// ---------------------------------------------------------------------------

{

    assert(
        isTerminalRecoveryFailure({ code: "ROOM_NOT_FOUND" }),
        "ROOM_NOT_FOUND code is terminal"
    );

    assert(
        isTerminalRecoveryFailure({ reason: "Room session is not active" }),
        "inactive room reason is terminal"
    );

    assert(
        isTerminalRecoveryFailure({ reason: "Player session is not recoverable" }),
        "unrecoverable player is terminal"
    );

    assert(
        !isTerminalRecoveryFailure({
            reason: "No active gameplay session for recovery"
        }),
        "missing gameplay session must not wipe payment/setup seat"
    );

    assert(
        !isTerminalRecoveryFailure({ reason: "Recovery snapshot is unavailable" }),
        "snapshot gap is not a terminal wipe"
    );

    assert(
        !isTerminalRecoveryFailure({}),
        "empty failure is not terminal"
    );

    console.log("  terminal recovery failure rules passed");

}

// ---------------------------------------------------------------------------
// Gameplay recovery (authoritative snapshot domain).
// ---------------------------------------------------------------------------

{

    const now = 5_000_000;

    assert(
        resolveGameplayRecoveryPage({
            gameState: GAME_STATES.SPEED,
            wheelAngle: 45
        }, now) === APP_PAGES.GAMEPLAY,
        "active gameplay restores Page5"
    );

    assert(
        resolveGameplayRecoveryPage({
            gameState: GAME_STATES.RESULT,
            gameResult: { winner: { id: "p1" } }
        }, now) === APP_PAGES.GAMEPLAY,
        "RESULT phase restores Page5 for winner presentation"
    );

    // Test A — Active Page6 recovery
    assert(
        resolveGameplayRecoveryPage({
            gameState: GAME_STATES.RESULT,
            gameResult: { winner: { id: "p1" } },
            openPage6: true,
            resultSessionExpiresAt: now + 120_000
        }, now) === APP_PAGES.RESULT,
        "TEST A: openPage6 + future expiresAt → Page6"
    );

    // Test B — Expired Page6 recovery
    assert(
        resolveGameplayRecoveryPage({
            gameState: GAME_STATES.RESULT,
            gameResult: { winner: { id: "p1" } },
            openPage6: true,
            resultSessionExpiresAt: now - 1000
        }, now) === APP_PAGES.WELCOME,
        "TEST B: openPage6 + past expiresAt → Page1"
    );

    // openPage6 without live deadline → terminal (no invented duration)
    assert(
        resolveGameplayRecoveryPage({
            gameState: GAME_STATES.RESULT,
            openPage6: true
        }, now) === APP_PAGES.WELCOME,
        "openPage6 without expiresAt → Page1 (no invented deadline)"
    );

    assert(
        resolveGameplayRecoveryPage({
            gameState: GAME_STATES.BRAKE,
            gameResult: { winner: { id: "p1" } }
        }, now) === APP_PAGES.GAMEPLAY,
        "gameResult alone must not open Page6 during BRAKE"
    );

    // Test D — RESULT without OPEN_PAGE6
    assert(
        resolveGameplayRecoveryPage({
            gameResult: { winner: { id: "p1" } }
        }, now) === null,
        "gameResult without openPage6 must not open Page6"
    );

    assert(
        resolveGameplayRecoveryPage({
            gameState: GAME_STATES.RESULT,
            openPage6: false,
            resultSessionExpiresAt: now + 120_000
        }, now) === APP_PAGES.GAMEPLAY,
        "TEST D: RESULT without openPage6 stays Page5"
    );

    assert(
        hasGameplayIdentity({ roomId: "ABC", playerId: "player_1" }),
        "in-memory identity is sufficient for gameplay recovery"
    );

    assert(
        !hasGameplayIdentity({ roomId: "ABC" }),
        "identity without playerId is invalid"
    );

    console.log("  gameplay: authoritative page resolution passed");

}

// ---------------------------------------------------------------------------
// R12.5C — normalizeSessionSnapshot preserves Page6 recovery fields.
// ---------------------------------------------------------------------------

{

    const expiresAt = Date.now() + 180_000;

    const normalized = normalizeSessionSnapshot({
        gameId: "g1",
        roomId: "R1",
        playerId: "p1",
        gameState: GAME_STATES.RESULT,
        openPage6: true,
        resultSessionExpiresAt: expiresAt,
        gameResult: { winner: { id: "p1" } }
    });

    assert(
        normalized.openPage6 === true,
        "normalize preserves openPage6"
    );

    assert(
        normalized.resultSessionExpiresAt === expiresAt,
        "normalize preserves resultSessionExpiresAt"
    );

    // Regression: previously dropped fields caused Page6 → Page5.
    assert(
        resolveGameplayRecoveryPage(normalized) === APP_PAGES.RESULT,
        "normalized active Page6 snapshot still routes to Page6"
    );

    const expiredNormalized = normalizeSessionSnapshot({
        gameState: GAME_STATES.RESULT,
        openPage6: true,
        resultSessionExpiresAt: Date.now() - 500
    });

    assert(
        resolveGameplayRecoveryPage(expiredNormalized) === APP_PAGES.WELCOME,
        "normalized expired Page6 snapshot routes to Page1"
    );

    const droppedShape = normalizeSessionSnapshot({
        gameState: GAME_STATES.RESULT,
        openPage6: true,
        resultSessionExpiresAt: Date.now() + 60_000
    });

    assert(
        Object.prototype.hasOwnProperty.call(droppedShape, "openPage6"),
        "openPage6 key always present after normalize"
    );

    assert(
        Object.prototype.hasOwnProperty.call(droppedShape, "resultSessionExpiresAt"),
        "resultSessionExpiresAt key always present after normalize"
    );

    console.log("  R12.5C normalize + Page6 recovery fields passed");

}

console.log("recoveryFlow.test.js: all assertions passed");
