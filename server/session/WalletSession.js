/**
 * T2.6 — Wallet session domain model.
 */

import {
    canTransitionWalletStatus,
    WALLET_SESSION_STATUS
} from "./WalletSessionStates.js";
import { InvalidWalletStateTransitionError } from "./WalletManagerErrors.js";

export const WALLET_VERIFICATION_METHOD = Object.freeze({
    ADDRESS_ONLY: "ADDRESS_ONLY",
    TONCONNECT_PROOF: "TONCONNECT_PROOF",
    MANUAL: "MANUAL"
});

export class WalletSession {

    constructor({
        walletSessionId,
        playerId,
        roomId,
        gameId = null,
        walletAddress = null,
        network,
        status = WALLET_SESSION_STATUS.CREATED,
        verificationMethod = null,
        createdAt = Date.now(),
        updatedAt = Date.now(),
        lastConnectedAt = null,
        expiresAt = null,
        correlationId = null,
        version = 1,
        walletLocked = false,
        lastError = null
    }) {

        this.walletSessionId = walletSessionId;

        this.playerId = playerId;

        this.roomId = roomId;

        this.gameId = gameId ?? null;

        this.walletAddress = walletAddress ?? null;

        this.network = network;

        this.status = status;

        this.verificationMethod = verificationMethod ?? null;

        this.createdAt = createdAt;

        this.updatedAt = updatedAt;

        this.lastConnectedAt = lastConnectedAt ?? null;

        this.expiresAt = expiresAt ?? null;

        this.correlationId = correlationId ?? null;

        this.version = version;

        this.walletLocked = walletLocked === true;

        this.lastError = lastError ?? null;

    }

    static fromRecord(record) {

        const payload = record?.payload ?? record ?? {};

        return new WalletSession({
            walletSessionId: payload.walletSessionId ?? record?.recordId,
            playerId: payload.playerId,
            roomId: payload.roomId,
            gameId: payload.gameId ?? null,
            walletAddress: payload.walletAddress ?? null,
            network: payload.network ?? record?.tonNetwork ?? null,
            status: payload.status ?? WALLET_SESSION_STATUS.CREATED,
            verificationMethod: payload.verificationMethod ?? null,
            createdAt: payload.createdAt ?? record?.createdAt ?? Date.now(),
            updatedAt: payload.updatedAt ?? record?.updatedAt ?? Date.now(),
            lastConnectedAt: payload.lastConnectedAt ?? null,
            expiresAt: payload.expiresAt ?? null,
            correlationId: payload.correlationId ?? record?.correlationId ?? null,
            version: payload.version ?? record?.version ?? 1,
            walletLocked: payload.walletLocked === true,
            lastError: payload.lastError ?? null
        });

    }

    toPayload() {

        return Object.freeze({
            walletSessionId: this.walletSessionId,
            playerId: this.playerId,
            roomId: this.roomId,
            gameId: this.gameId,
            walletAddress: this.walletAddress,
            network: this.network,
            status: this.status,
            verificationMethod: this.verificationMethod,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
            lastConnectedAt: this.lastConnectedAt,
            expiresAt: this.expiresAt,
            correlationId: this.correlationId,
            version: this.version,
            walletLocked: this.walletLocked,
            lastError: this.lastError
        });

    }

    toDashboardSnapshot() {

        const now = Date.now();

        return Object.freeze({
            walletSessionId: this.walletSessionId,
            playerId: this.playerId,
            roomId: this.roomId,
            gameId: this.gameId,
            walletAddress: this.walletAddress,
            network: this.network,
            status: this.status,
            verificationMethod: this.verificationMethod,
            sessionAgeMs: Math.max(0, now - this.createdAt),
            lastActivityAt: this.lastConnectedAt ?? this.updatedAt,
            expiresAt: this.expiresAt,
            walletLocked: this.walletLocked,
            lastError: this.lastError,
            correlationId: this.correlationId,
            version: this.version
        });

    }

    transitionTo(nextStatus, patch = {}) {

        if (!canTransitionWalletStatus(this.status, nextStatus)) {

            throw new InvalidWalletStateTransitionError(
                this.walletSessionId,
                this.status,
                nextStatus
            );

        }

        this.status = nextStatus;

        this.updatedAt = patch.updatedAt ?? Date.now();

        if (patch.walletAddress !== undefined) {

            this.walletAddress = patch.walletAddress;

        }

        if (patch.verificationMethod !== undefined) {

            this.verificationMethod = patch.verificationMethod;

        }

        if (patch.lastConnectedAt !== undefined) {

            this.lastConnectedAt = patch.lastConnectedAt;

        }

        if (patch.expiresAt !== undefined) {

            this.expiresAt = patch.expiresAt;

        }

        if (patch.gameId !== undefined) {

            this.gameId = patch.gameId;

        }

        if (patch.walletLocked !== undefined) {

            this.walletLocked = patch.walletLocked === true;

        }

        if (patch.lastError !== undefined) {

            this.lastError = patch.lastError;

        }

        if (patch.correlationId !== undefined) {

            this.correlationId = patch.correlationId;

        }

        this.version += 1;

        return this;

    }

    isActive() {

        return ![
            WALLET_SESSION_STATUS.EXPIRED,
            WALLET_SESSION_STATUS.REVOKED,
            WALLET_SESSION_STATUS.INVALID
        ].includes(this.status);

    }

    isVerified() {

        return this.status === WALLET_SESSION_STATUS.VERIFIED;

    }

    isExpired(now = Date.now()) {

        return this.expiresAt != null && now >= this.expiresAt;

    }

}
