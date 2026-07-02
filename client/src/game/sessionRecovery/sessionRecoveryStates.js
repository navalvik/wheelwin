export const RECOVERY_CONNECTION_STATES = Object.freeze({
    CONNECTED: "CONNECTED",
    CONNECTION_LOST: "CONNECTION_LOST",
    RECONNECTING: "RECONNECTING",
    RESYNCHRONIZING: "RESYNCHRONIZING"
});

export const RECOVERY_PROGRESS = Object.freeze({
    IDLE: "idle",
    REQUESTING: "requesting",
    RESTORING_GAME_STATE: "restoring:gameState",
    RESTORING_PHYSICS: "restoring:physics",
    RESTORING_WHEEL: "restoring:wheel",
    RESTORING_PLAYER_UI: "restoring:playerUI",
    RESTORING_BUTTON: "restoring:button",
    RESTORING_AUDIO: "restoring:audio",
    RESTORING_RESULT: "restoring:result",
    COMPLETE: "complete",
    FAILED: "failed"
});
