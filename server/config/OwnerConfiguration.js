import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalizeTonWalletAddress } from "../models/TonWalletAddress.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Default owner config path: <repo>/config/owner.json
 * (module lives at server/config/OwnerConfiguration.js).
 */
export const DEFAULT_OWNER_CONFIG_PATH = resolve(
    MODULE_DIR,
    "../../config/owner.json"
);

export const OWNER_CONFIG_EXAMPLE_PATH = resolve(
    MODULE_DIR,
    "../../config/owner.example.json"
);

/** Marker when owner wallet is loaded from OWNER_WALLET (not a filesystem path). */
export const OWNER_WALLET_ENV_SOURCE = "env:OWNER_WALLET";

/**
 * P6.8A — External owner wallet configuration.
 *
 * Loaded once at startup. Immutable thereafter.
 * Priority: OWNER_WALLET env → config/owner.json.
 * No other module may read the configuration file directly.
 */
export class OwnerConfiguration {

    static _frozen = null;

    /**
     * Load, validate, and freeze owner configuration.
     * Fatal if neither OWNER_WALLET nor owner.json provides a valid wallet.
     *
     * @param {{
     *   configPath?: string,
     *   env?: NodeJS.ProcessEnv
     * }} [options]
     */
    static load({
        configPath = DEFAULT_OWNER_CONFIG_PATH,
        env = process.env
    } = {}) {

        if (OwnerConfiguration._frozen) {

            throw new Error(
                "OwnerConfiguration is already loaded and immutable."
            );

        }

        const envWallet = String(env?.OWNER_WALLET || "").trim();

        if (envWallet) {

            const ownerWallet = canonicalizeTonWalletAddress(envWallet);

            if (!ownerWallet) {

                throw new Error(
                    "Owner wallet configuration invalid: ownerWallet is not a valid TON address."
                );

            }

            OwnerConfiguration._frozen = Object.freeze({
                ownerWallet,
                configPath: OWNER_WALLET_ENV_SOURCE
            });

            return OwnerConfiguration._frozen;

        }

        const resolvedPath = resolve(configPath);

        if (!existsSync(resolvedPath)) {

            throw new Error(
                "Owner wallet configuration missing.\n"
                    + "Create config/owner.json before starting WheelWin."
            );

        }

        let parsed;

        try {

            parsed = JSON.parse(readFileSync(resolvedPath, "utf8"));

        } catch (error) {

            throw new Error(
                `Owner wallet configuration invalid: cannot parse JSON (${error.message}).`
            );

        }

        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {

            throw new Error(
                "Owner wallet configuration invalid: expected a JSON object."
            );

        }

        const rawWallet = parsed.ownerWallet;

        if (typeof rawWallet !== "string" || !rawWallet.trim()) {

            throw new Error(
                "Owner wallet configuration invalid: ownerWallet is required."
            );

        }

        const ownerWallet = canonicalizeTonWalletAddress(rawWallet);

        if (!ownerWallet) {

            throw new Error(
                "Owner wallet configuration invalid: ownerWallet is not a valid TON address."
            );

        }

        OwnerConfiguration._frozen = Object.freeze({
            ownerWallet,
            configPath: resolvedPath
        });

        return OwnerConfiguration._frozen;

    }

    /**
     * Read-only owner wallet. Requires a prior successful load().
     */
    static getOwnerWallet() {

        if (!OwnerConfiguration._frozen) {

            throw new Error(
                "OwnerConfiguration has not been loaded."
            );

        }

        return OwnerConfiguration._frozen.ownerWallet;

    }

    /**
     * True after a successful load().
     */
    static isLoaded() {

        return OwnerConfiguration._frozen !== null;

    }

    /**
     * Test-only reset. Production code must never call this.
     */
    static resetForTests() {

        OwnerConfiguration._frozen = null;

    }

}
