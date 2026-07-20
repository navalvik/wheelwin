import { GAME_MESSAGE_CHANNEL } from "./events.js";

export const WINNER_RESULT_MESSAGE_TYPE = "GAME_RESULT";

const RADIANS_TO_DEGREES = 180 / Math.PI;

export function buildWinnerResultPayload(winnerPayload) {

    const finalAngleRadians = winnerPayload?.wheelFinalAngle
        ?? winnerPayload?.finalWheelAngle
        ?? 0;

    const triangleAngleRadians = winnerPayload?.triangleFinalAngle ?? null;

    return {
        gameId: winnerPayload?.gameId ?? null,
        winner: {
            id: winnerPayload?.winnerPlayerId
                ?? winnerPayload?.winningPlayerId
                ?? null,
            color: winnerPayload?.winningPlayerColor ?? null,
            icon: winnerPayload?.winningPlayerIcon ?? null
        },
        winningSector: {
            index: winnerPayload?.winnerSectorIndex
                ?? winnerPayload?.winningSector?.index
                ?? null,
            sectorId: winnerPayload?.winningSector?.sectorId ?? null,
            color: winnerPayload?.winningSector?.color ?? null,
            icon: winnerPayload?.winningSector?.icon ?? null
        },
        winnerPlayerId: winnerPayload?.winnerPlayerId
            ?? winnerPayload?.winningPlayerId
            ?? null,
        winnerSectorIndex: winnerPayload?.winnerSectorIndex
            ?? winnerPayload?.winningSector?.index
            ?? null,
        finalWheelAngle: finalAngleRadians * RADIANS_TO_DEGREES,
        wheelFinalAngle: finalAngleRadians * RADIANS_TO_DEGREES,
        triangleFinalAngle: Number.isFinite(triangleAngleRadians)
            ? triangleAngleRadians * RADIANS_TO_DEGREES
            : null,
        resolvedAt: winnerPayload?.resolvedAt ?? null,
        serverTimestamp: winnerPayload?.serverTimestamp
            ?? winnerPayload?.resolvedAt
            ?? Date.now()
    };

}

export function buildWinnerResultMessage(winnerPayload) {

    return {
        channel: GAME_MESSAGE_CHANNEL,
        message: {
            type: WINNER_RESULT_MESSAGE_TYPE,
            payload: buildWinnerResultPayload(winnerPayload)
        }
    };

}
