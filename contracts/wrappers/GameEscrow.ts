/**
 * R7.66B — Re-export Tact-generated GameEscrow bindings for Blueprint tests.
 */
export {
    GameEscrow,
    storeInitGame,
    storeSettle,
    STATUS_UNINITIALIZED,
    STATUS_DEPLOYED,
    STATUS_READY,
    STATUS_SETTLING,
    STATUS_SETTLED,
    STATUS_FAILED,
    CONTRACT_VERSION,
    GameEscrow_errors
} from "../build/GameEscrow/GameEscrow_GameEscrow";

export type {
    InitGame,
    Settle,
    SettlementInfo
} from "../build/GameEscrow/GameEscrow_GameEscrow";
