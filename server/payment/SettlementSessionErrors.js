export class InvalidSettlementStateTransitionError extends Error {
    constructor(settlementSessionId, fromStatus, toStatus) {
        super(
            `Invalid settlement session transition | id=${settlementSessionId} | `
                + `from=${fromStatus} | to=${toStatus}`
        );
        this.name = "InvalidSettlementStateTransitionError";
        this.code = "INVALID_SETTLEMENT_STATE_TRANSITION";
        this.details = { settlementSessionId, fromStatus, toStatus };
    }
}
