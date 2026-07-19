import { io } from "socket.io-client";

import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import { PHYSICS_UPDATE_MESSAGE_TYPE } from "../socket/gameplayPhysicsProtocol.js";
import { GAME_MESSAGE_CHANNEL } from "../socket/events.js";
import { createGameplaySocketHarness } from "./helpers/gameplaySocketHarness.js";
import { emitEntryPaymentCompleted } from "./helpers/gameplayBootstrapHarness.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

function wait(ms) {

    return new Promise((resolve) => setTimeout(resolve, ms));

}

function connectClient(port) {

    const socket = io(`http://127.0.0.1:${port}`, {
        transports: ["websocket"],
        forceNew: true
    });

    return new Promise((resolve, reject) => {

        const timer = setTimeout(() => {

            reject(new Error("Client connection timed out"));

        }, 5000);

        socket.on("connect", () => {

            clearTimeout(timer);

            resolve(socket);

        });

        socket.on("connect_error", (error) => {

            clearTimeout(timer);

            reject(error);

        });

    });

}

function waitForEvent(socket, eventName, timeoutMs = 5000) {

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

async function startGameplaySession(harness) {

    const host = await connectClient(harness.port);

    host.emit("createRoom");

    const created = await waitForEvent(host, "roomCreated");

    const guestA = await connectClient(harness.port);

    guestA.emit("joinRoom", created.roomId);

    await waitForEvent(guestA, "roomJoined");

    const guestB = await connectClient(harness.port);

    const guestBJoinedPromise = waitForEvent(guestB, "roomJoined");

    const startHostPromise = waitForEvent(host, "startGame");

    const startGuestAPromise = waitForEvent(guestA, "startGame");

    const startGuestBPromise = waitForEvent(guestB, "startGame");

    guestB.emit("joinRoom", created.roomId);

    await guestBJoinedPromise;

    await Promise.all([
        startHostPromise,
        startGuestAPromise,
        startGuestBPromise
    ]);

    emitEntryPaymentCompleted(harness.eventBus, created.roomId);

    const games = harness.gameManager.getGames();

    assert(games.length === 1, "gameplay session should create one game");

    return {
        host,
        guestA,
        guestB,
        created,
        gameId: games[0].gameId
    };

}

function collectPhysicsUpdates(socket) {

    const updates = [];

    const handler = (message) => {

        if (message?.type === PHYSICS_UPDATE_MESSAGE_TYPE) {

            updates.push(message.payload);

        }

    };

    socket.on(GAME_MESSAGE_CHANNEL, handler);

    return {
        updates,
        stop() {

            socket.off(GAME_MESSAGE_CHANNEL, handler);

        }
    };

}

function waitForPhysicsUpdates(updates, minCount, timeoutMs = 5000) {

    return new Promise((resolve, reject) => {

        const startedAt = Date.now();

        const timer = setInterval(() => {

            if (updates.length >= minCount) {

                clearInterval(timer);

                resolve(updates.slice());

                return;

            }

            if (Date.now() - startedAt >= timeoutMs) {

                clearInterval(timer);

                reject(new Error(
                    `Timed out waiting for ${minCount} physics updates`
                ));

            }

        }, 10);

    });

}

const harness = await createGameplaySocketHarness();

try {

    const session = await startGameplaySession(harness);

    const hostCollector = collectPhysicsUpdates(session.host);

    const guestCollector = collectPhysicsUpdates(session.guestA);

    const physicsEvents = [];

    harness.eventBus.subscribe(EVENT_TYPES.PHYSICS_UPDATED, (envelope) => {

        physicsEvents.push(envelope.payload);

    });

    const hostUpdates = await waitForPhysicsUpdates(hostCollector.updates, 3);

    await wait(40);

    const guestUpdates = guestCollector.updates;

    assert(
        physicsEvents.length >= 3,
        "PHYSICS_UPDATED should continue to reach the EventBus"
    );

    assert(
        hostUpdates.length >= 3,
        "client should receive repeated physics updates"
    );

    assert(
        guestUpdates.length >= 3,
        "room players should receive physics updates"
    );

    for (const payload of hostUpdates) {

        assert(
            payload.gameId === session.gameId,
            "physics payload should include the authoritative gameId"
        );

        assert(
            payload.wheelAngle === 0,
            "wheel angle should remain zero"
        );

        assert(
            payload.angularVelocity === 0,
            "angular velocity should remain zero"
        );

        assert(
            payload.simulationTime !== undefined,
            "payload should include simulationTime"
        );

        assert(
            typeof payload.serverTimestamp === "number",
            "payload should include serverTimestamp"
        );

    }

    assert(
        harness.bootstrapEngines.gameStateEngine.getState(session.gameId) !== null,
        "authoritative GameState should exist during physics sync"
    );

    const outsider = await connectClient(harness.port);

    outsider.emit("createRoom");

    const outsiderRoom = await waitForEvent(outsider, "roomCreated");

    const outsiderCollector = collectPhysicsUpdates(outsider);

    await wait(60);

    assert(
        outsiderCollector.updates.length === 0,
        "physics packets should not be delivered outside the active game room"
    );

    assert(
        outsiderRoom.roomId !== session.created.roomId,
        "isolation test should use a separate room"
    );

    hostCollector.stop();

    guestCollector.stop();

    outsiderCollector.stop();

    session.host.disconnect();

    session.guestA.disconnect();

    session.guestB.disconnect();

    outsider.disconnect();

    console.log("gameplayPhysicsSync.integration.test.js: all assertions passed");

} finally {

    await harness.shutdown();

}
