import { EVENT_TYPES } from "../events/EventTypes.js";

import { GAME_MESSAGE_CHANNEL } from "./events.js";
import { RECOVERY_SOCKET_MESSAGE_TYPES } from "./gameplayRecoveryProtocol.js";

export { GAME_MESSAGE_CHANNEL };

export const GAMEPLAY_INPUT_MESSAGE_TYPES = Object.freeze([
    EVENT_TYPES.BUTTON_PRESS,
    EVENT_TYPES.BUTTON_RELEASE
]);

export const GAMEPLAY_CLIENT_MESSAGE_TYPES = Object.freeze([
    ...GAMEPLAY_INPUT_MESSAGE_TYPES,
    RECOVERY_SOCKET_MESSAGE_TYPES.SESSION_RECOVERY_REQUEST
]);

const GAMEPLAY_INPUT_MESSAGE_SET = new Set(GAMEPLAY_INPUT_MESSAGE_TYPES);

const GAMEPLAY_CLIENT_MESSAGE_SET = new Set(GAMEPLAY_CLIENT_MESSAGE_TYPES);

export function isGameplayInputMessageType(type) {

    return typeof type === "string"
        && GAMEPLAY_INPUT_MESSAGE_SET.has(type.trim().toUpperCase());

}

export function isGameplayClientMessageType(type) {

    return typeof type === "string"
        && GAMEPLAY_CLIENT_MESSAGE_SET.has(type.trim().toUpperCase());

}

export function isRecoveryRequestMessageType(type) {

    return typeof type === "string"
        && type.trim().toUpperCase()
            === RECOVERY_SOCKET_MESSAGE_TYPES.SESSION_RECOVERY_REQUEST;

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
