export const LIVE_PAYMENT_ACCEPTANCE_ENABLED = true;
export const LIVE_PAYMENT_ACCEPTANCE_DISABLED_REASON = "REFUND_EXECUTION_NOT_READY";

export function assertLivePaymentAcceptanceEnabled() {
    if (!LIVE_PAYMENT_ACCEPTANCE_ENABLED) {
        throw new Error(
            `Live payment acceptance is disabled: ${LIVE_PAYMENT_ACCEPTANCE_DISABLED_REASON}`
        );
    }
}
