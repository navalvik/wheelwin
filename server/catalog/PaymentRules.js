export const PAYMENT_RULES = Object.freeze({
    currency: "TON",
    platformFeeRate: 0.1,
    contributionByStake: Object.freeze({
        1: 2.5,
        10: 25
    })
});

export const PAYMENT_STATUS = Object.freeze({
    PENDING: "PENDING",
    PREPARED: "PREPARED",
    COMPLETED: "COMPLETED",
    FAILED: "FAILED"
});
