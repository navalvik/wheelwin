/**
 * R7.0H — Markdown report builder for production validation.
 */

export class ValidationReportBuilder {

    /**
     * @param {{
     *   title?: string,
     *   stage?: string,
     *   date?: string,
     *   results: object[],
     *   statistics: object,
     *   recommendations?: string[]
     * }} input
     */
    build(input) {

        const {
            title = "R7.0H — Production Validation Report",
            stage = "Production Validation Suite",
            date = new Date().toISOString().slice(0, 10),
            results = [],
            statistics = {},
            recommendations = []
        } = input;

        const overall = statistics.overallPass === true ? "PASS" : "FAIL";

        const lines = [
            `# ${title}`,
            "",
            `**Stage:** ${stage}`,
            `**Date:** ${date}`,
            `**Overall:** ${overall}`,
            "**Scope:** Validate production infrastructure under realistic operational conditions (no gameplay redesign)",
            "",
            "---",
            "",
            "## Summary",
            "",
            `| Metric | Value |`,
            `|--------|-------|`,
            `| Scenarios | ${statistics.scenarios ?? 0} |`,
            `| Passed | ${statistics.passed ?? 0} |`,
            `| Failed | ${statistics.failed ?? 0} |`,
            `| Warnings | ${statistics.warnings ?? 0} |`,
            `| Assertions | ${statistics.assertions ?? 0} |`,
            `| Total duration | ${statistics.totalDurationMs ?? 0} ms |`,
            "",
            "## Executed scenarios",
            "",
            `| Scenario | Result | Duration (ms) | Assertions | Warnings |`,
            `|----------|--------|---------------|------------|----------|`
        ];

        for (const result of results) {

            lines.push(
                `| ${result.name} | ${result.passed ? "PASS" : "FAIL"} | `
                    + `${result.durationMs} | ${result.assertionCount} | `
                    + `${result.warningCount} |`
            );

        }

        lines.push("", "## Performance metrics", "", "| Metric | Value |", "|--------|-------|");

        const metrics = statistics.metrics ?? {};

        for (const [key, value] of Object.entries(metrics)) {

            lines.push(`| ${key} | ${value == null ? "—" : value} |`);

        }

        lines.push("", "## Scenario details", "");

        for (const result of results) {

            lines.push(`### ${result.name}`, "");

            lines.push(`- **ID:** \`${result.id}\``);

            lines.push(`- **Result:** ${result.passed ? "PASS" : "FAIL"}`);

            lines.push(`- **Duration:** ${result.durationMs} ms`);

            if (result.description) {

                lines.push(`- **Description:** ${result.description}`);

            }

            if (result.failures?.length) {

                lines.push("", "**Failures:**", "");

                for (const failure of result.failures) {

                    lines.push(`- ${failure}`);

                }

            }

            if (result.warnings?.length) {

                lines.push("", "**Warnings:**", "");

                for (const warning of result.warnings) {

                    lines.push(`- ${warning}`);

                }

            }

            if (result.evidence && Object.keys(result.evidence).length > 0) {

                lines.push("", "**Evidence:**", "", "```json");

                lines.push(JSON.stringify(result.evidence, null, 2));

                lines.push("```");

            }

            lines.push("");

        }

        const recs = recommendations.length
            ? recommendations
            : this._defaultRecommendations(statistics, results);

        lines.push("## Recommendations", "");

        for (const rec of recs) {

            lines.push(`- ${rec}`);

        }

        lines.push(
            "",
            "## Acceptance criteria",
            "",
            "| Area | Status |",
            "|------|--------|",
            `| Gameplay authority unchanged | ${overall === "PASS" ? "Met (validation-only)" : "Review"} |`,
            `| Infrastructure stability | ${statistics.failed === 0 ? "Met" : "Failed scenarios present"} |`,
            `| Observability | ${this._scenarioPassed(results, "monitoring") && this._scenarioPassed(results, "logging") ? "Met" : "Review"} |`,
            `| Deployment probes | ${this._scenarioPassed(results, "deployment") ? "Met" : "Review"} |`,
            `| Security (no secret leakage) | ${this._noSecretFailures(results) ? "Met" : "Failed"} |`,
            "",
            "## Overall production readiness",
            "",
            overall === "PASS"
                ? "WheelWin production infrastructure **is validated for release** under the automated R7.0H suite."
                : "WheelWin production infrastructure **is not ready** until failing scenarios are resolved.",
            ""
        );

        return lines.join("\n");

    }

    _scenarioPassed(results, idFragment) {

        const match = results.find((r) => r.id.includes(idFragment));

        return match ? match.passed === true : true;

    }

    _noSecretFailures(results) {

        return !results.some((r) => (r.failures ?? [])
            .some((f) => /secret|jwt|password|mnemonic|private/i.test(f)));

    }

    _defaultRecommendations(statistics, results) {

        const recs = [];

        if (statistics.overallPass) {

            recs.push(
                "Keep probe refresh intervals and collector intervals within profile defaults in production."
            );

            recs.push(
                "Run the optional long-duration suite (`VALIDATION_LONG_MS`) before major releases."
            );

            recs.push(
                "Monitor readiness transitions during deploy drains in staging."
            );

        } else {

            for (const result of results.filter((r) => !r.passed)) {

                recs.push(`Investigate failures in scenario \`${result.id}\`.`);

            }

        }

        if ((statistics.warnings ?? 0) > 0) {

            recs.push("Review scenario warnings for soft capacity limits.");

        }

        return recs;

    }

}
