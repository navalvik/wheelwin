import { GAME_MESSAGE_CHANNEL } from "./events.js";

export const WINNER_RESULT_MESSAGE_TYPE = "GAME_RESULT";

const RADIANS_TO_DEGREES = 180 / Math.PI;

export function buildWinnerResultPayload(winnerPayload) {

    const finalAngleRadians = winnerPayload?.finalWheelAngle ?? 0;

    return {
        gameId: winnerPayload?.gameId ?? null,
        winner: {
            id: winnerPayload?.winningPlayerId ?? null,
            color: winnerPayload?.winningPlayerColor ?? null,
            icon: winnerPayload?.winningPlayerIcon ?? null
        },
        winningSector: {
            index: winnerPayload?.winningSector?.index ?? null,
            sectorId: winnerPayload?.winningSector?.sectorId ?? null,
            color: winnerPayload?.winningSector?.color ?? null,
            icon: winnerPayload?.winningSector?.icon ?? null
        },
        finalWheelAngle: finalAngleRadians * RADIANS_TO_DEGREES,
        serverTimestamp: winnerPayload?.serverTimestamp ?? Date.now()
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
