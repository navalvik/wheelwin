import { GAME_MESSAGE_CHANNEL } from "./events.js";

export const PLAYER_INPUT_ACCEPTED_MESSAGE_TYPE = "PLAYER_INPUT_ACCEPTED";

export const PLAYER_INPUT_REJECTED_MESSAGE_TYPE = "PLAYER_INPUT_REJECTED";

export function buildInputAckPayload(inputPayload, accepted) {

    return {
        gameId: inputPayload?.gameId ?? null,
        playerId: inputPayload?.playerId ?? null,
        action: inputPayload?.action ?? null,
        gameState: inputPayload?.gameState ?? null,
        reason: inputPayload?.reason ?? null,
        pressCount: inputPayload?.pressCount ?? null,
        completedCycles: inputPayload?.completedCycles
            ?? inputPayload?.pressCount
            ?? null,
        remainingPresses: inputPayload?.remainingPresses ?? null,
        buttonPressed: inputPayload?.buttonPressed
            ?? inputPayload?.pressed
            ?? null,
        pressed: inputPayload?.pressed
            ?? inputPayload?.buttonPressed
            ?? null,
        locked: inputPayload?.locked
            ?? inputPayload?.buttonLocked
            ?? null,
        buttonLocked: inputPayload?.buttonLocked
            ?? inputPayload?.locked
            ?? null,
        lastReleaseAt: inputPayload?.lastReleaseAt ?? null,
        cooldownUntil: inputPayload?.cooldownUntil ?? null,
        timestamp: inputPayload?.timestamp ?? null,
        accepted,
        serverTimestamp: Date.now()
    };

}

export function buildInputAcceptedMessage(inputPayload) {

    return {
        channel: GAME_MESSAGE_CHANNEL,
        message: {
            type: PLAYER_INPUT_ACCEPTED_MESSAGE_TYPE,
            payload: buildInputAckPayload(inputPayload, true)
        }
    };

}

export function buildInputRejectedMessage(inputPayload) {

    return {
        channel: GAME_MESSAGE_CHANNEL,
        message: {
            type: PLAYER_INPUT_REJECTED_MESSAGE_TYPE,
            payload: buildInputAckPayload(inputPayload, false)
        }
    };

}
