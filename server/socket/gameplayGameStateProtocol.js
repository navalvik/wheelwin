import { GAME_MESSAGE_CHANNEL } from "./events.js";

export const GAME_STATE_MESSAGE_TYPE = "GAME_STATE";

export function buildGameStateSyncPayload(statePayload) {

    return {
        gameId: statePayload?.gameId ?? null,
        state: statePayload?.currentState ?? null,
        previousState: statePayload?.previousState ?? null,
        timestamp: statePayload?.timestamp ?? null,
        reason: statePayload?.reason ?? null,
        serverTimestamp: Date.now()
    };

}

export function buildGameStateSyncMessage(statePayload) {

    return {
        channel: GAME_MESSAGE_CHANNEL,
        message: {
            type: GAME_STATE_MESSAGE_TYPE,
            payload: buildGameStateSyncPayload(statePayload)
        }
    };

}
