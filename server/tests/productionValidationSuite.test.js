/**
 * R7.0H — Automated production validation suite test.
 */

import assert from "node:assert/strict";

import { ProductionValidationSuite } from "../validation/ProductionValidationSuite.js";

async function main() {

    const suite = new ProductionValidationSuite({
        longRunningMs: 600,
        writeReport: true,
        onScenarioComplete: (result) => {

            process.stdout.write(
                `  ${result.passed ? "✓" : "✗"} ${result.id}\n`
            );

        }
    });

    const listed = suite.listScenarios();

    assert.equal(listed.length, 9, "Nine validation scenarios registered");

    const outcome = await suite.run();

    assert.equal(outcome.results.length, 9);

    assert.ok(outcome.reportMarkdown.includes("R7.0H"));

    assert.ok(outcome.reportPath);

    assert.equal(
        outcome.overallPass,
        true,
        `Validation suite failed:\n${outcome.results
            .filter((r) => !r.passed)
            .map((r) => `${r.id}: ${r.failures.join("; ")}`)
            .join("\n")}`
    );

    console.log("productionValidationSuite.test.js: OK");

}

main().catch((error) => {

    console.error(error);

    process.exit(1);

});
