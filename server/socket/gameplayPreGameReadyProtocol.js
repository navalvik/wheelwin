import { GAME_MESSAGE_CHANNEL } from "./events.js";
import { EVENT_TYPES } from "../events/EventTypes.js";

export const PRE_GAME_READY_MESSAGE_TYPES = Object.freeze({
    PRE_GAME_READY_STARTED: EVENT_TYPES.PRE_GAME_READY_STARTED,
    PRE_GAME_READY_UPDATED: EVENT_TYPES.PRE_GAME_READY_UPDATED,
    PRE_GAME_READY_COMPLETED: EVENT_TYPES.PRE_GAME_READY_COMPLETED
});

export function buildPreGameReadyPayload(payload) {

    return {
        gameId: payload?.gameId ?? null,
        readyPlayers: payload?.readyPlayers ?? {},
        startedAt: payload?.startedAt ?? null,
        expiresAt: payload?.expiresAt ?? null,
        completedAt: payload?.completedAt ?? null,
        serverTimestamp: payload?.timestamp ?? Date.now()
    };

}

export function buildPreGameReadyMessage(eventType, payload) {

    return {
        channel: GAME_MESSAGE_CHANNEL,
        message: {
            type: eventType,
            payload: buildPreGameReadyPayload(payload)
        }
    };

}
