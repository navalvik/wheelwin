import { EVENT_TYPES } from "../events/EventTypes.js";

import { GAME_MESSAGE_CHANNEL } from "./events.js";

export { GAME_MESSAGE_CHANNEL };

export const GAMEPLAY_INPUT_MESSAGE_TYPES = Object.freeze([
    EVENT_TYPES.BUTTON_PRESS,
    EVENT_TYPES.BUTTON_RELEASE
]);

const GAMEPLAY_INPUT_MESSAGE_SET = new Set(GAMEPLAY_INPUT_MESSAGE_TYPES);

export function isGameplayInputMessageType(type) {

    return typeof type === "string"
        && GAMEPLAY_INPUT_MESSAGE_SET.has(type.trim().toUpperCase());

}

export function normalizeGameplayMessage(rawMessage) {

    if (!rawMessage || typeof rawMessage !== "object") {

        return null;

    }

    const type = rawMessage.type;

    if (typeof type !== "string" || !type.trim()) {

        return null;

    }

    return {
        type: type.trim().toUpperCase(),
        payload: rawMessage.payload ?? {}
    };

}
