/**
 * Phase 1 — Immutable room deadline value object.
 *
 * R1 / room deadline: every room has exactly one deadline, fixed at
 * `roomCreatedAt + 300000` milliseconds. The value is immutable — it can be
 * derived but never restarted, extended, or recomputed.
 */

import {
    ROOM_LIFETIME_MS
} from "./RoomPaymentConstants.js";

import {
    PaymentValidationError
} from "./PaymentErrors.js";

export class RoomDeadline {

    /**
     * @param {number} roomCreatedAt Epoch milliseconds of room creation.
     */
    constructor(roomCreatedAt) {

        if (!Number.isInteger(roomCreatedAt) || roomCreatedAt <= 0) {

            throw new PaymentValidationError(
                "roomCreatedAt must be a positive integer epoch-milliseconds value",
                { roomCreatedAt }
            );

        }

        this._roomCreatedAt = roomCreatedAt;

        this._deadlineMs = roomCreatedAt + ROOM_LIFETIME_MS;

        Object.freeze(this);

    }

    /** Epoch milliseconds at which the room was created. */
    get roomCreatedAt() {

        return this._roomCreatedAt;

    }

    /**
     * Absolute room deadline: exactly `roomCreatedAt + 300000`.
     */
    get deadlineMs() {

        return this._deadlineMs;

    }

    /**
     * Remaining room lifetime in milliseconds (never negative).
     *
     * @param {number} [now]
     * @returns {number}
     */
    remainingMs(now = Date.now()) {

        return Math.max(0, this._deadlineMs - now);

    }

    /**
     * @param {number} [now]
     * @returns {boolean} true once the room deadline has been reached.
     */
    isReached(now = Date.now()) {

        return now >= this._deadlineMs;

    }

    toJSON() {

        return Object.freeze({
            roomCreatedAt: this._roomCreatedAt,
            roomLifetimeMs: ROOM_LIFETIME_MS,
            deadlineMs: this._deadlineMs
        });

    }

}

/**
 * Factory used by the payment service. Kept explicit so the 300s rule lives in
 * exactly one place.
 *
 * @param {number} roomCreatedAt
 * @returns {RoomDeadline}
 */
export function createRoomDeadline(roomCreatedAt) {

    return new RoomDeadline(roomCreatedAt);

}
