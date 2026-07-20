import { GAME_MESSAGE_CHANNEL } from "./events.js";

export const WHEEL_CONFIGURATION_MESSAGE_TYPE = "WHEEL_CONFIGURATION";

export function buildWheelConfigurationPayload({
    gameId,
    sectors,
    wheelAngle,
    triangleAngle
}) {

    return {
        gameId: gameId ?? null,
        sectors: Array.isArray(sectors) ? sectors : [],
        wheelAngle: Number.isFinite(wheelAngle) ? wheelAngle : null,
        triangleAngle: Number.isFinite(triangleAngle) ? triangleAngle : null,
        serverTimestamp: Date.now()
    };

}

export function buildWheelConfigurationMessage(payload) {

    return {
        channel: GAME_MESSAGE_CHANNEL,
        message: {
            type: WHEEL_CONFIGURATION_MESSAGE_TYPE,
            payload: buildWheelConfigurationPayload(payload)
        }
    };

}
