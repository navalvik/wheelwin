/**
 * T2.3 — Game contract get-method stack deserializers.
 */

import {
    createArchiveDTO,
    createBalanceDTO,
    createCancelStatusDTO,
    createContractStateDTO,
    createParticipantDTO,
    createPlayerPaymentDTO,
    createSettlementDTO,
    createWinnerDTO
} from "./GameContractDtos.js";
import {
    GAME_CONTRACT_GET_METHODS,
    GAME_CONTRACT_ON_CHAIN_STATUS,
    GAME_CONTRACT_VERSION
} from "./GameContractOpcodes.js";
import {
    DeserializationError,
    InvalidContractResponseError,
    UnsupportedContractVersionError
} from "./GameContractErrors.js";

const STATUS_BY_CODE = Object.freeze({
    0: GAME_CONTRACT_ON_CHAIN_STATUS.UNINITIALIZED,
    1: GAME_CONTRACT_ON_CHAIN_STATUS.DEPLOYED,
    2: GAME_CONTRACT_ON_CHAIN_STATUS.WAITING_PAYMENTS,
    3: GAME_CONTRACT_ON_CHAIN_STATUS.PAYMENTS_OPEN,
    4: GAME_CONTRACT_ON_CHAIN_STATUS.PAYMENTS_LOCKED,
    5: GAME_CONTRACT_ON_CHAIN_STATUS.READY,
    6: GAME_CONTRACT_ON_CHAIN_STATUS.LOCKED,
    7: GAME_CONTRACT_ON_CHAIN_STATUS.SETTLING,
    8: GAME_CONTRACT_ON_CHAIN_STATUS.SETTLED,
    9: GAME_CONTRACT_ON_CHAIN_STATUS.CANCELLED,
    10: GAME_CONTRACT_ON_CHAIN_STATUS.FAILED,
    11: GAME_CONTRACT_ON_CHAIN_STATUS.ARCHIVED,
    12: GAME_CONTRACT_ON_CHAIN_STATUS.DESTROYED
});

export function decodeContractState(address, network, stackResult) {

    const stack = normalizeStack(stackResult);

    const statusCode = readInt(stack, 0, "get_contract_state");

    const contractVersion = readInt(stack, 1, "get_contract_state", {
        optional: true
    });

    const paidMask = readInt(stack, 2, "get_contract_state", {
        optional: true,
        fallback: 0
    });

    if (
        contractVersion != null
        && contractVersion > 0
        && contractVersion > GAME_CONTRACT_VERSION
    ) {

        throw new UnsupportedContractVersionError(contractVersion);

    }

    return createContractStateDTO({
        address,
        network,
        status: STATUS_BY_CODE[statusCode] ?? GAME_CONTRACT_ON_CHAIN_STATUS.FAILED,
        contractVersion,
        paidMask,
        exists: true
    });

}

export function decodePaidMask(stackResult) {

    const stack = normalizeStack(stackResult);

    return readInt(stack, 0, GAME_CONTRACT_GET_METHODS.PAID_MASK);

}

export function decodeTotalPaid(stackResult) {

    const stack = normalizeStack(stackResult);

    return readBigInt(stack, 0, GAME_CONTRACT_GET_METHODS.TOTAL_PAID);

}

export function decodeRequiredTotal(stackResult) {

    const stack = normalizeStack(stackResult);

    return readBigInt(stack, 0, GAME_CONTRACT_GET_METHODS.REQUIRED_TOTAL);

}

/**
 * R7.69B — Decode GameEscrow get_player_payment(index).
 * Stack: player address, requiredStake, paid (0|1).
 */
export function decodePlayerPayment(stackResult, index = 0) {

    const stack = normalizeStack(stackResult);

    const wallet = readAddress(stack[0], 0, { optional: true });

    const requiredStake = readBigInt(stack, 1, GAME_CONTRACT_GET_METHODS.PLAYER_PAYMENT, {
        optional: true,
        fallback: 0n
    });

    const paid = readInt(stack, 2, GAME_CONTRACT_GET_METHODS.PLAYER_PAYMENT, {
        optional: true,
        fallback: 0
    }) === 1;

    return createPlayerPaymentDTO({
        index: Number(index) || 0,
        wallet,
        requiredStake,
        paid
    });

}

