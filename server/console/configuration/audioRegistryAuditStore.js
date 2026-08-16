/**
 * R17.9I.3 — Append-only audit log for AUDIO_REGISTRY_CHANGED.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

const DEFAULT_AUDIT_PATH = resolve(
    MODULE_DIR,
    "../../runtime/audio-registry-audit.jsonl"
);

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveAudioRegistryAuditPath(env = process.env) {

    const configured = String(env.AUDIO_REGISTRY_AUDIT_PATH || "").trim();

    return configured || DEFAULT_AUDIT_PATH;

}

/**
 * @param {{
 *   user: string|null,
 *   role: string|null,
 *   id?: string,
 *   eventId?: string,
 *   field: string,
 *   oldValue: unknown,
 *   newValue: unknown,
 *   configVersion?: number|null,
 *   timestamp?: string|null
 * }} entry
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {object}
 */
export function appendAudioRegistryAudit(entry, env = process.env) {

    const auditPath = resolveAudioRegistryAuditPath(env);

    mkdirSync(dirname(auditPath), { recursive: true });

    const id = entry.id ?? entry.eventId ?? null;

    const record = Object.freeze({
        event: "AUDIO_REGISTRY_CHANGED",
        user: entry.user ?? null,
        role: entry.role ?? null,
        id,
        eventId: id,
        field: entry.field,
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
export function readAudioRegistryAudit({ limit = 100 } = {}, env = process.env) {

    const auditPath = resolveAudioRegistryAuditPath(env);

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
