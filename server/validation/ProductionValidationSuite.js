/**
 * R7.0H — Production Validation Suite entry point.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ValidationRunner } from "./ValidationRunner.js";
import { ValidationReportBuilder } from "./ValidationReportBuilder.js";
import { LongRunningScenario } from "./scenarios/LongRunningScenario.js";
import { HighLoadScenario } from "./scenarios/HighLoadScenario.js";
import { GracefulShutdownScenario } from "./scenarios/GracefulShutdownScenario.js";
import { RestartScenario } from "./scenarios/RestartScenario.js";
import { FailureRecoveryScenario } from "./scenarios/FailureRecoveryScenario.js";
import { MonitoringScenario } from "./scenarios/MonitoringScenario.js";
import { LoggingScenario } from "./scenarios/LoggingScenario.js";
import { DeploymentScenario } from "./scenarios/DeploymentScenario.js";
import { BlockchainSimulationScenario } from "./scenarios/BlockchainSimulationScenario.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export class ProductionValidationSuite {

    /**
     * @param {{
     *   longRunningMs?: number,
     *   writeReport?: boolean,
     *   reportPath?: string,
     *   onScenarioComplete?: (result: object) => void
     * }} [options]
     */
    constructor(options = {}) {

        this._options = options;

        this._scenarios = [
            new LongRunningScenario(),
            new HighLoadScenario(),
            new GracefulShutdownScenario(),
            new RestartScenario(),
            new FailureRecoveryScenario(),
            new MonitoringScenario(),
            new LoggingScenario(),
            new DeploymentScenario(),
            new BlockchainSimulationScenario()
        ];

    }

    listScenarios() {

        return this._scenarios.map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description
        }));

    }

    async run() {

        const runner = new ValidationRunner({
            scenarios: this._scenarios,
            context: {
                longRunningMs: this._options.longRunningMs
            },
            onScenarioComplete: this._options.onScenarioComplete
        });

        const { results, statistics } = await runner.runAll();

        const reportMarkdown = new ValidationReportBuilder().build({
            title: "R7.0H — Production Validation Report",
            stage: "Production Validation Suite",
            date: new Date().toISOString().slice(0, 10),
            results,
            statistics
        });

        let reportPath = null;

        if (this._options.writeReport !== false) {

            reportPath = this._options.reportPath
                ?? resolve(
                    __dirname,
                    "../../docs/architecture/R7.0H-Production-Validation-Report.md"
                );

            mkdirSync(dirname(reportPath), { recursive: true });

            writeFileSync(reportPath, reportMarkdown, "utf8");

        }

        return {
            results,
            statistics,
            reportMarkdown,
            reportPath,
            overallPass: statistics.overallPass === true
        };

    }

}

/**
 * CLI / programmatic entry.
 */
export async function runProductionValidation(options = {}) {

    const suite = new ProductionValidationSuite(options);

    return suite.run();

}
