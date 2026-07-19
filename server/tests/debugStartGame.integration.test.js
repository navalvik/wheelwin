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

try {

    const host = await connectClient(harness.port);

    const guestA = await connectClient(harness.port);

    const guestB = await connectClient(harness.port);

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

    const openHost = waitFor(host, "OPEN_PAGE5", 5000);

    const openA = waitFor(guestA, "OPEN_PAGE5", 5000);

    const openB = waitFor(guestB, "OPEN_PAGE5", 5000);

    const timerHost = waitFor(host, "GAMEPLAY_TIMER_STARTED", 5000);

    const busEvents = [];

    harness.eventBus.subscribe(EVENT_TYPES.ENTRY_PAYMENT_COMPLETED, (e) => {

        busEvents.push(e.type);

    });

    harness.eventBus.subscribe(EVENT_TYPES.GAME_INITIALIZED, (e) => {

        busEvents.push(e.type);

    });

    host.emit("DEBUG_START_GAME");

    const [openPayloadHost, openPayloadA, openPayloadB, timerPayload] =
        await Promise.all([openHost, openA, openB, timerHost]);

    assert(
        openPayloadHost.roomId === created.roomId
            && openPayloadA.roomId === created.roomId
            && openPayloadB.roomId === created.roomId,
        "OPEN_PAGE5 must reach every client with roomId"
    );

    assert(
        busEvents.includes(EVENT_TYPES.ENTRY_PAYMENT_COMPLETED),
        "DEBUG_START_GAME must reuse ENTRY_PAYMENT_COMPLETED"
    );

    assert(
        busEvents.includes(EVENT_TYPES.GAME_INITIALIZED),
        "DEBUG_START_GAME must trigger GAME_INITIALIZED"
    );

    assert(
        Number.isFinite(timerPayload.expiresAt),
        "GameplayTimer must start with expiresAt"
    );

    assert(
        harness.bootstrapEngines.gameClockEngine.isRunning(pending),
        "GameClock must be running after DEBUG_START_GAME"
    );

    const simulation = harness.bootstrapEngines.physicsEngine
        .getSimulation(pending);

    assert(simulation, "physics simulation must exist after DEBUG_START_GAME");

    // Production guard: bridge rejects when not development.
    harness.roomLobbyBridge._isDevelopment = false;

    const rejectedBefore = harness.roomLobbyBridge
        ._entryPaymentCompletedByRoom.has(created.roomId);

    guestA.emit("DEBUG_START_GAME");

    await new Promise((resolve) => setTimeout(resolve, 100));

    assert(
        rejectedBefore === true,
        "toggling isDevelopment off must not clear completed state"
    );

    console.log("debugStartGame.integration.test.js: all assertions passed");

} finally {

    await harness.shutdown();

}
