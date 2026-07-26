/**
 * R9.0C — Platform governance markdown report.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function mdTable(headers, rows) {

    const head = `| ${headers.join(" | ")} |`;

    const sep = `| ${headers.map(() => "---").join(" | ")} |`;

    const body = rows.map((r) => `| ${r.join(" | ")} |`).join("\n");

    return `${head}\n${sep}\n${body}`;

}

export class GovernanceReportBuilder {

    /**
     * @param {object} input
     */
    buildMarkdown(input) {

        const audit = input.audit ?? {};

        const compliance = input.compliance ?? {};

        const risk = input.risk ?? {};

        const policies = input.policies ?? {};

        const archive = input.archive ?? {};

        const review = input.review ?? {};

        const decision = input.decision ?? {};

        const lines = [
            "# R9.0C — Platform Governance Report",
            "",
            "**Stage:** Long-Term Platform Governance & Operational Audit  ",
            `**Generated:** ${new Date().toISOString()}  `,
            `**Governance lifecycle:** ${input.lifecycle ?? "n/a"}  `,
            `**Governance score:** ${input.governanceScore ?? "n/a"}  `,
            `**Decision:** ${decision.status ?? "n/a"}  `,
            "",
            "---",
            "",
            "## Governance summary",
            "",
            mdTable(
                ["Field", "Value"],
                [
                    ["Lifecycle", String(input.lifecycle ?? "n/a")],
                    ["Cycle", String(input.cycle ?? 0)],
                    ["Score", String(input.governanceScore ?? 0)],
                    ["Decision", String(decision.status ?? "n/a")],
                    [
                        "Decision reason",
                        String(decision.reason ?? "").replace(/\|/g, "/")
                    ]
                ]
            ),
            "",
            "## Audit summary",
            "",
            mdTable(
                ["Field", "Value"],
                [
                    ["Score", String(audit.score ?? 0)],
                    ["Passed", String(audit.passed ?? 0)],
                    ["Warned", String(audit.warned ?? 0)],
                    ["Failed", String(audit.failed ?? 0)]
                ]
            ),
            "",
            mdTable(
                ["Domain", "Status"],
                (audit.records ?? []).map((r) => [r.domain, r.status])
            ),
            "",
            "## Compliance summary",
            "",
            mdTable(
                ["Item", "Status", "Policy"],
                (compliance.results ?? []).map((r) => [
                    r.id,
                    r.status,
                    r.policyId ?? "—"
                ])
            ),
            "",
            `Compliance score: **${compliance.score ?? 0}**`,
            "",
            "## Risk summary",
            "",
            mdTable(
                ["Risk", "Category", "Severity", "Score"],
                (risk.risks ?? []).map((r) => [
                    r.id,
                    r.category,
                    r.severity,
                    String(r.score)
                ])
            ),
            "",
            `Risk score (higher better): **${risk.score ?? 0}**`,
            "",
            "## Policy summary",
            "",
            mdTable(
                ["Field", "Value"],
                [
                    ["Total", String(policies.total ?? 0)],
                    ["Approved", String(policies.approved ?? 0)]
                ]
            ),
            "",
            "## Evidence summary",
            "",
            mdTable(
                ["Field", "Value"],
                [
                    ["Archive entries", String(archive.total ?? 0)],
                    [
                        "Latest hash",
                        String(archive.latestHash ?? "n/a").slice(0, 24)
                    ],
                    [
                        "Retention days",
                        String(archive.retentionDays ?? "n/a")
                    ]
                ]
            ),
            "",
            "## Platform review",
            "",
            mdTable(
                ["Field", "Value"],
                [
                    ["Review id", String(review.id ?? "n/a")],
                    ["Score", String(review.score ?? 0)],
                    [
                        "Recommendations",
                        String((review.recommendations ?? []).length)
                    ]
                ]
            ),
            "",
            "## Governance recommendations",
            "",
            ...(input.recommendations?.length
                ? input.recommendations.map((r) => `- ${r}`)
                : ["- Continue scheduled governance cycles."]),
            "",
            "_Governance only. Gameplay, infrastructure, operations, and release pipelines were not modified._",
            ""
        ];

        return lines.join("\n");

    }

    /**
     * @param {string} absolutePath
     * @param {object} input
     */
    writeReport(absolutePath, input) {

        const markdown = this.buildMarkdown(input);

        mkdirSync(dirname(absolutePath), { recursive: true });

        writeFileSync(absolutePath, markdown, "utf8");

        return { path: absolutePath, markdown };

    }

}
