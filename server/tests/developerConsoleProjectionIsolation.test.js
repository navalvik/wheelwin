import assert from "node:assert/strict";

import { DeveloperConsoleGateway } from "../console/DeveloperConsoleGateway.js";
import { CONSOLE_SERVER_EVENTS } from "../console/consoleProtocol.js";

function createGateway(projectionService) {
    const gateway = Object.create(DeveloperConsoleGateway.prototype);
    gateway._projectionService = projectionService;
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

process.stdout.write("developerConsoleProjectionIsolation.test.js passed\n");
