export const FINANCE_REFRESH_INTERVAL_MS = 10_000;

/** Keep the existing nanoTON formatting; only the displayed unit varies by network. */
export function formatFinanceBalance(nanoValue, network) {
    if (nanoValue == null || !/^\d+$/.test(String(nanoValue))) return "—";
    const nano = BigInt(nanoValue);
    const whole = nano / 1_000_000_000n;
    const fraction = String(nano % 1_000_000_000n).padStart(9, "0");
    const unit = network === "mainnet" ? "TON" : "GRAM";
    return `${whole}.${fraction} ${unit}`;
}
