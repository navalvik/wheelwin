import { GAME_MESSAGE_CHANNEL } from "./events.js";

export const GAME_CLOCK_MESSAGE_TYPE = "GAME_CLOCK_UPDATE";

export function buildGameClockUpdatePayload(clockPayload) {

    return {
        gameId: clockPayload?.gameId ?? null,
        phase: clockPayload?.phase ?? null,
        startedAt: clockPayload?.startedAt ?? null,
        endsAt: clockPayload?.endsAt ?? null,
        remainingMs: clockPayload?.remainingMs ?? null,
        remainingSeconds: clockPayload?.remainingSeconds ?? null,
        running: clockPayload?.running ?? false,
        gameState: clockPayload?.gameState ?? null,
        wheelAngle: clockPayload?.physics?.wheelAngle ?? null,
        triangleAngle: clockPayload?.physics?.triangleAngle ?? null,
        angularVelocity: clockPayload?.physics?.angularVelocity ?? null,
        triangleAngularVelocity:
            clockPayload?.physics?.triangleAngularVelocity ?? null,
        simulationTimeMs: clockPayload?.physics?.simulationTimeMs ?? null,
        syncSequence: Number.isSafeInteger(clockPayload?.syncSequence)
            ? clockPayload.syncSequence
            : null,
        serverTimestamp: clockPayload?.serverTimestamp ?? Date.now()
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
