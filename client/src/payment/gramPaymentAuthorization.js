/**
 * Local preflight for native TON transfers displayed as GRAM in WheelWin.
 * The room and payment request must come from authoritative server state.
 */
const RAW = /^(-?(?:0|[1-9][0-9]{0,2})):([0-9a-fA-F]{64})$/;
const FRIENDLY = /^[A-Za-z0-9_-]{48}$/;

function crc16(payload) {
    let crc = 0;
    for (const byte of payload) {
        crc ^= byte << 8;
        for (let bit = 0; bit < 8; bit++) {
            crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
        }
    }
    return crc;
}

export function tonAccountIdentityOrNull(value) {
    if (typeof value !== "string" || value !== value.trim()) return null;
    const match = RAW.exec(value);
    if (match) {
        const wc = Number(match[1]);
        return wc >= -128 && wc <= 127 ? `${wc}:${match[2].toLowerCase()}` : null;
    }
    if (!FRIENDLY.test(value)) return null;
    try {
        const decoded = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
        if (decoded.length !== 36) return null;
        const bytes = Uint8Array.from(decoded, char => char.charCodeAt(0));
        if (![0x11, 0x51, 0x91, 0xd1].includes(bytes[0])) return null;
        if (crc16(bytes.subarray(0, 34)) !== ((bytes[34] << 8) | bytes[35])) return null;
        const wc = bytes[1] >= 128 ? bytes[1] - 256 : bytes[1];
        return `${wc}:${[...bytes.subarray(2, 34)].map(x => x.toString(16).padStart(2, "0")).join("")}`;
    } catch {
        return null;
    }
}

/** Native TON Testnet room-wallet payment request (not a TEP-74 Jetton). */
export function assessGramPaymentRequest(payment, connectedWalletAddress) {
    if (payment?.enabled !== true) return { ready: false, reason: "ACCEPTANCE_DISABLED" };
    if (payment.network !== "testnet" || payment.asset !== "TON")
        return { ready: false, reason: "UNSUPPORTED_ASSET_OR_NETWORK" };
    const recipient = tonAccountIdentityOrNull(payment.destination);
    const sender = tonAccountIdentityOrNull(payment.expectedSender);
    const connected = tonAccountIdentityOrNull(connectedWalletAddress);
    if (!recipient || !sender || !connected || sender !== connected || sender === recipient)
        return { ready: false, reason: "MISSING_OR_MISMATCHED_WALLET_IDENTITY" };
    if (payment.jettonMaster != null || payment.senderJettonWalletAddress != null ||
        payment.jettonWalletVerified != null)
        return { ready: false, reason: "MIXED_JETTON_PAYMENT_PROTOCOL" };
    const amount = typeof payment.amountAtomic === "string"
        ? payment.amountAtomic
        : Number.isSafeInteger(payment.amountAtomic) ? String(payment.amountAtomic) : null;
    if (!amount || !/^[1-9][0-9]*$/.test(amount)
        || typeof payment.reference !== "string"
        || !/^[A-Za-z0-9_-]{1,64}$/.test(payment.reference))
        return { ready: false, reason: "INVALID_PAYMENT_INTENT" };
    return { ready: true, reason: "PRECHECK_ONLY", amountAtomic: amount };
}
