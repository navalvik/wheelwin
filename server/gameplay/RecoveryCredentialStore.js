import { createHash, randomBytes, timingSafeEqual } from "crypto";

/**
 * R13.1E — Server-issued recovery credentials.
 *
 * Plaintext is returned once at issuance and never persisted.
 * Only SHA-256 digests are retained, bound to playerId + roomId.
 */

export const RECOVERY_AUTH_REASONS = Object.freeze({
    MISSING: "RECOVERY_AUTH_MISSING",
    INVALID: "RECOVERY_AUTH_INVALID",
    PLAYER_MISMATCH: "RECOVERY_AUTH_PLAYER_MISMATCH",
    ROOM_MISMATCH: "RECOVERY_AUTH_ROOM_MISMATCH"
});

function hashCredential(credential) {

    return createHash("sha256").update(String(credential), "utf8").digest();

}

export class RecoveryCredentialStore {

    constructor() {

        /** @type {Map<string, { roomId: string, hash: Buffer, issuedAt: number }>} */
        this._byPlayer = new Map();

    }

    /**
     * Issue a new credential for a player seat. Replaces any prior credential.
     * @returns {string} plaintext credential (deliver only to owner socket)
     */
    issue(playerId, roomId) {

        if (!playerId || !roomId) {

            throw new Error("RecoveryCredentialStore.issue requires playerId and roomId");

        }

        const credential = randomBytes(32).toString("base64url");

        this._byPlayer.set(playerId, {
            roomId,
            hash: hashCredential(credential),
            issuedAt: Date.now()
        });

        return credential;

    }

    /**
     * Validate a client-presented credential against the stored binding.
     * @returns {{ ok: true, playerId: string, roomId: string }
     *   | { ok: false, reason: string }}
     */
    validate({ playerId, roomId = null, credential = null } = {}) {

        if (!playerId
            || credential == null
            || typeof credential !== "string"
            || credential.length === 0) {

            return {
                ok: false,
                reason: RECOVERY_AUTH_REASONS.MISSING
            };

        }

        const entry = this._byPlayer.get(playerId);

        if (!entry) {

            return {
                ok: false,
                reason: RECOVERY_AUTH_REASONS.INVALID
            };

        }

        if (roomId && entry.roomId && roomId !== entry.roomId) {

            return {
                ok: false,
                reason: RECOVERY_AUTH_REASONS.ROOM_MISMATCH
            };

        }

        const presented = hashCredential(credential);

        if (
            presented.length !== entry.hash.length
            || !timingSafeEqual(presented, entry.hash)
        ) {

            // Credential may belong to a different player — classify mismatch.
            for (const [otherPlayerId, otherEntry] of this._byPlayer) {

                if (otherPlayerId === playerId) {

                    continue;

                }

                if (
                    presented.length === otherEntry.hash.length
                    && timingSafeEqual(presented, otherEntry.hash)
                ) {

                    return {
                        ok: false,
                        reason: RECOVERY_AUTH_REASONS.PLAYER_MISMATCH
                    };

                }

            }

            return {
                ok: false,
                reason: RECOVERY_AUTH_REASONS.INVALID
            };

        }

        return {
            ok: true,
            playerId,
            roomId: entry.roomId
        };

    }

    has(playerId) {

        return this._byPlayer.has(playerId);

    }

    invalidate(playerId) {

        if (!playerId) {

            return;

        }

        this._byPlayer.delete(playerId);

    }

    invalidateRoom(roomId) {

        if (!roomId) {

            return;

        }

        for (const [playerId, entry] of this._byPlayer) {

            if (entry.roomId === roomId) {

                this._byPlayer.delete(playerId);

            }

        }

    }

    clear() {

        this._byPlayer.clear();

    }

}
