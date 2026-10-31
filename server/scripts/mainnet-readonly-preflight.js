/**
 * Operator-only Mainnet read-only preflight.
 *
 * Run from server/ with: node scripts/mainnet-readonly-preflight.js
 * Uses existing Railway environment variable names and prints ONLY safe
 * booleans/counts. No address, credential, mnemonic, token or value is logged.
 * Does not enable, sign or broadcast payments.
 */
import { probeMainnetReadOnly } from "../mainnet/MainnetReadOnlyPreflight.js";

try {
    const result = await probeMainnetReadOnly();
    process.stdout.write(JSON.stringify(result) + "\n");
} catch (error) {
    const reason = /^MAINNET_PREFLIGHT_[A-Z_]+$/.test(error?.message ?? "")
        ? error.message
        : "MAINNET_PREFLIGHT_UNKNOWN_ERROR";
    process.stderr.write(JSON.stringify({
        status: "BLOCKED",
        code: reason
    }) + "\n");
    process.exitCode = 1;
}
