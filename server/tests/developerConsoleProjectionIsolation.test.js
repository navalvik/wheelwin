import assert from "node:assert/strict";

import { DeveloperConsoleGateway } from "../console/DeveloperConsoleGateway.js";
import { CONSOLE_SERVER_EVENTS } from "../console/consoleProtocol.js";
import { registerDeveloperConsoleRoutes } from "../console/registerDeveloperConsoleRoutes.js";

function createGateway(projectionService) {
    const gateway = Object.create(DeveloperConsoleGateway.prototype);
    gateway._projectionService = projectionService;
    gateway._clients = new Map();
    gateway._logBuffer = [];
    gateway._appendLog = (level, message) => {
        gateway._logBuffer.push({ level, message });
    };
    gateway._emit = (socket, type, payload) => {
        gateway._lastEmission = { socket, type, payload };
    };
    return gateway;
}

{
    const gateway = createGateway({});
    const client = { socket: { connected: true } };

    assert.doesNotThrow(() => gateway._safePush(client, "_pushPayments"));
    assert.equal(gateway._lastEmission.type, CONSOLE_SERVER_EVENTS.PAYMENTS);
    assert.equal(gateway._lastEmission.payload.status, "UNAVAILABLE");
    assert.equal("network" in gateway._lastEmission.payload, false);
    assert.equal("globalId" in gateway._lastEmission.payload, false);
}

{
    const gateway = createGateway({
        buildPaymentsOverview() {
            throw new Error("legacy projection unavailable");
        }
    });
    const client = { socket: { connected: true } };

    assert.doesNotThrow(() => gateway._safePush(client, "_pushPayments"));
    assert.equal(gateway._lastEmission.type, CONSOLE_SERVER_EVENTS.PAYMENTS);
    assert.equal(gateway._lastEmission.payload.status, "UNAVAILABLE");
}

{
    const gateway = createGateway({});
    const client = { socket: { connected: true } };
    let laterProjectionRan = false;

    gateway._pushBrokenProjection = () => {
        throw new Error("projection failure");
    };
    gateway._pushHealthyProjection = () => {
        laterProjectionRan = true;
    };

    assert.doesNotThrow(() => gateway._safePush(client, "_pushBrokenProjection"));
    gateway._safePush(client, "_pushHealthyProjection");

    assert.equal(laterProjectionRan, true);
    assert.equal(gateway._logBuffer.length, 1);
    assert.match(gateway._logBuffer[0].message, /projection failure/);
}


{
    const gateway = createGateway({
        buildServerOverview() { throw new Error("server projection failure"); },
        buildRoomsIndex() { throw new Error("rooms projection failure"); },
        buildPlayersIndex() { throw new Error("players projection failure"); },
        buildPaymentsOverview() { throw new Error("payments projection failure"); },
        buildRecoveryOverview() { throw new Error("recovery projection failure"); },
        buildSimulationOverview() { throw new Error("simulation projection failure"); },
        buildMetricsOverview() { throw new Error("metrics projection failure"); }
    });
    const client = {
        subscribed: false,
        focus: { roomId: null, gameId: null },
        socket: { id: "test-console", connected: true, data: {}, emit() {} }
    };

    assert.doesNotThrow(() => gateway._onSubscribe(client));
    assert.equal(client.subscribed, true);
    assert.ok(gateway._logBuffer.some((entry) =>
        entry.message.includes("Console subscribed test-console")
    ));
}


{
    const routes = new Map();
    const app = {
        use() {},
        get(path, handler) { routes.set(path, handler); },
        put() {},
        post() {}
    };
    registerDeveloperConsoleRoutes(app, {});
    const handler = routes.get("/console/payments");
    assert.equal(typeof handler, "function");

    const response = {
        statusCode: 200,
        payload: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.payload = payload; return this; }
    };

    handler({}, response);
    assert.equal(response.statusCode, 503);
    assert.equal(response.payload.status, "UNAVAILABLE");
}

{
    const routes = new Map();
    const app = {
        use() {},
        get(path, handler) { routes.set(path, handler); },
        put() {},
        post() {}
    };
    registerDeveloperConsoleRoutes(app, {
        buildPaymentsOverview() {
            throw new Error("payment overview failed");
        }
    });
    const handler = routes.get("/console/payments");
    const response = {
        statusCode: 200,
        payload: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.payload = payload; return this; }
    };

    handler({}, response);
    assert.equal(response.statusCode, 503);
    assert.equal(response.payload.status, "UNAVAILABLE");
}

process.stdout.write("developerConsoleProjectionIsolation.test.js passed\n");
