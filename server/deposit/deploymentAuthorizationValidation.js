/**
 * R17.9L.5A — DeploymentAuthorization creation rules (no client/socket/Page4 path).
 */

import { DEPOSIT_SESSION_STATUS } from "./DepositSessionStates.js";
import { DEPLOYMENT_AUTHORIZATION_STATUS } from "./DeploymentAuthorizationStates.js";
import {
    InvalidDeploymentAuthorizationError,
    MissingDeploymentAuthorizationError
} from "./DeploymentAuthorizationErrors.js";
import { computeDeploymentAuthorizationHash } from "./deploymentAuthorizationHash.js";
import { normalizeDepositIdPart } from "./depositValidation.js";
import { timingSafeEqual } from "node:crypto";

function assertNonEmpty(value, field, details = {}) {

    const normalized = typeof value === "string" ? value.trim() : "";

    if (!normalized) {

        throw new InvalidDeploymentAuthorizationError(`${field} is required`, details);

    }

    return normalized;

}

export function captureDepositStateSnapshot(session) {

    if (!session || typeof session !== "object") {

        throw new InvalidDeploymentAuthorizationError(
            "depositStateSnapshot data is required",
            { session: null }
        );

    }

    const bindings = Array.isArray(session.bindings) ? session.bindings : [];

    if (bindings.length === 0) {

        throw new InvalidDeploymentAuthorizationError(
            "depositStateSnapshot data is required",
            { depositId: session.depositId ?? null }
        );

    }

    return Object.freeze({
        depositId: session.depositId,
        roomId: session.roomId,
        gameId: session.gameId,
        state: session.state,
        bindings: Object.freeze(bindings.map((binding) => Object.freeze({ ...binding }))),
        fundingEventIds: Object.freeze([...(session.fundingEventIds ?? [])]),
        expiresAt: session.expiresAt ?? null,
        depositFullAt: session.depositFullAt ?? null,
        updatedAt: session.updatedAt
    });

}

export function resolveAuthorizationNetwork(session, overrides = {}) {

    const fromOverride = normalizeDepositIdPart(overrides.network ?? overrides.tonNetwork);

    if (fromOverride) {

        return fromOverride;

    }

    const metadata = session?.metadata && typeof session.metadata === "object"
        ? session.metadata
        : {};

    const fromMetadata = normalizeDepositIdPart(
        metadata.network ?? metadata.tonNetwork
    );

    return fromMetadata || "testnet";

}

export function assertCanCreateDeploymentAuthorization(session, options = {}) {

    if (!session || typeof session !== "object") {

        throw new InvalidDeploymentAuthorizationError(
            "DepositSession is required",
            { session: null }
        );

    }

    const depositId = assertNonEmpty(session.depositId, "depositId", {
        depositId: session.depositId ?? null
    });

    const roomId = assertNonEmpty(session.roomId, "roomId", { depositId });

    const gameId = assertNonEmpty(session.gameId, "gameId", { depositId, roomId });

    if (typeof options.roomExists === "function" && !options.roomExists(roomId)) {

        throw new InvalidDeploymentAuthorizationError("roomId does not exist", {
            depositId,
            roomId
        });

    }

    if (typeof options.gameExists === "function" && !options.gameExists(gameId)) {

        throw new InvalidDeploymentAuthorizationError("gameId does not exist", {
            depositId,
            gameId
        });

    }

    if (session.state !== DEPOSIT_SESSION_STATUS.DEPOSIT_FULL) {

        throw new InvalidDeploymentAuthorizationError(
            "DeploymentAuthorization requires DepositSession.state === DEPOSIT_FULL",
            {
                depositId,
                roomId,
                gameId,
                state: session.state
            }
        );

    }

    const bindingHash = assertNonEmpty(session.bindingHash, "bindingHash", {
        depositId,
        roomId,
        gameId
    });

    const depositStateSnapshot = captureDepositStateSnapshot(session);

    const network = resolveAuthorizationNetwork(session, options);

    return {
        depositId,
        roomId,
        gameId,
        bindingHash,
        depositStateSnapshot,
        network
    };

}

const ENTRY_DEPLOYMENT_AUTHORIZATION_STATES = Object.freeze([
    DEPOSIT_SESSION_STATUS.AWAITING_FUNDS,
    DEPOSIT_SESSION_STATUS.PARTIALLY_FUNDED,
    DEPOSIT_SESSION_STATUS.DEPOSIT_FULL
]);

/**
 * R18-S16 — GameEscrow may be authorized once the Deposit package exists
 * (wallets bound, StateInit published). Does not require DEPOSIT_FULL.
 */
