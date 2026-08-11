/**
 * R12.5D — Page6 recovery enrichment after RESULT-phase cache / teardown.
 */
import assert from "node:assert/strict";

import {
    buildClientRecoveryPayload,
    enrichPage6RecoveryFields
} from "../socket/gameplayRecoveryProtocol.js";

import { GAME_STATES } from "../engines/gameState/GameStates.js";

const now = 5_000_000;

// ---------------------------------------------------------------------------
// Stale RESULT cache (captured before OPEN_PAGE6) must not stay Page5-only
// once Result Session / page6Opened is known.
// ---------------------------------------------------------------------------

{

    const staleResultPayload = buildClientRecoveryPayload({
        snapshot: {
            gameId: "g1",
            gameState: { currentState: GAME_STATES.RESULT },
            openPage6: false,
            resultSessionExpiresAt: null,
            winner: {
                winnerPlayerId: "p1",
                wheelFinalAngle: 1,
                winningPlayer: { playerId: "p1", color: "#f00", icon: "x" },
                winningSector: { index: 0, sectorId: "s0", color: "#f00", icon: "x" }
            },
            input: {
                players: [{
                    playerId: "p1",
                    pressCount: 0,
                    remainingPresses: 0,
                    pressed: false,
                    buttonLocked: false
                }]
            },
            physics: {
                angle: 0,
                triangleAngle: 0,
                angularVelocity: 0,
                triangleAngularVelocity: 0
            },
            clock: {
                remainingTime: 0,
                phaseStartedAt: now - 4000,
                phaseEndsAt: now
            },
            recoveredAt: now
        },
        playerId: "p1",
        roomId: "R1"
    });

    assert.equal(staleResultPayload.openPage6, false);
    assert.equal(staleResultPayload.resultSessionExpiresAt, null);

    const enrichedLive = enrichPage6RecoveryFields(staleResultPayload, {
        resultSession: {
            roomId: "R1",
            expiresAt: now + 120_000
        }
    });

    assert.equal(enrichedLive.openPage6, true, "live Result Session ⇒ openPage6");
    assert.equal(
        enrichedLive.resultSessionExpiresAt,
        now + 120_000,
        "live expiresAt wins"
    );

    const enrichedCached = enrichPage6RecoveryFields(staleResultPayload, {
        page6Opened: true,
        cachedResultSessionExpiresAt: now + 90_000
    });

    assert.equal(enrichedCached.openPage6, true, "cache page6Opened stamp ⇒ openPage6");
    assert.equal(
        enrichedCached.resultSessionExpiresAt,
        now + 90_000,
        "cached expiresAt used when live session missing"
    );

    const enrichedExpired = enrichPage6RecoveryFields(staleResultPayload, {
        page6Opened: true,
        cachedResultSessionExpiresAt: now - 1000
    });

    assert.equal(enrichedExpired.openPage6, true, "expired Page6 still marked opened");
    assert.equal(
        enrichedExpired.resultSessionExpiresAt,
        now - 1000,
        "past deadline preserved for terminal routing"
    );

    const midResult = enrichPage6RecoveryFields(staleResultPayload, {});

    assert.equal(
        midResult.openPage6,
        false,
        "RESULT before OPEN_PAGE6 stays openPage6=false"
    );

    console.log("  enrichPage6RecoveryFields: OK");

}

console.log("page6Recovery.r125d.test.js: all assertions passed");
