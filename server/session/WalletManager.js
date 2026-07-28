/**
 * T2.6 — Wallet ownership and session lifecycle manager.
 *
 * Owns wallet registration, verification, reconnect handling, and persistence.
 * No payments, contracts, signing, or private key storage.
 */

import { randomUUID } from "node:crypto";

import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { SessionWalletStore } from "./SessionWalletStore.js";
import {
    WalletAlreadyExistsError,
    WalletNetworkMismatchError,
    WalletNotFoundError,
    WalletSessionConflictError,
    WalletSessionExpiredError,
    WalletVerificationError
} from "./WalletManagerErrors.js";
import {
    WALLET_SESSION_STATUS,
    TERMINAL_WALLET_SESSION_STATUSES
} from "./WalletSessionStates.js";
import {
    WALLET_VERIFICATION_METHOD,
    WalletSession
} from "./WalletSession.js";
import {
    assertWalletNetworkCompatibility,
    normalizeNetwork,
    validateWalletAddress,
    WalletProofVerifier
} from "./walletAddressValidation.js";

const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const REPLACEABLE_STATUSES = new Set([
    WALLET_SESSION_STATUS.CREATED,
    WALLET_SESSION_STATUS.CONNECTED,
    WALLET_SESSION_STATUS.DISCONNECTED,
    WALLET_SESSION_STATUS.INVALID
]);

/**
 * @typedef {object} WalletManagerOptions
 * @property {object} logger
 * @property {import("../events/EventBus.js").EventBus} eventBus
 * @property {import("../services/TonService.js").TonService} [tonService]
 * @property {SessionWalletStore} [sessionWalletStore]
 * @property {import("../persistence/TonFinancialPersistence.js").TonFinancialPersistence} [financialPersistence]
 * @property {WalletProofVerifier} [proofVerifier]
 * @property {number} [sessionTtlMs]
 * @property {string} [defaultNetwork]
 */

export class WalletManager {

