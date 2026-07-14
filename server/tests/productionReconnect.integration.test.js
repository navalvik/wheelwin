/**
 * C4.12 — Production Validation Suite / Group B — Reconnect.
 *
 * B1  Disconnect during SPEED, reconnect before RESULT; recovery restores the
 *     current authoritative state and the player finishes their own input.
 * B2  Disconnect during BRAKE, reconnect before Cleanup; recovery restores the
 *     current authoritative state.
 * B3  "Refresh page" (new socket) during SPEED, reconnect; the game continues.
 *
 * "Recovery restores the current state" is validated with the authoritative
 * RecoveryEngine.buildRecoverySnapshot(gameId) — the exact snapshot the socket
 * reconnect path delivers to a returning client. The read-only builder is used
 * (it does not persist) so Group F still asserts RecoveryEngine returns to 0.
 *
 * Each scenario runs on its own fresh stack. Validation only.
 */
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import {
    assert,
    buildProductionStack
} from "./helpers/productionValidationHarness.js";

function continuationHas(stack, gameId, playerId) {

    return stack.components.offlineInputContinuation
        .getActiveContinuations()
        .some((entry) => entry.gameId === gameId && entry.playerId === playerId);

}

function assertRecoveryRestores(stack, gameId, expectedState, playerId, label) {

    const snapshot = stack.components.recoveryEngine
        .buildRecoverySnapshot(gameId);

    assert(
        snapshot.gameState.currentState === expectedState,
        `${label}: recovery must restore current state ${expectedState} `
            + `(got ${snapshot.gameState?.currentState})`
    );

    const playerInput = snapshot.input.players.find(
        (entry) => entry.playerId === playerId
    );

    assert(
        playerInput,
        `${label}: recovery snapshot must include the reconnecting player input`
    );

}

// ---------------------------------------------------------------------------
// B1 — disconnect during SPEED, reconnect before RESULT.
// ---------------------------------------------------------------------------

{

    const stack = await buildProductionStack();

    try {

        const baseline = stack.snapshot();

        const result = await stack.runGame({
            index: "B1",
            onSpeed: async (ctx) => {

                const returning = ctx.roster[2];

                ctx.disconnect(returning);

                assert(
                    continuationHas(stack, ctx.gameId, returning),
                    "B1: continuation must adopt the player on disconnect"
                );

                ctx.reconnect(returning);

                assert(
                    !continuationHas(stack, ctx.gameId, returning),
                    "B1: continuation must release the player on reconnect"
                );

                assert(
                    stack.components.gameStateEngine.getState(ctx.gameId)
                        === GAME_STATES.SPEED,
                    "B1: game must still be in SPEED after reconnect"
                );

                assertRecoveryRestores(
                    stack,
                    ctx.gameId,
                    GAME_STATES.SPEED,
                    returning,
                    "B1"
                );

                // The reconnected player and their peers finish their own input.
                ctx.exhaustOnline();

            }
        });

        assert(
            stack.observed.winners.has(result.gameId),
            "B1: winner must resolve after reconnect"
        );

        assert(
            stack.observed.cleanups.has(result.gameId),
            "B1: cleanup must execute after reconnect"
        );

        stack.assertClean(baseline, "B1");

        console.log("  B1 (disconnect SPEED, reconnect before RESULT) passed");

    } finally {

        await stack.shutdown();

    }

}

// ---------------------------------------------------------------------------
// B2 — disconnect during BRAKE, reconnect before Cleanup.
// ---------------------------------------------------------------------------

{

    const stack = await buildProductionStack();

    try {

        const baseline = stack.snapshot();

        const result = await stack.runGame({
            index: "B2",
            hooks: {
                [GAME_STATES.BRAKE]: (ctx) => {

                    const returning = ctx.roster[2];

                    // SPEED already finished (all online), so this is post-input:
                    // disconnect then reconnect before the deferred teardown.
                    ctx.disconnect(returning);

                    ctx.reconnect(returning);

                    assertRecoveryRestores(
                        stack,
                        ctx.gameId,
                        stack.components.gameStateEngine.getState(ctx.gameId),
                        returning,
                        "B2"
                    );

                }
            }
            // onSpeed omitted -> all players online at SPEED are auto-finished.
        });

        assert(
            stack.observed.winners.has(result.gameId),
            "B2: winner must resolve"
        );

        assert(
            stack.observed.cleanups.has(result.gameId),
            "B2: cleanup must execute after reconnect during BRAKE"
        );

        stack.assertClean(baseline, "B2");

        console.log("  B2 (disconnect BRAKE, reconnect before Cleanup) passed");

    } finally {

        await stack.shutdown();

    }

}

// ---------------------------------------------------------------------------
// B3 — refresh page during SPEED (new socket), reconnect, game continues.
// ---------------------------------------------------------------------------

{

    const stack = await buildProductionStack();

    try {

        const baseline = stack.snapshot();

        const result = await stack.runGame({
            index: "B3",
            onSpeed: async (ctx) => {

                const returning = ctx.roster[1];

                // Page refresh: the old socket drops, a brand-new socket returns.
                ctx.disconnect(returning);

                const reconnected = ctx.reconnect(
                    returning,
                    `refresh-${returning}`
                );

                assert(
                    reconnected.ok,
                    "B3: gameplay reconnect after refresh must succeed"
                );

                assert(
                    stack.components.gameStateEngine.getState(ctx.gameId)
                        === GAME_STATES.SPEED,
                    "B3: game must continue in SPEED after a refresh"
                );

                ctx.exhaustOnline();

            }
        });

        assert(
            stack.observed.winners.has(result.gameId),
            "B3: winner must resolve after a page refresh reconnect"
        );

        assert(
            stack.observed.cleanups.has(result.gameId),
            "B3: cleanup must execute after a page refresh reconnect"
        );

        stack.assertClean(baseline, "B3");

        console.log("  B3 (refresh during SPEED, reconnect, continues) passed");

    } finally {

        await stack.shutdown();

    }

}

console.log("productionReconnect.integration.test.js: all assertions passed");
