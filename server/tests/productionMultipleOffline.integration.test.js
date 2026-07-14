/**
 * C4.12 — Production Validation Suite / Group C — Multiple Offline Players.
 *
 * C1  One offline player.
 * C2  Two offline players.
 * C3  All three players offline.
 *
 * Players go offline before SPEED; OfflineInputContinuation finishes every
 * offline participant authoritatively. In all cases the server must complete
 * the game: winner resolved, payment completed, cleanup executed, Baseline
 * restored (Group F).
 *
 * Each scenario runs on its own fresh stack. Validation only.
 */
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import {
    assert,
    buildProductionStack
} from "./helpers/productionValidationHarness.js";

async function runMultipleOfflineScenario(label, offlineCount) {

    const stack = await buildProductionStack();

    try {

        const baseline = stack.snapshot();

        const result = await stack.runGame({
            index: label,
            hooks: {
                [GAME_STATES.READY]: (ctx) => {

                    // Drop the last `offlineCount` players before SPEED. They are
                    // adopted by OfflineInputContinuation on SPEED entry.
                    for (let i = 0; i < offlineCount; i += 1) {

                        ctx.disconnect(ctx.roster[ctx.roster.length - 1 - i]);

                    }

                }
            }
            // onSpeed omitted -> remaining online players (if any) are finished;
            // offline players are finished by continuation.
        });

        assert(
            stack.observed.winners.has(result.gameId),
            `${label}: winner must resolve with ${offlineCount} offline player(s)`
        );

        assert(
            stack.observed.paymentsCompleted.has(result.gameId),
            `${label}: payment must complete with ${offlineCount} offline player(s)`
        );

        assert(
            stack.observed.cleanups.has(result.gameId),
            `${label}: cleanup must execute with ${offlineCount} offline player(s)`
        );

        stack.assertClean(baseline, label);

        console.log(`  ${label} (${offlineCount} offline) passed`);

    } finally {

        await stack.shutdown();

    }

}

await runMultipleOfflineScenario("C1", 1);

await runMultipleOfflineScenario("C2", 2);

await runMultipleOfflineScenario("C3", 3);

console.log("productionMultipleOffline.integration.test.js: all assertions passed");
