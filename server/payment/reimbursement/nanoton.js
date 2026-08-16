/**
 * R17.8V.2P.K — Nanoton helpers (no IEEE float money math).
 */

const NANOTON_SCALE = 1_000_000_000n;

/**
 * @param {unknown} raw
 * @returns {bigint|null}
 */
export function parseNanoton(raw) {

    if (typeof raw === "bigint") {

        return raw >= 0n ? raw : null;

    }

    if (typeof raw === "number") {

        if (!Number.isFinite(raw) || raw < 0 || !Number.isInteger(raw)) {

            return null;

        }

        return BigInt(raw);

    }

    if (typeof raw === "string") {

        const trimmed = raw.trim();

        if (!/^\d+$/.test(trimmed)) {

            return null;

        }

        return BigInt(trimmed);

    }

    return null;

}

/**
 * @param {bigint} nanoton
 * @returns {string}
 */
export function nanotonToTonString(nanoton) {

    if (typeof nanoton !== "bigint" || nanoton < 0n) {

        throw new Error("nanotonToTonString requires non-negative bigint");

    }

    const whole = nanoton / NANOTON_SCALE;
    const frac = nanoton % NANOTON_SCALE;
    const fracStr = frac.toString().padStart(9, "0").replace(/0+$/, "");

    return fracStr.length > 0
        ? `${whole.toString()}.${fracStr}`
        : whole.toString();

}

/**
 * @param {string} tonDecimal
 * @returns {bigint|null}
 */
export function tonStringToNanoton(tonDecimal) {

    const raw = String(tonDecimal ?? "").trim();

    if (!/^\d+(\.\d+)?$/.test(raw)) {

        return null;

    }

    const [wholePart, fracPart = ""] = raw.split(".");
    const frac = `${fracPart}000000000`.slice(0, 9);

    return BigInt(wholePart) * NANOTON_SCALE + BigInt(frac);

}
