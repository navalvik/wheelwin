/**
 * R7.0C — Secret key registry and redaction helpers.
 * Secrets must never appear in logs, REST, console, metrics, or stack traces.
 */

export const SECRET_ENV_KEYS = Object.freeze([
    "DEVELOPER_AUTH_PASSWORD",
    "DEVELOPER_AUTH_SECRET",
    "TON_DEPLOYER_MNEMONIC",
    "TON_TESTNET_DEPOSIT_DEPLOYER_MNEMONIC",
    "TON_REIMBURSEMENT_MNEMONIC",
    "TON_RESIDUES_MNEMONIC",
    "L25_PLAYER_0_MNEMONIC",
    "L25_PLAYER_1_MNEMONIC",
    "L25_PLAYER_2_MNEMONIC",
    "TON_API_KEY",
    "ROOM_WALLETS_JSON"
]);

export const SECRET_CONFIG_KEYS = Object.freeze([
    ...SECRET_ENV_KEYS,
    "ownerWallet",
    "developer.secret",
    "developer.password",
    "developer.passwordHash",
    "ton.deployerMnemonic",
    "ton.testnetDepositDeployerMnemonic",
    "ton.reimbursementMnemonic",
    "ton.residuesMnemonic",
    "ton.apiKey"
]);

const INSECURE_SECRET_DEFAULTS = Object.freeze([
    "change-me-developer-console-secret",
    "developer",
    "changeme",
    "secret",
    "password"
]);

export function isSecretKey(key) {

    if (!key) {

        return false;

    }

    const normalized = String(key);

    if (SECRET_CONFIG_KEYS.includes(normalized)) {

        return true;

    }

    const upper = normalized.toUpperCase();

    return SECRET_ENV_KEYS.some((secretKey) => upper.includes(secretKey))
        || /password|secret|mnemonic|api[_-]?key|private/i.test(normalized);

}

export function isInsecureSecretDefault(value) {

    if (typeof value !== "string") {

        return false;

    }

    const trimmed = value.trim().toLowerCase();

    return INSECURE_SECRET_DEFAULTS.includes(trimmed);

}

/**
 * Sanitize a received value for error messages and diagnostics.
 */
export function sanitizeReceivedValue(key, value) {

    if (isSecretKey(key)) {

        if (value === undefined) {

            return "<undefined>";

        }

        if (value === null) {

            return "<null>";

        }

        if (value === "") {

            return "<empty>";

        }

        return "[redacted]";

    }

    if (value === undefined) {

        return "<undefined>";

    }

    if (value === null) {

        return "<null>";

    }

    if (value === "") {

        return "<empty>";

    }

    if (typeof value === "string" && value.length > 120) {

        return `${value.slice(0, 117)}...`;

    }

    return value;

}

export function redactSecretsFromObject(input) {

    if (!input || typeof input !== "object") {

        return input;

    }

    if (Array.isArray(input)) {

        return input.map((item) => redactSecretsFromObject(item));

    }

    const out = {};

    for (const [key, value] of Object.entries(input)) {

        if (isSecretKey(key)) {

            out[key] = value == null || value === ""
                ? sanitizeReceivedValue(key, value)
                : "[redacted]";

            continue;

        }

        if (value && typeof value === "object") {

            out[key] = redactSecretsFromObject(value);

            continue;

        }

        out[key] = value;

    }

    return out;

}
