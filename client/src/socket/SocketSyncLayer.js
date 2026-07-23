import { EngineBridge } from "./EngineBridge";

import { SocketDispatcher, normalizeSocketMessage } from "./SocketDispatcher";

import {
    INCOMING_SOCKET_EVENTS,
    OUTGOING_SOCKET_EVENTS,
    SOCKET_CONNECTION_STATES,
    SOCKET_MESSAGE_CHANNEL
} from "./socketEvents";

export class SocketSyncLayer {

    constructor(socket, {

        engineBridge = new EngineBridge(),

        devMode = false,

        onStatusChange,

        onDebugChange

    } = {}) {

        this._socket = socket;

        this._engineBridge = engineBridge;

        this._devMode = devMode;

        this._onStatusChange = onStatusChange;

        this._onDebugChange = onDebugChange;

        this._dispatcher = new SocketDispatcher({
            devMode,
            onUnknownEvent: (message) => {

                if (this._devMode) {

                    console.warn(
                        `[SocketSync] Unknown incoming event: ${message.type}`
                    );

                }

            }
        });

        this._unregisterDispatcher = this._dispatcher.registerModuleHandlers(
            this._engineBridge.createDispatcherHandlers()
        );

        this._status = SOCKET_CONNECTION_STATES.DISCONNECTED;

        this._lastIncoming = null;

        this._lastOutgoing = null;

        this._pingMs = null;

        this._bound = false;

    }

    getEngineBridge() {

        return this._engineBridge;

    }

    getStatus() {

        return {
            connectionState: this._status,
            connected: this._status === SOCKET_CONNECTION_STATES.CONNECTED,
            lastIncoming: this._lastIncoming,
            lastOutgoing: this._lastOutgoing,
            pingMs: this._pingMs,
            socketId: this._socket?.id || null
        };

    }

    connect() {

        this._bindSocketEvents();

        if (this._socket.connected) {

            this._setStatus(SOCKET_CONNECTION_STATES.CONNECTED);

            return;

        }

        this._setStatus(SOCKET_CONNECTION_STATES.CONNECTING);

        this._socket.connect();

    }

    disconnect() {

        if (this._socket.connected) {

            this.send(OUTGOING_SOCKET_EVENTS.CLIENT_DISCONNECTED, {
                socketId: this._socket.id
            });

        }

        this._socket.disconnect();

        this._setStatus(SOCKET_CONNECTION_STATES.DISCONNECTED);

    }

    send(type, payload = {}) {

        const message = {
            type,
            payload
        };

        this._lastOutgoing = message;

        this._notifyDebug();

        if (this._socket.connected) {

            this._socket.emit(SOCKET_MESSAGE_CHANNEL, message);

        }

        return message;

    }

    sendPing() {

        const timestamp = Date.now();

        this.send(OUTGOING_SOCKET_EVENTS.PING, { timestamp });

        return timestamp;

    }

    dispatchLocal(message) {

        const normalized = this._dispatcher.dispatch(message);

        if (normalized) {

            this._lastIncoming = normalized;

            this._notifyDebug();

        }

        return normalized;

    }

    dispose() {

        // Release this layer's subscriptions (dispatcher routes + socket event
        // listeners) but intentionally leave the shared singleton socket
        // connected. Presentation navigation such as Page5 → Page6 unmounts this
        // layer, yet the socket must remain active with no reconnect. Use
        // disconnect() for an intentional teardown.
        this._unregisterDispatcher?.();

        this._unbindSocketEvents();

    }

