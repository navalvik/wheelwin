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

        this._unregisterDispatcher?.();

        this._unbindSocketEvents();

        this.disconnect();

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

        this._socket.on("connect", this._handleConnect);

        this._socket.on("disconnect", this._handleDisconnect);

        this._socket.io.on("reconnect_attempt", this._handleReconnectAttempt);

        this._socket.on(SOCKET_MESSAGE_CHANNEL, this._handleGameMessage);

        this._socket.on("startGame", this._handleStartGame);

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
