import { EngineBridge } from "./EngineBridge.js";
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
        id: "socket_lifetime_test",
        connected: true,
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

            this.connected = false;

        },
        // Simulate the server pushing a message down the shared channel.
        _serverEmit(channel, message) {

            const handler = listeners.get(channel);

            assert(
                typeof handler === "function",
                `no listener bound for channel ${channel}`
            );

            handler(message);

        }
    };

}

const AUTHORITATIVE_SEQUENCE = [
    "READY",
    "COUNTDOWN",
    "SELF_TEST",
    "SPEED",
    "BRAKE",
    "RESULT"
];

// ---------------------------------------------------------------------------
// The subscription is created BEFORE the consuming module registers (mirrors
// hoisting the SocketSyncLayer to the flow root, while the gameState module
// registers as its provider mounts). No authoritative GAME_STATE packet may be
// lost, reordered, or duplicated regardless of that ordering.
// ---------------------------------------------------------------------------

{

    const socket = createFakeSocket();

    const bridge = new EngineBridge();

    // 1. Subscription layer is bound first — before any consumer exists.
    const layer = new SocketSyncLayer(socket, {
        engineBridge: bridge,
        devMode: false
    });

    layer.connect();

    assert(
        typeof socket.io === "object",
        "layer should have bound socket listeners on connect"
    );

    // 2. The gameState module registers later (as its React provider mounts).
    const received = [];

    bridge.register("gameState", {
        onGameState: (payload) => {

            received.push(payload?.state ?? payload);

        }
    });

    // 3. Server pushes the complete authoritative sequence down the channel.
    for (const state of AUTHORITATIVE_SEQUENCE) {

        socket._serverEmit(SOCKET_MESSAGE_CHANNEL, {
            type: INCOMING_SOCKET_EVENTS.GAME_STATE,
            payload: { state }
        });

    }

    assert(
        received.length === AUTHORITATIVE_SEQUENCE.length,
        `expected ${AUTHORITATIVE_SEQUENCE.length} GAME_STATE packets, got ${received.length}`
    );

    assert(
        received.join(",") === AUTHORITATIVE_SEQUENCE.join(","),
        `sequence mismatch: got ${received.join(",")}`
    );

    // No duplicates: every state appears exactly once.
    const unique = new Set(received);

    assert(
        unique.size === received.length,
        "no GAME_STATE transition may be duplicated"
    );

    console.log("  lifetime: full ordered sequence delivered to late-registered module passed");

}

// ---------------------------------------------------------------------------
// The very first authoritative packet (COUNTDOWN — the one previously lost to
// the navigation race) must reach a consumer that is already registered when
// gameplay begins. This proves the subscription lifetime is independent of the
// page that eventually renders the state.
// ---------------------------------------------------------------------------

{

    const socket = createFakeSocket();

    const bridge = new EngineBridge();

    const received = [];

    bridge.register("gameState", {
        onGameState: (payload) => {

            received.push(payload?.state ?? payload);

        }
    });

    const layer = new SocketSyncLayer(socket, {
        engineBridge: bridge,
        devMode: false
    });

    layer.connect();

    socket._serverEmit(SOCKET_MESSAGE_CHANNEL, {
        type: INCOMING_SOCKET_EVENTS.GAME_STATE,
        payload: { state: "COUNTDOWN", previousState: "READY" }
    });

    assert(
        received.length === 1 && received[0] === "COUNTDOWN",
        "first authoritative COUNTDOWN packet must not be lost"
    );

    console.log("  lifetime: first COUNTDOWN packet delivered (no navigation race) passed");

}

console.log("subscriptionLifetime.test.js: all assertions passed");
