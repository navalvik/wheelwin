/**
 * R7.0C — Deterministic configuration validation errors (secrets redacted).
 */

import { sanitizeReceivedValue } from "./secrets.js";

export class ConfigurationError extends Error {

    /**
     * @param {{
     *   errors: Array<{
     *     key: string,
     *     reason: string,
     *     expectedType?: string,
     *     received?: unknown,
     *     suggestedFix?: string
     *   }>
     * }} options
     */
    constructor({ errors }) {

        const list = Array.isArray(errors) ? errors : [];

        const lines = list.map((entry) => {

            const received = sanitizeReceivedValue(entry.key, entry.received);

            return [
                `key=${entry.key}`,
                `reason=${entry.reason}`,
                entry.expectedType ? `expected=${entry.expectedType}` : null,
                `received=${JSON.stringify(received)}`,
                entry.suggestedFix ? `fix=${entry.suggestedFix}` : null
            ].filter(Boolean).join(" | ");

        });

        super(
            lines.length > 0
                ? `Configuration validation failed:\n  - ${lines.join("\n  - ")}`
                : "Configuration validation failed"
        );

        this.name = "ConfigurationError";

        this.phase = "startup";

        this.component = "Configuration";

        this.errors = Object.freeze(
            list.map((entry) => Object.freeze({
                key: entry.key,
                reason: entry.reason,
                expectedType: entry.expectedType ?? null,
                received: sanitizeReceivedValue(entry.key, entry.received),
                suggestedFix: entry.suggestedFix ?? null
            }))
        );

    }

}

/**
 * Collect validation issues then throw a single ConfigurationError.
 */
export class ConfigurationIssueCollector {

    constructor() {

        this._issues = [];

    }

    add(issue) {

        if (!issue?.key || !issue?.reason) {

            return;

        }

        this._issues.push(issue);

    }

    get size() {

        return this._issues.length;

    }

    throwIfAny() {

        if (this._issues.length === 0) {

            return;

        }

        throw new ConfigurationError({ errors: this._issues });

    }

}
