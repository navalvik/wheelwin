import { randomBytes } from "node:crypto";

const DEFAULT_TTL_MS = 2 * 60 * 1000;
const DEFAULT_CLAIM_LEASE_MS = 30 * 1000;

function normalizeTelegramUserId(value) {
    const normalized = String(value ?? "").trim();

    return normalized || null;
}

export class RoomNetworkHandoffStore {
    constructor({
        logger = null,
        ttlMs = DEFAULT_TTL_MS,
        claimLeaseMs = DEFAULT_CLAIM_LEASE_MS,
        now = () => Date.now(),
        tokenGenerator = () => randomBytes(24).toString("base64url")
    } = {}) {
        this._logger = logger;
        this._ttlMs = Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0
            ? Number(ttlMs)
            : DEFAULT_TTL_MS;
        this._claimLeaseMs = Number.isFinite(Number(claimLeaseMs))
            && Number(claimLeaseMs) > 0
            ? Number(claimLeaseMs)
            : DEFAULT_CLAIM_LEASE_MS;
        this._now = now;
        this._tokenGenerator = tokenGenerator;
        this._records = new Map();
    }

    create({ roomId, ownerPlayerId, ownerTelegramUserId, targetNetwork = "mainnet" }) {
        const normalizedRoomId = String(roomId ?? "").trim();
        const normalizedPlayerId = String(ownerPlayerId ?? "").trim();
        const normalizedTelegramUserId = normalizeTelegramUserId(ownerTelegramUserId);
        const normalizedTarget = String(targetNetwork ?? "").trim().toLowerCase();

        if (!normalizedRoomId || !normalizedPlayerId || !normalizedTelegramUserId) {
            throw new Error("Invalid room handoff identity");
        }

        if (normalizedTarget !== "mainnet") {
            throw new Error("Unsupported room handoff target network");
        }

        this._purgeExpired();

        const handoffId = this._tokenGenerator();
        const createdAt = this._now();
        const expiresAt = createdAt + this._ttlMs;

        this._records.set(handoffId, {
            handoffId,
            roomId: normalizedRoomId,
            ownerPlayerId: normalizedPlayerId,
            ownerTelegramUserId: normalizedTelegramUserId,
            targetNetwork: normalizedTarget,
            createdAt,
            expiresAt,
            state: "pending",
            claimedByTelegramUserId: null,
            claimExpiresAt: null,
            mainnetRoomId: null
        });

        return {
            handoffId,
            roomId: normalizedRoomId,
            targetNetwork: normalizedTarget,
            expiresAt
        };
    }

    claim({ handoffId, telegramUserId }) {
        const record = this._getLiveRecord(handoffId);
        const normalizedTelegramUserId = normalizeTelegramUserId(telegramUserId);

        if (!record) {
            return { ok: false, reason: "NOT_FOUND_OR_EXPIRED" };
        }

        if (record.ownerTelegramUserId !== normalizedTelegramUserId) {
            return { ok: false, reason: "OWNER_MISMATCH" };
        }

        const now = this._now();

        if (record.state === "completed") {
            return {
                ok: true,
                state: "completed",
                roomId: record.roomId,
                mainnetRoomId: record.mainnetRoomId
            };
        }

        if (record.state === "claimed" && Number(record.claimExpiresAt) > now) {
            return {
                ok: true,
                state: "claimed",
                roomId: record.roomId,
                mainnetRoomId: record.mainnetRoomId
            };
        }

        record.state = "claimed";
        record.claimedByTelegramUserId = normalizedTelegramUserId;
        record.claimExpiresAt = now + this._claimLeaseMs;

        return {
            ok: true,
            state: "claimed",
            roomId: record.roomId,
            mainnetRoomId: record.mainnetRoomId
        };
    }

    complete({ handoffId, telegramUserId, mainnetRoomId }) {
        const record = this._getLiveRecord(handoffId);
        const normalizedTelegramUserId = normalizeTelegramUserId(telegramUserId);
        const normalizedMainnetRoomId = String(mainnetRoomId ?? "").trim();

        if (!record) {
            return { ok: false, reason: "NOT_FOUND_OR_EXPIRED" };
        }

        if (record.ownerTelegramUserId !== normalizedTelegramUserId) {
            return { ok: false, reason: "OWNER_MISMATCH" };
        }

        if (record.state === "completed") {
            return {
                ok: true,
                state: "completed",
                mainnetRoomId: record.mainnetRoomId
            };
        }

        if (record.state !== "claimed"
            || record.claimedByTelegramUserId !== normalizedTelegramUserId
            || Number(record.claimExpiresAt) <= this._now()) {
            return { ok: false, reason: "CLAIM_REQUIRED" };
        }

        if (!normalizedMainnetRoomId) {
            return { ok: false, reason: "INVALID_MAINNET_ROOM_ID" };
        }

        record.state = "completed";
        record.mainnetRoomId = normalizedMainnetRoomId;
        record.claimExpiresAt = null;

        return {
            ok: true,
            state: "completed",
            mainnetRoomId: normalizedMainnetRoomId
        };
    }

    release({ handoffId }) {
        const normalizedHandoffId = String(handoffId ?? "").trim();

        if (normalizedHandoffId) {
            this._records.delete(normalizedHandoffId);
        }
    }

    get(handoffId) {
        const record = this._getLiveRecord(handoffId);

        if (!record) {
            return null;
        }

        return { ...record };
    }

    size() {
        this._purgeExpired();

        return this._records.size;
    }

    _getLiveRecord(handoffId) {
        this._purgeExpired();

        const normalizedHandoffId = String(handoffId ?? "").trim();
        const record = this._records.get(normalizedHandoffId);

        return record ?? null;
    }

    _purgeExpired() {
        const now = this._now();

        for (const [handoffId, record] of this._records.entries()) {
            if (Number(record.expiresAt) <= now) {
                this._records.delete(handoffId);
            }
        }
    }
}

export const ROOM_NETWORK_HANDOFF_DEFAULTS = Object.freeze({
    ttlMs: DEFAULT_TTL_MS,
    claimLeaseMs: DEFAULT_CLAIM_LEASE_MS
});
