import { EVENT_TYPES } from "../events/EventTypes.js";
import {
    CONSOLE_CLIENT_EVENTS,
    CONSOLE_NAMESPACE,
    CONSOLE_SERVER_EVENTS,
    CONSOLE_UPDATE_POLICY,
    buildConsoleEnvelope
} from "./consoleProtocol.js";

/**
 * R6.0D — Live Gateway for the WheelWin Developer Console.
 *
 * - owns Socket.IO namespace `/console` only
 * - never reads managers directly
 * - never computes projections (uses DeveloperConsoleProjectionService)
 * - never mutates gameplay
 * - never joins gameplay rooms / never emits gameplay events
 *
 * Connection session metadata (subscriptions / focus) is tracked per socket
 * for push routing only — not authoritative game state.
 */
export class DeveloperConsoleGateway {

    constructor({
        logger,
        io,
        projectionService,
        eventBus = null
    }) {

        this._logger = logger;

        this._io = io;

        this._projectionService = projectionService;

        this._eventBus = eventBus;

        this._nsp = null;

        this._clients = new Map();

        this._timers = [];

        this._eventHandlers = [];

        this._roomsPushTimer = null;

        this._logBuffer = [];

        this._initialized = false;

        this._connectionHandler = null;

    }

    initialize() {

        if (this._initialized) {

            return this._nsp;

        }

        if (!this._io) {

            throw new Error("DeveloperConsoleGateway requires Socket.IO server");

        }

        if (!this._projectionService) {

            throw new Error(
                "DeveloperConsoleGateway requires DeveloperConsoleProjectionService"
            );

        }

        this._nsp = this._io.of(CONSOLE_NAMESPACE);

        this._connectionHandler = (socket) => {

            this._handleConnection(socket);

        };

        this._nsp.on("connection", this._connectionHandler);

        this._startTimers();

        this._subscribeEventBus();

        this._initialized = true;

        this._appendLog("info", "DeveloperConsoleGateway ready on /console");

        return this._nsp;

    }

    shutdown() {

        if (!this._initialized) {

            return;

        }

        this._clearTimers();

        this._unsubscribeEventBus();

        if (this._nsp && this._connectionHandler) {

            this._nsp.off("connection", this._connectionHandler);

        }

        for (const [socketId, client] of this._clients) {

            try {

                client.socket.disconnect(true);

            } catch {

                // ignore

            }

            this._clients.delete(socketId);

        }

        this._nsp = null;

        this._connectionHandler = null;

        this._initialized = false;

    }

    getConnectedConsoleCount() {

        return this._clients.size;

    }

    _handleConnection(socket) {

        const client = {
            socket,
            subscribed: false,
            focus: Object.freeze({ roomId: null, gameId: null })
        };

        this._clients.set(socket.id, client);

        this._appendLog("info", `Console socket connected ${socket.id}`);

        socket.on(CONSOLE_CLIENT_EVENTS.SUBSCRIBE, (payload) => {

            this._onSubscribe(client, payload);

        });

        socket.on(CONSOLE_CLIENT_EVENTS.FOCUS, (payload) => {

            this._onFocus(client, payload);

        });

        socket.on(CONSOLE_CLIENT_EVENTS.UNSUBSCRIBE, () => {

            client.subscribed = false;

            client.focus = Object.freeze({ roomId: null, gameId: null });

        });

        socket.on("disconnect", () => {

            this._clients.delete(socket.id);

            this._appendLog("info", `Console socket disconnected ${socket.id}`);

        });

    }

    _onSubscribe(client) {

        client.subscribed = true;

        this._emit(
            client.socket,
            CONSOLE_SERVER_EVENTS.CONNECTED,
            Object.freeze({
                namespace: CONSOLE_NAMESPACE,
                socketId: client.socket.id,
                updatePolicy: CONSOLE_UPDATE_POLICY,
                authentication: "none"
            })
        );

        // Initial snapshot — one projection per message type.
        this._pushServer(client);
        this._pushRooms(client);
        this._pushPlayers(client);
        this._pushPayments(client);
        this._pushRecovery(client);
        this._pushSimulation(client);
        this._pushMetrics(client);
        this._pushFocus(client);
        this._pushLogBuffer(client);

        this._appendLog("info", `Console subscribed ${client.socket.id}`);

    }

    _onFocus(client, payload) {

        if (!client.subscribed) {

            return;

        }

        const roomId = typeof payload?.roomId === "string" && payload.roomId
            ? payload.roomId
            : null;

        const gameId = typeof payload?.gameId === "string" && payload.gameId
            ? payload.gameId
            : null;

        client.focus = Object.freeze({ roomId, gameId });

        this._pushFocus(client);

    }

