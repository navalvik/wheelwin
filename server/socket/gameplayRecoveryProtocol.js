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

    const finalAngleRadians = winner.wheelFinalAngle
        ?? winner.finalAngle
        ?? 0;

    const triangleAngleRadians = winner.triangleFinalAngle;

    return {
        gameId,
        winner: {
            id: winner.winnerPlayerId
                ?? winner.winningPlayer?.playerId
                ?? null,
            color: winner.winningPlayer?.color ?? null,
            icon: winner.winningPlayer?.icon ?? null
        },
        winningSector: {
            index: winner.winnerSectorIndex
                ?? winner.winningSector?.index
                ?? null,
            sectorId: winner.winningSector?.sectorId ?? null,
            color: winner.winningSector?.color ?? null,
            icon: winner.winningSector?.icon ?? null
        },
        winnerPlayerId: winner.winnerPlayerId
            ?? winner.winningPlayer?.playerId
            ?? null,
        winnerSectorIndex: winner.winnerSectorIndex
            ?? winner.winningSector?.index
            ?? null,
        finalWheelAngle: finalAngleRadians * RADIANS_TO_DEGREES,
        wheelFinalAngle: finalAngleRadians * RADIANS_TO_DEGREES,
        triangleFinalAngle: Number.isFinite(triangleAngleRadians)
            ? triangleAngleRadians * RADIANS_TO_DEGREES
            : null,
        resolvedAt: winner.resolvedAt ?? null,
        serverTimestamp: recoveredAt ?? winner.resolvedAt ?? Date.now()
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

    const hasLivePhysics = Boolean(snapshot?.physics?.snapshot);

    const triangleRadians = hasLivePhysics
        ? (snapshot.physics.triangleAngle ?? 0)
        : null;

    const angularVelocity = snapshot?.physics?.angularVelocity ?? 0;

    const triangleAngularVelocity
        = snapshot?.physics?.triangleAngularVelocity ?? 0;

    const sectors = snapshot?.configuration?.sectors ?? [];

    const configWheelAngle = snapshot?.configuration?.wheel?.startAngle;

    const configTriangleAngle = snapshot?.configuration?.triangle?.startAngle;

    const physicsWheelDegrees = angleRadians * RADIANS_TO_DEGREES;

    const wheelAngleDegrees = hasLivePhysics && physicsWheelDegrees !== 0
        ? physicsWheelDegrees
        : (Number.isFinite(configWheelAngle)
            ? configWheelAngle
            : (hasLivePhysics ? physicsWheelDegrees : 0));

    const triangleAngleDegrees = Number.isFinite(triangleRadians)
        ? triangleRadians * RADIANS_TO_DEGREES
        : (Number.isFinite(configTriangleAngle) ? configTriangleAngle : 0);

    const playerStates = (snapshot?.input?.players ?? []).map((player) => ({

        playerId: player.playerId,

        pressCount: player.pressCount ?? player.completedCycles ?? 0,

        completedCycles: player.completedCycles ?? player.pressCount ?? 0,

        remainingPresses: player.remainingPresses ?? 0,

        locked: player.locked ?? player.buttonLocked ?? false,

        buttonLocked: player.buttonLocked ?? player.locked ?? false,

        buttonPressed: player.buttonPressed === true || player.pressed === true,

        pressed: player.pressed === true || player.buttonPressed === true,

        lastReleaseAt: player.lastReleaseAt ?? null,

        cooldownUntil: player.cooldownUntil ?? null

    }));

    const localPlayerState = playerStates.find(
        (entry) => entry.playerId === playerId
    );

    const wheelSpeedDegPerSec = Math.abs(angularVelocity) * RADIANS_TO_DEGREES;

    const triangleSpeedDegPerSec
        = Math.abs(triangleAngularVelocity) * RADIANS_TO_DEGREES;

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
            ? {
                sectors,
                wheelAngle: wheelAngleDegrees,
                triangleAngle: triangleAngleDegrees
            }
            : null,
        wheelAngle: wheelAngleDegrees,
        triangleAngle: triangleAngleDegrees,
        physics: {
            wheelAngle: wheelAngleDegrees,
            triangleAngle: triangleAngleDegrees,
            currentWheelSpeed: wheelSpeedDegPerSec,
            wheelSpeed: wheelSpeedDegPerSec,
            triangleSpeed: triangleSpeedDegPerSec,
            angularVelocity,
            triangleAngularVelocity,
            isBraking: snapshot?.physics?.state === "BRAKING",
            remainingBrakeTime: null,
            elapsedTime: snapshot?.clock?.elapsed ?? null,
            selfTestActive: snapshot?.physics?.selfTestActive === true,
            speedActive: snapshot?.physics?.speedActive === true,
            brakeActive: snapshot?.physics?.brakeActive === true,
            brakeDurationMs: snapshot?.physics?.brakeDurationMs ?? null,
            brakeElapsedMs: snapshot?.physics?.brakeElapsedMs ?? null,
            brakeStartWheelOmega:
                snapshot?.physics?.brakeStartWheelOmega ?? null,
            remainingBrakeTime: Number.isFinite(snapshot?.clock?.remainingTime)
                ? snapshot.clock.remainingTime
                : null
        },
        playerStates,
        button: {
            pressCounter: localPlayerState?.completedCycles
                ?? localPlayerState?.pressCount
                ?? 0,
            completedCycles: localPlayerState?.completedCycles
                ?? localPlayerState?.pressCount
                ?? 0,
            remainingPresses: localPlayerState?.remainingPresses ?? 0,
            buttonPressed: localPlayerState?.pressed === true,
            pressed: localPlayerState?.pressed === true,
            locked: localPlayerState?.buttonLocked === true,
            buttonLocked: localPlayerState?.buttonLocked === true,
            lastReleaseAt: localPlayerState?.lastReleaseAt ?? null,
            cooldownUntil: localPlayerState?.cooldownUntil ?? null
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
