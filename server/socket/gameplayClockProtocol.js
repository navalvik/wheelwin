import { GAME_MESSAGE_CHANNEL } from "./events.js";

export const GAME_CLOCK_MESSAGE_TYPE = "GAME_CLOCK_UPDATE";

export function buildGameClockUpdatePayload(clockPayload) {

    return {
        gameId: clockPayload?.gameId ?? null,
        phase: clockPayload?.phase ?? null,
        remainingMs: clockPayload?.remainingMs ?? null,
        remainingSeconds: clockPayload?.remainingSeconds ?? null,
        running: clockPayload?.running ?? false,
        serverTimestamp: Date.now()
    };

}

export function buildGameClockUpdateMessage(clockPayload) {

    return {
        channel: GAME_MESSAGE_CHANNEL,
        message: {
            type: GAME_CLOCK_MESSAGE_TYPE,
            payload: buildGameClockUpdatePayload(clockPayload)
        }
    };

}