    _startTimers() {

        this._timers.push(setInterval(() => {

            this._forSubscribed((client) => this._pushServer(client));

        }, CONSOLE_UPDATE_POLICY.SERVER_MS));

        this._timers.push(setInterval(() => {

            this._forSubscribed((client) => this._pushMetrics(client));

        }, CONSOLE_UPDATE_POLICY.METRICS_MS));

        this._timers.push(setInterval(() => {

            this._forSubscribed((client) => {

                this._pushRooms(client);
                this._pushPlayers(client);
                this._pushPayments(client);
                this._pushRecovery(client);
                this._pushSimulation(client);

            });

        }, CONSOLE_UPDATE_POLICY.LOW_FREQUENCY_MS));

        this._timers.push(setInterval(() => {

            this._forSubscribed((client) => this._pushFocus(client));

        }, CONSOLE_UPDATE_POLICY.FOCUS_HIGH_FREQUENCY_MS));

    }

    _clearTimers() {

        for (const timer of this._timers) {

            clearInterval(timer);

        }

        this._timers = [];

        if (this._roomsPushTimer) {

            clearTimeout(this._roomsPushTimer);

            this._roomsPushTimer = null;

        }

    }

    _subscribeEventBus() {

        if (!this._eventBus) {

            return;

        }

        const roomEvents = [
            EVENT_TYPES.ROOM_CREATED,
            EVENT_TYPES.ROOM_FULL,
            EVENT_TYPES.ROOM_LOCKED,
            EVENT_TYPES.ROOM_DESTROYED,
            EVENT_TYPES.PLAYER_JOINED,
            EVENT_TYPES.PLAYER_LEFT,
            EVENT_TYPES.GAME_CREATED,
            EVENT_TYPES.GAME_DESTROYED
        ];

        for (const event of roomEvents) {

            const handler = () => {

                this._scheduleRoomsPush();

            };

            this._eventBus.subscribe(event, handler);

            this._eventHandlers.push({ event, handler });

        }

    }

    _unsubscribeEventBus() {

        if (!this._eventBus) {

            this._eventHandlers = [];

            return;

        }

        for (const { event, handler } of this._eventHandlers) {

            this._eventBus.unsubscribe(event, handler);

        }

        this._eventHandlers = [];

    }

    _scheduleRoomsPush() {

        if (this._roomsPushTimer) {

            return;

        }

        this._roomsPushTimer = setTimeout(() => {

            this._roomsPushTimer = null;

            this._forSubscribed((client) => this._pushRooms(client));

        }, CONSOLE_UPDATE_POLICY.ROOMS_DEBOUNCE_MS);

    }

    _forSubscribed(fn) {

        for (const client of this._clients.values()) {

            if (client.subscribed && client.socket.connected) {

                fn(client);

            }

        }

    }

    _pushServer(client) {

        this._emit(
            client.socket,
            CONSOLE_SERVER_EVENTS.SERVER,
            this._projectionService.buildServerOverview()
        );

    }

    _pushRooms(client) {

        this._emit(
            client.socket,
            CONSOLE_SERVER_EVENTS.ROOMS,
            this._projectionService.buildRoomsIndex()
        );

    }

    _pushPlayers(client) {

        this._emit(
            client.socket,
            CONSOLE_SERVER_EVENTS.PLAYERS,
            this._projectionService.buildPlayersIndex()
        );

    }

    _pushPayments(client) {

        this._emit(
            client.socket,
            CONSOLE_SERVER_EVENTS.PAYMENTS,
            this._projectionService.buildPaymentsOverview()
        );

    }

    _pushRecovery(client) {

        this._emit(
            client.socket,
            CONSOLE_SERVER_EVENTS.RECOVERY,
            this._projectionService.buildRecoveryOverview()
        );

    }

    _pushSimulation(client) {

        this._emit(
            client.socket,
            CONSOLE_SERVER_EVENTS.SIMULATION,
            this._projectionService.buildSimulationOverview()
        );

    }

    _pushMetrics(client) {

        this._emit(
            client.socket,
            CONSOLE_SERVER_EVENTS.METRICS,
            this._projectionService.buildMetricsOverview()
        );

    }

    _pushFocus(client) {

        const { roomId, gameId } = client.focus ?? {};

        if (roomId) {

            const room = this._projectionService.buildRoomDetail(roomId);

            if (room) {

                this._emit(client.socket, CONSOLE_SERVER_EVENTS.ROOM, room);

            }

        }

        if (gameId) {

            const game = this._projectionService.buildGameDetail(gameId);

            if (game) {

                this._emit(client.socket, CONSOLE_SERVER_EVENTS.GAME, game);

            }

        }

    }

    _pushLogBuffer(client) {

        for (const entry of this._logBuffer) {

            this._emit(client.socket, CONSOLE_SERVER_EVENTS.LOG, entry);

        }

    }

    _appendLog(level, message) {

        const entry = Object.freeze({
            level,
            message,
            at: Date.now()
        });

        this._logBuffer.push(entry);

        if (this._logBuffer.length > CONSOLE_UPDATE_POLICY.LOG_BUFFER_SIZE) {

            this._logBuffer.splice(
                0,
                this._logBuffer.length - CONSOLE_UPDATE_POLICY.LOG_BUFFER_SIZE
            );

        }

        this._forSubscribed((client) => {

            this._emit(client.socket, CONSOLE_SERVER_EVENTS.LOG, entry);

        });

    }

    _emit(socket, type, payload) {

        if (!socket?.connected) {

            return;

        }

        socket.emit(type, buildConsoleEnvelope(type, payload));

    }

}
