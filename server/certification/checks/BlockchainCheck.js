/**
 * R8.0C — Blockchain / TON configuration readiness.
 */

import { CertificationCheck } from "./CertificationCheck.js";
import { CHECK_STATUS } from "../CertificationStatus.js";

export class BlockchainCheck extends CertificationCheck {

    constructor() {

        super({
            id: "blockchain",
            name: "Blockchain Readiness",
            category: "blockchain"
        });

    }

    async run(context) {

        const ton = context.tonConfig
            ?? context.runtimeConfig?.ton
            ?? null;

        const profile = context.productionConfig?.deployment?.profile
            ?? context.profile
            ?? "development";

        if (!ton) {

            return {
                status: CHECK_STATUS.WARN,
                details: { available: false },
                recommendations: [
                    "Provide TON configuration for blockchain certification"
                ]
            };

        }

        const network = String(ton.network || "").toLowerCase();

        const deployMode = String(ton.deployMode || "").toLowerCase();

        const details = {
            network,
            deployMode,
            profile,
            endpointConfigured: Boolean(ton.endpoint || ton.endpointConfigured),
            apiKeyConfigured: Boolean(ton.apiKey || ton.apiKeyConfigured),
            mnemonicConfigured: Boolean(
                ton.deployerMnemonic || ton.mnemonicConfigured
            )
        };

        const failures = [];

        const warnings = [];

        if (!network) {

            failures.push("TON network not configured");

        }

        if (profile === "production" && network === "testnet") {

            warnings.push(
                "Production profile still on testnet — expected for beta, not for mainnet GA"
            );

        }

        if (profile === "production"
            && network === "mainnet"
            && deployMode === "stub") {

            failures.push("Mainnet production cannot use stub deploy mode");

        }

        if (profile === "production"
            && network !== "testnet"
            && network !== "mainnet") {

            failures.push(`Unexpected TON network for production: ${network}`);

        }

        if (!details.endpointConfigured && deployMode === "live") {

            warnings.push("Live deploy mode without explicit endpoint");

        }

        if (failures.length) {

            return {
                status: CHECK_STATUS.FAIL,
                details: { ...details, failures },
                recommendations: failures
            };

        }

        return {
            status: warnings.length ? CHECK_STATUS.WARN : CHECK_STATUS.PASS,
            details: { ...details, warnings },
            recommendations: warnings
        };

    }

}