/**
 * R7.69C — Decode GameEscrow get_refund_mask().
 */
export function decodeRefundMask(stackResult) {

    const stack = normalizeStack(stackResult);

    return readInt(stack, 0, GAME_CONTRACT_GET_METHODS.REFUND_MASK);

}

/**
 * R7.69C — Decode GameEscrow get_refunded_total().
 */
export function decodeRefundedTotal(stackResult) {

    const stack = normalizeStack(stackResult);

    return readBigInt(stack, 0, GAME_CONTRACT_GET_METHODS.REFUNDED_TOTAL);

}

/**
 * R7.69C — Decode GameEscrow get_cancel_status().
 * Stack: cancelled (0|1), cancelReason, refundMask.
 */
export function decodeCancelStatus(stackResult) {

    const stack = normalizeStack(stackResult);

    const cancelled = readInt(stack, 0, GAME_CONTRACT_GET_METHODS.CANCEL_STATUS, {
        optional: true,
        fallback: 0
    }) === 1;

    const cancelReason = readInt(stack, 1, GAME_CONTRACT_GET_METHODS.CANCEL_STATUS, {
        optional: true,
        fallback: 0
    });

    const refundMask = readInt(stack, 2, GAME_CONTRACT_GET_METHODS.CANCEL_STATUS, {
        optional: true,
        fallback: 0
    });

    return createCancelStatusDTO({
        cancelled,
        cancelReason,
        refundMask
    });

}

export function decodeParticipants(stackResult) {

    const stack = normalizeStack(stackResult);

    const tuple = stack[0]?.tuple ?? stack[0]?.items ?? stack[0];

    if (!Array.isArray(tuple)) {

        throw new InvalidContractResponseError("get_participants");

    }

    return Object.freeze(tuple.map((entry, index) => {

        const wallet = readAddress(entry?.[0] ?? entry?.wallet ?? entry, index);

        const requiredAmount = readInt(
            [entry?.[1] ?? entry?.requiredAmount],
            0,
            "participant",
            { optional: true }
        );

        const paid = readInt(
            [entry?.[2] ?? entry?.paid],
            0,
            "participant",
            { optional: true, fallback: 0 }
        ) === 1;

        const paymentReference = readString(
            [entry?.[3] ?? entry?.paymentReference],
            0,
            { optional: true }
        );

        return createParticipantDTO({
            index,
            wallet,
            requiredAmount,
            paid,
            paymentReference
        });

    }));

}

export function decodeWinner(address, stackResult) {

    const stack = normalizeStack(stackResult);

    const winnerWallet = readAddress(stack[0], 0, { optional: true });

    const winnerPlayerIdHash = readString(stack, 1, { optional: true });

    return createWinnerDTO({
        address,
        winnerWallet,
        winnerPlayerIdHash
    });

}

export function decodeSettlementState(address, stackResult) {

    const stack = normalizeStack(stackResult);

    const statusCode = readInt(stack, 0, "get_settlement_state");

    const winnerWallet = readAddress(stack[1], 1, { optional: true });

    const winnerAmount = readInt(stack, 2, "get_settlement_state", {
        optional: true
    });

    const organizerAmount = readInt(stack, 3, "get_settlement_state", {
        optional: true
    });

    const settlementTxHash = readString(stack, 4, { optional: true });

    return createSettlementDTO({
        address,
        status: STATUS_BY_CODE[statusCode] ?? GAME_CONTRACT_ON_CHAIN_STATUS.FAILED,
        winnerWallet,
        winnerAmount,
        organizerAmount,
        settlementTxHash
    });

}

export function decodeBalances(address, stackResult) {

    const stack = normalizeStack(stackResult);

    const tonBalance = readBigInt(stack, 0, "get_balances");

    const jettonBalance = readBigInt(stack, 1, "get_balances", {
        optional: true,
        fallback: 0n
    });

    const currency = readString(stack, 2, { optional: true });

    return createBalanceDTO({
        address,
        tonBalance,
        jettonBalance,
        currency
    });

}