export function assertCanCreateEntryDeploymentAuthorization(session, options = {}) {

    if (!session || typeof session !== "object") {

        throw new InvalidDeploymentAuthorizationError(
            "DepositSession is required",
            { session: null }
        );

    }

    const depositId = assertNonEmpty(session.depositId, "depositId", {
        depositId: session.depositId ?? null
    });

    const roomId = assertNonEmpty(session.roomId, "roomId", { depositId });

    const gameId = assertNonEmpty(session.gameId, "gameId", { depositId, roomId });

    if (typeof options.roomExists === "function" && !options.roomExists(roomId)) {

        throw new InvalidDeploymentAuthorizationError("roomId does not exist", {
            depositId,
            roomId
        });

    }

    if (typeof options.gameExists === "function" && !options.gameExists(gameId)) {

        throw new InvalidDeploymentAuthorizationError("gameId does not exist", {
            depositId,
            gameId
        });

    }

    if (!ENTRY_DEPLOYMENT_AUTHORIZATION_STATES.includes(session.state)) {

        throw new InvalidDeploymentAuthorizationError(
            "Entry DeploymentAuthorization requires a fundable DepositSession",
            {
                depositId,
                roomId,
                gameId,
                state: session.state
            }
        );

    }

    assertNonEmpty(session.depositAddress, "depositAddress", {
        depositId,
        roomId,
        gameId
    });

    const bindingHash = assertNonEmpty(session.bindingHash, "bindingHash", {
        depositId,
        roomId,
        gameId
    });

    const depositStateSnapshot = captureDepositStateSnapshot(session);

    const network = resolveAuthorizationNetwork(session, options);

    return {
        depositId,
        roomId,
        gameId,
        bindingHash,
        depositStateSnapshot,
        network
    };

}

export function hashesEqual(left, right) {

    const a = Buffer.from(String(left ?? ""), "utf8");

    const b = Buffer.from(String(right ?? ""), "utf8");

    if (a.length === 0 || a.length !== b.length) {

        return false;

    }

    return timingSafeEqual(a, b);

}

/**
 * Fail-closed checks before GameContractManager may start deploy.
 */
export function assertAuthorizationReadyForDeploy(authorization, {
    roomId,
    gameId,
    network = null
} = {}) {

    if (!authorization) {

        throw new MissingDeploymentAuthorizationError(
            roomId,
            gameId,
            "missing"
        );

    }

    const expectedRoom = normalizeDepositIdPart(roomId);
    const expectedGame = normalizeDepositIdPart(gameId);

    if (authorization.roomId !== expectedRoom) {

        throw new InvalidDeploymentAuthorizationError(
            "DeploymentAuthorization roomId does not match deploy request",
            {
                authorizationId: authorization.authorizationId,
                expectedRoomId: expectedRoom,
                actualRoomId: authorization.roomId
            }
        );

    }

    if (authorization.gameId !== expectedGame) {

        throw new InvalidDeploymentAuthorizationError(
            "DeploymentAuthorization gameId does not match deploy request",
            {
                authorizationId: authorization.authorizationId,
                expectedGameId: expectedGame,
                actualGameId: authorization.gameId
            }
        );

    }

    if (authorization.status === DEPLOYMENT_AUTHORIZATION_STATUS.REVOKED) {

        throw new MissingDeploymentAuthorizationError(
            expectedRoom,
            expectedGame,
            "revoked",
            { authorizationId: authorization.authorizationId }
        );

    }

    if (authorization.status === DEPLOYMENT_AUTHORIZATION_STATUS.CONSUMED) {

        throw new MissingDeploymentAuthorizationError(
            expectedRoom,
            expectedGame,
            "consumed",
            { authorizationId: authorization.authorizationId }
        );

    }

    if (authorization.status !== DEPLOYMENT_AUTHORIZATION_STATUS.VALID) {

        throw new MissingDeploymentAuthorizationError(
            expectedRoom,
            expectedGame,
            authorization.status ?? "invalid",
            { authorizationId: authorization.authorizationId }
        );

    }

    const expectedHash = computeDeploymentAuthorizationHash({
        roomId: authorization.roomId,
        gameId: authorization.gameId,
        depositId: authorization.depositId,
        bindingHash: authorization.bindingHash,
        createdAt: authorization.createdAt,
        network: authorization.network
    });

    if (!hashesEqual(expectedHash, authorization.authorizationHash)) {

        throw new InvalidDeploymentAuthorizationError(
            "DeploymentAuthorization hash is invalid",
            {
                authorizationId: authorization.authorizationId,
                roomId: expectedRoom,
                gameId: expectedGame
            }
        );

    }

    const requestedNetwork = normalizeDepositIdPart(network);

    if (requestedNetwork && authorization.network !== requestedNetwork) {

        throw new InvalidDeploymentAuthorizationError(
            "DeploymentAuthorization network does not match deploy request",
            {
                authorizationId: authorization.authorizationId,
                expectedNetwork: requestedNetwork,
                actualNetwork: authorization.network
            }
        );

    }

    const expiresAt = Number(
        authorization.metadata?.expiresAt
        ?? authorization.expiresAt
        ?? NaN
    );

    if (Number.isFinite(expiresAt) && Date.now() > expiresAt) {

        throw new MissingDeploymentAuthorizationError(
            expectedRoom,
            expectedGame,
            "expired",
            { authorizationId: authorization.authorizationId, expiresAt }
        );

    }

    return authorization;

}
