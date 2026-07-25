/**
 * R8.0C — Markdown certification report builder.
 */

import { CERTIFICATION_STATUS } from "./CertificationStatus.js";

export class CertificationReportBuilder {

    /**
     * @param {{
     *   certificate: object,
     *   evidence: object[],
     *   summary: object,
     *   recommendation?: string
     * }} input
     */
    build(input) {

        const {
            certificate,
            evidence = [],
            summary = {},
            recommendation = null
        } = input;

        const status = certificate?.status ?? CERTIFICATION_STATUS.NOT_CERTIFIED;

        const betaReady = status === CERTIFICATION_STATUS.PASSED
            || status === CERTIFICATION_STATUS.PASSED_WITH_WARNINGS;

        const lines = [
            "# Release Certification Report",
            "",
            `**Version:** ${certificate?.version ?? "—"}`,
            `**Channel:** ${certificate?.channel ?? "—"}`,
            `**Status:** ${status}`,
            `**Timestamp (UTC):** ${certificate?.certifiedAt ?? "—"}`,
            `**Commit:** ${certificate?.commit ?? "—"}`,
            `**Fingerprint:** \`${certificate?.fingerprint ?? "—"}\``,
            `**Evidence hash:** \`${certificate?.evidenceHash ?? "—"}\``,
            "",
            "---",
            "",
            "## Overall status",
            "",
            `| Metric | Value |`,
            `|--------|-------|`,
            `| Checks | ${summary.total ?? evidence.length} |`,
            `| Passed | ${summary.passed ?? 0} |`,
            `| Warnings | ${summary.warnings ?? 0} |`,
            `| Failures | ${summary.failures ?? 0} |`,
            `| Duration | ${certificate?.durationMs ?? "—"} ms |`,
            `| Closed Beta ready | ${betaReady ? "YES" : "NO"} |`,
            "",
            "## Checks",
            "",
            `| Check | Category | Status | Duration (ms) |`,
            `|-------|----------|--------|---------------|`
        ];

        for (const item of evidence) {

            lines.push(
                `| ${item.name} | ${item.category} | ${item.status} | ${item.durationMs} |`
            );

        }

        const warnings = evidence.filter((e) => e.status === "WARN");

        const failures = evidence.filter((e) => e.status === "FAIL");

        lines.push("", "## Warnings", "");

        if (!warnings.length) {

            lines.push("_None_");

        } else {

            for (const w of warnings) {

                lines.push(`### ${w.name}`, "");

                for (const rec of w.recommendations ?? []) {

                    lines.push(`- ${rec}`);

                }

                lines.push("");

            }

        }

        lines.push("## Failures", "");

        if (!failures.length) {

            lines.push("_None_");

        } else {

            for (const f of failures) {

                lines.push(`### ${f.name}`, "");

                for (const rec of f.recommendations ?? []) {

                    lines.push(`- ${rec}`);

                }

                lines.push("");

            }

        }

        lines.push(
            "## Security summary",
            "",
            this._findDetails(evidence, "security"),
            "",
            "## Operational summary",
            "",
            this._findDetails(evidence, "infrastructure"),
            "",
            this._findDetails(evidence, "deployment"),
            "",
            "## Recommendation",
            "",
            recommendation
                ?? (betaReady
                    ? "Release Candidate is certified for Closed Beta."
                    : "Do not begin Closed Beta until failures are resolved and certification is re-run."),
            ""
        );

        return lines.join("\n");

    }

    _findDetails(evidence, category) {

        const item = evidence.find((e) => e.category === category);

        if (!item) {

            return "_No evidence_";

        }

        return "```json\n"
            + JSON.stringify(item.details ?? {}, null, 2)
            + "\n```";

    }

}