export function decodeArchiveState(address, stackResult) {

    const stack = normalizeStack(stackResult);

    const archived = readInt(stack, 0, "get_archive_state") === 1;

    const archivedAt = readInt(stack, 1, "get_archive_state", {
        optional: true
    });

    const archiveReason = readString(stack, 2, { optional: true });

    return createArchiveDTO({
        address,
        archived,
        archivedAt,
        archiveReason
    });

}

export function decodeNetwork(stackResult) {

    const stack = normalizeStack(stackResult);

    return readString(stack, 0) ?? null;

}

/**
 * @ton/ton TonClient.runMethod returns `{ stack: TupleReader }` (@ton/core).
 * Existing tests/shims also pass plain arrays or `{ stack: [...] }`.
 */
function isTupleReaderLike(value) {

    return Boolean(
        value
        && typeof value === "object"
        && typeof value.pop === "function"
        && typeof value.peek === "function"
        && typeof value.remaining === "number"
    );

}

function tupleReaderToItemArray(reader) {

    // Non-destructive: TupleReader keeps items on a runtime field (TS-private).
    if (Array.isArray(reader.items)) {

        return reader.items.slice();

    }

    const items = [];

    while (reader.remaining > 0) {

        items.push(reader.pop());

    }

    return items;

}

function normalizeStack(stackResult) {

    if (!stackResult) {

        throw new InvalidContractResponseError("stack", { reason: "missing" });

    }

    if (Array.isArray(stackResult.stack)) {

        return stackResult.stack;

    }

    if (Array.isArray(stackResult)) {

        return stackResult;

    }

    // Production TonClient.runMethod shape: { gas_used, stack: TupleReader }.
    if (isTupleReaderLike(stackResult.stack)) {

        return tupleReaderToItemArray(stackResult.stack);

    }

    if (isTupleReaderLike(stackResult)) {

        return tupleReaderToItemArray(stackResult);

    }

    throw new InvalidContractResponseError("stack", { reason: "invalid_shape" });

}

function readInt(stack, index, method, { optional = false, fallback = null } = {}) {

    const item = stack[index];

    if (item == null) {

        if (optional) {

            return fallback;

        }

        throw new InvalidContractResponseError(method, { index, type: "int" });

    }

    const value = item?.value ?? item;

    if (typeof value === "number") {

        return value;

    }

    if (typeof value === "bigint") {

        return Number(value);

    }

    if (typeof value === "string" && value.trim() !== "") {

        return Number(value);

    }

    throw new DeserializationError(`Unable to decode int at index ${index}`);

}

function readBigInt(stack, index, method, { optional = false, fallback = 0n } = {}) {

    const item = stack[index];

    if (item == null) {

        if (optional) {

            return fallback;

        }

        throw new InvalidContractResponseError(method, { index, type: "bigint" });

    }

    const value = item?.value ?? item;

    if (typeof value === "bigint") {

        return value;

    }

    if (typeof value === "number") {

        return BigInt(value);

    }

    if (typeof value === "string" && value.trim() !== "") {

        return BigInt(value);

    }

    throw new DeserializationError(`Unable to decode bigint at index ${index}`);

}

function readString(stack, index, { optional = false } = {}) {

    const item = stack[index];

    if (item == null) {

        if (optional) {

            return null;

        }

        throw new InvalidContractResponseError("string", { index });

    }

    const value = item?.value ?? item;

    if (typeof value === "string") {

        return value;

    }

    return null;

}

function readAddress(item, index, { optional = false } = {}) {

    if (item == null) {

        if (optional) {

            return null;

        }

        throw new InvalidContractResponseError("address", { index });

    }

    const value = item?.value ?? item;

    if (typeof value === "string" && value.trim()) {

        return value.trim();

    }

    if (value && typeof value.toString === "function") {

        try {

            return value.toString({ bounceable: true, urlSafe: true });

        } catch {

            // fall through

        }

    }

    if (optional) {

        return null;

    }

    throw new DeserializationError(`Unable to decode address at index ${index}`);

}
