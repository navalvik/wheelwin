/**
 * T2.6 — Persistent wallet session storage.
 *
 * P6.1 legacy room→player address map is preserved for RoomLobbyBridge.
 * T2.6 wallet sessions are persisted via TonFinancialPersistence.
 */

import { randomUUID } from "node:crypto";

import { TON_FINANCIAL_RECORD_TYPES } from "../persistence/TonFinancialPersistence.js";
import { WalletAlreadyExistsError, WalletNotFoundError } from "./WalletManagerErrors.js";
import { WalletSession } from "./WalletSession.js";
import { WALLET_SESSION_STATUS } from "./WalletSessionStates.js";

export class SessionWalletStore {

    constructor({ financialPersistence = null, logger = null } = {}) {

        this._financialPersistence = financialPersistence;

        this._logger = logger;

        /** @type {Map<string, WalletSession>} */
        this._sessionsById = new Map();

        /** @type {Map<string, string>} */
        this._activeByPlayerRoom = new Map();

        /** @type {Map<string, Set<string>>} */
        this._sessionIdsByRoom = new Map();

        /** @type {Map<string, Set<string>>} */
        this._sessionIdsByWallet = new Map();

        // P6.1 legacy: roomId → Map(playerId → walletAddress)
        this._walletsByRoom = new Map();

        // R13.1H — financial wallet locks after PAYMENT_CONFIRMED (roomId::playerId).
        this._financialLockedKeys = new Set();

    }

    create(sessionInput) {

        const session = sessionInput instanceof WalletSession
            ? sessionInput
            : new WalletSession({
                walletSessionId: sessionInput.walletSessionId ?? randomUUID(),
                ...sessionInput
            });

        if (this._sessionsById.has(session.walletSessionId)) {

            throw new WalletAlreadyExistsError(session.playerId, session.roomId);

        }

        this._indexSession(session);

        this._persistSession(session, "create");

        return session;

    }

    load(walletSessionId) {

        const session = this._sessionsById.get(walletSessionId) ?? null;

        if (!session) {

            throw new WalletNotFoundError(walletSessionId);

        }

        return session;

    }

    update(walletSessionId, patch = {}) {

        const session = this.load(walletSessionId);

        const previousAddress = session.walletAddress;

        if (
            patch.walletAddress
            && patch.walletAddress !== previousAddress
            && this.isFinancialWalletLocked(session.roomId, session.playerId)
        ) {

            this._logError(
                `WALLET_FINANCIALLY_LOCKED | refuse update | `
                    + `roomId=${session.roomId} | playerId=${session.playerId}`
            );

            return session;

        }

        if (patch.status && patch.status !== session.status) {

            session.transitionTo(patch.status, patch);

        } else if (Object.keys(patch).length > 0) {

            Object.assign(session, {
                ...patch,
                updatedAt: patch.updatedAt ?? Date.now(),
                version: session.version + 1
            });

        }

        if (patch.walletAddress && patch.walletAddress !== previousAddress) {

            this._reindexWallet(session, previousAddress);

        }

        this._indexSession(session);

        this._persistSession(session, "update");

        return session;

    }

    archive(walletSessionId, metadata = {}) {

        const session = this.load(walletSessionId);

        const archivedAt = metadata.archivedAt ?? Date.now();

        const targetStatus = metadata.status ?? WALLET_SESSION_STATUS.REVOKED;

        if (session.status !== targetStatus) {

            session.transitionTo(
                targetStatus,
                {
                    updatedAt: archivedAt,
                    lastError: metadata.reason ?? session.lastError,
                    walletLocked: metadata.walletLocked
                }
            );

        }

        this._removeActiveIndex(session);

        this._persistSession(session, "update", {
            status: "ARCHIVED",
            archivedAt
        });

        return session;

    }

    findByPlayer(playerId, { roomId = null, activeOnly = true } = {}) {

        if (roomId) {

            const key = this._playerRoomKey(roomId, playerId);

            const sessionId = this._activeByPlayerRoom.get(key) ?? null;

            if (!sessionId) {

                return Object.freeze([]);

            }

            const session = this._sessionsById.get(sessionId) ?? null;

            if (!session) {

                return Object.freeze([]);

            }

            if (activeOnly && !session.isActive()) {

                return Object.freeze([]);

            }

            return Object.freeze([session]);

        }

        const matches = [];

        for (const session of this._sessionsById.values()) {

            if (String(session.playerId) !== String(playerId)) {

                continue;

            }

            if (activeOnly && !session.isActive()) {

                continue;

            }

            matches.push(session);

        }

        return Object.freeze(matches);

    }

