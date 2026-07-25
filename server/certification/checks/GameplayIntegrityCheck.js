/**
 * R8.0C — Gameplay integrity (read-only structural assertions).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { CertificationCheck } from "./CertificationCheck.js";
import { CHECK_STATUS } from "../CertificationStatus.js";

const AUTHORITY_MARKERS = [
    "server/engines/RecoveryEngine.js",
    "server/engines/PhysicsEngine.js",
    "server/engines/GameStateEngine.js",
    "server/engines/PaymentEngine.js",
    "server/simulation/SimulationLoop.js",
    "server/input/InputAuthority.js"
];

export class GameplayIntegrityCheck extends CertificationCheck {

    constructor() {

        super({
            id: "gameplay-integrity",
            name: "Gameplay Integrity",
            category: "gameplay"
        });

    }

    async run(context) {

        const root = context.repoRoot;

        const missing = [];

        for (const rel of AUTHORITY_MARKERS) {

            // SimulationLoop path may vary — try alternatives
            const candidates = [join(root, rel)];

            if (rel.includes("SimulationLoop")) {

                candidates.push(join(root, "server/gameplay/SimulationLoop.js"));

                candidates.push(join(root, "server/engines/SimulationLoop.js"));

            }

            if (!candidates.some((p) => existsSync(p))) {

                missing.push(rel);

            }

        }

        const details = {
            markersChecked: AUTHORITY_MARKERS.length,
            missing,
            note: "Structural presence only — certification does not mutate gameplay"
        };

        // Allow missing SimulationLoop path variants if at least Recovery+Physics+Payment exist
        const critical = [
            "server/engines/RecoveryEngine.js",
            "server/engines/PhysicsEngine.js",
            "server/engines/PaymentEngine.js",
            "server/input/InputAuthority.js"
        ];

        const criticalMissing = critical.filter(
            (rel) => !existsSync(join(root, rel))
        );

        if (criticalMissing.length) {

            return {
                status: CHECK_STATUS.FAIL,
                details: { ...details, criticalMissing },
                recommendations: [
                    "Authoritative engines missing from repository — refuse certification"
                ]
            };

        }

        const warnings = missing.length
            ? [`Optional marker paths not found: ${missing.join(", ")}`]
            : [];

        return {
            status: warnings.length ? CHECK_STATUS.WARN : CHECK_STATUS.PASS,
            details: { ...details, warnings },
            recommendations: warnings
        };

    }

}
