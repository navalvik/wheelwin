/**
 * R17.9L.11 — Re-export Tact-generated DepositContract bindings for Blueprint tests.
 */
export {
    DepositContract,
    storeFundSeat,
    storeRelease,
    storeExpire,
    storeRefund,
    STATUS_UNINITIALIZED,
    STATUS_AWAITING_FUNDS,
    STATUS_PARTIALLY_FUNDED,
    STATUS_FULL,
    STATUS_RELEASED,
    STATUS_REFUNDING,
    STATUS_REFUNDED,
    STATUS_EXPIRED,
    DEPOSIT_CONTRACT_VERSION,
    SEAT_COUNT,
    ALL_SEATS_MASK,
    DepositContract_errors
} from "../build/DepositContract/DepositContract_DepositContract";

export type {
    FundSeat,
    Release,
    Expire,
    Refund
} from "../build/DepositContract/DepositContract_DepositContract";
