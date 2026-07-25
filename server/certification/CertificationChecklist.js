/**
 * R8.0C — Default certification checklist (ordered checks).
 */

import { ArtifactCheck } from "./checks/ArtifactCheck.js";
import { ConfigurationCheck } from "./checks/ConfigurationCheck.js";
import { DocumentationCheck } from "./checks/DocumentationCheck.js";
import { InfrastructureCheck } from "./checks/InfrastructureCheck.js";
import { MonitoringCheck } from "./checks/MonitoringCheck.js";
import { LoggingCheck } from "./checks/LoggingCheck.js";
import { BlockchainCheck } from "./checks/BlockchainCheck.js";
import { SecurityCheck } from "./checks/SecurityCheck.js";
import { DeploymentCheck } from "./checks/DeploymentCheck.js";
import { GameplayIntegrityCheck } from "./checks/GameplayIntegrityCheck.js";

export class CertificationChecklist {

    /**
     * @param {{ checks?: import("./checks/CertificationCheck.js").CertificationCheck[] }} [options]
     */
    constructor(options = {}) {

        this._checks = options.checks ?? [
            new ArtifactCheck(),
            new ConfigurationCheck(),
            new DocumentationCheck(),
            new InfrastructureCheck(),
            new MonitoringCheck(),
            new LoggingCheck(),
            new BlockchainCheck(),
            new SecurityCheck(),
            new DeploymentCheck(),
            new GameplayIntegrityCheck()
        ];

    }

    list() {

        return this._checks.map((c) => ({
            id: c.id,
            name: c.name,
            category: c.category
        }));

    }

    getChecks() {

        return [...this._checks];

    }

}
