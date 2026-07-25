/**
 * R7.0H — Sequential validation scenario runner.
 */

import { ValidationAssertions } from "./ValidationAssertions.js";
import { ValidationStatistics } from "./ValidationStatistics.js";

export class ValidationRunner {

    /**
     * @param {{
     *   scenarios: import("./ValidationScenario.js").ValidationScenario[],
     *   context?: object,
     *   onScenarioComplete?: (result: object) => void
     * }} options
     */
    constructor({ scenarios, context = {}, onScenarioComplete = null }) {

        this._scenarios = scenarios ?? [];

        this._context = context;

        this._onScenarioComplete = onScenarioComplete;

        this._statistics = new ValidationStatistics();

        this._results = [];

    }

    get statistics() {

        return this._statistics;

    }

    get results() {

        return this._results;

    }

    async runAll() {

        this._results = [];

        this._statistics = new ValidationStatistics();

        for (const scenario of this._scenarios) {

            const result = await this._runOne(scenario);

            this._results.push(result);

            this._statistics.recordScenario({
                passed: result.passed,
                warningCount: result.warningCount,
                assertionCount: result.assertionCount,
                durationMs: result.durationMs
            });

            if (result.metrics) {

                this._statistics.mergeMetrics(result.metrics);

            }

            this._onScenarioComplete?.(result);

        }

        return {
            results: this._results,
            statistics: this._statistics.snapshot()
        };

    }

    async _runOne(scenario) {

        const assert = new ValidationAssertions();

        const started = performance.now();

        let evidence = {};

        let metrics = null;

        let error = null;

        try {

            const output = await scenario.run(assert, this._context);

            if (output && typeof output === "object") {

                evidence = output.evidence ?? (
                    output.metrics ? {} : output
                );

                metrics = output.metrics ?? output.evidence?.metrics ?? null;

            }

        } catch (err) {

            error = err;

            assert.ok(false, `Unhandled error: ${err?.message ?? err}`);

        }

        const durationMs = Number((performance.now() - started).toFixed(3));

        const snap = assert.snapshot();

        return {
            id: scenario.id,
            name: scenario.name,
            description: scenario.description ?? "",
            passed: !assert.failed && error == null,
            durationMs,
            assertionCount: snap.passed,
            warningCount: snap.warnings.length,
            failures: snap.failures,
            warnings: snap.warnings,
            evidence,
            metrics,
            error: error ? String(error.message ?? error) : null
        };

    }

}
