import { io } from "socket.io-client";

import { TIMER_PHASES } from "../catalog/Timers.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import { GAME_CLOCK_MESSAGE_TYPE } from "../socket/gameplayClockProtocol.js";
import { GAME_MESSAGE_CHANNEL } from "../socket/events.js";
import { createGameplaySocketHarness } from "./helpers/gameplaySocketHarness.js";
import {
    emitEntryPaymentCompleted,
    exhaustAllPlayerInput
} from "./helpers/gameplayBootstrapHarness.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

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

function collectClockUpdates(socket) {

    const updates = [];

    const handler = (message) => {

        if (message?.type === GAME_CLOCK_MESSAGE_TYPE) {

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

function waitFor(predicate, timeoutMs = 15000) {

    return new Promise((resolve, reject) => {

        const startedAt = Date.now();

        const timer = setInterval(() => {

            if (predicate()) {

                clearInterval(timer);

                resolve();

                return;

            }

            if (Date.now() - startedAt >= timeoutMs) {

                clearInterval(timer);

                reject(new Error("Timed out waiting for clock condition"));

            }

        }, 10);

    });

}

const CATALOG_PHASES = new Set(Object.values(TIMER_PHASES));

const harness = await createGameplaySocketHarness();

try {

    const host = await connectClient(harness.port);

    // Bind clock collectors as soon as each socket exists — mirroring the client
    // where the authoritative subscription is active for the whole session
    // (C4.6). This guarantees the very first COUNTDOWN frame is captured.
    const hostClock = collectClockUpdates(host);

    host.emit("createRoom");

    const created = await waitForEvent(host, "roomCreated");

    const guestA = await connectClient(harness.port);

    const guestAClock = collectClockUpdates(guestA);

    guestA.emit("joinRoom", created.roomId);

    await waitForEvent(guestA, "roomJoined");

    const guestB = await connectClient(harness.port);

    const guestBClock = collectClockUpdates(guestB);

    const startPromises = [
        waitForEvent(host, "startGame"),
        waitForEvent(guestA, "startGame"),
        waitForEvent(guestB, "startGame")
    ];

    const guestBJoined = waitForEvent(guestB, "roomJoined");

    guestB.emit("joinRoom", created.roomId);

    await guestBJoined;

    await Promise.all(startPromises);

    emitEntryPaymentCompleted(harness.eventBus, created.roomId);

    const games = harness.gameManager.getGames();

    assert(games.length === 1, "gameplay session should create one game");

    const gameId = games[0].gameId;

    const playerIds = [...games[0].players];

    // C4.8: SPEED persists until authoritative gameplay completes. Exhaust every
    // player's input budget so SpeedActivation can advance the clock.
    await waitFor(
        () => harness.bootstrapEngines.gameStateEngine.getState(gameId)
            === GAME_STATES.SPEED
    );

    exhaustAllPlayerInput(harness.inputAuthority, gameId, playerIds);

    // Run until the authoritative clock stops (its final packet is not running).
    await waitFor(() => hostClock.updates.some((p) => p.running === false));

    // Let the last fan-out settle across every client.
    await new Promise((resolve) => setTimeout(resolve, 100));

    hostClock.stop();

    guestAClock.stop();

    guestBClock.stop();

    assert(
        hostClock.updates.length > 0,
        "host should receive authoritative clock packets"
    );

    // Every packet is authoritative: correct game, catalog phase, server-provided
    // remaining time. Nothing is computed on the client.
    for (const payload of hostClock.updates) {

        assert(
            payload.gameId === gameId,
            "clock packet should carry the authoritative gameId"
        );

        assert(
            CATALOG_PHASES.has(payload.phase),
            `clock phase must be an authoritative catalog phase (got ${payload.phase})`
        );

        assert(
            payload.remainingSeconds === null
            || Number.isInteger(payload.remainingSeconds),
            "remaining seconds must be provided by the server (int or null)"
        );

    }

    // The first authoritative phase clients observe is COUNTDOWN.
    assert(
        hostClock.updates[0].phase === TIMER_PHASES.COUNTDOWN,
        `first clock packet should be COUNTDOWN (got ${hostClock.updates[0].phase})`
    );

    // No visible drift: three clients in the same room receive an identical
    // ordered stream of authoritative clock frames.
    const serialize = (updates) => updates
        .map((p) => `${p.phase}:${p.remainingSeconds}:${p.running}`)
        .join("|");

    const hostSeq = serialize(hostClock.updates);

    const guestASeq = serialize(guestAClock.updates);

    const guestBSeq = serialize(guestBClock.updates);

    assert(
        hostSeq === guestASeq && hostSeq === guestBSeq,
        "all three clients must receive an identical authoritative clock stream"
    );

    // The broadcaster owns no work once the clock is done — no leaked intervals.
    assert(
        harness.gameClockBroadcaster.getActiveBroadcastCount() === 0,
        "clock broadcaster must stop sampling once the clock is finished"
    );

    host.disconnect();

    guestA.disconnect();

    guestB.disconnect();

    console.log("gameplayClockSync.integration.test.js: all assertions passed");

} finally {

    await harness.shutdown();

}
