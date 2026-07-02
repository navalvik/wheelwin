import { GAME_MESSAGE_CHANNEL } from "./events.js";

export const PHYSICS_UPDATE_MESSAGE_TYPE = "PHYSICS_UPDATE";

const RADIANS_TO_DEGREES = 180 / Math.PI;

export function buildPhysicsSyncPayload(physicsPayload) {

    const angleRadians = physicsPayload?.angle ?? 0;

    const angularVelocity = physicsPayload?.angularVelocity ?? 0;

    const angularAcceleration = physicsPayload?.angularAcceleration ?? 0;

    const simulationTime = physicsPayload?.timestamp ?? 0;

    return {
        gameId: physicsPayload?.gameId ?? null,
        simulationTime,
        wheelAngle: angleRadians * RADIANS_TO_DEGREES,
        angularVelocity,
        angularAcceleration,
        serverTimestamp: Date.now()
    };

}

export function buildPhysicsSyncMessage(physicsPayload) {

    return {
        channel: GAME_MESSAGE_CHANNEL,
        message: {
            type: PHYSICS_UPDATE_MESSAGE_TYPE,
            payload: buildPhysicsSyncPayload(physicsPayload)
        }
    };

}
