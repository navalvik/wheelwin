import {
    APP_PAGES,
    RECOVERY_UI_STATUS,
    canRecoverPreGame,
    hasGameplayIdentity,
    isGameplayPage,
    isPreGamePage,
    resolveGameplayRecoveryPage
} from "./recoveryFlow.js";

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
// Gameplay recovery (authoritative snapshot domain).
// ---------------------------------------------------------------------------

{

    assert(
        resolveGameplayRecoveryPage({
            gameState: GAME_STATES.SPEED,
            wheelAngle: 45
        }) === APP_PAGES.GAMEPLAY,
        "active gameplay restores Page5"
    );

    assert(
        resolveGameplayRecoveryPage({
            gameState: GAME_STATES.RESULT,
            gameResult: { winner: { id: "p1" } }
        }) === APP_PAGES.GAMEPLAY,
        "RESULT phase restores Page5 for winner presentation"
    );

    assert(
        resolveGameplayRecoveryPage({
            gameState: GAME_STATES.RESULT,
            gameResult: { winner: { id: "p1" } },
            openPage6: true
        }) === APP_PAGES.RESULT,
        "OPEN_PAGE6 restores Page6"
    );

    assert(
        resolveGameplayRecoveryPage({
            gameState: GAME_STATES.BRAKE,
            gameResult: { winner: { id: "p1" } }
        }) === APP_PAGES.GAMEPLAY,
        "gameResult alone must not open Page6 during BRAKE"
    );

    assert(
        resolveGameplayRecoveryPage({
            gameResult: { winner: { id: "p1" } }
        }) === null,
        "gameResult without openPage6 must not open Page6"
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

console.log("recoveryFlow.test.js: all assertions passed");
