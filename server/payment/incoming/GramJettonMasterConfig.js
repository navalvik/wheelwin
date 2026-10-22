/**
 * Explicit GRAM Jetton Master identity.
 *
 * Do not infer token identity from ticker, name, explorer URL or the native
 * TON message value. Testnet must have an explicitly configured master.
 * This module does not query any blockchain API and does not sign transfers.
 */
export function requireGramJettonMaster({
    env = process.env,
    network = "testnet"
} = {}) {
    if (network !== "testnet") {
        throw new Error("GRAM Jetton Master configuration is Testnet-only in this phase");
    }
    const master = env.GRAM_JETTON_MASTER_TESTNET;
    if (typeof master !== "string" || master.trim() === "") {
        throw new Error("GRAM_JETTON_MASTER_TESTNET must be configured before GRAM payment verification");
    }
    const normalized = master.trim();
    // Standard TON user-friendly addresses are 48 base64url characters.
    // Raw workchain:hash form is also accepted for later canonical comparison.
    const friendly = /^[A-Za-z0-9_-]{48}$/.test(normalized);
    const raw = /^-?\d+:[a-fA-F0-9]{64}$/.test(normalized);
    if (!friendly && !raw) {
        throw new Error("GRAM_JETTON_MASTER_TESTNET is not a valid TON address representation");
    }
    return normalized;
}