    findByRoom(roomId, { activeOnly = true } = {}) {

        const sessionIds = this._sessionIdsByRoom.get(roomId) ?? new Set();

        const matches = [];

        for (const sessionId of sessionIds) {

            const session = this._sessionsById.get(sessionId);

            if (!session) {

                continue;

            }

            if (activeOnly && !session.isActive()) {

                continue;

            }

            matches.push(session);

        }

        return Object.freeze(matches);

    }

    findByWallet(walletAddress, { activeOnly = true } = {}) {

        const normalized = String(walletAddress ?? "").trim();

        const sessionIds = this._sessionIdsByWallet.get(normalized) ?? new Set();

        const matches = [];

        for (const sessionId of sessionIds) {

            const session = this._sessionsById.get(sessionId);

            if (!session) {

                continue;

            }

            if (activeOnly && !session.isActive()) {

                continue;

            }

            matches.push(session);

        }

        return Object.freeze(matches);

    }

    listAllSessions({ activeOnly = false } = {}) {

        const matches = [];

        for (const session of this._sessionsById.values()) {

            if (activeOnly && !session.isActive()) {

                continue;

            }

            matches.push(session);

        }

        return Object.freeze(matches);

    }

    restore() {

        if (!this._financialPersistence) {

            return Object.freeze({
                restored: 0,
                expired: 0,
                invalid: 0
            });

        }

        const records = this._financialPersistence.listActive(
            TON_FINANCIAL_RECORD_TYPES.WALLET_SESSION
        );

        let restored = 0;

        let expired = 0;

        let invalid = 0;

        for (const record of records) {

            try {

                const session = WalletSession.fromRecord(record);

                if (this._sessionsById.has(session.walletSessionId)) {

                    continue;

                }

                if (session.isExpired()) {

                    session.status = WALLET_SESSION_STATUS.EXPIRED;

                    expired += 1;

                }

                if (session.status === WALLET_SESSION_STATUS.INVALID) {

                    invalid += 1;

                }

                this._indexSession(session);

                restored += 1;

            } catch (error) {

                this._logError(
                    `SessionWalletStore restore skipped | id=${record?.recordId} | `
                        + `${error?.message ?? error}`
                );

            }

        }

        return Object.freeze({
            restored,
            expired,
            invalid
        });

    }

    // -------------------------------------------------------------------------
    // P6.1 legacy API (RoomLobbyBridge compatibility)
    // -------------------------------------------------------------------------

    /**
     * R13.1H — Lock the player's financial wallet after payment confirmation.
     * Subsequent setWallet / address updates are rejected.
     */
    lockFinancialWallet(roomId, playerId) {

        if (!roomId || !playerId) {

            return false;

        }

        this._financialLockedKeys.add(this._financialLockKey(roomId, playerId));

        const existing = this.findByPlayer(playerId, { roomId, activeOnly: true });

        for (const session of existing) {

            if (!session.walletLocked) {

                try {

                    this.update(session.walletSessionId, {
                        walletLocked: true
                    });

                } catch {

                    session.walletLocked = true;

                }

            }

        }

        return true;

    }

    isFinancialWalletLocked(roomId, playerId) {

        if (!roomId || !playerId) {

            return false;

        }

        return this._financialLockedKeys.has(
            this._financialLockKey(roomId, playerId)
        );

    }

    setWallet(roomId, playerId, wallet) {

        if (!roomId || !playerId || typeof wallet !== "string") {

            return false;

        }

        if (this.isFinancialWalletLocked(roomId, playerId)) {

            const current = this.getWallet(roomId, playerId);

            if (current && current === wallet) {

                return true;

            }

            this._logError(
                `WALLET_FINANCIALLY_LOCKED | refuse setWallet | `
                    + `roomId=${roomId} | playerId=${playerId}`
            );

            return false;

        }

        let roomWallets = this._walletsByRoom.get(roomId);

        if (!roomWallets) {

            roomWallets = new Map();

            this._walletsByRoom.set(roomId, roomWallets);

        }

        roomWallets.set(playerId, wallet);

        const existing = this.findByPlayer(playerId, { roomId, activeOnly: true });

        if (existing.length > 0) {

            this.update(existing[0].walletSessionId, {
                walletAddress: wallet
            });

        }

        return true;

    }

    getWallet(roomId, playerId) {

        if (!roomId || !playerId) {

            return null;

        }

        const active = this.findByPlayer(playerId, { roomId, activeOnly: true });

        if (active.length > 0 && active[0].walletAddress) {

            return active[0].walletAddress;

        }

        return this._walletsByRoom.get(roomId)?.get(playerId) ?? null;

    }