    _bindSocketEvents() {

        if (this._bound) {

            return;

        }

        this._bound = true;

        this._handleConnect = () => {

            this._setStatus(SOCKET_CONNECTION_STATES.CONNECTED);

            this.send(OUTGOING_SOCKET_EVENTS.CLIENT_CONNECTED, {
                socketId: this._socket.id
            });

        };

        this._handleDisconnect = () => {

            this._setStatus(SOCKET_CONNECTION_STATES.DISCONNECTED);

        };

        this._handleReconnectAttempt = () => {

            this._setStatus(SOCKET_CONNECTION_STATES.RECONNECTING);

        };

        this._handleGameMessage = (message) => {

            this._handleIncoming(message);

        };

        this._handleStartGame = (payload) => {

            this._handleIncoming({
                type: INCOMING_SOCKET_EVENTS.GAME_START,
                payload
            });

        };

        this._handleSetupSessionStarted = (payload) => {

            this._handleIncoming({
                type: INCOMING_SOCKET_EVENTS.SETUP_SESSION_STARTED,
                payload
            });

        };

        this._handleSetupSessionSync = (payload) => {

            this._handleIncoming({
                type: INCOMING_SOCKET_EVENTS.SETUP_SESSION_SYNC,
                payload
            });

        };

        this._handleSetupSessionExpired = (payload) => {

            this._handleIncoming({
                type: INCOMING_SOCKET_EVENTS.SETUP_SESSION_EXPIRED,
                payload
            });

        };

        this._handlePlayerUpdate = (payload) => {

            this._handleIncoming({
                type: INCOMING_SOCKET_EVENTS.PLAYER_UPDATE,
                payload
            });

        };

        this._handleVerifyCompleted = (payload) => {

            this._handleIncoming({
                type: INCOMING_SOCKET_EVENTS.VERIFY_COMPLETED,
                payload
            });

        };

        this._handlePaymentStageReady = (payload) => {

            this._handleIncoming({
                type: INCOMING_SOCKET_EVENTS.PAYMENT_STAGE_READY,
                payload
            });

        };

        this._handleEntryPaymentSessionUpdated = (payload) => {

            this._handleIncoming({
                type: INCOMING_SOCKET_EVENTS.ENTRY_PAYMENT_SESSION_UPDATED,
                payload
            });

        };

        this._handleEntryPaymentCompleted = (payload) => {

            this._handleIncoming({
                type: INCOMING_SOCKET_EVENTS.ENTRY_PAYMENT_COMPLETED,
                payload
            });

        };

        this._handleWalletConnectionSessionUpdated = (payload) => {

            this._handleIncoming({
                type: INCOMING_SOCKET_EVENTS.WALLET_CONNECTION_SESSION_UPDATED,
                payload
            });

        };

        this._handlePaymentConnectionReady = (payload) => {

            this._handleIncoming({
                type: INCOMING_SOCKET_EVENTS.PAYMENT_CONNECTION_READY,
                payload
            });

        };

        this._handlePaymentSessionCreated = (payload) => {

            this._handleIncoming({
                type: INCOMING_SOCKET_EVENTS.PAYMENT_SESSION_CREATED,
                payload
            });

        };

        this._handlePaymentSessionUpdated = (payload) => {

            this._handleIncoming({
                type: INCOMING_SOCKET_EVENTS.PAYMENT_SESSION_UPDATED,
                payload
            });

        };

        this._handlePaymentRequest = (payload) => {

            this._handleIncoming({
                type: INCOMING_SOCKET_EVENTS.PAYMENT_REQUEST,
                payload
            });

        };

        this._handlePaymentSessionCompleted = (payload) => {

            this._handleIncoming({
                type: INCOMING_SOCKET_EVENTS.PAYMENT_SESSION_COMPLETED,
                payload
            });

        };

        this._handlePaymentSessionFailed = (payload) => {

            this._handleIncoming({
                type: INCOMING_SOCKET_EVENTS.PAYMENT_SESSION_FAILED,
                payload
            });

        };

        this._handleGameContractUpdated = (payload) => {

            this._handleIncoming({
                type: INCOMING_SOCKET_EVENTS.GAME_CONTRACT_UPDATED,
                payload
            });

        };

        this._handleGameContractDeployed = (payload) => {

            this._handleIncoming({
                type: INCOMING_SOCKET_EVENTS.GAME_CONTRACT_DEPLOYED,
                payload
            });

        };

        this._handleGameContractDeployFailed = (payload) => {

            this._handleIncoming({
                type: INCOMING_SOCKET_EVENTS.GAME_CONTRACT_DEPLOY_FAILED,
                payload
            });

        };

        this._handleGameStartAuthorized = (payload) => {

            this._handleIncoming({
                type: INCOMING_SOCKET_EVENTS.GAME_START_AUTHORIZED,
                payload
            });

        };

        this._handleGameInitializing = (payload) => {

            this._handleIncoming({
                type: INCOMING_SOCKET_EVENTS.GAME_INITIALIZING,
                payload
            });

        };

        this._handleOpenPage5 = (payload) => {

            this._handleIncoming({
                type: INCOMING_SOCKET_EVENTS.OPEN_PAGE5,
                payload
            });

        };

        this._handleOpenPage6 = (payload) => {

            this._handleIncoming({
                type: INCOMING_SOCKET_EVENTS.OPEN_PAGE6,
                payload
            });

        };

        this._handleSessionFinished = (payload) => {

            this._handleIncoming({
                type: INCOMING_SOCKET_EVENTS.SESSION_FINISHED,
                payload
            });

        };

        this._socket.on("connect", this._handleConnect);

        this._socket.on("disconnect", this._handleDisconnect);

        this._socket.io.on("reconnect_attempt", this._handleReconnectAttempt);

        this._socket.on(SOCKET_MESSAGE_CHANNEL, this._handleGameMessage);

        this._socket.on("startGame", this._handleStartGame);

        this._socket.on(
            INCOMING_SOCKET_EVENTS.SETUP_SESSION_STARTED,
            this._handleSetupSessionStarted
        );

        this._socket.on(
            INCOMING_SOCKET_EVENTS.SETUP_SESSION_SYNC,
            this._handleSetupSessionSync
        );

        this._socket.on(
            INCOMING_SOCKET_EVENTS.SETUP_SESSION_EXPIRED,
            this._handleSetupSessionExpired
        );

        this._socket.on(
            INCOMING_SOCKET_EVENTS.PLAYER_UPDATE,
            this._handlePlayerUpdate
        );

        this._socket.on(
            INCOMING_SOCKET_EVENTS.VERIFY_COMPLETED,
            this._handleVerifyCompleted
        );

        this._socket.on(
            INCOMING_SOCKET_EVENTS.PAYMENT_STAGE_READY,
            this._handlePaymentStageReady
        );

        this._socket.on(
            INCOMING_SOCKET_EVENTS.ENTRY_PAYMENT_SESSION_UPDATED,
            this._handleEntryPaymentSessionUpdated
        );

        this._socket.on(
            INCOMING_SOCKET_EVENTS.ENTRY_PAYMENT_COMPLETED,
            this._handleEntryPaymentCompleted
        );

        this._socket.on(
            INCOMING_SOCKET_EVENTS.WALLET_CONNECTION_SESSION_UPDATED,
            this._handleWalletConnectionSessionUpdated
        );

        this._socket.on(
            INCOMING_SOCKET_EVENTS.PAYMENT_CONNECTION_READY,
            this._handlePaymentConnectionReady
        );

        this._socket.on(
            INCOMING_SOCKET_EVENTS.PAYMENT_SESSION_CREATED,
            this._handlePaymentSessionCreated
        );

        this._socket.on(
            INCOMING_SOCKET_EVENTS.PAYMENT_SESSION_UPDATED,
            this._handlePaymentSessionUpdated
        );

        this._socket.on(
            INCOMING_SOCKET_EVENTS.PAYMENT_REQUEST,
            this._handlePaymentRequest
        );

        this._socket.on(
            INCOMING_SOCKET_EVENTS.PAYMENT_SESSION_COMPLETED,
            this._handlePaymentSessionCompleted
        );

        this._socket.on(
            INCOMING_SOCKET_EVENTS.PAYMENT_SESSION_FAILED,
            this._handlePaymentSessionFailed
        );

        this._socket.on(
            INCOMING_SOCKET_EVENTS.GAME_CONTRACT_UPDATED,
            this._handleGameContractUpdated
        );

        this._socket.on(
            INCOMING_SOCKET_EVENTS.GAME_CONTRACT_DEPLOYED,
            this._handleGameContractDeployed
        );

        this._socket.on(
            INCOMING_SOCKET_EVENTS.GAME_CONTRACT_DEPLOY_FAILED,
            this._handleGameContractDeployFailed
        );

        this._socket.on(
            INCOMING_SOCKET_EVENTS.GAME_START_AUTHORIZED,
            this._handleGameStartAuthorized
        );

        this._socket.on(
            INCOMING_SOCKET_EVENTS.GAME_INITIALIZING,
            this._handleGameInitializing
        );

        this._socket.on(
            INCOMING_SOCKET_EVENTS.OPEN_PAGE5,
            this._handleOpenPage5
        );

        this._socket.on(
            INCOMING_SOCKET_EVENTS.OPEN_PAGE6,
            this._handleOpenPage6
        );

        this._socket.on(
            INCOMING_SOCKET_EVENTS.SESSION_FINISHED,
            this._handleSessionFinished
        );

        this._bound = true;

    }

