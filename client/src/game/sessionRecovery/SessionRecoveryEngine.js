import { RECOVERY_SOCKET_EVENTS } from "./sessionRecoveryEvents";

import {
    RECOVERY_CONNECTION_STATES,
    RECOVERY_PROGRESS
} from "./sessionRecoveryStates";

import {
    getModulesToRestore,
    normalizeSessionSnapshot
} from "./sessionSnapshotUtils";

const RESTORE_HANDLERS = Object.freeze({
    wheel: "restoreWheel",
    physics: "restorePhysics",
    gameState: "restoreGameState",
    playerUI: "restorePlayerUI",
    button: "restoreButton",
    audio: "restoreAudio",
    winnerResolver: "restoreWinnerResult",
    payment: "restorePayment"
});

const RESTORE_PROGRESS = Object.freeze({
    wheel: RECOVERY_PROGRESS.RESTORING_WHEEL,
    physics: RECOVERY_PROGRESS.RESTORING_PHYSICS,
    gameState: RECOVERY_PROGRESS.RESTORING_GAME_STATE,
    playerUI: RECOVERY_PROGRESS.RESTORING_PLAYER_UI,
    button: RECOVERY_PROGRESS.RESTORING_BUTTON,
    audio: RECOVERY_PROGRESS.RESTORING_AUDIO,
    winnerResolver: RECOVERY_PROGRESS.RESTORING_RESULT,
    payment: RECOVERY_PROGRESS.RESTORING_RESULT
});

export class SessionRecoveryEngine {

    constructor({
        localPlayerId = 1,
        devMode = false,
        getModules,
        sendMessage,
        getPlayerIdentity = null,
        onStateChange
    } = {}) {

        this._localPlayerId = localPlayerId;

        this._devMode = devMode;

        this._getModules = getModules;

        this._sendMessage = sendMessage;

        this._getPlayerIdentity = getPlayerIdentity;

        this._onStateChange = onStateChange;

        this._connectionState = RECOVERY_CONNECTION_STATES.CONNECTED;

        this._recoveryProgress = RECOVERY_PROGRESS.IDLE;

        this._lastRecoveryTime = null;

        this._recoveredGameState = null;

        this._recoveryMessage = null;

        this._hadSuccessfulConnection = false;

        this._hadConnectionLoss = false;

        this._recoveryPending = false;

        this._restoreInProgress = false;

        this._lastAppliedSnapshotId = null;

        this._reconnectTimer = null;

    }

    getStatus() {

        return {
            connectionState: this._connectionState,
            recoveryProgress: this._recoveryProgress,
            lastRecoveryTime: this._lastRecoveryTime,
            recoveredGameState: this._recoveredGameState,
            recoveryMessage: this._recoveryMessage
        };

    }

    handleSocketStatus(socketStatus) {

        const connectionState = socketStatus?.connectionState;

        if (!connectionState) {

            return;

        }

        if (connectionState === "RECONNECTING") {

            this._setConnectionState(RECOVERY_CONNECTION_STATES.RECONNECTING);

            return;

        }

        if (connectionState === "CONNECTED") {

            this._hadSuccessfulConnection = true;

            if (this._hadConnectionLoss) {

                this.reconnect();

                return;

            }

            this._setConnectionState(RECOVERY_CONNECTION_STATES.CONNECTED);

            return;

        }

        if ((connectionState === "DISCONNECTED" || !socketStatus.connected)
            && this._hadSuccessfulConnection) {

            this.connectionLost();

        }

    }

    connectionLost() {

        this._hadConnectionLoss = true;

        this._recoveryMessage = "Connection lost. Game continues — reconnecting…";

        this._setConnectionState(RECOVERY_CONNECTION_STATES.CONNECTION_LOST);

        const modules = this._getModules?.() || {};

        modules.playerUI?.setLocalPlayerOffline?.(this._localPlayerId);

        this._log("Connection lost — local player marked offline");

    }

    reconnect() {

        this._recoveryMessage = "Reconnected. Restoring session…";

        this._setConnectionState(RECOVERY_CONNECTION_STATES.RECONNECTING);

        if (this._reconnectTimer) {

            return;

        }

        this._reconnectTimer = setTimeout(() => {

            this._reconnectTimer = null;

            // Recovery requests are coordinated by RecoveryExperience at the
            // app shell level. This engine only restores modules when the
            // authoritative SESSION_SNAPSHOT arrives via EngineBridge.

        }, 300);

        this._log("Socket reconnected — awaiting authoritative snapshot");

    }

