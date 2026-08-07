/**
 * R7.69A — Re-export Tact-generated GameEscrow bindings for Blueprint tests.
 */
export {
    GameEscrow,
    storeInitGame,
    storeOpenPayments,
    storeStake,
    storeSettle,
    STATUS_UNINITIALIZED,
    STATUS_DEPLOYED,
    STATUS_WAITING_PAYMENTS,
    STATUS_PAYMENTS_OPEN,
    STATUS_READY,
    STATUS_SETTLING,
    STATUS_SETTLED,
    STATUS_CANCELLED,
    STATUS_FAILED,
    CONTRACT_VERSION,
    PLAYER_COUNT,
    GameEscrow_errors
} from "../build/GameEscrow/GameEscrow_GameEscrow";

export type {
    InitGame,
    OpenPayments,
    Stake,
    Settle,
    SettlementInfo,
    PlayerPaymentInfo
} from "../build/GameEscrow/GameEscrow_GameEscrow";
