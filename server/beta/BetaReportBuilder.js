/**
 * R8.0D — Markdown Closed Beta operational report builder.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function pct(rate) {

    if (!Number.isFinite(rate)) {

        return "n/a";

    }

    return `${(rate * 100).toFixed(1)}%`;

}

function mdTable(headers, rows) {

    const head = `| ${headers.join(" | ")} |`;

    const sep = `| ${headers.map(() => "---").join(" | ")} |`;

    const body = rows.map((r) => `| ${r.join(" | ")} |`).join("\n");

    return `${head}\n${sep}\n${body}`;

}

export class BetaReportBuilder {

    /**
     * @param {{
     *   lifecycle: string,
     *   rcVersion?: string|null,
     *   certification?: object|null,
     *   participants: object,
     *   metrics: object,
     *   readiness: object,
     *   feedbackSummary: object,
     *   incidentSummary: object,
     *   crashSummary: object,
     *   recommendations?: string[]
     * }} input
     */
    buildMarkdown(input) {

        const t = input.metrics?.telemetry ?? {};

        const session = t.session ?? {};

        const network = t.network ?? {};

        const recovery = t.recovery ?? {};

        const payment = t.payment ?? {};

        const gameplay = t.gameplay ?? {};

        const readiness = input.readiness ?? {};

        const recommendations = input.recommendations?.length
            ? input.recommendations
            : this._defaultRecommendations(input);

        const lines = [
            "# R8.0D — Closed Beta Operational Report",
            "",
            "**Stage:** Closed Beta Operations & Telemetry  ",
            `**Generated:** ${new Date().toISOString()}  `,
            `**RC version:** ${input.rcVersion ?? "unknown"}  `,
            `**Lifecycle:** ${input.lifecycle}  `,
            `**Readiness:** ${readiness.readiness ?? "n/a"} (score ${readiness.score ?? "n/a"})  `,
            `**Certification:** ${input.certification?.status ?? "n/a"}  `,
            "",
            "---",
            "",
            "## Participant summary",
            "",
            mdTable(
                ["Metric", "Value"],
                [
                    ["Total", String(input.participants?.total ?? 0)],
                    ["Active", String(input.participants?.active ?? 0)],
                    ["Approved", String(input.participants?.approved ?? 0)],
                    ["Pending", String(input.participants?.pending ?? 0)],
                    ["Invited", String(input.participants?.invited ?? 0)]
                ]
            ),
            "",
            "## Session summary",
            "",
            mdTable(
                ["Metric", "Value"],
                [
                    ["Games started", String(session.gamesStarted ?? 0)],
                    ["Games completed", String(session.gamesCompleted ?? 0)],
                    ["Games abandoned", String(session.gamesAbandoned ?? 0)],
                    ["Reconnects", String(session.reconnectCount ?? 0)],
                    ["Active sessions", String(t.activeSessions ?? 0)],
                    [
                        "Avg game duration (ms)",
                        String(session.averageGameDurationMs ?? 0)
                    ]
                ]
            ),
            "",
            "## Telemetry summary",
            "",
            mdTable(
                ["Domain", "Highlight"],
                [
                    [
                        "Network",
                        `avg latency ${network.averageLatencyMs ?? 0}ms / max ${network.maximumLatencyMs ?? 0}ms`
                    ],
                    [
                        "Recovery",
                        `success ${pct(recovery.recoverySuccessRate)} / failures ${recovery.recoveryFailures ?? 0}`
                    ],
                    [
                        "Payments",
                        `completed ${payment.paymentsCompleted ?? 0} / failed ${payment.paymentsFailed ?? 0} / settlement ${pct(payment.settlementSuccessRate)}`
                    ],
                    [
                        "Gameplay",
                        `spins ${gameplay.wheelSpins ?? 0} / desync ${gameplay.desynchronizationCount ?? 0} / physics anomalies ${gameplay.physicsAnomalies ?? 0}`
                    ]
                ]
            ),
            "",
            "## Crash summary",
            "",
            mdTable(
                ["Metric", "Value"],
                [
                    ["Total crashes", String(input.crashSummary?.total ?? 0)],
                    ["Fatal", String(input.crashSummary?.fatal ?? 0)],
                    ["Recent hour", String(input.crashSummary?.recentHour ?? 0)],
                    ["Crash rate", String(input.metrics?.crashRate ?? 0)]
                ]
            ),
            "",
            "## Incident summary",
            "",
            mdTable(
                ["Metric", "Value"],
                [
                    ["Total", String(input.incidentSummary?.total ?? 0)],
                    ["Open critical", String(input.incidentSummary?.openCritical ?? 0)]
                ]
            ),
            "",
            "## Feedback summary",
            "",
            mdTable(
                ["Metric", "Value"],
                [
                    ["Total", String(input.feedbackSummary?.total ?? 0)],
                    [
                        "Open",
                        String(input.feedbackSummary?.byStatus?.OPEN ?? 0)
                    ],
                    [
                        "Critical (all statuses)",
                        String(input.feedbackSummary?.bySeverity?.CRITICAL ?? 0)
                    ]
                ]
            ),
            "",
            "## Performance summary",
            "",
            mdTable(
                ["Phase", "Avg duration (ms)"],
                [
                    ["Setup", String(session.averageSetupDurationMs ?? 0)],
                    ["Payment", String(session.averagePaymentDurationMs ?? 0)],
                    ["READY", String(session.averageReadyPhaseDurationMs ?? 0)],
                    ["SPEED", String(session.averageSpeedPhaseDurationMs ?? 0)],
                    ["BRAKE", String(session.averageBrakePhaseDurationMs ?? 0)],
                    ["RESULT", String(session.averageResultPhaseDurationMs ?? 0)]
                ]
            ),
            "",
            "## Gameplay integrity summary",
            "",
            mdTable(
                ["Check", "Value"],
                [
                    [
                        "Authoritative sync failures",
                        String(gameplay.authoritativeSyncFailures ?? 0)
                    ],
                    [
                        "Desynchronization count",
                        String(gameplay.desynchronizationCount ?? 0)
                    ],
                    [
                        "Config validation failures",
                        String(gameplay.configurationValidationFailures ?? 0)
                    ],
                    [
                        "Physics anomalies",
                        String(gameplay.physicsAnomalies ?? 0)
                    ]
                ]
            ),
            "",
            "## Blockchain summary",
            "",
            mdTable(
                ["Metric", "Value"],
                [
                    [
                        "Payments initiated",
                        String(payment.paymentsInitiated ?? 0)
                    ],
                    [
                        "Payments completed",
                        String(payment.paymentsCompleted ?? 0)
                    ],
                    [
                        "Payments failed",
                        String(payment.paymentsFailed ?? 0)
                    ],
                    [
                        "Settlement success rate",
                        pct(payment.settlementSuccessRate)
                    ],
                    [
                        "Settlement duration (ms)",
                        String(payment.settlementDurationMs ?? 0)
                    ]
                ]
            ),
            "",
            "## Readiness evaluation",
            "",
            mdTable(
                ["Check", "OK", "Detail"],
                (readiness.checks ?? []).map((c) => [
                    c.id,
                    c.ok ? "yes" : "no",
                    String(c.detail ?? "").replace(/\|/g, "/")
                ])
            ),
            "",
            "## Operational recommendations",
            "",
            ...recommendations.map((r) => `- ${r}`),
            "",
            "## Final readiness recommendation",
            "",
            `**${readiness.readiness ?? "NOT_READY"}** — score ${readiness.score ?? 0}/100.`,
            "",
            "_This report is observational. Gameplay, networking, blockchain, release packaging, and certification systems were not modified by Closed Beta operations._",
            ""
        ];

        return lines.join("\n");

    }

    /**
     * @param {string} absolutePath
     * @param {Parameters<BetaReportBuilder["buildMarkdown"]>[0]} input
     */
    writeReport(absolutePath, input) {

        const markdown = this.buildMarkdown(input);

        mkdirSync(dirname(absolutePath), { recursive: true });

        writeFileSync(absolutePath, markdown, "utf8");

        return { path: absolutePath, markdown };

    }

    _defaultRecommendations(input) {

        const out = [];

        const readiness = input.readiness?.readiness;

        if (readiness === "READY_FOR_OPEN_BETA") {

            out.push("Proceed to Open Beta planning with the certified RC build.");

            out.push("Keep crash and incident collectors enabled during Open Beta ramp.");

        } else if (readiness === "NEEDS_ATTENTION") {

            out.push("Resolve failing readiness checks before promoting to Open Beta.");

            out.push("Triage open HIGH/CRITICAL feedback and non-critical incidents.");

        } else {

            out.push("Do not promote to Open Beta until critical blockers are cleared.");

            out.push("Investigate open critical incidents and gameplay integrity failures first.");

        }

        if ((input.crashSummary?.total ?? 0) > 0) {

            out.push("Review crash stacks (already redacted) for recurring fatal paths.");

        }

        if ((input.incidentSummary?.openCritical ?? 0) > 0) {

            out.push("Close or mitigate all CRITICAL incidents before READY_FOR_REVIEW.");

        }

        return out;

    }

}
