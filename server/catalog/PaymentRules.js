export const PAYMENT_RULES = Object.freeze({
    currency: "TON",
    // WheelWin commission: 5% of total paid (prize pool = 95%).
    platformFeeRate: 0.05,
    // 2-sector players pay BaseStake × multiplier (matches Page2 GRM rules).
    twoSectorMultiplier: 2.5,
    // Base stake → 1-sector contribution (GRM). 2-sector uses × twoSectorMultiplier.
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
