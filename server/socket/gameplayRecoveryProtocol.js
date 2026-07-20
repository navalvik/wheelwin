import { GAME_MESSAGE_CHANNEL } from "./events.js";

export const RECOVERY_SOCKET_MESSAGE_TYPES = Object.freeze({
    SESSION_RECOVERY_REQUEST: "SESSION_RECOVERY_REQUEST",
    SESSION_SNAPSHOT: "SESSION_SNAPSHOT",
    SESSION_RECOVERY_FAILED: "SESSION_RECOVERY_FAILED"
});

const RADIANS_TO_DEGREES = 180 / Math.PI;

function mapWinnerToGameResult(gameId, winner, recoveredAt) {

    if (!winner) {

        return null;

    }

    const finalAngleRadians = winner.finalAngle ?? 0;

    return {
        gameId,
        winner: {
            id: winner.winningPlayer?.playerId ?? null,
            color: winner.winningPlayer?.color ?? null,
            icon: winner.winningPlayer?.icon ?? null
        },
        winningSector: {
            index: winner.winningSector?.index ?? null,
            sectorId: winner.winningSector?.sectorId ?? null,
            color: winner.winningSector?.color ?? null,
            icon: winner.winningSector?.icon ?? null
        },
        finalWheelAngle: finalAngleRadians * RADIANS_TO_DEGREES,
        serverTimestamp: recoveredAt ?? Date.now()
    };

}

function mapAuditStatusForClient(auditStatus) {

    if (auditStatus === "READY") {

        return { status: "READY" };

    }

    if (auditStatus === "FAILED") {

        return { status: "FAILED" };

    }

    if (auditStatus === "STARTED") {

        return { status: "STARTED" };

    }

    return null;

}

function mapPaymentStatusForClient(paymentStatus, payment) {

    if (payment?.paymentStatus === "COMPLETED") {

        return {
            status: "COMPLETED",
            winnerAmount: payment.winnerAmount ?? null
        };

    }

    if (paymentStatus === "FAILED") {

        return {
            status: "FAILED",
            reason: "Settlement failed"
        };

    }

    if (paymentStatus === "PREPARED" || paymentStatus === "PENDING") {

        return { status: "STARTED" };

    }

    return null;

}

/**
 * Maps the authoritative RecoveryEngine snapshot (plus optional payment
 * enrichment) into the client SESSION_SNAPSHOT shape. The client must never
 * infer gameplay state — it only displays what the server provides here.
 */
export function buildClientRecoveryPayload({
    snapshot,
    playerId,
    roomId,
    paymentStatus = null,
    payment = null,
    auditStatus = null
}) {

    const gameId = snapshot?.gameId ?? null;

    const currentState = snapshot?.gameState?.currentState ?? null;

    const angleRadians = snapshot?.physics?.angle ?? 0;

    const angularVelocity = snapshot?.physics?.angularVelocity ?? 0;

    const wheelAngleDegrees = angleRadians * RADIANS_TO_DEGREES;

    const sectors = snapshot?.configuration?.sectors ?? [];

    const playerStates = (snapshot?.input?.players ?? []).map((player) => ({

        playerId: player.playerId,

        pressCount: player.pressCount ?? 0,

        remainingPresses: player.remainingPresses ?? 0,

        locked: player.locked ?? false

    }));

    const gameResult = mapWinnerToGameResult(
        gameId,
        snapshot?.winner,
        snapshot?.recoveredAt
    );

    return {
        gameId,
        roomId: roomId ?? snapshot?.configuration?.roomId ?? null,
        playerId: playerId ?? null,
        gameState: currentState,
        wheelConfiguration: sectors.length > 0
            ? { sectors }
            : null,
        wheelAngle: wheelAngleDegrees,
        triangleAngle: 0,
        physics: {
            wheelAngle: wheelAngleDegrees,
            triangleAngle: 0,
            currentWheelSpeed: Math.abs(angularVelocity),
            wheelSpeed: Math.abs(angularVelocity),
            isBraking: snapshot?.physics?.state === "BRAKING",
            remainingBrakeTime: null,
            elapsedTime: snapshot?.clock?.elapsed ?? null
        },
        playerStates,
        button: {
            pressCounter: playerStates.find(
                (entry) => entry.playerId === playerId
            )?.pressCount ?? 0
        },
        remainingGameTime: snapshot?.clock?.remainingTime ?? null,
        phaseStartedAt: snapshot?.clock?.phaseStartedAt ?? null,
        phaseEndsAt: snapshot?.clock?.phaseEndsAt ?? null,
        gameResult,
        payment: mapPaymentStatusForClient(
            paymentStatus ?? payment?.paymentStatus ?? null,
            payment ?? snapshot?.payment
        ),
        audit: mapAuditStatusForClient(auditStatus),
        timestamp: snapshot?.recoveredAt ?? Date.now(),
        traceSeed: snapshot?.metadata?.traceSeed ?? null
    };

}

export function buildRecoverySnapshotMessage(payload) {

    return {
        channel: GAME_MESSAGE_CHANNEL,
        message: {
            type: RECOVERY_SOCKET_MESSAGE_TYPES.SESSION_SNAPSHOT,
            payload
        }
    };

}

export function buildRecoveryFailedMessage({ reason, gameId = null, playerId = null }) {

    return {
        channel: GAME_MESSAGE_CHANNEL,
        message: {
            type: RECOVERY_SOCKET_MESSAGE_TYPES.SESSION_RECOVERY_FAILED,
            payload: {
                gameId,
                playerId,
                message: reason ?? "Session recovery failed",
                timestamp: Date.now()
            }
        }
    };

}
