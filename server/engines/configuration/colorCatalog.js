/**
 * R5.12B — Resolve PLAYER SETUP color labels to authoritative catalog entries.
 */

export function normalizeColorLabel(label) {

    return String(label ?? "").trim().toLowerCase();

}

export function resolveCatalogColor(label, catalogColors) {

    const normalized = normalizeColorLabel(label);

    if (!normalized) {

        return null;

    }

    for (const entry of catalogColors) {

        if (normalizeColorLabel(entry.label) === normalized) {

            return entry;

        }

        if (String(entry.id ?? "").replace(/_/g, " ").toLowerCase() === normalized) {

            return entry;

        }

    }

    return null;

}

export function resolvePlayerSetupColors(labels, catalogColors) {

    if (!Array.isArray(labels) || labels.length === 0) {

        return [];

    }

    return labels.map((label) => {

        const entry = resolveCatalogColor(label, catalogColors);

        if (!entry) {

            throw new Error(`Unknown sector color (${label})`);

        }

        return {
            id: entry.id,
            hex: entry.hex,
            label: entry.label ?? label
        };

    });

}
