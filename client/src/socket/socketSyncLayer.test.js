import { SocketSyncLayer } from "./SocketSyncLayer.js";
import { INCOMING_SOCKET_EVENTS, SOCKET_MESSAGE_CHANNEL } from "./socketEvents.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

function createFakeSocket() {

    const listeners = new Map();

    const ioListeners = new Map();

    return {
        id: "socket_test",
        connected: true,
        disconnectCalls: 0,
        emitted: [],
        io: {
            on(event, handler) {

                ioListeners.set(event, handler);

            },
            off(event) {

                ioListeners.delete(event);

            }
        },
        on(event, handler) {

            listeners.set(event, handler);

        },
        off(event) {

            listeners.delete(event);

        },
        emit(channel, message) {

            this.emitted.push({ channel, message });

        },
        connect() {

            this.connected = true;

        },
        disconnect() {

            this.disconnectCalls += 1;

            this.connected = false;

        },
        _listenerCount() {

            return listeners.size + ioListeners.size;

        },
        _hasListener(event) {

            return listeners.has(event) || ioListeners.has(event);

        }
    };

}

// ---------------------------------------------------------------------------
// dispose() releases Page5 subscriptions but keeps the singleton socket active.
// ---------------------------------------------------------------------------

{

    const socket = createFakeSocket();

    const layer = new SocketSyncLayer(socket, { devMode: false });

    layer.connect();

    assert(
        socket._hasListener("connect")
        && socket._hasListener(SOCKET_MESSAGE_CHANNEL)
        && socket._hasListener("reconnect_attempt"),
        "connect() should bind gameplay socket listeners"
    );

    const boundCount = socket._listenerCount();

    assert(boundCount > 0, "listeners should be bound after connect");

    layer.dispose();

    assert(
        socket.disconnectCalls === 0,
        "dispose() must NOT disconnect the shared singleton socket"
    );

    assert(
        socket.connected === true,
        "socket must remain connected after Page5 disposal (no reconnect)"
    );

    assert(
        socket._listenerCount() === 0,
        "dispose() should release all Page5 socket subscriptions"
    );

    console.log("  dispose: keeps socket active, releases subscriptions passed");

}

// ---------------------------------------------------------------------------
// Explicit disconnect() still tears the socket down intentionally.
// ---------------------------------------------------------------------------

{

    const socket = createFakeSocket();

    const layer = new SocketSyncLayer(socket, { devMode: false });

    layer.connect();

    layer.disconnect();

    assert(
        socket.disconnectCalls === 1,
        "explicit disconnect() should disconnect the socket"
    );

    assert(
        socket.connected === false,
        "socket should be disconnected after explicit disconnect()"
    );

    console.log("  disconnect: explicit teardown still works passed");

}

// ---------------------------------------------------------------------------
// Incoming GAME_RESULT is routed to the winnerResolver module (client display),
// proving the authoritative result reaches the presentation layer via the bus.
// ---------------------------------------------------------------------------

{

    const socket = createFakeSocket();

    const received = [];

    const engineBridge = {
        createDispatcherHandlers() {

            return {
                [INCOMING_SOCKET_EVENTS.GAME_RESULT]: (payload) => {

                    received.push(payload);

                }
            };

        }
    };

    const layer = new SocketSyncLayer(socket, { engineBridge, devMode: false });

    layer.connect();

    const gameMessageHandler = socket;

    // Simulate the server emitting an authoritative GAME_RESULT.
    layer.dispatchLocal({
        type: INCOMING_SOCKET_EVENTS.GAME_RESULT,
        payload: {
            gameId: "game_1",
            winner: { id: "player_1", color: "#00f", icon: "star" },
            winningSector: { index: 0, sectorId: "sector_1" },
            finalWheelAngle: 42,
            serverTimestamp: 123
        }
    });

    void gameMessageHandler;

    assert(received.length === 1, "GAME_RESULT should be dispatched exactly once");

    assert(
        received[0].winner.id === "player_1",
        "dispatched GAME_RESULT should carry the authoritative winner"
    );

    console.log("  dispatch: GAME_RESULT routed to presentation passed");

}

// ---------------------------------------------------------------------------
// Incoming authoritative payment events are routed to the presentation layer.
// The client only displays them — it never settles or recalculates.
// ---------------------------------------------------------------------------

{

    const socket = createFakeSocket();

    const received = [];

    const engineBridge = {
        createDispatcherHandlers() {

            return {
                [INCOMING_SOCKET_EVENTS.PAYMENT_STARTED]: (payload) => {

                    received.push({ event: "STARTED", payload });

                },
                [INCOMING_SOCKET_EVENTS.PAYMENT_COMPLETED]: (payload) => {

                    received.push({ event: "COMPLETED", payload });

                },
                [INCOMING_SOCKET_EVENTS.PAYMENT_FAILED]: (payload) => {

                    received.push({ event: "FAILED", payload });

                }
            };

        }
    };

    const layer = new SocketSyncLayer(socket, { engineBridge, devMode: false });

    layer.connect();

    layer.dispatchLocal({
        type: INCOMING_SOCKET_EVENTS.PAYMENT_STARTED,
        payload: { gameId: "game_1", status: "STARTED" }
    });

    layer.dispatchLocal({
        type: INCOMING_SOCKET_EVENTS.PAYMENT_COMPLETED,
        payload: { gameId: "game_1", status: "COMPLETED", winnerAmount: 22.5 }
    });

    assert(
        received.length === 2,
        "payment events should be dispatched to the presentation layer"
    );

    assert(
        received[0].event === "STARTED" && received[1].event === "COMPLETED",
        "payment lifecycle should arrive in order (STARTED -> COMPLETED)"
    );

    assert(
        received[1].payload.winnerAmount === 22.5,
        "authoritative payout amount should reach the client for display"
    );

    console.log("  dispatch: payment events routed to presentation passed");

}

console.log("socketSyncLayer.test.js: all assertions passed");
