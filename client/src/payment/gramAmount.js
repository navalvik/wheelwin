/**
 * Monetary presentation for WheelWin's GRAM-denominated stake amounts.
 * Storage and calculations use integer nano-units (10^9 per GRAM).
 * UI rounds to at most two fractional digits, omitting .00 and trailing zeroes.
 * No floating-point arithmetic is used.
 */
export const GRAM_NANO_UNITS = 1_000_000_000n;

export function formatGramUnits(nanoUnits) {
    const raw = typeof nanoUnits === "bigint"
        ? nanoUnits.toString()
        : nanoUnits;
    if (typeof raw !== "string" || !/^-?(0|[1-9][0-9]*)$/.test(raw)) {
        throw new TypeError("GRAM amount must be an integer nano-unit string or bigint");
    }
    const negative = raw.startsWith("-");
    const magnitude = BigInt(raw);
    const absolute = magnitude < 0n ? -magnitude : magnitude;
    // Round to hundredths using integers only.
    const hundredths = (absolute * 100n + GRAM_NANO_UNITS / 2n) / GRAM_NANO_UNITS;
    const whole = hundredths / 100n;
    const fraction = hundredths % 100n;
    const suffix = fraction === 0n
        ? ""
        : `.${fraction.toString().padStart(2, "0").replace(/0+$/, "")}`;
    const sign = negative && hundredths !== 0n ? "-" : "";
    return `${sign}${whole}${suffix}`;
}

export function parseGramToNanoUnits(displayAmount) {
    if (typeof displayAmount !== "string"
        || !/^(0|[1-9][0-9]*)(?:\.[0-9]{1,9})?$/.test(displayAmount)) {
        throw new TypeError("GRAM amount must be a nonnegative decimal with up to nine digits");
    }
    const [whole, fraction = ""] = displayAmount.split(".");
    return (BigInt(whole) * GRAM_NANO_UNITS
        + BigInt(fraction.padEnd(9, "0"))).toString();
}
