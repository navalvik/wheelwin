import { io } from "socket.io-client";

import {
    appendConsoleLog,
    appendTimelineEntries,
    createConsoleStoreState,
    diffRoomsTimeline
} from "./consoleStore";
import {
    CONSOLE_CLIENT_EVENTS,
    CONSOLE_CONNECTION_STATES,
    CONSOLE_SERVER_EVENTS,
    CONSOLE_SOCKET_URL
} from "./consoleSocketEvents";

/**
 * R6.0D — Client transport for DeveloperConsoleGateway (`/console` namespace).
 * Completely separate from the gameplay Socket.IO singleton.
 */
export class ConsoleStreamLayer {

    constructor({
        url = CONSOLE_SOCKET_URL,
        onStateChange = null,
        accessToken = null
    } = {}) {

        this._onStateChange = onStateChange;

        this._state = createConsoleStoreState();

        this._accessToken = accessToken || null;

        this._socket = io(url, {
            autoConnect: false,
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            transports: ["websocket", "polling"],
            auth: this._accessToken
                ? { token: this._accessToken }
                : {}
        });

        this._bound = false;

        this._disposed = false;

    }

    setAccessToken(accessToken) {

        const next = accessToken || null;

        if (this._accessToken === next) {

            return;

        }

        this._accessToken = next;

        this._socket.auth = next ? { token: next } : {};

        if (this._socket.connected) {

            this.disconnect();

        }

        if (next) {

            this.connect();

        }

    }

    getState() {

        return this._state;

    }

    connect() {

        if (this._disposed) {

            return;

        }

        this._bindSocket();

        this._setConnectionState(
            this._socket.connected
                ? CONSOLE_CONNECTION_STATES.CONNECTED
                : CONSOLE_CONNECTION_STATES.CONNECTING
        );

        if (!this._socket.connected) {

            this._socket.connect();

        }

    }

    disconnect() {

        if (this._socket.connected) {

            this._socket.emit(CONSOLE_CLIENT_EVENTS.UNSUBSCRIBE);

        }

        this._socket.disconnect();

        this._patchState({
            connectionState: CONSOLE_CONNECTION_STATES.DISCONNECTED,
            connected: false,
            subscribed: false,
            socketId: null
        });

    }

    setFocus({ roomId = null, gameId = null } = {}) {

        const focus = Object.freeze({
            roomId: roomId || null,
            gameId: gameId || null
        });

        this._patchState({ focus });

        if (this._socket.connected && this._state.subscribed) {

            this._socket.emit(CONSOLE_CLIENT_EVENTS.FOCUS, focus);

        }

    }

    dispose() {

        this._disposed = true;

        this._unbindSocket();

        try {

            if (this._socket.connected) {

                this._socket.emit(CONSOLE_CLIENT_EVENTS.UNSUBSCRIBE);

            }

        } catch {

            // ignore

        }

        this._socket.disconnect();

        this._socket.removeAllListeners();

        this._state = createConsoleStoreState();

        this._notify();

    }

    _bindSocket() {

        if (this._bound) {

            return;

        }

        this._bound = true;

        this._socket.on("connect", () => {

            this._patchState({
                connectionState: CONSOLE_CONNECTION_STATES.CONNECTED,
                connected: true,
                socketId: this._socket.id
            });

            this._socket.emit(CONSOLE_CLIENT_EVENTS.SUBSCRIBE, {});

            if (this._state.focus.roomId || this._state.focus.gameId) {

                this._socket.emit(
                    CONSOLE_CLIENT_EVENTS.FOCUS,
                    this._state.focus
                );

            }

        });

        this._socket.on("disconnect", () => {

            this._patchState({
                connectionState: CONSOLE_CONNECTION_STATES.DISCONNECTED,
                connected: false,
                subscribed: false,
                socketId: null
            });

        });

        this._socket.on("reconnect_attempt", () => {

            this._setConnectionState(CONSOLE_CONNECTION_STATES.RECONNECTING);

        });

        this._socket.on("reconnect", () => {

            this._patchState({
                connectionState: CONSOLE_CONNECTION_STATES.CONNECTED,
                connected: true,
                socketId: this._socket.id
            });

        });

        this._socket.on("connect_error", () => {

            if (!this._socket.connected) {

                this._setConnectionState(
                    this._state.connectionState
                        === CONSOLE_CONNECTION_STATES.CONNECTED
                        ? CONSOLE_CONNECTION_STATES.RECONNECTING
                        : CONSOLE_CONNECTION_STATES.DISCONNECTED
                );

            }

        });

        this._socket.on(CONSOLE_SERVER_EVENTS.CONNECTED, (envelope) => {

            this._patchState({
                subscribed: true,
                lastEnvelopeAt: envelope?.sentAt ?? Date.now()
            });

        });

        this._bindProjection(
            CONSOLE_SERVER_EVENTS.SERVER,
            "server"
        );

        this._socket.on(CONSOLE_SERVER_EVENTS.ROOMS, (envelope) => {

            const rooms = envelope?.payload ?? null;
            const previousRooms = this._state.rooms?.rooms ?? null;
            const timelineDelta = rooms
                ? diffRoomsTimeline(previousRooms, rooms.rooms ?? [])
                : [];

            this._patchState({
                rooms,
                timeline: appendTimelineEntries(
                    this._state.timeline,
                    timelineDelta
                ),
                lastEnvelopeAt: envelope?.sentAt ?? Date.now()
            });

        });

        this._bindProjection(
            CONSOLE_SERVER_EVENTS.ROOM,
            "room"
        );

        this._bindProjection(
            CONSOLE_SERVER_EVENTS.GAME,
            "game"
        );

        this._bindProjection(
            CONSOLE_SERVER_EVENTS.PLAYERS,
            "players"
        );

        this._bindProjection(
            CONSOLE_SERVER_EVENTS.PAYMENTS,
            "payments"
        );

        this._bindProjection(
            CONSOLE_SERVER_EVENTS.RECOVERY,
            "recovery"
        );

        this._bindProjection(
            CONSOLE_SERVER_EVENTS.SIMULATION,
            "simulation"
        );

        this._bindProjection(
            CONSOLE_SERVER_EVENTS.METRICS,
            "metrics"
        );

        this._socket.on(CONSOLE_SERVER_EVENTS.LOG, (envelope) => {

            const entry = envelope?.payload;

            if (!entry) {

                return;

            }

            const normalized = Object.freeze({
                ...entry,
                source: entry.source ?? "DeveloperConsoleGateway",
                level: entry.level ?? "info"
            });

            this._patchState({
                logs: appendConsoleLog(this._state.logs, normalized),
                lastEnvelopeAt: envelope.sentAt ?? Date.now()
            });

        });

    }

    _unbindSocket() {

        if (!this._bound) {

            return;

        }

        this._socket.removeAllListeners();

        this._bound = false;

    }

    _bindProjection(eventName, stateKey) {

        this._socket.on(eventName, (envelope) => {

            this._patchState({
                [stateKey]: envelope?.payload ?? null,
                lastEnvelopeAt: envelope?.sentAt ?? Date.now()
            });

        });

    }

    _setConnectionState(connectionState) {

        this._patchState({
            connectionState,
            connected: connectionState === CONSOLE_CONNECTION_STATES.CONNECTED
        });

    }

    _patchState(patch) {

        this._state = {
            ...this._state,
            ...patch
        };

        this._notify();

    }

    _notify() {

        if (typeof this._onStateChange === "function") {

            this._onStateChange(this._state);

        }

    }

}
