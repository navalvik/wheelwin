/**
 * Player-funded network fee accounting policy.
 *
 * Pure accounting only: this module does not estimate TON fees, sign, send,
 * broadcast, or authorize payment acceptance. Trusted fee quotes and finalized
 * actual-fee evidence must be supplied by the runtime.
 *
 * The reserve is collected separately from game principal. It must never be
 * hidden inside stake amounts or deducted from the winner/operator allocation.
 */

export class PlayerFundedNetworkFeeError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = "PlayerFundedNetworkFeeError";
        this.code = "PLAYER_FUNDED_NETWORK_FEE_INVALID";
        this.details = Object.freeze({ ...details });
    }
}

const fail = (message, details) => {
    throw new PlayerFundedNetworkFeeError(message, details);
};

function safeNonNegativeInteger(value, field) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        fail(`${field} must be a non-negative safe integer`, { field, value });
    }
}

function nonEmptyString(value, field) {
    if (typeof value !== "string" || value.trim() === "") {
        fail(`${field} must be a non-empty string`, { field });
    }
    return value.trim();
}

function validateThreePlayers(playerIds) {
    if (!Array.isArray(playerIds) || playerIds.length !== 3) {
        fail("exactly three player IDs are required", {
            playerCount: Array.isArray(playerIds) ? playerIds.length : null
        });
    }
    const normalized = playerIds.map((id, index) => nonEmptyString(id, `playerIds[${index}]`));
    if (new Set(normalized).size !== 3) fail("player IDs must be unique");
    return normalized.sort((a, b) => a.localeCompare(b));
}

function validateQuotes(feeQuotes, nowMs) {
    if (!Array.isArray(feeQuotes) || feeQuotes.length === 0) {
        fail("at least one trusted outgoing fee quote is required");
    }
    safeNonNegativeInteger(nowMs, "nowMs");
    const seen = new Set();
    return feeQuotes.map((quote, index) => {
        if (!quote || typeof quote !== "object" || Array.isArray(quote)) {
            fail(`feeQuotes[${index}] must be an object`);
        }
        const operationId = nonEmptyString(quote.operationId, `feeQuotes[${index}].operationId`);
        if (seen.has(operationId)) fail("duplicate outgoing fee operation", { operationId });
        seen.add(operationId);
        safeNonNegativeInteger(quote.feeAtomic, `feeQuotes[${index}].feeAtomic`);
        safeNonNegativeInteger(quote.quotedAtMs, `feeQuotes[${index}].quotedAtMs`);
        if (!Number.isSafeInteger(quote.validForMs) || quote.validForMs <= 0) {
            fail(`feeQuotes[${index}].validForMs must be a positive safe integer`);
        }
        if (quote.quotedAtMs > nowMs || nowMs - quote.quotedAtMs > quote.validForMs) {
            fail("outgoing fee quote is stale or from the future", { operationId });
        }
        return Object.freeze({
            operationId,
            feeAtomic: quote.feeAtomic,
            quotedAtMs: quote.quotedAtMs,
            validForMs: quote.validForMs
        });
    });
}

/**
 * Build a separate player-funded reserve from fresh trusted outgoing fee quotes.
 * Nanoton remainder is assigned by sorted player ID, so allocation is stable
 * regardless of the order in which the three players joined the room.
 */
export function createPlayerFundedFeeReserve({ roomId, playerIds, feeQuotes, nowMs }) {
    const normalizedRoomId = nonEmptyString(roomId, "roomId");
    const players = validateThreePlayers(playerIds);
    const quotes = validateQuotes(feeQuotes, nowMs);
    const totalReserveAtomic = quotes.reduce((sum, quote) => {
        const next = sum + quote.feeAtomic;
        if (!Number.isSafeInteger(next)) fail("total fee reserve exceeds safe integer range");
        return next;
    }, 0);

    const baseShare = Math.floor(totalReserveAtomic / players.length);
    const remainder = totalReserveAtomic % players.length;
    const contributions = players.map((playerId, index) => Object.freeze({
        playerId,
        amountAtomic: baseShare + (index < remainder ? 1 : 0)
    }));

    return Object.freeze({
        roomId: normalizedRoomId,
        currency: "TON",
        atomicUnit: "nanoton",
        playerIds: Object.freeze(players),
        feeQuotes: Object.freeze(quotes),
        totalReserveAtomic,
        contributions: Object.freeze(contributions),
        computedAtMs: nowMs,
        principalExcluded: true
    });
}

/**
 * Reconcile finalized actual outgoing fees against the player-funded reserve.
 * Missing, duplicate, or unquoted operations fail closed. A shortfall blocks
 * settlement; it must never be charged to stake principal or the room wallet.
 */
export function reconcilePlayerFundedFees({ reserve, actualFees }) {
    if (!reserve || reserve.principalExcluded !== true
        || !Array.isArray(reserve.feeQuotes)
        || !Number.isSafeInteger(reserve.totalReserveAtomic)) {
        fail("a valid player-funded fee reserve is required");
    }
    if (!Array.isArray(actualFees) || actualFees.length !== reserve.feeQuotes.length) {
        fail("actual fee evidence must cover every reserved outgoing operation");
    }

    const expected = new Map(reserve.feeQuotes.map((quote) => [quote.operationId, quote]));
    const seen = new Set();
    const normalizedActual = actualFees.map((actual, index) => {
        if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
            fail(`actualFees[${index}] must be an object`);
        }
        const operationId = nonEmptyString(actual.operationId, `actualFees[${index}].operationId`);
        if (!expected.has(operationId) || seen.has(operationId)) {
            fail("actual fee operation is unquoted or duplicated", { operationId });
        }
        seen.add(operationId);
        safeNonNegativeInteger(actual.feeAtomic, `actualFees[${index}].feeAtomic`);
        return Object.freeze({ operationId, feeAtomic: actual.feeAtomic });
    });

    const actualTotalAtomic = normalizedActual.reduce((sum, item) => {
        const next = sum + item.feeAtomic;
        if (!Number.isSafeInteger(next)) fail("actual fee total exceeds safe integer range");
        return next;
    }, 0);

    if (actualTotalAtomic > reserve.totalReserveAtomic) {
        fail("actual fees exceed the player-funded reserve; settlement is blocked", {
            reservedAtomic: reserve.totalReserveAtomic,
            actualAtomic: actualTotalAtomic,
            shortfallAtomic: actualTotalAtomic - reserve.totalReserveAtomic
        });
    }

    return Object.freeze({
        roomId: reserve.roomId,
        reservedAtomic: reserve.totalReserveAtomic,
        actualAtomic: actualTotalAtomic,
        surplusAtomic: reserve.totalReserveAtomic - actualTotalAtomic,
        settlementAllowed: true,
        surplusDisposition: "REQUIRES_EXPLICIT_REFUND_OR_RECONCILIATION",
        actualFees: Object.freeze(normalizedActual)
    });
}
