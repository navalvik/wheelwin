/**
 * R7.0C — Owner configuration loader (wraps OwnerConfiguration).
 */

import { existsSync, readFileSync } from "node:fs";

import {
    DEFAULT_OWNER_CONFIG_PATH,
    OwnerConfiguration
} from "../OwnerConfiguration.js";
import { ConfigurationError } from "../ConfigurationError.js";
import { OWNER_SCHEMA } from "../schemas/ownerSchema.js";

/**
 * @param {{
 *   configPath?: string,
 *   resetForTests?: boolean
 * }} [options]
 */
export function loadOwnerConfiguration({
    configPath = DEFAULT_OWNER_CONFIG_PATH,
    resetForTests = false
} = {}) {

    if (resetForTests) {

        OwnerConfiguration.resetForTests();

    }

    if (!existsSync(configPath)) {

        throw new ConfigurationError({
            errors: [{
                key: OWNER_SCHEMA.path.key,
                reason: "Owner configuration file does not exist",
                expectedType: OWNER_SCHEMA.path.type,
                received: configPath,
                suggestedFix: OWNER_SCHEMA.path.suggestedFix
            }]
        });

    }

    try {

        // Pre-check JSON validity for deterministic error messaging.
        JSON.parse(readFileSync(configPath, "utf8"));

    } catch (error) {

        throw new ConfigurationError({
            errors: [{
                key: OWNER_SCHEMA.path.key,
                reason: `Invalid JSON (${error.message})`,
                expectedType: "json-object",
                received: "<invalid-json>",
                suggestedFix: OWNER_SCHEMA.path.suggestedFix
            }]
        });

    }

    try {

        const frozen = OwnerConfiguration.load({ configPath });

        return Object.freeze({
            configPath: frozen.configPath,
            loaded: true,
            // Wallet kept for runtime use; never included in safe summaries.
            ownerWallet: frozen.ownerWallet
        });

    } catch (error) {

        throw new ConfigurationError({
            errors: [{
                key: OWNER_SCHEMA.ownerWallet.key,
                reason: error.message,
                expectedType: OWNER_SCHEMA.ownerWallet.type,
                received: "[redacted-or-invalid]",
                suggestedFix: OWNER_SCHEMA.ownerWallet.suggestedFix
            }]
        });

    }

}
