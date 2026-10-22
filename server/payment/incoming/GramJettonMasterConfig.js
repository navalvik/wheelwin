/**
 * GRAM Jetton Master configuration for Testnet.
 *
 * Token identity is an account identity, not a display ticker or a 48-character
 * string. TON friendly addresses include a CRC16 checksum; a syntactically
 * plausible string without a valid checksum must not authorize payment intake.
 * No blockchain call or signing takes place here.
 */
import { tonAddressIdentityOrNull } from "./TonAddressIdentity.js";

export function requireGramJettonMaster({
    env = process.env,
    network = "testnet"
} = {}) {
    if (network !== "testnet") {
        throw new Error("GRAM Jetton Master configuration is Testnet-only in this phase");
    }

    const master = env?.GRAM_JETTON_MASTER_TESTNET;
    if (typeof master !== "string" || master.trim() === "") {
        throw new Error("GRAM_JETTON_MASTER_TESTNET must be configured before GRAM payment verification");
    }

    const normalized = master.trim();
    if (tonAddressIdentityOrNull(normalized) === null) {
        throw new Error("GRAM_JETTON_MASTER_TESTNET must contain a valid TON account address");
    }

    return normalized;
}