    requestRecovery() {

        if (this._recoveryPending
            && this._recoveryProgress !== RECOVERY_PROGRESS.FAILED) {

            this._log("Recovery already in progress");

            return;

        }

        this._recoveryPending = true;

        this._recoveryProgress = RECOVERY_PROGRESS.REQUESTING;

        this._setConnectionState(RECOVERY_CONNECTION_STATES.RESYNCHRONIZING);

        const identity = this._getPlayerIdentity?.() ?? {};

        this._sendMessage?.(
            RECOVERY_SOCKET_EVENTS.SESSION_RECOVERY_REQUEST,
            {
                playerId: identity.playerId ?? this._localPlayerId,
                roomId: identity.roomId ?? null,
                gameId: identity.gameId ?? null,
                timestamp: Date.now()
            }
        );

        this._notify();

        this._log("Recovery request sent");

    }

    restoreSession(snapshot) {

        if (!snapshot) {

            this.handleRecoveryFailed({ message: "Empty session snapshot" });

            return null;

        }

        const snapshotId = snapshot.timestamp
            ?? snapshot.sessionId
            ?? `${snapshot.gameState}:${snapshot.wheelAngle}:${snapshot.triangleAngle}`;

        if (this._restoreInProgress) {

            this._log("Restore already in progress");

            return null;

        }

        if (this._lastAppliedSnapshotId === snapshotId
            && this._recoveryProgress === RECOVERY_PROGRESS.COMPLETE) {

            this._log("Snapshot already applied");

            return normalizeSessionSnapshot(snapshot);

        }

        this._restoreInProgress = true;

        const normalized = normalizeSessionSnapshot(snapshot);

        try {

            const modules = this._getModules?.() || {};

            const modulesToRestore = getModulesToRestore(normalized);

            modulesToRestore.forEach((moduleName) => {

                this._recoveryProgress = RESTORE_PROGRESS[moduleName]
                    || RECOVERY_PROGRESS.REQUESTING;

                this.restoreModule(moduleName, normalized, modules);

                this._notify();

            });

            modules.playerUI?.setLocalPlayerOnline?.(this._localPlayerId);

            this._lastAppliedSnapshotId = snapshotId;

            this.recoveryComplete(normalized.gameState);

            return normalized;

        } finally {

            this._restoreInProgress = false;

        }

    }

    restoreModule(moduleName, snapshot, modules = null) {

        const registry = modules || this._getModules?.() || {};

        const handlerName = RESTORE_HANDLERS[moduleName];

        const handler = handlerName ? registry[handlerName] : null;

        if (typeof handler !== "function") {

            return false;

        }

        handler(snapshot);

        this._log(`Restored module: ${moduleName}`);

        return true;

    }

    recoveryComplete(gameState) {

        this._hadConnectionLoss = false;

        this._recoveryPending = false;

        this._lastRecoveryTime = Date.now();

        this._recoveredGameState = gameState;

        this._recoveryProgress = RECOVERY_PROGRESS.COMPLETE;

        this._recoveryMessage = "Session restored successfully.";

        this._setConnectionState(RECOVERY_CONNECTION_STATES.CONNECTED);

        this._log(`Recovery complete — game state: ${gameState}`);

    }

    handleRecoveryFailed(payload = {}) {

        this._recoveryPending = false;

        this._recoveryProgress = RECOVERY_PROGRESS.FAILED;

        this._recoveryMessage = payload.message
            || "Session recovery failed. Will retry on next connection.";

        this._setConnectionState(RECOVERY_CONNECTION_STATES.CONNECTION_LOST);

        this._notify();

        this._log(this._recoveryMessage);

    }

    reset() {

        if (this._reconnectTimer) {

            clearTimeout(this._reconnectTimer);

            this._reconnectTimer = null;

        }

        this._connectionState = RECOVERY_CONNECTION_STATES.CONNECTED;

        this._recoveryProgress = RECOVERY_PROGRESS.IDLE;

        this._recoveryMessage = null;

        this._recoveredGameState = null;

        this._hadConnectionLoss = false;

        this._hadSuccessfulConnection = false;

        this._recoveryPending = false;

        this._restoreInProgress = false;

        this._lastAppliedSnapshotId = null;

        this._notify();

    }

    _setConnectionState(state) {

        this._connectionState = state;

        this._notify();

    }

    _notify() {

        this._onStateChange?.(this.getStatus());

    }

    _log(message) {

        if (this._devMode) {

            console.log(`[SessionRecovery] ${message}`);

        }

    }

}
