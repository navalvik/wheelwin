import assert from "node:assert/strict";

import { DeveloperConsoleGateway } from "../console/DeveloperConsoleGateway.js";
import { CONSOLE_CLIENT_EVENTS, CONSOLE_SERVER_EVENTS, CONSOLE_UPDATE_POLICY } from "../console/consoleProtocol.js";

const namespaceHandlers = new Map();
const namespace = {
    on(event, handler) { namespaceHandlers.set(event, handler); },
    off(event) { namespaceHandlers.delete(event); },
    use() {}
};
const io = { of(name) { assert.equal(name, "/console"); return namespace; } };

const emitted = [];
const socketHandlers = new Map();
let socketEmitShouldThrowOnLog = false;
let socketEmitShouldThrowOnConnected = false;
const socket = {
    id: "testnet-console-test",
    connected: true,
    data: {},
    on(event, handler) { socketHandlers.set(event, handler); },
    emit(event, envelope) {
        if (socketEmitShouldThrowOnConnected && event === CONSOLE_SERVER_EVENTS.CONNECTED) {
            throw new Error("simulated connected acknowledgement failure");
        }
        if (socketEmitShouldThrowOnLog && event === CONSOLE_SERVER_EVENTS.LOG) {
            throw new Error("simulated socket log emit failure");
        }
        emitted.push({ event, envelope });
    },
    disconnect() { this.connected = false; }
};

let focusProjectionShouldThrow = false;

const projectionService = {
    buildServerOverview: () => ({ ok: true }),
    buildRoomsIndex: () => ({ rooms: [] }),
    buildPlayersIndex: () => ({ players: [] }),
    buildPaymentsOverview() { throw new Error("simulated payment projection failure"); },
    buildRecoveryOverview: () => ({ pending: 0 }),
    buildSimulationOverview: () => ({ active: 0 }),
    buildMetricsOverview: () => ({ ok: true }),
    buildRoomDetail() {
        if (focusProjectionShouldThrow) throw new Error("simulated focus projection failure");
        return null;
    },
    buildGameDetail: () => null
};

assert.equal(CONSOLE_UPDATE_POLICY.FOCUS_HIGH_FREQUENCY_MS, 1000, "focused room/game projections refresh no faster than once per second");

const gateway = new DeveloperConsoleGateway({
    logger: null,
    io,
    projectionService,
    authService: { isEnabled: () => false },
    loggingManager: null
});

gateway.initialize();
namespaceHandlers.get("connection")(socket);
socketHandlers.get(CONSOLE_CLIENT_EVENTS.SUBSCRIBE)();

const eventNames = emitted.map((entry) => entry.event);
assert.ok(eventNames.includes(CONSOLE_SERVER_EVENTS.CONNECTED), "connected acknowledgement emitted");
assert.ok(eventNames.includes(CONSOLE_SERVER_EVENTS.SERVER), "server projection still emitted");
assert.ok(eventNames.includes(CONSOLE_SERVER_EVENTS.ROOMS), "rooms projection still emitted");
assert.ok(eventNames.includes(CONSOLE_SERVER_EVENTS.PLAYERS), "players projection still emitted");
assert.ok(eventNames.includes(CONSOLE_SERVER_EVENTS.RECOVERY), "recovery projection still emitted");
assert.ok(eventNames.includes(CONSOLE_SERVER_EVENTS.METRICS), "metrics projection still emitted");
assert.ok(
    emitted.some(({ event, envelope }) =>
        event === CONSOLE_SERVER_EVENTS.LOG
        && envelope.payload?.message?.includes("section=payments")
        && envelope.payload?.message?.includes("simulated payment projection failure")),
    "payment projection error is logged without aborting the subscription snapshot"
);

// Direct client focus events must also isolate projection failures.
focusProjectionShouldThrow = true;
assert.doesNotThrow(() => {
    socketHandlers.get(CONSOLE_CLIENT_EVENTS.FOCUS)({ roomId: "stale-room-id" });
}, "focus projection failure must not escape the Socket.IO event handler");
assert.ok(
    emitted.some(({ event, envelope }) =>
        event === CONSOLE_SERVER_EVENTS.LOG
        && envelope.payload?.message?.includes("section=focus")
        && envelope.payload?.message?.includes("simulated focus projection failure")),
    "focus projection failure is logged when log delivery works"
);

// If log delivery itself throws while reporting a projection failure, the
// gateway must record the secondary failure locally without recursive rebroadcast.
socketEmitShouldThrowOnLog = true;
assert.doesNotThrow(() => {
    socketHandlers.get(CONSOLE_CLIENT_EVENTS.FOCUS)({ roomId: "stale-room-id" });
}, "focus projection failure plus log emit failure must not escape or recurse");

// The SUBSCRIBE guard also covers failures before any projection is emitted.
socketEmitShouldThrowOnLog = false;
socketEmitShouldThrowOnConnected = true;
assert.doesNotThrow(() => {
    socketHandlers.get(CONSOLE_CLIENT_EVENTS.SUBSCRIBE)();
}, "CONNECTED acknowledgement failure must not escape the SUBSCRIBE handler");

gateway.shutdown();
console.log("developerConsoleGatewayProjectionIsolation.test.js: all passed");
