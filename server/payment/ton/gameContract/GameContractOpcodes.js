/**
 * T2.3 — WheelWin Game Escrow contract opcodes (T1.3 aligned).
 */

export const GAME_CONTRACT_VERSION = 1;

export const GAME_CONTRACT_OPCODES = Object.freeze({
    // Legacy 24-bit settle opcode retained for backward compatibility.
    SETTLE: 0x53544c,
    INIT_GAME: 0x494e4954,
    // R7.69A — on-chain player stakes / open payments.
    OPEN_PAYMENTS: 0x4F50454E,
    STAKE: 0x5354414B,
    EMERGENCY_CANCEL: 0x43414e43,
    ARCHIVE: 0x41524348,
    // Post-SETTLED residual sweep (not SETTLE ABI).
    SWEEP_RESIDUAL: 0x53574550
});

/**
 * Matches GameEscrow.tact SETTLE_GAS_RESERVE.
 * Residual sweep must leave this on-chain so get_status remains callable.
 */
export const GAME_ESCROW_SETTLE_GAS_RESERVE_TON = "0.05";

export const GAME_CONTRACT_GET_METHODS = Object.freeze({
    CONTRACT_STATE: "get_contract_state",
    PAID_MASK: "get_paid_mask",
    TOTAL_PAID: "get_total_paid",
    REQUIRED_TOTAL: "get_required_total",
    PLAYER_PAYMENT: "get_player_payment",
    REFUND_MASK: "get_refund_mask",
    REFUNDED_TOTAL: "get_refunded_total",
    CANCEL_STATUS: "get_cancel_status",
    PARTICIPANTS: "get_participants",
    WINNER: "get_winner",
    SETTLEMENT_STATE: "get_settlement_state",
    BALANCES: "get_balances",
    NETWORK: "get_network",
    ARCHIVE_STATE: "get_archive_state",
    RESIDUAL_SWEPT: "get_residual_swept"
});

export const GAME_CONTRACT_ON_CHAIN_STATUS = Object.freeze({
    UNINITIALIZED: "UNINITIALIZED",
    DEPLOYED: "DEPLOYED",
    WAITING_PAYMENTS: "WAITING_PAYMENTS",
    PAYMENTS_OPEN: "PAYMENTS_OPEN",
    PAYMENTS_LOCKED: "PAYMENTS_LOCKED",
    READY: "READY",
    LOCKED: "LOCKED",
    SETTLING: "SETTLING",
    SETTLED: "SETTLED",
    CANCELLED: "CANCELLED",
    FAILED: "FAILED",
    ARCHIVED: "ARCHIVED",
    DESTROYED: "DESTROYED"
});
