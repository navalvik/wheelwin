export const PAYMENT_RULES = Object.freeze({
    currency: "TON",
    // WheelWin commission: 5% of total paid (prize pool = 95%).
    platformFeeRate: 0.05,
    // Second sector cost = BaseStake × secondSectorMultiplier (1.5×).
    secondSectorMultiplier: 1.5,
    // Base stake → first-sector contribution (1 × BaseStake GRM).
    contributionByStake: Object.freeze({
        1: 1,
        10: 10
    })
});

export const PAYMENT_STATUS = Object.freeze({
    PENDING: "PENDING",
    PREPARED: "PREPARED",
    COMPLETED: "COMPLETED",
    FAILED: "FAILED"
});
