import { io } from "socket.io-client";

import { EVENT_TYPES } from "../events/EventTypes.js";
import { createLobbyIntegrationHarness } from "./helpers/lobbyIntegrationHarness.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

function waitFor(socket, eventName, timeoutMs = 8000) {

    return new Promise((resolve, reject) => {

        const timer = setTimeout(() => {

            reject(new Error(`Timed out waiting for ${eventName}`));

        }, timeoutMs);

        socket.once(eventName, (payload) => {

            clearTimeout(timer);

            resolve(payload);

        });

    });

}

function connectClient(port) {

    const socket = io(`http://127.0.0.1:${port}`, {
        transports: ["websocket"],
        forceNew: true
    });

    return waitFor(socket, "connect").then(() => socket);

}

const harness = await createLobbyIntegrationHarness();
const clients = [];

try {

    const host = await connectClient(harness.port);
    clients.push(host);

    const guestA = await connectClient(harness.port);
    clients.push(guestA);

    const guestB = await connectClient(harness.port);
    clients.push(guestB);

    host.emit("createRoom");

    const created = await waitFor(host, "roomCreated");

    guestA.emit("joinRoom", created.roomId);

    await waitFor(guestA, "roomJoined");

    const startPromises = [
        waitFor(host, "startGame"),
        waitFor(guestA, "startGame"),
        waitFor(guestB, "startGame")
    ];

    guestB.emit("joinRoom", created.roomId);

    await waitFor(guestB, "roomJoined");

    await Promise.all(startPromises);

    // Wait until gameplay prep is pending (SETUP_SESSION_COMPLETED path).
    let pending = null;

    for (let attempt = 0; attempt < 40; attempt += 1) {

        pending = harness.gameManager._pendingGameplayActivation
            .get(created.roomId);

        if (pending) {

            break;

        }

        await new Promise((resolve) => setTimeout(resolve, 50));

    }

    assert(pending, "DEBUG_START_GAME requires pending gameplay activation");

    const busEvents = [];

    harness.eventBus.subscribe(EVENT_TYPES.GAME_START_AUTHORIZED, (e) => {

        busEvents.push(e.type);

    });

    harness.eventBus.subscribe(EVENT_TYPES.GAME_INITIALIZED, (e) => {

        busEvents.push(e.type);

    });

    host.emit("DEBUG_START_GAME");

    await new Promise((resolve) => setTimeout(resolve, 100));

    assert(
        !busEvents.includes(EVENT_TYPES.GAME_START_AUTHORIZED),
        "DEBUG_START_GAME cannot bypass the payment gate"
    );

    assert(
        !busEvents.includes(EVENT_TYPES.GAME_INITIALIZED),
        "gameplay remains uninitialized while payment acceptance is disabled"
    );

    assert(
        harness.bootstrapEngines.gameClockEngine.isRunning(pending) === false,
        "GameClock remains stopped while payments are unavailable"
    );

    // Production guard: bridge rejects when not development.
    harness.roomLobbyBridge._isDevelopment = false;

    const paymentStageCount = busEvents.filter((type) =>
        type === EVENT_TYPES.GAME_START_AUTHORIZED).length;

    guestA.emit("DEBUG_START_GAME");

    await new Promise((resolve) => setTimeout(resolve, 100));

    assert(busEvents.filter((type) =>
        type === EVENT_TYPES.GAME_START_AUTHORIZED).length === paymentStageCount,
    "the development-only command does not create a gameplay authorization");

    console.log("debugStartGame.integration.test.js: all assertions passed");

} finally {

    for (const client of clients) {

        client.disconnect();

    }

    await harness.shutdown();

}
