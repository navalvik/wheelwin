/**
 * R7.0C — Shared parsing helpers for configuration validators.
 */

const BOOLEAN_TRUE = new Set(["true", "1", "yes"]);
const BOOLEAN_FALSE = new Set(["false", "0", "no"]);

export function isMissing(value) {

    return value === undefined || value === null || value === "";

}

export function parseBooleanStrict(raw) {

    if (typeof raw === "boolean") {

        return { ok: true, value: raw };

    }

    if (isMissing(raw)) {

        return { ok: true, value: undefined };

    }

    const normalized = String(raw).trim().toLowerCase();

    if (BOOLEAN_TRUE.has(normalized)) {

        return { ok: true, value: true };

    }

    if (BOOLEAN_FALSE.has(normalized)) {

        return { ok: true, value: false };

    }

    return { ok: false, value: undefined };

}

export function parseIntegerStrict(raw) {

    if (isMissing(raw)) {

        return { ok: true, value: undefined };

    }

    if (typeof raw === "number" && Number.isInteger(raw)) {

        return { ok: true, value: raw };

    }

    const text = String(raw).trim();

    if (!/^-?\d+$/.test(text)) {

        return { ok: false, value: undefined };

    }

    const value = Number(text);

    if (!Number.isInteger(value)) {

        return { ok: false, value: undefined };

    }

    return { ok: true, value };

}

export function assertPresent(collector, schema, raw) {

    if (!schema.required) {

        return true;

    }

    if (!isMissing(raw)) {

        return true;

    }

    collector.add({
        key: schema.key,
        reason: "Missing required variable",
        expectedType: schema.type,
        received: raw,
        suggestedFix: schema.suggestedFix
    });

    return false;

}
