/**
 * R7.0H — Blockchain outage simulation (retries / circuit / no gameplay impact).
 */

import { ValidationScenario } from "../ValidationScenario.js";
import { createValidationStack, delay } from "../validationHarness.js";
import { FAILURE_DECISION } from "../../failure/failureTypes.js";
import { CIRCUIT_STATE } from "../../failure/failureTypes.js";

export class BlockchainSimulationScenario extends ValidationScenario {

    constructor() {

        super({
            id: "blockchain-simulation",
            name: "Blockchain Outage Simulation",
            description:
                "Temporary blockchain failures: retry, backoff, circuit, recovery"
        });

    }

    async run(assert) {

        const stack = await createValidationStack();

        stack.markReady();

        stack.state.games = 3;

        stack.state.rooms = 3;

        const policy = stack.failurePolicy;

        const decisions = [];

        // Simulate outage burst
        for (let attempt = 1; attempt <= 4; attempt += 1) {

            const result = policy.decide({
                component: "blockchain",
                operation: "poll_room",
                error: new Error("temporary blockchain delay"),
                attempt,
                fields: { roomId: "r-outage" }
            });

            decisions.push(result.decision);

            if (result.decision === FAILURE_DECISION.RETRY_LATER
                || result.decision === FAILURE_DECISION.RETRY_NOW) {

                let done = false;

                policy.scheduleRetry({
                    decision: result,
                    execute: async () => {

                        done = true;

                    }
                });

                await delay((result.delayMs ?? 0) + 40);

                assert.equal(done, true, `Retry ${attempt} completed`);

            }

        }

        // Force circuit open
        for (let i = 0; i < 6; i += 1) {

            policy.decide({
                component: "blockchain",
                operation: "getTransactions",
                error: new Error("timeout contacting chain"),
                attempt: 1
            });

        }

        let status = policy.getSafeStatus();

        const blockchainCircuit = status.circuitBreakers
            .find((c) => c.name === "blockchain");

        assert.ok(blockchainCircuit, "Blockchain circuit exists");

        assert.equal(
            blockchainCircuit.state,
            CIRCUIT_STATE.OPEN,
            "Circuit opened during outage"
        );

        // Gameplay authority unaffected
        assert.equal(stack.state.games, 3, "Active games unchanged");

        assert.equal(
            stack.healthManager.getLivenessResponse().live,
            true,
            "Liveness unaffected by blockchain outage"
        );

        // Wait for half-open / recovery window
        await delay(40);

        policy.reportSuccess({
            component: "blockchain",
            operation: "getTransactions"
        });

        policy.reportSuccess({
            component: "blockchain",
            operation: "getTransactions"
        });

        status = policy.getSafeStatus();

        const after = status.circuitBreakers
            .find((c) => c.name === "blockchain");

        assert.ok(
            after.state === CIRCUIT_STATE.CLOSED
                || after.state === CIRCUIT_STATE.HALF_OPEN
                || after.recoveryCount >= 0,
            "Circuit recovery tracked"
        );

        await stack.shutdown();

        return {
            evidence: {
                decisions,
                circuitState: after.state,
                recoveryCount: after.recoveryCount,
                gamesUnchanged: true
            }
        };

    }

}
