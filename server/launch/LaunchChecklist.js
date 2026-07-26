/**
 * R8.0E — Launch documentation / artifact checklist (filesystem, read-only).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { GATE_STATUS, BLOCKER_SEVERITY } from "./LaunchConfiguration.js";
import { createLaunchGateResult } from "./models/LaunchGateResult.js";

/**
 * Relative paths checked from repo root.
 */
export const CHECKLIST_ITEMS = Object.freeze([
    Object.freeze({
        id: "closed_beta_report",
        name: "Closed Beta report",
        path: "docs/release/R8.0D-Closed-Beta-Report.md",
        category: "documentation",
        severity: BLOCKER_SEVERITY.HIGH
    }),
    Object.freeze({
        id: "open_beta_readiness_report",
        name: "Open Beta readiness report",
        path: "docs/release/R8.0E-Open-Beta-Readiness-Report.md",
        category: "documentation",
        severity: BLOCKER_SEVERITY.MEDIUM,
        optionalUntilGenerated: true
    }),
    Object.freeze({
        id: "privacy_policy",
        name: "Privacy policy",
        path: "docs/legal/privacy.md",
        altPaths: Object.freeze([
            "client/public/docs/privacy.md",
            "docs/privacy.md",
            "docs/legal/PRIVACY.md"
        ]),
        category: "documentation",
        severity: BLOCKER_SEVERITY.HIGH
    }),
    Object.freeze({
        id: "terms_of_service",
        name: "Terms of service",
        path: "docs/legal/terms.md",
        altPaths: Object.freeze([
            "client/public/docs/terms.md",
            "docs/terms.md",
            "docs/legal/TERMS.md"
        ]),
        category: "documentation",
        severity: BLOCKER_SEVERITY.HIGH
    }),
    Object.freeze({
        id: "release_notes",
        name: "Release notes",
        path: "docs/release/RELEASE_NOTES.md",
        altPaths: Object.freeze([
            "client/public/docs/changelog.md",
            "docs/CHANGELOG.md",
            "CHANGELOG.md"
        ]),
        category: "documentation",
        severity: BLOCKER_SEVERITY.MEDIUM
    }),
    Object.freeze({
        id: "api_documentation",
        name: "API documentation",
        path: "docs/api/README.md",
        altPaths: Object.freeze([
            "docs/API.md",
            "docs/architecture/API.md",
            "docs/architecture/R7.0A-Production-Readiness-Architecture.md"
        ]),
        category: "documentation",
        severity: BLOCKER_SEVERITY.LOW
    }),
    Object.freeze({
        id: "operational_runbook",
        name: "Operational runbook",
        path: "docs/operations/runbook.md",
        altPaths: Object.freeze([
            "docs/operations/RUNBOOK.md",
            "docs/runbook.md",
            "docs/architecture/R7.0G-Production-Health-Readiness-Deployment-Validation.md"
        ]),
        category: "operations",
        severity: BLOCKER_SEVERITY.HIGH
    }),
    Object.freeze({
        id: "support_documentation",
        name: "Support documentation",
        path: "docs/support/FAQ.md",
        altPaths: Object.freeze([
            "client/public/docs/faq.md",
            "docs/FAQ.md",
            "docs/support/faq.md"
        ]),
        category: "documentation",
        severity: BLOCKER_SEVERITY.MEDIUM
    }),
    Object.freeze({
        id: "r8_architecture",
        name: "RC architecture doc",
        path: "docs/release/R8.0A-Release-Candidate-Architecture.md",
        category: "documentation",
        severity: BLOCKER_SEVERITY.LOW
    }),
    Object.freeze({
        id: "certification_validation",
        name: "Certification validation report",
        path: "docs/architecture/R8.0C-Release-Certification-Validation.md",
        category: "documentation",
        severity: BLOCKER_SEVERITY.MEDIUM
    }),
    Object.freeze({
        id: "closed_beta_validation",
        name: "Closed Beta validation report",
        path: "docs/architecture/R8.0D-Closed-Beta-Operations-Validation.md",
        category: "documentation",
        severity: BLOCKER_SEVERITY.MEDIUM
    })
]);

function resolveExisting(repoRoot, item) {

    const primary = join(repoRoot, item.path);

    if (existsSync(primary)) {

        return { path: item.path, found: true };

    }

    for (const alt of item.altPaths ?? []) {

        if (existsSync(join(repoRoot, alt))) {

            return { path: alt, found: true };

        }

    }

    return { path: item.path, found: false };

}

export class LaunchChecklist {

    /**
     * @param {{ repoRoot: string }} options
     */
    constructor({ repoRoot }) {

        this._repoRoot = repoRoot;

    }

    /**
     * @param {{ skipOptional?: boolean }} [opts]
     */
    validate(opts = {}) {

        const results = [];

        let present = 0;

        let required = 0;

        for (const item of CHECKLIST_ITEMS) {

            if (opts.skipOptional && item.optionalUntilGenerated) {

                continue;

            }

            required += 1;

            const started = Date.now();

            const resolved = resolveExisting(this._repoRoot, item);

            if (resolved.found) {

                present += 1;

            }

            const status = resolved.found
                ? GATE_STATUS.PASS
                : GATE_STATUS.FAIL;

            results.push(createLaunchGateResult({
                id: `checklist_${item.id}`,
                name: item.name,
                category: item.category,
                status,
                severity: item.severity,
                durationMs: Date.now() - started,
                details: {
                    expectedPath: item.path,
                    resolvedPath: resolved.path,
                    found: resolved.found
                },
                recommendations: resolved.found
                    ? []
                    : [`Provide ${item.name} at ${item.path}`]
            }));

        }

        const completeness = required > 0
            ? Number((present / required).toFixed(4))
            : 1;

        return Object.freeze({
            results: Object.freeze(results),
            present,
            required,
            completeness,
            complete: present === required
        });

    }

}
