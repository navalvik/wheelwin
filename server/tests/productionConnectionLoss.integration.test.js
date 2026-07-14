/**
 * C4.12 — Production Validation Suite / Group A — Connection Loss.
 *
 * A1..A6 each disconnect one player during a specific phase and prove the game
 * still completes the full lifecycle and returns the server to Baseline
 * (Group F). During SPEED the offline player's remaining input is finished
 * authoritatively by OfflineInputContinuation.
 *
 * Each scenario runs on its own fresh stack (fully independent) and identifies
 * itself in any failure message. Validation only — no gameplay changes.
 */
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import {
    assert,
    buildProductionStack
} from "./helpers/productionValidationHarness.js";

async function runConnectionLossScenario(label, phase) {

    const stack = await buildProductionStack();

    try {

        const baseline = stack.snapshot();

        const result = await stack.runGame({
            index: label,
            hooks: {
                [phase]: (ctx) => {

                    // Drop one participant precisely when `phase` is entered.
                    ctx.disconnect(ctx.roster[2]);

                }
            }
        });

        // Gameplay must have reached a resolved winner and completed cleanup.
        assert(
            stack.components.eventBus && stack.observed.winners.has(result.gameId),
            `${label}: winner must be resolved despite a disconnect during ${phase}`
        );

        assert(
            stack.observed.cleanups.has(result.gameId),
            `${label}: cleanup must execute despite a disconnect during ${phase}`
        );

        assert(
            stack.components.offlineInputContinuation
                .getActiveContinuations().length === 0,
            `${label}: no continuation may remain active after cleanup`
        );

        // Group F — every runtime counter is back to Baseline.
        stack.assertClean(baseline, label);

        console.log(`  ${label} (disconnect during ${phase}) passed`);

    } finally {

        await stack.shutdown();

    }

}

await runConnectionLossScenario("A1", GAME_STATES.READY);

await runConnectionLossScenario("A2", GAME_STATES.COUNTDOWN);

await runConnectionLossScenario("A3", GAME_STATES.SELF_TEST);

await runConnectionLossScenario("A4", GAME_STATES.SPEED);

await runConnectionLossScenario("A5", GAME_STATES.BRAKE);

await runConnectionLossScenario("A6", GAME_STATES.RESULT);

console.log("productionConnectionLoss.integration.test.js: all assertions passed");
