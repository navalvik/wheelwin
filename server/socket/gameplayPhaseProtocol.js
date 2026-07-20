import { GAME_MESSAGE_CHANNEL } from "./events.js";
import {
    getPhaseCompletedEventType,
    getPhaseStartedEventType
} from "../gameplay/GameplayPhaseSequence.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";

export const GAMEPLAY_PHASE_MESSAGE_TYPES = Object.freeze({
    READY_STARTED: getPhaseStartedEventType(GAME_STATES.READY),
    READY_COMPLETED: getPhaseCompletedEventType(GAME_STATES.READY),
    SELF_TEST_STARTED: getPhaseStartedEventType(GAME_STATES.SELF_TEST),
    SELF_TEST_COMPLETED: getPhaseCompletedEventType(GAME_STATES.SELF_TEST),
    SPEED_STARTED: getPhaseStartedEventType(GAME_STATES.SPEED),
    SPEED_COMPLETED: getPhaseCompletedEventType(GAME_STATES.SPEED),
    BRAKE_STARTED: getPhaseStartedEventType(GAME_STATES.BRAKE),
    BRAKE_COMPLETED: getPhaseCompletedEventType(GAME_STATES.BRAKE),
    RESULT_STARTED: getPhaseStartedEventType(GAME_STATES.RESULT),
    RESULT_COMPLETED: getPhaseCompletedEventType(GAME_STATES.RESULT)
});

export function buildGameplayPhasePayload(phasePayload) {

    return {
        gameId: phasePayload?.gameId ?? null,
        phase: phasePayload?.phase ?? null,
        startedAt: phasePayload?.startedAt ?? null,
        endsAt: phasePayload?.endsAt ?? null,
        durationMs: phasePayload?.durationMs ?? null,
        completedAt: phasePayload?.completedAt ?? null,
        serverTimestamp: Date.now()
    };

}

export function buildGameplayPhaseMessage(eventType, phasePayload) {

    return {
        channel: GAME_MESSAGE_CHANNEL,
        message: {
            type: eventType,
            payload: buildGameplayPhasePayload(phasePayload)
        }
    };

}
