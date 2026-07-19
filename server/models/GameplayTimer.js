/**
 * R1.3C — Authoritative Gameplay Timer record (Timer 2).
 *
 * Wall-clock session limit for Page5. Not a phase clock. Immutable
 * startedAt / expiresAt once created; remainingTime is derived.
 */
export class GameplayTimer {

    constructor({
        gameId,
        roomId = null,
        startedAt,
        expiresAt,
        durationMs,
        warningEmitted = false,
        expired = false
    }) {

        if (!gameId) {

            throw new Error("GameplayTimer requires gameId");

        }

        if (!Number.isFinite(startedAt) || !Number.isFinite(expiresAt)) {

            throw new Error("GameplayTimer requires startedAt and expiresAt");

        }

        if (!Number.isFinite(durationMs) || durationMs <= 0) {

            throw new Error("GameplayTimer requires a positive durationMs");

        }

        this.gameId = gameId;

        this.roomId = roomId;

        this.startedAt = startedAt;

        this.expiresAt = expiresAt;

        this.durationMs = durationMs;

        this.warningEmitted = warningEmitted === true;

        this.expired = expired === true;

    }

    remainingTime(now = Date.now()) {

        return Math.max(0, this.expiresAt - now);

    }

    markWarningEmitted() {

        this.warningEmitted = true;

    }

    markExpired() {

        this.expired = true;

    }

    toSnapshot(now = Date.now()) {

        return Object.freeze({
            gameId: this.gameId,
            roomId: this.roomId,
            startedAt: this.startedAt,
            expiresAt: this.expiresAt,
            durationMs: this.durationMs,
            remainingTime: this.remainingTime(now),
            warningEmitted: this.warningEmitted,
            expired: this.expired
        });

    }

}
