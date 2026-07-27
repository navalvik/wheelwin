/**
 * T2.3 — WheelWin Game Escrow contract opcodes (T1.3 aligned).
 */

export const GAME_CONTRACT_VERSION = 1;

export const GAME_CONTRACT_OPCODES = Object.freeze({
    // Legacy 24-bit settle opcode retained for backward compatibility.
    SETTLE: 0x53544c,
    INIT_GAME: 0x494e4954,
    EMERGENCY_CANCEL: 0x43414e43,
    ARCHIVE: 0x41524348
});

export const GAME_CONTRACT_GET_METHODS = Object.freeze({
    CONTRACT_STATE: "get_contract_state",
    PAID_MASK: "get_paid_mask",
    PARTICIPANTS: "get_participants",
    WINNER: "get_winner",
    SETTLEMENT_STATE: "get_settlement_state",
    BALANCES: "get_balances",
    NETWORK: "get_network",
    ARCHIVE_STATE: "get_archive_state"
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