    constructor({
        logger,
        eventBus,
        tonService = null,
        sessionWalletStore = null,
        financialPersistence = null,
        proofVerifier = null,
        sessionTtlMs = DEFAULT_SESSION_TTL_MS,
        defaultNetwork = "testnet"
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._tonService = tonService;

        this._financialPersistence = financialPersistence;

        this._sessionWalletStore = sessionWalletStore
            ?? new SessionWalletStore({
                financialPersistence,
                logger
            });

        this._proofVerifier = proofVerifier ?? new WalletProofVerifier();

        this._sessionTtlMs = Number.isFinite(sessionTtlMs) && sessionTtlMs > 0
            ? sessionTtlMs
            : DEFAULT_SESSION_TTL_MS;

        this._defaultNetwork = normalizeNetwork(defaultNetwork) || "testnet";

        this._initialized = false;

        this._lastVerificationAt = null;

        this._operationLocks = new Map();

    }

    initialize() {

        if (this._initialized) {

            return;

        }

        this._initialized = true;

        this._log("WalletManager initialized");

    }

    async connectWallet({
        playerId,
        roomId,
        gameId = null,
        walletAddress,
        network = null,
        correlationId = null
    }) {

        return this._withLock(`${roomId}:${playerId}`, async () => {

            this._assertInitialized();

            const activeNetwork = this._resolveActiveNetwork(network);

            const addressInfo = validateWalletAddress(walletAddress, {
                network: activeNetwork
            });

            assertWalletNetworkCompatibility(addressInfo, activeNetwork);

            const existing = this._findActiveSession(playerId, roomId);

            if (existing) {

                this._assertSessionUsable(existing);

                if (
                    existing.walletAddress
                    && existing.walletAddress !== addressInfo.friendly
                ) {

                    this._assertWalletReplaceable(existing);

                }

                const previousAddress = existing.walletAddress;

                const patch = {
                    walletAddress: addressInfo.friendly,
                    lastConnectedAt: Date.now(),
                    network: activeNetwork,
                    gameId: gameId ?? existing.gameId,
                    correlationId: correlationId ?? existing.correlationId,
                    lastError: null
                };

                if (existing.status !== WALLET_SESSION_STATUS.CONNECTED) {

                    existing.transitionTo(WALLET_SESSION_STATUS.CONNECTED, patch);

                    this._sessionWalletStore.update(existing.walletSessionId, {
                        status: WALLET_SESSION_STATUS.CONNECTED,
                        ...patch
                    });

                } else {

                    this._sessionWalletStore.update(existing.walletSessionId, patch);

                }

                if (previousAddress && previousAddress !== addressInfo.friendly) {

                    this._emit(EVENT_TYPES.WALLET_CHANGED, existing);

                } else {

                    this._emit(EVENT_TYPES.WALLET_CONNECTED, existing);

                }

                return existing;

            }

            this._assertWalletAddressAvailable(addressInfo.friendly, roomId, playerId);

            const session = new WalletSession({
                walletSessionId: randomUUID(),
                playerId,
                roomId,
                gameId,
                walletAddress: addressInfo.friendly,
                network: activeNetwork,
                status: WALLET_SESSION_STATUS.CONNECTED,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                lastConnectedAt: Date.now(),
                expiresAt: Date.now() + this._sessionTtlMs,
                correlationId: correlationId ?? randomUUID()
            });

            this._sessionWalletStore.create(session);

            this._emit(EVENT_TYPES.WALLET_SESSION_CREATED, session);

            this._emit(EVENT_TYPES.WALLET_CONNECTED, session);

            return session;

        });

    }

    async registerWallet({
        playerId,
        roomId,
        gameId = null,
        walletAddress = null,
        network = null,
        correlationId = null
    }) {

        return this._withLock(`${roomId}:${playerId}`, async () => {

            this._assertInitialized();

            const activeNetwork = this._resolveActiveNetwork(network);

            const existing = this._findActiveSession(playerId, roomId);

            if (existing) {

                throw new WalletAlreadyExistsError(playerId, roomId);

            }

            let normalizedAddress = null;

            if (walletAddress) {

                const addressInfo = validateWalletAddress(walletAddress, {
                    network: activeNetwork
                });

                assertWalletNetworkCompatibility(addressInfo, activeNetwork);

                this._assertWalletAddressAvailable(normalizedAddress = addressInfo.friendly, roomId, playerId);

            }

            const session = new WalletSession({
                walletSessionId: randomUUID(),
                playerId,
                roomId,
                gameId,
                walletAddress: normalizedAddress,
                network: activeNetwork,
                status: WALLET_SESSION_STATUS.CREATED,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                expiresAt: Date.now() + this._sessionTtlMs,
                correlationId: correlationId ?? randomUUID()
            });

            this._sessionWalletStore.create(session);

            this._emit(EVENT_TYPES.WALLET_SESSION_CREATED, session);

            return session;

        });

    }

    async verifyWallet({
        walletSessionId,
        proof = null,
        verificationMethod = null
    }) {

        return this._withLock(walletSessionId, async () => {

            this._assertInitialized();

            const session = this._requireSession(walletSessionId);

            this._assertSessionUsable(session);

            if (session.status === WALLET_SESSION_STATUS.VERIFIED) {

                return session;

            }

            if (!session.walletAddress) {

                throw new WalletVerificationError(
                    "Wallet address required before verification",
                    { walletSessionId }
                );

            }

            session.transitionTo(WALLET_SESSION_STATUS.VERIFICATION_PENDING, {
                verificationMethod: verificationMethod
                    ?? (proof?.tonConnectProof
                        ? WALLET_VERIFICATION_METHOD.TONCONNECT_PROOF
                        : WALLET_VERIFICATION_METHOD.ADDRESS_ONLY)
            });

            this._sessionWalletStore.update(session.walletSessionId, {
                status: WALLET_SESSION_STATUS.VERIFICATION_PENDING,
                verificationMethod: session.verificationMethod
            });

            this._emit(EVENT_TYPES.WALLET_VERIFICATION_STARTED, session);

            try {

                const result = await this._proofVerifier.verify({
                    session,
                    proof,
                    tonService: this._tonService
                });

                if (!result?.verified) {

                    throw new WalletVerificationError(
                        "Wallet ownership verification failed",
                        { walletSessionId, result }
                    );

                }

                session.transitionTo(WALLET_SESSION_STATUS.VERIFIED, {
                    verificationMethod: result.method ?? session.verificationMethod,
                    walletLocked: true,
                    lastError: null
                });

                this._sessionWalletStore.update(session.walletSessionId, {
                    status: WALLET_SESSION_STATUS.VERIFIED,
                    verificationMethod: session.verificationMethod,
                    walletLocked: true,
                    lastError: null
                });

                this._lastVerificationAt = Date.now();

                this._emit(EVENT_TYPES.WALLET_VERIFIED, session);

                return session;

            } catch (error) {

                session.transitionTo(WALLET_SESSION_STATUS.INVALID, {
                    lastError: error?.message ?? "verification_failed"
                });

                this._sessionWalletStore.update(session.walletSessionId, {
                    status: WALLET_SESSION_STATUS.INVALID,
                    lastError: session.lastError
                });

                if (error instanceof WalletVerificationError) {

                    throw error;

                }

                throw new WalletVerificationError(
                    error?.message ?? "Wallet verification failed",
                    { walletSessionId, cause: error?.name }
                );

            }

        });

    }

    async disconnectWallet(walletSessionId) {

        return this._withLock(walletSessionId, async () => {

            this._assertInitialized();

            const session = this._requireSession(walletSessionId);

            this._assertSessionUsable(session);

            if (session.status === WALLET_SESSION_STATUS.DISCONNECTED) {

                return session;

            }

            session.transitionTo(WALLET_SESSION_STATUS.DISCONNECTED);

            this._sessionWalletStore.update(session.walletSessionId, {
                status: WALLET_SESSION_STATUS.DISCONNECTED
            });

            this._emit(EVENT_TYPES.WALLET_DISCONNECTED, session);

            return session;

        });

    }

    async expireWallet(walletSessionId) {

        return this._withLock(walletSessionId, async () => {

            this._assertInitialized();

            const session = this._requireSession(walletSessionId);

            if (session.status === WALLET_SESSION_STATUS.EXPIRED) {

                return session;

            }

            session.transitionTo(WALLET_SESSION_STATUS.EXPIRED);

            this._sessionWalletStore.update(session.walletSessionId, {
                status: WALLET_SESSION_STATUS.EXPIRED
            });

            this._emit(EVENT_TYPES.WALLET_EXPIRED, session);

            return session;

        });

    }

    async revokeWallet(walletSessionId, { reason = null } = {}) {

        return this._withLock(walletSessionId, async () => {

            this._assertInitialized();

            const session = this._requireSession(walletSessionId);

            if (session.status === WALLET_SESSION_STATUS.REVOKED) {

                return session;

            }

            const revoked = this._sessionWalletStore.archive(session.walletSessionId, {
                reason,
                status: WALLET_SESSION_STATUS.REVOKED,
                walletLocked: false
            });

            this._emit(EVENT_TYPES.WALLET_REVOKED, revoked);

            return revoked;

        });

    }

    getWallet(walletSessionId) {

        this._assertInitialized();

        try {

            return this._sessionWalletStore.load(walletSessionId);

        } catch {

            return null;

        }

    }

    getWalletByPlayer(playerId, roomId = null) {

        this._assertInitialized();

        const sessions = this._sessionWalletStore.findByPlayer(playerId, {
            roomId,
            activeOnly: true
        });

        return sessions[0] ?? null;

    }

    getWalletByRoom(roomId) {

        this._assertInitialized();

        return this._sessionWalletStore.findByRoom(roomId, { activeOnly: true });

    }

    restoreSessions() {

        this._assertInitialized();

        const summary = this._sessionWalletStore.restore();

        let cleanedExpired = 0;

        for (const session of this._sessionWalletStore.listAllSessions()) {

            if (session.isExpired() && session.isActive()) {

                session.status = WALLET_SESSION_STATUS.EXPIRED;

                this._sessionWalletStore.update(session.walletSessionId, {
                    status: WALLET_SESSION_STATUS.EXPIRED
                });

                cleanedExpired += 1;

            }

        }

        this._log(
            `RESTORE | restored=${summary.restored} | expired=${summary.expired} | `
                + `invalid=${summary.invalid} | cleaned=${cleanedExpired}`
        );

        return Object.freeze({
            ...summary,
            cleanedExpired
        });

    }

    health() {

        this._assertInitialized();

        let activeSessions = 0;

        let verifiedWallets = 0;

        let expiredSessions = 0;

        let invalidSessions = 0;

        for (const session of this._sessionWalletStore.listAllSessions()) {

            if (session.isActive()) {

                activeSessions += 1;

            }

            if (session.isVerified()) {

                verifiedWallets += 1;

            }

            if (session.status === WALLET_SESSION_STATUS.EXPIRED) {

                expiredSessions += 1;

            }

            if (session.status === WALLET_SESSION_STATUS.INVALID) {

                invalidSessions += 1;

            }

        }

        return Object.freeze({
            activeSessions,
            verifiedWallets,
            expiredSessions,
            invalidSessions,
            lastVerification: this._lastVerificationAt,
            network: this._resolveActiveNetwork()
        });

    }

    getDashboardSnapshot(roomId = null) {

        this._assertInitialized();

        const sessions = roomId
            ? this._sessionWalletStore.findByRoom(roomId, { activeOnly: false })
            : this._sessionWalletStore.listAllSessions();

        return Object.freeze({
            roomId,
            network: this._resolveActiveNetwork(),
            sessions: Object.freeze(
                sessions.map((session) => session.toDashboardSnapshot())
            ),
            health: this.health()
        });

    }

    lockWalletReplacement(walletSessionId, locked = true) {

        const session = this._requireSession(walletSessionId);

        session.walletLocked = locked === true;

        this._sessionWalletStore.update(session.walletSessionId, {
            walletLocked: session.walletLocked
        });

        return session;

    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    _findActiveSession(playerId, roomId) {

        const sessions = this._sessionWalletStore.findByPlayer(playerId, {
            roomId,
            activeOnly: true
        });

        return sessions[0] ?? null;

    }

    _requireSession(walletSessionId) {

        try {

            return this._sessionWalletStore.load(walletSessionId);

        } catch {

            throw new WalletNotFoundError(walletSessionId);

        }

    }

    _assertSessionUsable(session) {

        if (session.isExpired()) {

            throw new WalletSessionExpiredError(session.walletSessionId);

        }

        if (TERMINAL_WALLET_SESSION_STATUSES.includes(session.status)) {

            throw new WalletSessionConflictError(
                `Wallet session is terminal | status=${session.status}`,
                { walletSessionId: session.walletSessionId, status: session.status }
            );

        }

    }

    _assertWalletReplaceable(session) {

        if (session.walletLocked || session.isVerified()) {

            throw new WalletSessionConflictError(
                "Verified or locked wallet cannot be replaced",
                { walletSessionId: session.walletSessionId }
            );

        }

        if (!REPLACEABLE_STATUSES.has(session.status)) {

            throw new WalletSessionConflictError(
                `Wallet cannot be replaced in status ${session.status}`,
                { walletSessionId: session.walletSessionId, status: session.status }
            );

        }

    }

    _assertWalletAddressAvailable(walletAddress, roomId, playerId) {

        const matches = this._sessionWalletStore.findByWallet(walletAddress, {
            activeOnly: true
        });

        for (const session of matches) {

            if (
                session.roomId === roomId
                && String(session.playerId) === String(playerId)
            ) {

                continue;

            }

            throw new WalletSessionConflictError(
                "Wallet address already bound to another active session",
                {
                    walletAddress,
                    conflictingSessionId: session.walletSessionId
                }
            );

        }

    }

    _resolveActiveNetwork(override = null) {

        const serviceNetwork = this._tonService?.getActiveNetwork?.()
            ? normalizeNetwork(this._tonService.getActiveNetwork())
            : this._defaultNetwork;

        if (override) {

            const requested = normalizeNetwork(override);

            if (requested !== serviceNetwork) {

                throw new WalletNetworkMismatchError(requested, serviceNetwork);

            }

            return requested;

        }

        return serviceNetwork;

    }

    async _withLock(key, operation) {

        while (this._operationLocks.has(key)) {

            await this._operationLocks.get(key);

        }

        let release = null;

        const gate = new Promise((resolve) => {

            release = resolve;

        });

        this._operationLocks.set(key, gate);

        try {

            return await operation();

        } finally {

            this._operationLocks.delete(key);

            release();

        }

    }

    _emit(type, session) {

        this._eventBus.emit({
            source: EVENT_SOURCES.WALLET_MANAGER,
            type,
            payload: Object.freeze({
                walletSessionId: session.walletSessionId,
                playerId: session.playerId,
                roomId: session.roomId,
                walletAddress: session.walletAddress,
                network: session.network,
                status: session.status,
                timestamp: Date.now(),
                correlationId: session.correlationId
            })
        });

    }

    _assertInitialized() {

        if (!this._initialized) {

            throw new Error("WalletManager is not initialized");

        }

    }

    _log(message) {

        this._logger?.info?.(message);

    }

}
