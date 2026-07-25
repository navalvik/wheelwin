/**
 * R7.0H — CLI runner for the Production Validation Suite.
 *
 * Usage:
 *   node scripts/run-production-validation.js
 *   VALIDATION_LONG_MS=5000 node scripts/run-production-validation.js
 */

import { runProductionValidation } from "../validation/ProductionValidationSuite.js";

const longRunningMs = process.env.VALIDATION_LONG_MS
    ? Number(process.env.VALIDATION_LONG_MS)
    : undefined;

process.stdout.write("R7.0H Production Validation Suite\n");

const result = await runProductionValidation({
    longRunningMs: Number.isFinite(longRunningMs) ? longRunningMs : undefined,
    writeReport: true,
    onScenarioComplete: (scenario) => {

        const mark = scenario.passed ? "PASS" : "FAIL";

        process.stdout.write(
            `  [${mark}] ${scenario.name} (${scenario.durationMs} ms)\n`
        );

        if (!scenario.passed) {

            for (const failure of scenario.failures ?? []) {

                process.stdout.write(`         - ${failure}\n`);

            }

        }

    }
});

process.stdout.write("\n");

process.stdout.write(
    `Overall: ${result.overallPass ? "PASS" : "FAIL"} | `
        + `scenarios=${result.statistics.scenarios} `
        + `passed=${result.statistics.passed} `
        + `failed=${result.statistics.failed} `
        + `warnings=${result.statistics.warnings}\n`
);

if (result.reportPath) {

    process.stdout.write(`Report: ${result.reportPath}\n`);

}

process.exit(result.overallPass ? 0 : 1);
