import { io } from "socket.io-client";

import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_MESSAGE_CHANNEL } from "../socket/events.js";
import { createGameplaySocketHarness } from "./helpers/gameplaySocketHarness.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

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

function emitGameplayMessage(socket, message) {

    socket.emit(GAME_MESSAGE_CHANNEL, message);

}

async function waitFor(predicate, timeoutMs = 3000, intervalMs = 10) {

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {

        if (predicate()) {

            return true;

        }

        await new Promise((resolve) => setTimeout(resolve, intervalMs));

    }

    return false;

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

    return {
        host,
        guestA,
        guestB,
        created
    };

}

const harness = await createGameplaySocketHarness();

try {

    const session = await startGameplaySession(harness);

    harness.resetForwardedCalls();

    emitGameplayMessage(session.host, {
        type: EVENT_TYPES.BUTTON_PRESS,
        payload: {
            buttonState: "SPEED",
            pressCount: 0
        }
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    assert(
        harness.forwardedCalls.some(
            (call) => call.method === "press"
                && call.playerId === session.created.playerId
        ),
        "valid BUTTON_PRESS should reach InputAuthority"
    );

    harness.resetForwardedCalls();

    emitGameplayMessage(session.host, {
        type: EVENT_TYPES.BUTTON_RELEASE,
        payload: {
            buttonState: "SPEED",
            pressCount: 1
        }
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    assert(
        harness.forwardedCalls.some(
            (call) => call.method === "release"
                && call.playerId === session.created.playerId
        ),
        "valid BUTTON_RELEASE should reach InputAuthority"
    );

    session.host.disconnect();

    session.guestA.disconnect();

    session.guestB.disconnect();

    // C4.8b: disconnecting mid-SPEED hands each player to
    // OfflineInputContinuation, which authoritatively finishes their remaining
    // input through InputAuthority (recorded by the monkeypatched forwardedCalls).
    // This is legitimate background gameplay, not socket routing. The client-side
    // disconnect is processed by the server asynchronously, so wait until the
    // authoritative game has actually left SPEED (continuation completed it) and
    // no continuation cursors remain, before the routing assertions below.
    const drained = await waitFor(() => {

        const games = harness.gameManager.getGames();

        const anySpeed = games.some(
            (game) => harness.bootstrapEngines.gameStateEngine
                .getState(game.gameId) === "SPEED"
        );

        const activeContinuations = harness.bootstrapEngines
            .offlineInputContinuation.getActiveContinuations().length;

        return !anySpeed && activeContinuations === 0;

    });

    assert(drained, "offline continuation should complete SPEED after disconnect");

    const unknownClient = await connectClient(harness.port);

    harness.resetForwardedCalls();

    emitGameplayMessage(unknownClient, {
        type: "NOT_A_REAL_EVENT",
        payload: {}
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    assert(
        harness.forwardedCalls.length === 0,
        "unknown gameplay message should be ignored"
    );

    unknownClient.disconnect();

    const invalidPlayerClient = await connectClient(harness.port);

    harness.resetForwardedCalls();

    emitGameplayMessage(invalidPlayerClient, {
        type: EVENT_TYPES.BUTTON_PRESS,
        payload: {}
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    assert(
        harness.forwardedCalls.length === 0,
        "unbound socket should not reach InputAuthority"
    );

    invalidPlayerClient.disconnect();

    harness.socketGateway._handleGameplayMessage(
        { id: "offline-socket", connected: false },
        {
            type: EVENT_TYPES.BUTTON_PRESS,
            payload: {}
        }
    );

    assert(
        harness.forwardedCalls.length === 0,
        "disconnected socket should be rejected"
    );

    const malformedHarnessSession = await startGameplaySession(harness);

    harness.resetForwardedCalls();

    harness.socketGateway._handleGameplayMessage(
        { id: malformedHarnessSession.host.id, connected: true },
        null
    );

    assert(
        harness.forwardedCalls.length === 0,
        "malformed gameplay payload should be rejected"
    );

    const otherRoomHost = await connectClient(harness.port);

    otherRoomHost.emit("createRoom");

    const otherRoom = await waitForEvent(otherRoomHost, "roomCreated");

    harness.resetForwardedCalls();

    harness.gameplayContextResolver.bindSocket(
        malformedHarnessSession.host.id,
        {
            playerId: malformedHarnessSession.created.playerId,
            roomId: otherRoom.roomId
        }
    );

    emitGameplayMessage(malformedHarnessSession.host, {
        type: EVENT_TYPES.BUTTON_PRESS,
        payload: {}
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    assert(
        harness.forwardedCalls.length === 0,
        "player bound to another room should be rejected"
    );

    malformedHarnessSession.host.disconnect();

    malformedHarnessSession.guestA.disconnect();

    malformedHarnessSession.guestB.disconnect();

    otherRoomHost.disconnect();

    console.log("Gameplay socket integration tests passed");

} finally {

    await harness.shutdown();

}
