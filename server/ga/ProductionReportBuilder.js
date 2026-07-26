/**
 * R9.0A — GA release markdown report builder.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function mdTable(headers, rows) {

    const head = `| ${headers.join(" | ")} |`;

    const sep = `| ${headers.map(() => "---").join(" | ")} |`;

    const body = rows.map((r) => `| ${r.join(" | ")} |`).join("\n");

    return `${head}\n${sep}\n${body}`;

}

export class ProductionReportBuilder {

    /**
     * @param {object} input
     */
    buildMarkdown(input) {

        const release = input.release ?? {};

        const rollout = input.rollout ?? {};

        const verification = input.verification ?? {};

        const rollback = input.rollback ?? {};

        const metrics = input.metrics ?? {};

        const evidence = input.evidence ?? {};

        const announcement = input.announcement ?? {};

        const lines = [
            "# R9.0A — General Availability Release Report",
            "",
            "**Stage:** General Availability (GA) Release Orchestration  ",
            `**Generated:** ${new Date().toISOString()}  `,
            `**Lifecycle:** ${input.lifecycle ?? "n/a"}  `,
            `**Version:** ${release.version ?? "unknown"}  `,
            `**Channel:** ${release.channel ?? "n/a"}  `,
            `**Operational score:** ${metrics.operationalScore ?? "n/a"}  `,
            "",
            "---",
            "",
            "## Release summary",
            "",
            mdTable(
                ["Field", "Value"],
                [
                    ["Version", String(release.version ?? "n/a")],
                    ["Channel", String(release.channel ?? "n/a")],
                    ["Commit", String(release.commit ?? "n/a")],
                    ["Fingerprint", String(release.fingerprint ?? "n/a")],
                    [
                        "Certification ref",
                        String(release.certificationRef ?? "n/a")
                    ],
                    [
                        "Verification ref",
                        String(release.verificationRef ?? "n/a")
                    ],
                    [
                        "Announcement hash",
                        String(announcement.announcementHash ?? "n/a")
                            .slice(0, 24)
                    ]
                ]
            ),
            "",
            "## Rollout summary",
            "",
            mdTable(
                ["Field", "Value"],
                [
                    ["Mode", String(rollout.mode ?? "n/a")],
                    ["Stage", String(rollout.stage ?? "n/a")],
                    ["Complete", rollout.complete ? "yes" : "no"],
                    ["Duration (ms)", String(rollout.durationMs ?? 0)]
                ]
            ),
            "",
            "## Verification summary",
            "",
            mdTable(
                ["Field", "Value"],
                [
                    ["Status", String(verification.status ?? "n/a")],
                    ["Score", String(verification.score ?? 0)],
                    ["Duration (ms)", String(verification.durationMs ?? 0)],
                    ["Checks", String(verification.checks?.length ?? 0)]
                ]
            ),
            "",
            mdTable(
                ["Check", "Status", "Severity"],
                (verification.checks ?? []).map((c) => [
                    c.id,
                    c.status,
                    c.severity
                ])
            ),
            "",
            "## Operational summary",
            "",
            mdTable(
                ["Metric", "Value"],
                [
                    ["GA uptime (ms)", String(metrics.gaUptimeMs ?? 0)],
                    ["Health score", String(metrics.healthScore ?? 0)],
                    ["Deployment score", String(metrics.deploymentScore ?? 0)],
                    [
                        "Operational score",
                        String(metrics.operationalScore ?? 0)
                    ],
                    ["Incident count", String(metrics.incidentCount ?? 0)]
                ]
            ),
            "",
            "## Metrics summary",
            "",
            mdTable(
                ["Metric", "Value"],
                [
                    [
                        "Release duration (ms)",
                        String(metrics.releaseDurationMs ?? 0)
                    ],
                    [
                        "Verification duration (ms)",
                        String(metrics.verificationDurationMs ?? 0)
                    ],
                    [
                        "Rollout duration (ms)",
                        String(metrics.rolloutDurationMs ?? 0)
                    ]
                ]
            ),
            "",
            "## Evidence summary",
            "",
            mdTable(
                ["Field", "Value"],
                [
                    ["Total", String(evidence.total ?? 0)],
                    [
                        "Aggregate hash",
                        String(evidence.aggregateHash ?? "n/a").slice(0, 24)
                    ]
                ]
            ),
            "",
            "## Rollback evaluation",
            "",
            mdTable(
                ["Field", "Value"],
                [
                    ["Recommend rollback", rollback.recommend ? "YES" : "no"],
                    ["Severity", String(rollback.severity ?? "n/a")],
                    ["Reason", String(rollback.reason ?? "").replace(/\|/g, "/")],
                    ["Triggers", String(rollback.triggers?.length ?? 0)]
                ]
            ),
            "",
            "## Final GA decision",
            "",
            input.gaDecision
                ? `**${input.gaDecision}**`
                : (rollback.recommend
                    ? "**ROLLBACK_RECOMMENDED** — CRITICAL triggers present."
                    : (verification.status === "PASSED"
                        || verification.status === "PASSED_WITH_WARNINGS"
                        ? "**GA_ACTIVE / STABLE_RELEASE eligible** — verification passed."
                        : "**NOT_STABLE** — verification incomplete or failed.")),
            "",
            "_Observational orchestration only. Gameplay, networking, blockchain, release pipeline, and certification systems were not modified._",
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
