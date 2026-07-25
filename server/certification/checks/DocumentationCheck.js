/**
 * R8.0C — Documentation presence checks.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { CertificationCheck } from "./CertificationCheck.js";
import { CHECK_STATUS } from "../CertificationStatus.js";

const DOC_REQUIREMENTS = [
    { id: "readme", paths: ["README.md", "client/README.md", "server/README.md"] },
    { id: "rules", paths: ["client/public/docs/rules.md"] },
    { id: "faq", paths: ["client/public/docs/faq.md"] },
    { id: "privacy", paths: ["client/public/docs/privacy.md"] },
    { id: "terms", paths: ["client/public/docs/terms.md"] },
    { id: "changelog", paths: ["client/public/docs/changelog.md"] },
    {
        id: "releaseArchitecture",
        paths: ["docs/release/R8.0A-Release-Candidate-Architecture.md"]
    },
    {
        id: "validationReport",
        paths: [
            "docs/architecture/R7.0H-Production-Validation-Report.md",
            "docs/architecture/R8.0B-Release-Build-System-Validation.md"
        ],
        any: true
    }
];

export class DocumentationCheck extends CertificationCheck {

    constructor() {

        super({
            id: "documentation",
            name: "Documentation Completeness",
            category: "documentation"
        });

    }

    async run(context) {

        const root = context.repoRoot;

        const releaseDocs = context.releaseRoot
            ? join(context.releaseRoot, "documentation")
            : null;

        const found = {};

        const missing = [];

        const warnings = [];

        for (const req of DOC_REQUIREMENTS) {

            const hits = [];

            for (const rel of req.paths) {

                const candidates = [
                    join(root, rel)
                ];

                if (releaseDocs) {

                    candidates.push(join(releaseDocs, rel));

                    candidates.push(join(releaseDocs, "product", rel.split("/").pop()));

                }

                if (candidates.some((p) => existsSync(p))) {

                    hits.push(rel);

                }

            }

            const ok = req.any ? hits.length > 0 : hits.length > 0;

            // README: pass if ANY readme exists
            if (req.id === "readme") {

                found.readme = hits.length > 0;

                if (!found.readme) {

                    warnings.push("No README.md found at repo or client/server");

                }

                continue;

            }

            found[req.id] = ok;

            if (!ok) {

                if (req.id === "releaseArchitecture" || req.id === "validationReport") {

                    warnings.push(`Missing recommended doc: ${req.id}`);

                } else {

                    missing.push(req.id);

                }

            }

        }

        // Installation / deployment / API / runbook — soft until dedicated files exist
        const softDocs = [
            "docs/release/INSTALLATION.md",
            "docs/release/DEPLOYMENT.md",
            "docs/release/API.md",
            "docs/release/OPERATIONAL-RUNBOOK.md"
        ];

        for (const rel of softDocs) {

            if (!existsSync(join(root, rel))) {

                warnings.push(`Optional/missing ops doc: ${rel}`);

            }

        }

        if (missing.length) {

            return {
                status: CHECK_STATUS.FAIL,
                details: { found, missing, warnings },
                recommendations: [
                    "Add required product documentation before Closed Beta"
                ]
            };

        }

        return {
            status: warnings.length ? CHECK_STATUS.WARN : CHECK_STATUS.PASS,
            details: { found, warnings },
            recommendations: warnings.length
                ? ["Complete installation/deployment/API/runbook docs before GA"]
                : []
        };

    }

}
