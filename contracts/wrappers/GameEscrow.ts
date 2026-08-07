/**
 * R7.69C — Re-export Tact-generated GameEscrow bindings for Blueprint tests.
 */
export {
    GameEscrow,
    storeInitGame,
    storeOpenPayments,
    storeStake,
    storeSettle,
    storeEmergencyCancel,
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
    EmergencyCancel,
    SettlementInfo,
    PlayerPaymentInfo,
    CancelStatus
} from "../build/GameEscrow/GameEscrow_GameEscrow";
