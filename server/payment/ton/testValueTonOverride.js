/**
 * R17.8V.1C — Test-only oracle message valueTon override.
 *
 * Production default remains 0.05 TON unless TEST_VALUETON_OVERRIDE=true.
 * Never enable this flag in production startup paths.
 */

export const PRODUCTION_ORACLE_VALUE_TON = "0.05";

/** @type {Readonly<Record<string, string>>} */
export const TEST_VALUETON_ENV_KEYS = Object.freeze({
    DEPLOY: "TEST_VALUETON_DEPLOY",
    INIT_GAME: "TEST_VALUETON_INIT",
    OPEN_PAYMENTS: "TEST_VALUETON_OPEN",
    CANCEL: "TEST_VALUETON_CANCEL",
    SETTLE: "TEST_VALUETON_SETTLE",
    ARCHIVE: "TEST_VALUETON_ARCHIVE"
});

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isTestValueTonOverrideEnabled(env = process.env) {

    return String(env?.TEST_VALUETON_OVERRIDE ?? "")
        .trim()
        .toLowerCase() === "true";

}

/**
 * Resolve outbound oracle attach value for a named operation.
 *
 * @param {string} operation DEPLOY | INIT_GAME | OPEN_PAYMENTS | CANCEL | SETTLE | …
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} TON amount as decimal string
 */
export function resolveOracleValueTon(operation, env = process.env) {

    if (!isTestValueTonOverrideEnabled(env)) {

        return PRODUCTION_ORACLE_VALUE_TON;

    }

    const key = TEST_VALUETON_ENV_KEYS[String(operation ?? "").trim()]
        ?? null;

    if (!key) {

        return PRODUCTION_ORACLE_VALUE_TON;

    }

    const raw = env?.[key];

    if (raw === undefined || raw === null || String(raw).trim() === "") {

        return PRODUCTION_ORACLE_VALUE_TON;

    }

    const value = String(raw).trim();
    const numeric = Number(value);

    if (!Number.isFinite(numeric) || numeric <= 0) {

        return PRODUCTION_ORACLE_VALUE_TON;

    }

    return value;

}
