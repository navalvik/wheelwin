/**
 * C4.12 — Production Validation Suite / Group D — Duplicate Input.
 *
 * D1  Double click (press while already pressed) is rejected.
 * D2  Repeated identical input (repeated press / release-without-press) is
 *     rejected.
 * D3  Input after the player has already finished (locked) is rejected.
 *
 * InputAuthority must reject every duplicate, no accepted command may be
 * produced, authoritative input state must not change, and the game must still
 * complete and return to Baseline (Group F).
 *
 * Each scenario runs on its own fresh stack. Validation only.
 */
import {
    assert,
    buildProductionStack
} from "./helpers/productionValidationHarness.js";

// ---------------------------------------------------------------------------
// D1 — double click.
// ---------------------------------------------------------------------------

{

    const stack = await buildProductionStack();

    const ia = stack.components.inputAuthority;

    try {

        const baseline = stack.snapshot();

        const result = await stack.runGame({
            index: "D1",
            onSpeed: async (ctx) => {

                const pid = ctx.roster[0];

                const accepted = ia.handleButtonPress(ctx.gameId, pid);

                assert(accepted, "D1: first press must be accepted");

                const acceptedCount = ia.getAcceptedCommands(ctx.gameId).length;

                const duplicate = ia.handleButtonPress(ctx.gameId, pid);

                assert(
                    duplicate === null,
                    "D1: a double click (second press) must be rejected"
                );

                const state = ia.getPlayerInputState(ctx.gameId, pid);

                assert(
                    state.pressCount === 0 && state.buttonPressed === true,
                    "D1: duplicate press must not change authoritative state"
                );

                assert(
                    ia.getAcceptedCommands(ctx.gameId).length === acceptedCount,
                    "D1: a rejected double click must not enqueue a command"
                );

                ctx.exhaustOnline();

            }
        });

        assert(
            stack.observed.cleanups.has(result.gameId),
            "D1: cleanup must execute"
        );

        stack.assertClean(baseline, "D1");

        console.log("  D1 (double click) passed");

    } finally {

        await stack.shutdown();

    }

}

// ---------------------------------------------------------------------------
// D2 — repeated identical input.
// ---------------------------------------------------------------------------

{

    const stack = await buildProductionStack();

    const ia = stack.components.inputAuthority;

    try {

        const baseline = stack.snapshot();

        const result = await stack.runGame({
            index: "D2",
            onSpeed: async (ctx) => {

                const pid = ctx.roster[0];

                const strayRelease = ia.handleButtonRelease(ctx.gameId, pid);

                assert(
                    strayRelease === null,
                    "D2: a release without a press must be rejected"
                );

                const firstPress = ia.handleButtonPress(ctx.gameId, pid);

                assert(firstPress, "D2: the first press must be accepted");

                for (let i = 0; i < 3; i += 1) {

                    assert(
                        ia.handleButtonPress(ctx.gameId, pid) === null,
                        "D2: repeated identical presses must all be rejected"
                    );

                }

                const state = ia.getPlayerInputState(ctx.gameId, pid);

                assert(
                    state.pressCount === 0 && state.buttonPressed === true,
                    "D2: repeated identical input must not change state"
                );

                ctx.exhaustOnline();

            }
        });

        assert(
            stack.observed.cleanups.has(result.gameId),
            "D2: cleanup must execute"
        );

        stack.assertClean(baseline, "D2");

        console.log("  D2 (repeated identical input) passed");

    } finally {

        await stack.shutdown();

    }

}

// ---------------------------------------------------------------------------
// D3 — input after the player already finished.
// ---------------------------------------------------------------------------

{

    const stack = await buildProductionStack();

    const ia = stack.components.inputAuthority;

    try {

        const baseline = stack.snapshot();

        const result = await stack.runGame({
            index: "D3",
            onSpeed: async (ctx) => {

                const pid = ctx.roster[0];

                ctx.finishPlayer(pid);

                const finished = ia.getPlayerInputState(ctx.gameId, pid);

                assert(
                    finished.locked && finished.pressCount === 3,
                    "D3: player must be locked at the press limit before the test"
                );

                const commandsBefore = ia.getAcceptedCommands(ctx.gameId).length;

                const late = ia.handleButtonPress(ctx.gameId, pid);

                assert(
                    late === null,
                    "D3: input after a player finished must be rejected"
                );

                const after = ia.getPlayerInputState(ctx.gameId, pid);

                assert(
                    after.pressCount === 3 && after.locked,
                    "D3: late input must not change a finished player's state"
                );

                assert(
                    ia.getAcceptedCommands(ctx.gameId).length === commandsBefore,
                    "D3: late input must not enqueue a command"
                );

                // Finish the remaining players so the game completes.
                ctx.exhaustOnline();

            }
        });

        assert(
            stack.observed.cleanups.has(result.gameId),
            "D3: cleanup must execute"
        );

        stack.assertClean(baseline, "D3");

        console.log("  D3 (input after finished) passed");

    } finally {

        await stack.shutdown();

    }

}

console.log("productionDuplicateInput.integration.test.js: all assertions passed");
