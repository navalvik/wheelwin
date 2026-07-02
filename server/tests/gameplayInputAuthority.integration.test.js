import { io } from "socket.io-client";

import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import {
    PLAYER_INPUT_ACCEPTED_MESSAGE_TYPE,
    PLAYER_INPUT_REJECTED_MESSAGE_TYPE
} from "../socket/gameplayInputProtocol.js";
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
        gameId: games[0].gameId
    };

}

function collectInputAcks(socket) {

    const acks = [];

    const handler = (message) => {

        if (message?.type === PLAYER_INPUT_ACCEPTED_MESSAGE_TYPE
            || message?.type === PLAYER_INPUT_REJECTED_MESSAGE_TYPE) {

            acks.push(message);

        }

    };

    socket.on(GAME_MESSAGE_CHANNEL, handler);

    return {
        acks,
        stop() {

            socket.off(GAME_MESSAGE_CHANNEL, handler);

        }
    };

}

function waitForInputAckFrom(acks, startIndex, type, timeoutMs = 5000) {

    return new Promise((resolve, reject) => {

        const startedAt = Date.now();

        const timer = setInterval(() => {

            const match = acks
                .slice(startIndex)
                .find((message) => message.type === type);

            if (match) {

                clearInterval(timer);

                resolve(match);

                return;

            }

            if (Date.now() - startedAt >= timeoutMs) {

                clearInterval(timer);

                reject(new Error(`Timed out waiting for ${type}`));

            }

        }, 10);

    });

}

function sendButtonPress(socket, buttonState = "SPEED") {

    socket.emit(GAME_MESSAGE_CHANNEL, {
        type: EVENT_TYPES.BUTTON_PRESS,
        payload: {
            buttonState,
            pressCount: 0
        }
    });

}

const STATE_INPUT_EXPECTATIONS = [
    { state: GAME_STATES.READY, accept: false },
    { state: GAME_STATES.COUNTDOWN, accept: false },
    { state: GAME_STATES.SELF_TEST, accept: false },
    { state: GAME_STATES.SPEED, accept: true },
    { state: GAME_STATES.BRAKE, accept: false },
    { state: GAME_STATES.RESULT, accept: false }
];

async function validateInputAtState({
    harness,
    host,
    inputAckCollector,
    gameId,
    expectation
}) {

    const { state, accept } = expectation;

    const gameStateEngine = harness.bootstrapEngines.gameStateEngine;

    const originalGetState = gameStateEngine.getState.bind(gameStateEngine);

    gameStateEngine.getState = (targetGameId) => {

        if (targetGameId === gameId) {

            return state;

        }

        return originalGetState(targetGameId);

    };

    try {

        const acksBefore = inputAckCollector.acks.length;

        sendButtonPress(host, state);

        const expectedType = accept
            ? PLAYER_INPUT_ACCEPTED_MESSAGE_TYPE
            : PLAYER_INPUT_REJECTED_MESSAGE_TYPE;

        const ack = await waitForInputAckFrom(
            inputAckCollector.acks,
            acksBefore,
            expectedType
        );

        assert(
            ack.payload.accepted === accept,
            `${state} input should be ${accept ? "accepted" : "rejected"} on client`
        );

        assert(
            ack.payload.gameState === state,
            `${state} ack should include authoritative gameState`
        );

        assert(
            ack.payload.gameId === gameId,
            `${state} ack should include gameId`
        );

    } finally {

        gameStateEngine.getState = originalGetState;

    }

}

const harness = await createGameplaySocketHarness();

try {

    // This suite isolates InputAuthority validation + acknowledgement.
    // Stopping the SimulationLoop guarantees queued commands are not drained
    // into physics here — command→physics activation is covered by
    // gameplayPhysicsControl.integration.test.js (C3.7).
    harness.bootstrapEngines.simulationLoop.stop();

    const physicsEngine = harness.bootstrapEngines.physicsEngine;

    const gameStateEngine = harness.bootstrapEngines.gameStateEngine;

    let accelerationCalls = 0;

    const originalApplyAcceleration = physicsEngine.applyAcceleration
        .bind(physicsEngine);

    physicsEngine.applyAcceleration = (...args) => {

        accelerationCalls += 1;

        return originalApplyAcceleration(...args);

    };

    const serverAccepted = [];

    const serverRejected = [];

    harness.eventBus.subscribe(EVENT_TYPES.PLAYER_INPUT_ACCEPTED, (envelope) => {

        serverAccepted.push(envelope.payload);

    });

    harness.eventBus.subscribe(EVENT_TYPES.PLAYER_INPUT_REJECTED, (envelope) => {

        serverRejected.push(envelope.payload);

    });

    const session = await startGameplaySession(harness);

    const inputAckCollector = collectInputAcks(session.host);

    await wait(60);

    harness.bootstrapEngines.gameClockEngine.pauseClock(session.gameId);

    const stateBeforeInput = gameStateEngine.getState(session.gameId);

    for (const expectation of STATE_INPUT_EXPECTATIONS) {

        await validateInputAtState({
            harness,
            host: session.host,
            inputAckCollector,
            gameId: session.gameId,
            expectation
        });

    }

    assert(
        harness.forwardedCalls.some((call) => call.method === "press"),
        "BUTTON_PRESS should reach InputAuthority"
    );

    await wait(40);

    assert(
        accelerationCalls === 0,
        "applyAcceleration must not run while the simulation loop is stopped"
    );

    const simulation = physicsEngine.getSimulation(session.gameId);

    assert(
        simulation.runtime.angularVelocity === 0,
        "wheel velocity should remain zero"
    );

    assert(
        simulation.runtime.angle === 0,
        "wheel angle should remain zero"
    );

    assert(
        gameStateEngine.getState(session.gameId) === stateBeforeInput,
        "gameplay input must not change authoritative GameState"
    );

    assert(
        serverRejected.length >= 5,
        "server should emit PLAYER_INPUT_REJECTED for non-SPEED states"
    );

    assert(
        serverAccepted.length >= 1,
        "server should emit PLAYER_INPUT_ACCEPTED during SPEED"
    );

    for (const payload of serverRejected) {

        assert(
            payload.gameState !== GAME_STATES.SPEED,
            "rejected input should never be validated during SPEED"
        );

    }

    for (const payload of serverAccepted) {

        assert(
            payload.gameState === GAME_STATES.SPEED,
            "accepted input should only occur during SPEED"
        );

    }

    inputAckCollector.stop();

    session.host.disconnect();

    session.guestA.disconnect();

    session.guestB.disconnect();

    console.log("gameplayInputAuthority.integration.test.js: all assertions passed");

} finally {

    await harness.shutdown();

}
