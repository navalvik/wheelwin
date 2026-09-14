import { randomBytes } from "node:crypto";

const HANDOFF_TTL_MS = 2 * 60 * 1000;
const CLAIM_LEASE_MS = 30 * 1000;

export class RoomNetworkHandoffStore {
    constructor({ now = () => Date.now() } = {}) {
        this._now = now;
        this._records = new Map();
    }

    create({ roomId, ownerPlayerId, ownerTelegramUserId }) {
        const normalized = {
            roomId: String(roomId ?? "").trim(),
            ownerPlayerId: String(ownerPlayerId ?? "").trim(),
            ownerTelegramUserId: String(ownerTelegramUserId ?? "").trim()
        };

        if (!normalized.roomId || !normalized.ownerPlayerId || !normalized.ownerTelegramUserId) {
            throw new Error("Invalid room network handoff identity");
        }

        const handoffId = randomBytes(24).toString("base64url");
        const now = this._now();

        this._records.set(handoffId, {
            handoffId,
            ...normalized,
            targetNetwork: "mainnet",
            createdAt: now,
            expiresAt: now + HANDOFF_TTL_MS,
            state: "pending",
            claimExpiresAt: null,
            mainnetRoomId: null
        });

        return {
            handoffId,
            targetNetwork: "mainnet",
            expiresAt: now + HANDOFF_TTL_MS
        };
    }

    claim({ handoffId, ownerTelegramUserId }) {
        const record = this._getLive(handoffId);
        const telegramUserId = String(ownerTelegramUserId ?? "").trim();

        if (!record) return { ok: false, reason: "NOT_FOUND_OR_EXPIRED" };
        if (record.ownerTelegramUserId !== telegramUserId) {
            return { ok: false, reason: "OWNER_MISMATCH" };
        }
        if (record.state === "completed") {
            return { ok: true, state: "completed", mainnetRoomId: record.mainnetRoomId };
        }

        const now = this._now();
        if (record.state === "claimed" && record.claimExpiresAt > now) {
            return { ok: true, state: "claimed", mainnetRoomId: null };
        }

        record.state = "claimed";
        record.claimExpiresAt = now + CLAIM_LEASE_MS;

        return { ok: true, state: "claimed", mainnetRoomId: null };
    }

    complete({ handoffId, ownerTelegramUserId, mainnetRoomId }) {
        const record = this._getLive(handoffId);
        const telegramUserId = String(ownerTelegramUserId ?? "").trim();
        const roomId = String(mainnetRoomId ?? "").trim();

        if (!record) return { ok: false, reason: "NOT_FOUND_OR_EXPIRED" };
        if (record.ownerTelegramUserId !== telegramUserId) {
            return { ok: false, reason: "OWNER_MISMATCH" };
        }
        if (record.state === "completed") {
            return { ok: true, state: "completed", mainnetRoomId: record.mainnetRoomId };
        }
        if (record.state !== "claimed" || record.claimExpiresAt <= this._now()) {
            return { ok: false, reason: "CLAIM_REQUIRED" };
        }
        if (!roomId) return { ok: false, reason: "INVALID_MAINNET_ROOM_ID" };

        record.state = "completed";
        record.claimExpiresAt = null;
        record.mainnetRoomId = roomId;

        return { ok: true, state: "completed", mainnetRoomId: roomId };
    }

    release(handoffId) {
        this._records.delete(String(handoffId ?? "").trim());
    }

    _getLive(handoffId) {
        this._purgeExpired();
        return this._records.get(String(handoffId ?? "").trim()) ?? null;
    }

    _purgeExpired() {
        const now = this._now();
        for (const [id, record] of this._records) {
            if (record.expiresAt <= now) this._records.delete(id);
        }
    }
}