    getRoomWallets(roomId) {

        const result = {};

        const activeSessions = this.findByRoom(roomId, { activeOnly: true });

        for (const session of activeSessions) {

            if (session.walletAddress) {

                result[session.playerId] = session.walletAddress;

            }

        }

        const roomWallets = this._walletsByRoom.get(roomId);

        if (roomWallets) {

            for (const [playerId, wallet] of roomWallets.entries()) {

                if (!result[playerId]) {

                    result[playerId] = wallet;

                }

            }

        }

        return result;

    }

    clearRoom(roomId) {

        if (!roomId) {

            return;

        }

        this._walletsByRoom.delete(roomId);

        for (const key of [...this._financialLockedKeys]) {

            if (key.startsWith(`${roomId}::`)) {

                this._financialLockedKeys.delete(key);

            }

        }

        const sessions = this.findByRoom(roomId, { activeOnly: false });

        for (const session of sessions) {

            this._sessionsById.delete(session.walletSessionId);

            this._removeActiveIndex(session);

        }

        this._sessionIdsByRoom.delete(roomId);

    }

    clearAll() {

        this._walletsByRoom.clear();

        this._sessionsById.clear();

        this._activeByPlayerRoom.clear();

        this._sessionIdsByRoom.clear();

        this._sessionIdsByWallet.clear();

        this._financialLockedKeys.clear();

    }

    _financialLockKey(roomId, playerId) {

        return `${roomId}::${playerId}`;

    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    _playerRoomKey(roomId, playerId) {

        return `${roomId}::${playerId}`;

    }

    _indexSession(session) {

        this._sessionsById.set(session.walletSessionId, session);

        if (session.isActive()) {

            this._activeByPlayerRoom.set(
                this._playerRoomKey(session.roomId, session.playerId),
                session.walletSessionId
            );

        }

        let roomSet = this._sessionIdsByRoom.get(session.roomId);

        if (!roomSet) {

            roomSet = new Set();

            this._sessionIdsByRoom.set(session.roomId, roomSet);

        }

        roomSet.add(session.walletSessionId);

        if (session.walletAddress) {

            let walletSet = this._sessionIdsByWallet.get(session.walletAddress);

            if (!walletSet) {

                walletSet = new Set();

                this._sessionIdsByWallet.set(session.walletAddress, walletSet);

            }

            walletSet.add(session.walletSessionId);

        }

        if (session.walletAddress && session.roomId && session.playerId) {

            let roomWallets = this._walletsByRoom.get(session.roomId);

            if (!roomWallets) {

                roomWallets = new Map();

                this._walletsByRoom.set(session.roomId, roomWallets);

            }

            roomWallets.set(session.playerId, session.walletAddress);

        }

    }

    _removeActiveIndex(session) {

        const key = this._playerRoomKey(session.roomId, session.playerId);

        if (this._activeByPlayerRoom.get(key) === session.walletSessionId) {

            this._activeByPlayerRoom.delete(key);

        }

    }

    _reindexWallet(session, previousAddress) {

        if (previousAddress) {

            const previousSet = this._sessionIdsByWallet.get(previousAddress);

            previousSet?.delete(session.walletSessionId);

        }

        if (session.walletAddress) {

            let walletSet = this._sessionIdsByWallet.get(session.walletAddress);

            if (!walletSet) {

                walletSet = new Set();

                this._sessionIdsByWallet.set(session.walletAddress, walletSet);

            }

            walletSet.add(session.walletSessionId);

        }

    }

    _persistSession(session, operation, metadata = {}) {

        if (!this._financialPersistence) {

            return;

        }

        const payload = session.toPayload();

        const recordMetadata = {
            walletSessionId: session.walletSessionId,
            roomId: session.roomId,
            gameId: session.gameId,
            tonNetwork: session.network,
            correlationId: session.correlationId,
            status: metadata.status ?? session.status,
            ...metadata
        };

        try {

            if (operation === "create") {

                this._financialPersistence.createWalletSession(payload, recordMetadata);

            } else {

                this._financialPersistence.updateWalletSession(
                    session.walletSessionId,
                    payload,
                    recordMetadata
                );

            }

        } catch (error) {

            if (operation === "update" && error?.name === "RecordNotFoundError") {

                this._financialPersistence.createWalletSession(payload, recordMetadata);

                return;

            }

            throw error;

        }

    }

    _logError(message) {

        this._logger?.error?.(message);

    }

}
