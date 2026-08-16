/**
 * R17.9G.1 — Append-only audit log for RUNTIME_CONFIG_CHANGED.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

const DEFAULT_AUDIT_PATH = resolve(
    MODULE_DIR,
    "../../runtime/runtime-configuration-audit.jsonl"
);

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveRuntimeConfigurationAuditPath(env = process.env) {

    const configured = String(env.RUNTIME_CONFIGURATION_AUDIT_PATH || "").trim();

    return configured || DEFAULT_AUDIT_PATH;

}

/**
 * @param {{
 *   user: string|null,
 *   role: string|null,
 *   parameter: string,
 *   oldValue: unknown,
 *   newValue: unknown,
 *   configVersion?: number|null,
 *   timestamp?: string|null
 * }} entry
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {object}
 */
export function appendRuntimeConfigurationAudit(entry, env = process.env) {

    const auditPath = resolveRuntimeConfigurationAuditPath(env);

    mkdirSync(dirname(auditPath), { recursive: true });

    const record = Object.freeze({
        event: "RUNTIME_CONFIG_CHANGED",
        user: entry.user ?? null,
        role: entry.role ?? null,
        parameter: entry.parameter,
        oldValue: entry.oldValue ?? null,
        newValue: entry.newValue ?? null,
        configVersion: entry.configVersion ?? null,
        timestamp: entry.timestamp || new Date().toISOString()
    });

    appendFileSync(auditPath, `${JSON.stringify(record)}\n`, "utf8");

    return record;

}

/**
 * @param {{ limit?: number }} [options]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {object[]}
 */
export function readRuntimeConfigurationAudit({ limit = 100 } = {}, env = process.env) {

    const auditPath = resolveRuntimeConfigurationAuditPath(env);

    if (!existsSync(auditPath)) {

        return [];

    }

    try {

        const lines = readFileSync(auditPath, "utf8")
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);

        const max = Math.max(1, Math.min(1000, Number(limit) || 100));

        const slice = lines.slice(-max);

        const records = [];

        for (const line of slice) {

            try {

                records.push(JSON.parse(line));

            } catch {

                // skip corrupt line
            }

        }

        return records;

    } catch {

        return [];

    }

}
