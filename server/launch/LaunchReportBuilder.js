/**
 * R8.0E — Markdown launch readiness reports.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function mdTable(headers, rows) {

    const head = `| ${headers.join(" | ")} |`;

    const sep = `| ${headers.map(() => "---").join(" | ")} |`;

    const body = rows.map((r) => `| ${r.join(" | ")} |`).join("\n");

    return `${head}\n${sep}\n${body}`;

}

export class LaunchReportBuilder {

    /**
     * @param {"open_beta"|"production"} kind
     * @param {object} input
     */
    buildMarkdown(kind, input) {

        if (kind === "production") {

            return this._buildProduction(input);

        }

        return this._buildOpenBeta(input);

    }

    /**
     * @param {string} absolutePath
     * @param {"open_beta"|"production"} kind
     * @param {object} input
     */
    writeReport(absolutePath, kind, input) {

        const markdown = this.buildMarkdown(kind, input);

        mkdirSync(dirname(absolutePath), { recursive: true });

        writeFileSync(absolutePath, markdown, "utf8");

        return { path: absolutePath, markdown };

    }

    _buildOpenBeta(input) {

        const openBeta = input.openBeta ?? {};

        const decision = input.decision ?? {};

        const beta = input.closedBeta ?? {};

        const lines = [
            "# R8.0E — Open Beta Readiness Report",
            "",
            "**Stage:** Open Beta Readiness & Production Launch Gates  ",
            `**Generated:** ${new Date().toISOString()}  `,
            `**RC version:** ${input.rcVersion ?? "unknown"}  `,
            `**Launch lifecycle:** ${input.lifecycle ?? "n/a"}  `,
            `**Launch decision:** ${decision.decision ?? "n/a"} (score ${decision.score ?? "n/a"})  `,
            "",
            "---",
            "",
            "## Closed Beta summary",
            "",
            mdTable(
                ["Metric", "Value"],
                [
                    ["Lifecycle", String(beta.lifecycle ?? "n/a")],
                    ["Readiness", String(beta.readiness ?? "n/a")],
                    ["Participants", String(beta.participantCount ?? 0)],
                    ["Crash rate", String(beta.crashRate ?? 0)],
                    ["Open critical incidents", String(beta.incidents?.openCritical ?? 0)]
                ]
            ),
            "",
            "## Open Beta assessment",
            "",
            mdTable(
                ["Metric", "Value"],
                [
                    ["Ready", openBeta.ready ? "yes" : "no"],
                    ["Score", String(openBeta.score ?? 0)],
                    ["Gates", String(openBeta.gates?.length ?? 0)],
                    ["Blockers", String(openBeta.blockers?.length ?? 0)]
                ]
            ),
            "",
            "## Launch gate summary",
            "",
            mdTable(
                ["Gate", "Status", "Severity", "Detail"],
                (openBeta.gates ?? []).map((g) => [
                    g.id,
                    g.status,
                    g.severity,
                    String(JSON.stringify(g.details ?? {})).replace(/\|/g, "/")
                        .slice(0, 80)
                ])
            ),
            "",
            "## Blocker summary",
            "",
            (openBeta.blockers ?? []).length
                ? mdTable(
                    ["Id", "Severity", "Recommendation"],
                    (openBeta.blockers ?? []).map((b) => [
                        b.id,
                        b.severity,
                        (b.recommendations?.[0] ?? "").replace(/\|/g, "/")
                    ])
                )
                : "_No blockers._",
            "",
            "## Operational readiness",
            "",
            mdTable(
                ["Check", "Value"],
                [
                    [
                        "Avg latency (ms)",
                        String(beta.telemetry?.averageLatencyMs ?? "n/a")
                    ],
                    [
                        "Recovery success",
                        String(beta.telemetry?.recoverySuccessRate ?? "n/a")
                    ],
                    [
                        "Settlement success",
                        String(beta.telemetry?.settlementSuccessRate ?? "n/a")
                    ]
                ]
            ),
            "",
            "## Final launch recommendation",
            "",
            `**${decision.decision ?? "NOT_READY"}** — ${decision.reason ?? ""}`,
            "",
            "_Observational only. Gameplay, networking, blockchain, release, certification, and Closed Beta systems were not modified._",
            ""
        ];

        return lines.join("\n");

    }

    _buildProduction(input) {

        const production = input.production ?? {};

        const openBeta = input.openBeta ?? {};

        const decision = input.decision ?? {};

        const lines = [
            "# R8.0E — Production Launch Readiness Report",
            "",
            "**Stage:** Open Beta Readiness & Production Launch Gates  ",
            `**Generated:** ${new Date().toISOString()}  `,
            `**RC version:** ${input.rcVersion ?? "unknown"}  `,
            `**Launch lifecycle:** ${input.lifecycle ?? "n/a"}  `,
            `**Launch decision:** ${decision.decision ?? "n/a"} (score ${decision.score ?? "n/a"})  `,
            "",
            "---",
            "",
            "## Open Beta assessment",
            "",
            mdTable(
                ["Metric", "Value"],
                [
                    ["Ready", openBeta.ready ? "yes" : "no"],
                    ["Score", String(openBeta.score ?? 0)]
                ]
            ),
            "",
            "## Production assessment",
            "",
            mdTable(
                ["Metric", "Value"],
                [
                    ["Ready", production.ready ? "yes" : "no"],
                    ["Score", String(production.score ?? 0)],
                    [
                        "Documentation completeness",
                        String(production.documentationCompleteness ?? 0)
                    ],
                    ["Gates", String(production.gates?.length ?? 0)],
                    ["Blockers", String(production.blockers?.length ?? 0)]
                ]
            ),
            "",
            "## Launch gate summary",
            "",
            mdTable(
                ["Gate", "Status", "Severity"],
                (production.gates ?? []).map((g) => [
                    g.id,
                    g.status,
                    g.severity
                ])
            ),
            "",
            "## Blocker summary",
            "",
            (production.blockers ?? []).length
                ? mdTable(
                    ["Id", "Severity", "Recommendation"],
                    (production.blockers ?? []).map((b) => [
                        b.id,
                        b.severity,
                        (b.recommendations?.[0] ?? "").replace(/\|/g, "/")
                    ])
                )
                : "_No blockers._",
            "",
            "## Documentation readiness",
            "",
            `Completeness: **${production.documentationCompleteness ?? 0}**`,
            "",
            "## Infrastructure readiness",
            "",
            mdTable(
                ["Area", "Status"],
                [
                    ["Monitoring", String(input.monitoring?.enabled ?? "n/a")],
                    ["Health", String(input.health?.status ?? "n/a")],
                    ["Deployment profile", String(input.deployment?.profile ?? "n/a")]
                ]
            ),
            "",
            "## Blockchain readiness",
            "",
            mdTable(
                ["Metric", "Value"],
                [
                    ["Network", String(input.ton?.network ?? "n/a")],
                    [
                        "Settlement success",
                        String(
                            input.closedBeta?.telemetry?.settlementSuccessRate
                                ?? "n/a"
                        )
                    ]
                ]
            ),
            "",
            "## Security readiness",
            "",
            mdTable(
                ["Check", "Value"],
                [
                    [
                        "Critical blockers",
                        String(
                            (decision.blockers ?? []).filter(
                                (b) => b.severity === "CRITICAL"
                            ).length
                        )
                    ],
                    ["Certification", String(input.certification?.status ?? "n/a")]
                ]
            ),
            "",
            "## Final launch recommendation",
            "",
            `**${decision.decision ?? "NOT_READY"}** — ${decision.reason ?? ""}`,
            "",
            "_Only CRITICAL blockers prevent PRODUCTION_READY. Observational evaluation only._",
            ""
        ];

        return lines.join("\n");

    }

}
