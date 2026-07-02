import { io } from "socket.io-client";

import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import { GAME_STATE_MESSAGE_TYPE } from "../socket/gameplayGameStateProtocol.js";
import { GAME_MESSAGE_CHANNEL } from "../socket/events.js";
import { createGameplaySocketHarness } from "./helpers/gameplaySocketHarness.js";

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

    const hostCollector = collectGameStateUpdates(host);

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

    const games = harness.gameManager.getGames();

    assert(games.length === 1, "gameplay session should create one game");

    return {
        host,
        guestA,
        guestB,
        created,
        gameId: games[0].gameId,
        hostCollector
    };

}

function collectGameStateUpdates(socket) {

    const updates = [];

    const handler = (message) => {

        if (message?.type === GAME_STATE_MESSAGE_TYPE) {

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

function waitForGameState(updates, state, timeoutMs = 5000) {

    return new Promise((resolve, reject) => {

        const startedAt = Date.now();

        const timer = setInterval(() => {

            if (updates.some((payload) => payload.state === state)) {

                clearInterval(timer);

                resolve();

                return;

            }

            if (Date.now() - startedAt >= timeoutMs) {

                clearInterval(timer);

                reject(new Error(`Timed out waiting for GameState ${state}`));

            }

        }, 10);

    });

}

const EXPECTED_CLIENT_STATES = [
    GAME_STATES.READY,
    GAME_STATES.COUNTDOWN,
    GAME_STATES.SELF_TEST,
    GAME_STATES.SPEED,
    GAME_STATES.BRAKE,
    GAME_STATES.RESULT
];

const harness = await createGameplaySocketHarness();

try {

    const stateChanges = [];

    harness.eventBus.subscribe(EVENT_TYPES.GAME_STATE_CHANGED, (envelope) => {

        const state = envelope.payload?.currentState
            ?? envelope.payload?.state;

        if (state) {

            stateChanges.push(state);

        }

    });

    const session = await startGameplaySession(harness);

    const hostCollector = session.hostCollector;

    for (const state of EXPECTED_CLIENT_STATES) {

        await waitForGameState(hostCollector.updates, state);

    }

    await wait(40);

    const serverHistory = harness.bootstrapEngines.gameStateEngine
        .getHistory(session.gameId)
        .map((entry) => entry.state);

    assert(
        serverHistory.join(",") === [
            GAME_STATES.READY,
            GAME_STATES.COUNTDOWN,
            GAME_STATES.SELF_TEST,
            GAME_STATES.SPEED,
            GAME_STATES.BRAKE,
            GAME_STATES.RESULT
        ].join(","),
        "server should progress through every predefined phase"
    );

    assert(
        harness.bootstrapEngines.gameStateEngine.getState(session.gameId)
            === GAME_STATES.RESULT,
        "server GameState should reach RESULT"
    );

    assert(
        stateChanges.join(",") === serverHistory.join(","),
        `GAME_STATE_CHANGED should match server history (events=${stateChanges.join(",")} history=${serverHistory.join(",")})`
    );

    for (const state of EXPECTED_CLIENT_STATES) {

        assert(
            hostCollector.updates.some((payload) => payload.state === state),
            `client should receive GameState ${state}`
        );

    }

    for (const payload of hostCollector.updates) {

        assert(
            payload.gameId === session.gameId,
            "GameState payload should include authoritative gameId"
        );

        assert(
            typeof payload.state === "string",
            "GameState payload should include state"
        );

    }

    const simulation = harness.bootstrapEngines.physicsEngine
        .getSimulation(session.gameId);

    assert(
        simulation.runtime.angularVelocity === 0,
        "wheel velocity should remain zero"
    );

    assert(
        simulation.runtime.angle === 0,
        "wheel angle should remain zero"
    );

    harness.resetForwardedCalls();

    const stateBeforeInput = harness.bootstrapEngines.gameStateEngine
        .getState(session.gameId);

    session.host.emit(GAME_MESSAGE_CHANNEL, {
        type: EVENT_TYPES.BUTTON_PRESS,
        payload: {
            buttonState: "SPEED",
            pressCount: 0
        }
    });

    await wait(40);

    assert(
        harness.bootstrapEngines.gameStateEngine.getState(session.gameId)
            === stateBeforeInput,
        "gameplay input should not change authoritative GameState"
    );

    hostCollector.stop();

    session.host.disconnect();

    session.guestA.disconnect();

    session.guestB.disconnect();

    console.log("gameplayGameStateSync.integration.test.js: all assertions passed");

} finally {

    await harness.shutdown();

}
