/**
 * R7.0D — Secret / sensitive value sanitization for log records.
 */

import {
    isSecretKey,
    redactSecretsFromObject,
    sanitizeReceivedValue
} from "../config/secrets.js";

const SENSITIVE_PATTERN = /password|secret|token|jwt|mnemonic|private[_-]?key|authorization/i;

export class LogSanitizer {

    sanitizeMessage(message) {

        if (typeof message !== "string") {

            return String(message ?? "");

        }

        // Redact obvious inline assignments: password=..., token: ...
        return message.replace(
            /(password|secret|token|jwt|mnemonic|authorization)\s*[:=]\s*([^\s|,;]+)/gi,
            (_, key) => `${key}=[redacted]`
        );

    }

    sanitizeFields(fields) {

        if (!fields || typeof fields !== "object") {

            return {};

        }

        const out = {};

        for (const [key, value] of Object.entries(fields)) {

            if (isSecretKey(key) || SENSITIVE_PATTERN.test(key)) {

                out[key] = sanitizeReceivedValue(key, value);

                continue;

            }

            if (value && typeof value === "object" && !Array.isArray(value)) {

                out[key] = redactSecretsFromObject(value);

                continue;

            }

            out[key] = value;

        }

        return out;

    }

    sanitizeError(error) {

        if (!error) {

            return null;

        }

        const name = error.name || "Error";

        const message = this.sanitizeMessage(error.message || String(error));

        const stack = typeof error.stack === "string"
            ? this.sanitizeMessage(error.stack)
            : null;

        const cause = error.cause
            ? this.sanitizeError(error.cause)
            : null;

        return {
            name,
            message,
            stack,
            cause
        };

    }

}
