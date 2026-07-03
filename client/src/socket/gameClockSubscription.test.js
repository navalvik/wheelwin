import { EngineBridge } from "./EngineBridge.js";
import { SocketSyncLayer } from "./SocketSyncLayer.js";
import { INCOMING_SOCKET_EVENTS, SOCKET_MESSAGE_CHANNEL } from "./socketEvents.js";
import {
    INITIAL_GAME_CLOCK,
    formatClockSeconds,
    reduceGameClockUpdate,
    resolveClockPhaseLabel
} from "../game/gameClock/gameClockView.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

function createFakeSocket() {

    const listeners = new Map();

    return {
        id: "socket_clock_test",
        connected: true,
        emitted: [],
        io: {
            on() {},
            off() {}
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

// ---------------------------------------------------------------------------
// The clock view stores authoritative values verbatim and performs no timing
// calculation. remainingSeconds is taken as-is from the server payload.
// ---------------------------------------------------------------------------

{

    const state = reduceGameClockUpdate({
        gameId: "game_1",
        phase: "COUNTDOWN",
        remainingMs: 2400,
        remainingSeconds: 3,
        running: true,
        serverTimestamp: 111
    });

    assert(state.phase === "COUNTDOWN", "phase should be stored verbatim");

    assert(
        state.remainingSeconds === 3,
        "remainingSeconds must be taken from the server, not computed"
    );

    assert(state.active === true, "running clock with a phase should be active");

    assert(
        reduceGameClockUpdate(null) === INITIAL_GAME_CLOCK,
        "null payload resets to the initial (idle) clock"
    );

    const idle = reduceGameClockUpdate({
        gameId: "game_1",
        phase: "SPEED",
        remainingMs: null,
        remainingSeconds: null,
        running: false
    });

    assert(idle.active === false, "a stopped clock is never active");

    assert(
        formatClockSeconds(3) === "00:03",
        "formatter renders server seconds only"
    );

    assert(
        formatClockSeconds(null) === "--:--",
        "open-ended phases (no remaining) render a placeholder"
    );

    assert(
        resolveClockPhaseLabel("SPEED") === "SPINNING",
        "phase label maps to display text"
    );

    console.log("  clock view: stores authoritative values, no client calculation passed");

}

// ---------------------------------------------------------------------------
// GAME_CLOCK_UPDATE is routed to a gameClock module that registers AFTER the
// subscription layer is bound (mirrors the hoisted, session-wide subscription).
// ---------------------------------------------------------------------------

{

    const socket = createFakeSocket();

    const bridge = new EngineBridge();

    const layer = new SocketSyncLayer(socket, {
        engineBridge: bridge,
        devMode: false
    });

    layer.connect();

    const received = [];

    bridge.register("gameClock", {
        onClockUpdate: (payload) => {

            received.push(reduceGameClockUpdate(payload));

        }
    });

    const frames = [
        { phase: "COUNTDOWN", remainingSeconds: 3, running: true },
        { phase: "COUNTDOWN", remainingSeconds: 2, running: true },
        { phase: "COUNTDOWN", remainingSeconds: 1, running: true },
        { phase: "SPEED", remainingSeconds: null, running: true },
        { phase: "RESULT", remainingSeconds: null, running: false }
    ];

    for (const frame of frames) {

        socket._serverEmit(SOCKET_MESSAGE_CHANNEL, {
            type: INCOMING_SOCKET_EVENTS.GAME_CLOCK_UPDATE,
            payload: { gameId: "game_1", ...frame }
        });

    }

    assert(
        received.length === frames.length,
        `expected ${frames.length} clock frames, got ${received.length}`
    );

    assert(
        received.map((c) => c.remainingSeconds).join(",") === "3,2,1,,",
        "clock frames must arrive in authoritative order"
    );

    assert(
        received[received.length - 1].active === false,
        "final RESULT frame is not active — gameplay timer disappears naturally"
    );

    console.log("  clock routing: GAME_CLOCK_UPDATE delivered to late-registered module passed");

}

// ---------------------------------------------------------------------------
// Three independent clients that receive the SAME authoritative packet render
// identical values. Because the client never calculates time, there can be no
// per-client drift.
// ---------------------------------------------------------------------------

{

    const packet = {
        type: INCOMING_SOCKET_EVENTS.GAME_CLOCK_UPDATE,
        payload: {
            gameId: "game_1",
            phase: "BRAKE",
            remainingMs: 1200,
            remainingSeconds: 2,
            running: true
        }
    };

    const renders = [];

    for (let i = 0; i < 3; i += 1) {

        const socket = createFakeSocket();

        const bridge = new EngineBridge();

        const layer = new SocketSyncLayer(socket, {
            engineBridge: bridge,
            devMode: false
        });

        layer.connect();

        let view = null;

        bridge.register("gameClock", {
            onClockUpdate: (payload) => {

                const clock = reduceGameClockUpdate(payload);

                view = {
                    phaseLabel: resolveClockPhaseLabel(clock.phase),
                    remainingText: formatClockSeconds(clock.remainingSeconds)
                };

            }
        });

        socket._serverEmit(SOCKET_MESSAGE_CHANNEL, packet);

        renders.push(view);

    }

    const [first] = renders;

    for (const render of renders) {

        assert(
            render.phaseLabel === first.phaseLabel
            && render.remainingText === first.remainingText,
            "all clients must render an identical authoritative clock"
        );

    }

    assert(
        first.remainingText === "00:02" && first.phaseLabel === "BRAKING",
        "rendered clock must reflect the authoritative packet exactly"
    );

    console.log("  clock sync: three clients render identical authoritative time passed");

}

console.log("gameClockSubscription.test.js: all assertions passed");
