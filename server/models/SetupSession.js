import { randomUUID } from "node:crypto";

import { SETUP_SESSION_STATUS } from "./SetupSessionStatus.js";

/**
 * C5.6C — Authoritative Setup Session lifecycle object.
 *
 * 1:1 with a Room. Owns Setup Timer (startedAt / expiresAt) and preparation
 * state. Not a manager. Not a Game Session.
 */
export class SetupSession {

    constructor({
        roomId,
        startedAt,
        expiresAt,
        setupSessionId = null,
        state = SETUP_SESSION_STATUS.CREATED,
        verificationState = null,
        paymentPrepState = null,
        roomFull = false
    }) {

        if (!roomId) {

            throw new Error("SetupSession requires roomId");

        }

        if (!Number.isFinite(startedAt) || !Number.isFinite(expiresAt)) {

            throw new Error("SetupSession requires startedAt and expiresAt");

        }

        this.setupSessionId = setupSessionId ?? randomUUID();

        this.roomId = roomId;

        this.startedAt = startedAt;

        this.expiresAt = expiresAt;

        this.state = state;

        this.verificationState = verificationState;

        this.paymentPrepState = paymentPrepState;

        this.roomFull = roomFull;

        this._immutable = false;

    }

    activate() {

        this._assertMutable();

        this.state = SETUP_SESSION_STATUS.ACTIVE;

    }

    markRoomFull() {

        this._assertMutable();

        this.roomFull = true;

    }

    markVerificationReady() {

        this._assertMutable();

        this.verificationState = "READY";

    }

    markPaymentPrepReady() {

        this._assertMutable();

        this.paymentPrepState = "READY";

    }

    isCompletionReady() {

        return this.state === SETUP_SESSION_STATUS.ACTIVE
            && this.roomFull === true
            && this.verificationState === "READY"
            && this.paymentPrepState === "READY";

    }

    complete() {

        this._assertMutable();

        this.state = SETUP_SESSION_STATUS.COMPLETED;

        this._freeze();

    }

    expire() {

        this._assertMutable();

        this.state = SETUP_SESSION_STATUS.EXPIRED;

        this._freeze();

    }

    abort() {

        if (this._immutable) {

            return;

        }

        this.state = SETUP_SESSION_STATUS.ABORTED;

        this._freeze();

    }

    remainingTime(now = Date.now()) {

        return Math.max(0, this.expiresAt - now);

    }

    isActive() {

        return this.state === SETUP_SESSION_STATUS.ACTIVE;

    }

    toSnapshot(now = Date.now()) {

        return Object.freeze({
            setupSessionId: this.setupSessionId,
            roomId: this.roomId,
            startedAt: this.startedAt,
            expiresAt: this.expiresAt,
            remainingTime: this.remainingTime(now),
            state: this.state,
            verificationState: this.verificationState,
            paymentPrepState: this.paymentPrepState,
            roomFull: this.roomFull
        });

    }

    _assertMutable() {

        if (this._immutable) {

            throw new Error(
                `SetupSession is immutable (${this.setupSessionId})`
            );

        }

    }

    _freeze() {

        this._immutable = true;

        Object.freeze(this);

    }

}
