/**
 * R6.1 — Persisted application environment state (survives restarts).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeAppEnvironment } from "./AppEnvironment.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

const DEFAULT_STATE_PATH = resolve(MODULE_DIR, "../../runtime/app-environment.json");

function resolveStatePath(env = process.env) {

    const configured = String(env.APP_ENVIRONMENT_STATE_PATH || "").trim();

    return configured || DEFAULT_STATE_PATH;

}

export function readEnvironmentState(env = process.env) {

    const statePath = resolveStatePath(env);

    if (!existsSync(statePath)) {

        return null;

    }

    try {

        const parsed = JSON.parse(readFileSync(statePath, "utf8"));

        const appEnvironment = normalizeAppEnvironment(parsed?.appEnvironment);

        if (!appEnvironment) {

            return null;

        }

        return Object.freeze({
            appEnvironment,
            tonNetwork: String(parsed?.tonNetwork || "").trim().toLowerCase() || null,
            updatedAt: parsed?.updatedAt ?? null,
            updatedBy: parsed?.updatedBy ?? null
        });

    } catch {

        return null;

    }

}

/**
 * @param {{
 *   appEnvironment: string,
 *   tonNetwork: string,
 *   updatedBy?: string | null
 * }} state
 * @param {NodeJS.ProcessEnv} [env]
 */
export function writeEnvironmentState(state, env = process.env) {

    const statePath = resolveStatePath(env);

    mkdirSync(dirname(statePath), { recursive: true });

    const payload = {
        appEnvironment: state.appEnvironment,
        tonNetwork: state.tonNetwork,
        updatedAt: new Date().toISOString(),
        updatedBy: state.updatedBy ?? null
    };

    writeFileSync(statePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

    return Object.freeze(payload);

}

/**
 * Overlay persisted environment onto process env before configuration load.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
export function applyEnvironmentStateToEnv(env = process.env) {

    const persisted = readEnvironmentState(env);

    if (!persisted) {

        return env;

    }

    const merged = { ...env };

    if (env.APP_ENVIRONMENT === undefined && env.BLOCKCHAIN_NETWORK === undefined) {

        merged.APP_ENVIRONMENT = persisted.appEnvironment;

    }

    if (env.TON_NETWORK === undefined) {

        merged.TON_NETWORK = persisted.tonNetwork
            || (persisted.appEnvironment === "MAINNET" ? "mainnet" : "testnet");

    }

    return merged;

}
