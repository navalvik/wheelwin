import assert from "node:assert/strict";

import { DeveloperConsoleGateway } from "../console/DeveloperConsoleGateway.js";
import { CONSOLE_CLIENT_EVENTS, CONSOLE_SERVER_EVENTS } from "../console/consoleProtocol.js";

const namespaceHandlers = new Map();
const namespace = {
    on(event, handler) { namespaceHandlers.set(event, handler); },
    off(event) { namespaceHandlers.delete(event); },
    use() {}
};
const io = { of(name) { assert.equal(name, "/console"); return namespace; } };

const emitted = [];
const socketHandlers = new Map();
const socket = {
    id: "testnet-console-test",
    connected: true,
    data: {},
    on(event, handler) { socketHandlers.set(event, handler); },
    emit(event, envelope) { emitted.push({ event, envelope }); },
    disconnect() { this.connected = false; }
};

const projectionService = {
    buildServerOverview: () => ({ ok: true }),
    buildRoomsIndex: () => ({ rooms: [] }),
    buildPlayersIndex: () => ({ players: [] }),
    buildPaymentsOverview() { throw new Error("simulated payment projection failure"); },
    buildRecoveryOverview: () => ({ pending: 0 }),
    buildSimulationOverview: () => ({ active: 0 }),
    buildMetricsOverview: () => ({ ok: true }),
    buildRoomDetail: () => null,
    buildGameDetail: () => null
};

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

gateway.shutdown();
console.log("developerConsoleGatewayProjectionIsolation.test.js: all passed");
