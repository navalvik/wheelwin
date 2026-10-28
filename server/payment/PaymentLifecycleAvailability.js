// Explicit Testnet-only opt-in. Default remains closed until deployment validation.
export const LIVE_PAYMENT_ACCEPTANCE_ENABLED = process.env.ROOM_WALLET_PAYMENTS_ENABLED === 'true'
    && process.env.TON_NETWORK === 'testnet';
export const LIVE_PAYMENT_ACCEPTANCE_DISABLED_REASON = "TESTNET_PAYMENTS_NOT_ENABLED";

export function assertLivePaymentAcceptanceEnabled() {
    if (!LIVE_PAYMENT_ACCEPTANCE_ENABLED) {
        throw new Error(
            `Live payment acceptance is disabled: ${LIVE_PAYMENT_ACCEPTANCE_DISABLED_REASON}`
        );
    }
}