    _unbindSocketEvents() {

        if (!this._bound) {

            return;

        }

        this._socket.off("connect", this._handleConnect);

        this._socket.off("disconnect", this._handleDisconnect);

        this._socket.io.off("reconnect_attempt", this._handleReconnectAttempt);

        this._socket.off(SOCKET_MESSAGE_CHANNEL, this._handleGameMessage);

        this._socket.off("startGame", this._handleStartGame);

        this._socket.off(
            INCOMING_SOCKET_EVENTS.SETUP_SESSION_STARTED,
            this._handleSetupSessionStarted
        );

        this._socket.off(
            INCOMING_SOCKET_EVENTS.SETUP_SESSION_SYNC,
            this._handleSetupSessionSync
        );

        this._socket.off(
            INCOMING_SOCKET_EVENTS.SETUP_SESSION_EXPIRED,
            this._handleSetupSessionExpired
        );

        this._socket.off(
            INCOMING_SOCKET_EVENTS.PLAYER_UPDATE,
            this._handlePlayerUpdate
        );

        this._socket.off(
            INCOMING_SOCKET_EVENTS.VERIFY_COMPLETED,
            this._handleVerifyCompleted
        );

        this._socket.off(
            INCOMING_SOCKET_EVENTS.PAYMENT_STAGE_READY,
            this._handlePaymentStageReady
        );

        this._socket.off(
            INCOMING_SOCKET_EVENTS.ENTRY_PAYMENT_SESSION_UPDATED,
            this._handleEntryPaymentSessionUpdated
        );

        this._socket.off(
            INCOMING_SOCKET_EVENTS.ENTRY_PAYMENT_COMPLETED,
            this._handleEntryPaymentCompleted
        );

        this._socket.off(
            INCOMING_SOCKET_EVENTS.WALLET_CONNECTION_SESSION_UPDATED,
            this._handleWalletConnectionSessionUpdated
        );

        this._socket.off(
            INCOMING_SOCKET_EVENTS.PAYMENT_CONNECTION_READY,
            this._handlePaymentConnectionReady
        );

        this._socket.off(
            INCOMING_SOCKET_EVENTS.PAYMENT_SESSION_CREATED,
            this._handlePaymentSessionCreated
        );

        this._socket.off(
            INCOMING_SOCKET_EVENTS.PAYMENT_SESSION_UPDATED,
            this._handlePaymentSessionUpdated
        );

        this._socket.off(
            INCOMING_SOCKET_EVENTS.PAYMENT_REQUEST,
            this._handlePaymentRequest
        );

        this._socket.off(
            INCOMING_SOCKET_EVENTS.PAYMENT_SESSION_COMPLETED,
            this._handlePaymentSessionCompleted
        );

        this._socket.off(
            INCOMING_SOCKET_EVENTS.PAYMENT_SESSION_FAILED,
            this._handlePaymentSessionFailed
        );

        this._socket.off(
            INCOMING_SOCKET_EVENTS.GAME_CONTRACT_UPDATED,
            this._handleGameContractUpdated
        );

        this._socket.off(
            INCOMING_SOCKET_EVENTS.GAME_CONTRACT_DEPLOYED,
            this._handleGameContractDeployed
        );

        this._socket.off(
            INCOMING_SOCKET_EVENTS.GAME_CONTRACT_DEPLOY_FAILED,
            this._handleGameContractDeployFailed
        );

        this._socket.off(
            INCOMING_SOCKET_EVENTS.GAME_START_AUTHORIZED,
            this._handleGameStartAuthorized
        );

        this._socket.off(
            INCOMING_SOCKET_EVENTS.GAME_INITIALIZING,
            this._handleGameInitializing
        );

        this._socket.off(
            INCOMING_SOCKET_EVENTS.OPEN_PAGE5,
            this._handleOpenPage5
        );

        this._socket.off(
            INCOMING_SOCKET_EVENTS.OPEN_PAGE6,
            this._handleOpenPage6
        );

        this._socket.off(
            INCOMING_SOCKET_EVENTS.SESSION_FINISHED,
            this._handleSessionFinished
        );

        this._bound = false;

    }

