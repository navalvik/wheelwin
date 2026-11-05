/**
 * Phase 1 — Payment intent lifecycle.
 *
 * Payment intent states and the only transitions permitted between them.
 * Absence of a `->` entry means the transition is invalid and MUST be rejected
 * by the data model (`InvalidPaymentStateTransitionError`).
 *
 * NOTE: none of these states represents a fabricated, simulated balance or a
 * fake confirmation. `MATCHED` means an attributed blockchain transaction
 * identifier was observed for this intent — nothing is invented.
 */

/**
 * @typedef {"PENDING"|"MATCHED"|"SETTLED"|"REFUNDED"|"EXPIRED"|"FAILED"|"CANCELLED"} PaymentIntentState
 */

export const PAYMENT_INTENT_STATE = Object.freeze({
    PENDING: "PENDING",
    MATCHED: "MATCHED",
    SETTLED: "SETTLED",
    REFUNDED: "REFUNDED",
    EXPIRED: "EXPIRED",
    FAILED: "FAILED",
    CANCELLED: "CANCELLED"
});

export const PAYMENT_INTENT_STATES = Object.freeze([
    PAYMENT_INTENT_STATE.PENDING,
    PAYMENT_INTENT_STATE.MATCHED,
    PAYMENT_INTENT_STATE.SETTLED,
    PAYMENT_INTENT_STATE.REFUNDED,
    PAYMENT_INTENT_STATE.EXPIRED,
    PAYMENT_INTENT_STATE.FAILED,
    PAYMENT_INTENT_STATE.CANCELLED
]);

/**
 * Terminal states. No transition may leave a terminal state.
 */
export const TERMINAL_PAYMENT_INTENT_STATES = Object.freeze([
    PAYMENT_INTENT_STATE.SETTLED,
    PAYMENT_INTENT_STATE.REFUNDED,
    PAYMENT_INTENT_STATE.EXPIRED,
    PAYMENT_INTENT_STATE.FAILED,
    PAYMENT_INTENT_STATE.CANCELLED
]);

/**
 * Authoritative transition table.
 */
export const PAYMENT_INTENT_TRANSITIONS = Object.freeze({
    [PAYMENT_INTENT_STATE.PENDING]: Object.freeze([
        PAYMENT_INTENT_STATE.MATCHED,
        PAYMENT_INTENT_STATE.EXPIRED,
        PAYMENT_INTENT_STATE.FAILED,
        PAYMENT_INTENT_STATE.CANCELLED
    ]),
    [PAYMENT_INTENT_STATE.MATCHED]: Object.freeze([
        PAYMENT_INTENT_STATE.SETTLED,
        PAYMENT_INTENT_STATE.REFUNDED,
        PAYMENT_INTENT_STATE.FAILED
    ])
});

/**
 * States that still leave a payment or refund obligation open on the room and
 * therefore block recycling that room's wallet.
 */
export const OBLIGATION_OPEN_STATES = Object.freeze([
    PAYMENT_INTENT_STATE.PENDING,
    PAYMENT_INTENT_STATE.MATCHED
]);

/**
 * @param {string} state
 * @returns {boolean}
 */
export function isPaymentIntentState(state) {

    return PAYMENT_INTENT_STATES.includes(state);

}

/**
 * @param {string} state
 * @returns {boolean}
 */
export function isTerminalPaymentIntentState(state) {

    return TERMINAL_PAYMENT_INTENT_STATES.includes(state);

}

/**
 * @param {string} state
 * @returns {boolean}
 */
export function isObligationOpen(state) {

    return OBLIGATION_OPEN_STATES.includes(state);

}

/**
 * @param {string} fromState
 * @param {string} toState
 * @returns {boolean}
 */
export function canTransition(fromState, toState) {

    const allowed = PAYMENT_INTENT_TRANSITIONS[fromState];

    if (!allowed) {

        return false;

    }

    return allowed.includes(toState);

}
