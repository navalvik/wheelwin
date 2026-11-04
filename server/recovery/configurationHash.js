import { createHash } from "node:crypto";

/** Stable JSON encoding used by configuration and recovery checkpoints. */
export function stableStringify(value) {
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(",")}]`;
    }

    if (value && typeof value === "object") {
        return `{${Object.keys(value).sort().map((key) =>
            `${JSON.stringify(key)}:${stableStringify(value[key])}`
        ).join(",")}}`;
    }

    return JSON.stringify(value);
}

export function computeConfigurationHash(configuration) {
    return createHash("sha256").update(stableStringify(configuration)).digest("hex");
}