    _handleIncoming(message) {

        const normalized = normalizeSocketMessage(message);

        if (!normalized) {

            return;

        }

        if (normalized.type === INCOMING_SOCKET_EVENTS.PONG
            && normalized.payload?.requestTimestamp) {

            this._pingMs = Date.now() - normalized.payload.requestTimestamp;

            this._notifyDebug();

            return;

        }

        this._lastIncoming = normalized;

        this._notifyDebug();

        if (this._devMode
            && (normalized.type === INCOMING_SOCKET_EVENTS.PHYSICS_UPDATE
                || normalized.type === INCOMING_SOCKET_EVENTS.GAME_STATE)) {

            console.debug(
                `[SocketSync] Client received packet (${normalized.type})`,
                normalized.payload
            );

        }

        this._dispatcher.dispatch(normalized);

        if (normalized.type === INCOMING_SOCKET_EVENTS.PING) {

            this.send(OUTGOING_SOCKET_EVENTS.PONG, {
                timestamp: Date.now(),
                requestTimestamp: normalized.payload?.timestamp
            });

        }

    }

    _setStatus(status) {

        this._status = status;

        this._onStatusChange?.(this.getStatus());

        this._notifyDebug();

    }

    _notifyDebug() {

        this._onDebugChange?.(this.getStatus());

    }

}
