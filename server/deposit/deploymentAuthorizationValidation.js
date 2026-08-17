/**
 * R17.9L.5A — DeploymentAuthorization creation rules (no client/socket/Page4 path).
 */

import { DEPOSIT_SESSION_STATUS } from "./DepositSessionStates.js";
import { InvalidDeploymentAuthorizationError } from "./DeploymentAuthorizationErrors.js";
import { normalizeDepositIdPart } from "./depositValidation.js";

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
