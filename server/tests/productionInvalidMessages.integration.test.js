/**
 * C4.12 — Production Validation Suite / Group E — Invalid Gameplay Messages.
 *
 * E1  Wrong gameId.
 * E2  Wrong playerId.
 * E3  Old / stale sequenceNumber (server is authoritative over sequencing).
 * E4  Input during an invalid GameState (e.g. COUNTDOWN).
 *
 * The server must reject every invalid message and no gameplay state may
 * change. The game must still complete and return to Baseline (Group F).
 *
 * Each scenario runs on its own fresh stack. Validation only.
 */
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import {
    assert,
    buildProductionStack
} from "./helpers/productionValidationHarness.js";

function assertRosterUntouched(ia, gameId, roster, label) {

    for (const playerId of roster) {

        const state = ia.getPlayerInputState(gameId, playerId);

        assert(
            state && state.pressCount === 0 && state.buttonPressed === false,
            `${label}: no valid player's input state may change`
        );

    }

    assert(
        ia.getAcceptedCommands(gameId).length === 0,
        `${label}: an invalid message must not enqueue any accepted command`
    );

}

// ---------------------------------------------------------------------------
// E1 — wrong gameId.
// ---------------------------------------------------------------------------

{

    const stack = await buildProductionStack();

    const ia = stack.components.inputAuthority;

    try {

        const baseline = stack.snapshot();

        const result = await stack.runGame({
            index: "E1",
            onSpeed: async (ctx) => {

                const wrongGameId = `wrong-${ctx.gameId}`;

                const press = ia.handleButtonPress(wrongGameId, ctx.roster[0]);

                const release = ia.handleButtonRelease(wrongGameId, ctx.roster[0]);

                assert(
                    press === null && release === null,
                    "E1: input for a wrong gameId must be rejected"
                );

                assert(
                    !ia.hasGame(wrongGameId),
                    "E1: a wrong gameId must not create any registry"
                );

                assertRosterUntouched(ia, ctx.gameId, ctx.roster, "E1");

                ctx.exhaustOnline();

            }
        });

        assert(stack.observed.cleanups.has(result.gameId), "E1: cleanup must run");

        stack.assertClean(baseline, "E1");

        console.log("  E1 (wrong gameId) passed");

    } finally {

        await stack.shutdown();

    }

}

// ---------------------------------------------------------------------------
// E2 — wrong playerId.
// ---------------------------------------------------------------------------

{

    const stack = await buildProductionStack();

    const ia = stack.components.inputAuthority;

    try {

        const baseline = stack.snapshot();

        const result = await stack.runGame({
            index: "E2",
            onSpeed: async (ctx) => {

                const press = ia.handleButtonPress(ctx.gameId, "ghost-player");

                const release = ia.handleButtonRelease(ctx.gameId, "ghost-player");

                assert(
                    press === null && release === null,
                    "E2: input for a wrong playerId must be rejected"
                );

                assert(
                    ia.getPlayerInputState(ctx.gameId, "ghost-player") === null,
                    "E2: a wrong playerId must not gain input state"
                );

                assertRosterUntouched(ia, ctx.gameId, ctx.roster, "E2");

                ctx.exhaustOnline();

            }
        });

        assert(stack.observed.cleanups.has(result.gameId), "E2: cleanup must run");

        stack.assertClean(baseline, "E2");

        console.log("  E2 (wrong playerId) passed");

    } finally {

        await stack.shutdown();

    }

}

// ---------------------------------------------------------------------------
// E3 — old / stale sequenceNumber.
//
// The server is authoritative over sequencing: it assigns its own strictly
// increasing sequenceNumbers and ignores any client-supplied value. A stale /
// replayed action (a duplicate press) therefore produces no new accepted
// command and cannot rewind authoritative state.
// ---------------------------------------------------------------------------

{

    const stack = await buildProductionStack();

    const ia = stack.components.inputAuthority;

    try {

        const baseline = stack.snapshot();

        const result = await stack.runGame({
            index: "E3",
            onSpeed: async (ctx) => {

                const pid = ctx.roster[0];

                ia.handleButtonPress(ctx.gameId, pid);

                ia.handleButtonRelease(ctx.gameId, pid);

                const commands = ia.getAcceptedCommands(ctx.gameId);

                assert(
                    commands.length === 2,
                    "E3: one full cycle must yield exactly two accepted commands"
                );

                const sequences = commands.map((command) => command.sequenceNumber);

                for (let i = 1; i < sequences.length; i += 1) {

                    assert(
                        sequences[i] > sequences[i - 1],
                        "E3: server sequenceNumbers must be strictly increasing"
                    );

                }

                const stateBefore = ia.getPlayerInputState(ctx.gameId, pid);

                // Replay a stale action: a press while already released mid-cooldown
                // window is duplicate/out-of-order from the client's view. The
                // server accepts it only on its own authoritative rules, never on a
                // client sequenceNumber. Here we send a stray release (stale) which
                // must be rejected and must not rewind the accepted command log.
                const stale = ia.handleButtonRelease(ctx.gameId, pid);

                assert(
                    stale === null,
                    "E3: a stale/out-of-order action must be rejected"
                );

                assert(
                    ia.getAcceptedCommands(ctx.gameId).length === commands.length,
                    "E3: a stale action must not append an accepted command"
                );

                const stateAfter = ia.getPlayerInputState(ctx.gameId, pid);

                assert(
                    stateAfter.pressCount === stateBefore.pressCount,
                    "E3: a stale action must not change authoritative pressCount"
                );

                ctx.exhaustOnline();

            }
        });

        assert(stack.observed.cleanups.has(result.gameId), "E3: cleanup must run");

        stack.assertClean(baseline, "E3");

        console.log("  E3 (old sequenceNumber) passed");

    } finally {

        await stack.shutdown();

    }

}

// ---------------------------------------------------------------------------
// E4 — input during an invalid GameState (COUNTDOWN).
// ---------------------------------------------------------------------------

{

    const stack = await buildProductionStack();

    const ia = stack.components.inputAuthority;

    let countdownRejected = false;

    try {

        const baseline = stack.snapshot();

        const result = await stack.runGame({
            index: "E4",
            hooks: {
                [GAME_STATES.COUNTDOWN]: (ctx) => {

                    const pid = ctx.roster[0];

                    const press = ia.handleButtonPress(ctx.gameId, pid);

                    assert(
                        press === null,
                        "E4: input during COUNTDOWN must be rejected"
                    );

                    const state = ia.getPlayerInputState(ctx.gameId, pid);

                    assert(
                        state.pressCount === 0 && state.buttonPressed === false,
                        "E4: rejected input must not change gameplay state"
                    );

                    assert(
                        ia.getAcceptedCommands(ctx.gameId).length === 0,
                        "E4: rejected input must not enqueue a command"
                    );

                    countdownRejected = true;

                }
            }
        });

        assert(
            countdownRejected,
            "E4: the COUNTDOWN input attempt must have been exercised"
        );

        assert(stack.observed.cleanups.has(result.gameId), "E4: cleanup must run");

        stack.assertClean(baseline, "E4");

        console.log("  E4 (input during invalid GameState) passed");

    } finally {

        await stack.shutdown();

    }

}

console.log("productionInvalidMessages.integration.test.js: all assertions passed");
