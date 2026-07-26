/**
 * R9.0B — Post-launch operations markdown report.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function mdTable(headers, rows) {

    const head = `| ${headers.join(" | ")} |`;

    const sep = `| ${headers.map(() => "---").join(" | ")} |`;

    const body = rows.map((r) => `| ${r.join(" | ")} |`).join("\n");

    return `${head}\n${sep}\n${body}`;

}

export class OperationalReportBuilder {

    /**
     * @param {object} input
     */
    buildMarkdown(input) {

        const kpi = input.kpi ?? {};

        const sla = input.sla ?? {};

        const versions = input.versions ?? {};

        const maintenance = input.maintenance ?? {};

        const incidents = input.incidents ?? {};

        const trends = input.trends ?? {};

        const lines = [
            "# R9.0B — Post-Launch Operations Report",
            "",
            "**Stage:** Post-Launch Operations & Continuous Service Management  ",
            `**Generated:** ${new Date().toISOString()}  `,
            `**Service lifecycle:** ${input.lifecycle ?? "n/a"}  `,
            `**Active version:** ${versions.activeVersion ?? "n/a"}  `,
            `**Operational score:** ${input.operationalScore ?? "n/a"}  `,
            "",
            "---",
            "",
            "## Service summary",
            "",
            mdTable(
                ["Field", "Value"],
                [
                    ["Lifecycle", String(input.lifecycle ?? "n/a")],
                    ["Uptime (ms)", String(input.uptimeMs ?? 0)],
                    [
                        "Health score",
                        String(input.healthScore ?? "n/a")
                    ]
                ]
            ),
            "",
            "## Current version",
            "",
            mdTable(
                ["Field", "Value"],
                [
                    ["Active", String(versions.activeVersion ?? "n/a")],
                    ["Total tracked", String(versions.total ?? 0)],
                    [
                        "Supported",
                        String(versions.byStatus?.SUPPORTED ?? 0)
                    ],
                    [
                        "Deprecated",
                        String(versions.byStatus?.DEPRECATED ?? 0)
                    ],
                    [
                        "Retired",
                        String(versions.byStatus?.RETIRED ?? 0)
                    ]
                ]
            ),
            "",
            "## KPI summary",
            "",
            mdTable(
                ["KPI", "Value"],
                [
                    ["Availability", String(kpi.availability ?? 0)],
                    ["Avg latency (ms)", String(kpi.averageLatencyMs ?? 0)],
                    ["Peak latency (ms)", String(kpi.peakLatencyMs ?? 0)],
                    ["Error rate", String(kpi.errorRate ?? 0)],
                    ["Crash rate", String(kpi.crashRate ?? 0)],
                    [
                        "Recovery success",
                        String(kpi.recoverySuccessRate ?? 0)
                    ],
                    [
                        "Payment success",
                        String(kpi.paymentSuccessRate ?? 0)
                    ],
                    [
                        "Settlement success",
                        String(kpi.settlementSuccessRate ?? 0)
                    ],
                    ["Reconnect rate", String(kpi.reconnectRate ?? 0)],
                    [
                        "Memory utilization",
                        String(kpi.memoryUtilization ?? 0)
                    ],
                    [
                        "Daily active sessions",
                        String(kpi.dailyActiveSessions ?? 0)
                    ]
                ]
            ),
            "",
            "## SLA summary",
            "",
            mdTable(
                ["SLA", "Status", "Target", "Actual"],
                (sla.results ?? []).map((r) => [
                    r.id,
                    r.status,
                    String(r.target ?? "n/a"),
                    String(r.actual ?? "n/a")
                ])
            ),
            "",
            `SLA score: **${sla.score ?? 0}** (passed ${sla.passed ?? 0}, warning ${sla.warned ?? 0}, failed ${sla.failed ?? 0})`,
            "",
            "## Maintenance summary",
            "",
            mdTable(
                ["Field", "Value"],
                [
                    ["Active", maintenance.active ? "yes" : "no"],
                    ["Total windows", String(maintenance.summary?.total ?? 0)],
                    [
                        "Completed",
                        String(maintenance.summary?.byOutcome?.COMPLETED ?? 0)
                    ]
                ]
            ),
            "",
            "## Incident summary",
            "",
            mdTable(
                ["Field", "Value"],
                [
                    ["Total", String(incidents.total ?? 0)],
                    ["Open", String(incidents.open ?? 0)],
                    ["Open critical", String(incidents.openCritical ?? 0)],
                    ["Escalations", String(incidents.escalations ?? 0)]
                ]
            ),
            "",
            "## Trend analysis",
            "",
            mdTable(
                ["Metric", "Latest", "Average", "Trend"],
                Object.entries(trends.trends ?? {}).map(([key, t]) => [
                    key,
                    String(t.latest),
                    String(t.average),
                    String(t.trend)
                ])
            ),
            "",
            "## Operational recommendations",
            "",
            ...(input.recommendations?.length
                ? input.recommendations.map((r) => `- ${r}`)
                : ["- Continue normal operation monitoring."]),
            "",
            "## Long-term service assessment",
            "",
            `**${input.assessment ?? "STABLE"}** — operational score ${input.operationalScore ?? 0}/100.`,
            "",
            "_Observational only. Gameplay, networking, blockchain, release, and launch orchestration systems were not modified._",
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
