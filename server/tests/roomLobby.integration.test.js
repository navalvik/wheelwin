import { io } from "socket.io-client";

import { createLobbyIntegrationHarness } from "./helpers/lobbyIntegrationHarness.js";
import {
    isValidRoomId,
    ROOM_ID_LENGTH
} from "../managers/room/roomIdAlphabet.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

function waitForEvent(socket, eventName, timeoutMs = 5000, label = eventName) {

    return new Promise((resolve, reject) => {

        const timer = setTimeout(() => {

            reject(new Error(`Timed out waiting for ${label}`));

        }, timeoutMs);

        socket.once(eventName, (payload) => {

            clearTimeout(timer);

            resolve(payload);

        });

    });

}

function waitForEntryPaymentUpdate(socket, predicate, timeoutMs = 5000, label) {

    return new Promise((resolve, reject) => {

        const timer = setTimeout(() => {

            socket.off("ENTRY_PAYMENT_SESSION_UPDATED", onUpdate);

            reject(new Error(`Timed out waiting for ${label}`));

        }, timeoutMs);

        function onUpdate(payload) {

            if (!predicate(payload)) {

                return;

            }

            clearTimeout(timer);

            socket.off("ENTRY_PAYMENT_SESSION_UPDATED", onUpdate);

            resolve(payload);

        }

        socket.on("ENTRY_PAYMENT_SESSION_UPDATED", onUpdate);

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

const harness = await createLobbyIntegrationHarness();

try {

    const host = await connectClient(harness.port);

    host.emit("createRoom");

    const created = await waitForEvent(host, "roomCreated");

    assert(created.roomId, "create room should return roomId");

    assert(
        created.roomId.length === ROOM_ID_LENGTH,
        "create room should return a 4-character roomId"
    );

    assert(
        isValidRoomId(created.roomId),
        "create room should return a valid public room code"
    );

    assert(created.playerId, "create room should return playerId");

    assert(created.connectedPlayers === 1, "creator should be first player");

    assert(created.maxPlayers === 3, "room should expose maxPlayers");

    const guestA = await connectClient(harness.port);

    const joinedPromise = waitForEvent(guestA, "roomJoined");

    const hostStatePromise = waitForEvent(host, "roomState");

    guestA.emit("joinRoom", created.roomId);

    const joined = await joinedPromise;

    const hostState = await hostStatePromise;

    assert(joined.roomId === created.roomId, "join should return roomId");

    assert(
        joined.connectedPlayers === 2,
        "joined payload should include connected player count"
    );

    assert(
        hostState.connectedPlayers === 2,
        "host should receive synchronized room state"
    );

    const guestB = await connectClient(harness.port);

    const fullGuestPromise = waitForEvent(guestB, "roomJoined");

    const startHostPromise = waitForEvent(host, "startGame", 5000, "host.startGame");

    const startGuestAPromise = waitForEvent(guestA, "startGame", 5000, "guestA.startGame");

    const startGuestBPromise = waitForEvent(guestB, "startGame", 5000, "guestB.startGame");

    guestB.emit("joinRoom", created.roomId);

    const [joinedB, startHost, startGuestA, startGuestB] = await Promise.all([
        fullGuestPromise,
        startHostPromise,
        startGuestAPromise,
        startGuestBPromise
    ]);

    assert(joinedB.roomId === created.roomId, "third player should join room");

    assert(
        startHost.players.length === 3,
        "startGame should include three players for host"
    );

    assert(
        startGuestA.players.length === 3,
        "startGame should include three players for guest A"
    );

    assert(
        startGuestB.players.length === 3,
        "startGame should include three players for guest B"
    );

    assert(
        startHost.playerId === created.playerId,
        "host startGame must bind host playerId"
    );

    assert(
        startGuestA.playerId === joined.playerId,
        "guest A startGame must bind guest A playerId"
    );

    assert(
        startGuestB.playerId === joinedB.playerId,
        "guest B (last joiner) startGame must bind guest B playerId"
    );

    assert(
        startHost.playerId !== startGuestA.playerId
            && startGuestA.playerId !== startGuestB.playerId
            && startHost.playerId !== startGuestB.playerId,
        "each client must receive its own playerId on startGame"
    );

    // RC-FIX-006 — public identity visible before Confirm; peers verify participants.
    const peerSeatPromise = waitForEvent(
        guestA,
        "PLAYER_UPDATE",
        5000,
        "guestA.public.PLAYER_UPDATE"
    );

    const hostProfilePromise = waitForEvent(
        host,
        "PLAYER_UPDATE",
        5000,
        "host.PLAYER_UPDATE"
    );

    host.emit("updatePlayerProfile", {
        nickname: "Host",
        age: 30,
        color: "#111111",
        sectorCount: 2,
        sectorArrangement: "together",
        baseStake: 10
    });

    const [hostProfile, peerSeat] = await Promise.all([
        hostProfilePromise,
        peerSeatPromise
    ]);

    assert(
        hostProfile.playerId === created.playerId,
        "host should receive private profile ack"
    );

    assert(
        hostProfile.nickname === "Host",
        "private ack should include nickname"
    );

    assert(
        hostProfile.sectorCount === 2,
        "private ack should include sectorCount"
    );

    assert(
        peerSeat.playerId === created.playerId,
        "peers should receive host seat for Verify roster"
    );

    assert(
        peerSeat.nickname === "Host"
            && peerSeat.age === 30
            && peerSeat.sectorCount === 2
            && peerSeat.icon != null,
        "peers must receive public nickname/age/icon/sectorCount before Confirm"
    );

    assert(
        peerSeat.color == null
            && peerSeat.sectorArrangement == null,
        "peers must not receive color/sectorArrangement before Confirm"
    );

    guestA.emit("updatePlayerProfile", {
        nickname: "GueA",
        age: 25,
        color: "#222222",
        sectorCount: 1,
        baseStake: 10
    });

    await waitForEvent(guestA, "PLAYER_UPDATE", 5000, "guestA.PLAYER_UPDATE");

    guestB.emit("updatePlayerProfile", {
        nickname: "GueB",
        age: 28,
        color: "#333333",
        sectorCount: 1,
        baseStake: 10
    });

    await waitForEvent(guestB, "PLAYER_UPDATE", 5000, "guestB.PLAYER_UPDATE");

    // RC1.3 Bug #9 — Secret Matrix must match before Verify.
    const matrix = ["A", "1", "B", "2", "C", "3", "D", "4", "E"];

    const rejectHostPromise = waitForEvent(
        host,
        "SECRET_MATRIX_REJECTED",
        5000,
        "host.SECRET_MATRIX_REJECTED"
    );

    host.emit("submitSecretMatrix", matrix);

    guestA.emit("submitSecretMatrix", matrix);

    guestB.emit("submitSecretMatrix", [
        "Z", "1", "B", "2", "C", "3", "D", "4", "E"
    ]);

    const rejected = await rejectHostPromise;

    assert(
        rejected.code === "SECRET_MATRIX_MISMATCH",
        "mismatched matrices must be rejected"
    );

    const acceptHostPromise = waitForEvent(
        host,
        "SECRET_MATRIX_ACCEPTED",
        5000,
        "host.SECRET_MATRIX_ACCEPTED"
    );

    const acceptAPromise = waitForEvent(
        guestA,
        "SECRET_MATRIX_ACCEPTED",
        5000,
        "guestA.SECRET_MATRIX_ACCEPTED"
    );

    const acceptBPromise = waitForEvent(
        guestB,
        "SECRET_MATRIX_ACCEPTED",
        5000,
        "guestB.SECRET_MATRIX_ACCEPTED"
    );

    host.emit("submitSecretMatrix", matrix);

    guestA.emit("submitSecretMatrix", matrix);

    guestB.emit("submitSecretMatrix", matrix);

    await Promise.all([
        acceptHostPromise,
        acceptAPromise,
        acceptBPromise
    ]);

    const invalidRejectPromise = waitForEvent(
        host,
        "SECRET_MATRIX_REJECTED",
        5000,
        "host.invalid.SECRET_MATRIX_REJECTED"
    );

    host.emit("submitSecretMatrix", ["A"]);

    const invalidRejected = await invalidRejectPromise;

    assert(
        invalidRejected.code === "INVALID_SECRET_MATRIX",
        "incomplete matrix must be rejected by server"
    );

    const verifyHostPromise = waitForEvent(
        host,
        "VERIFY_COMPLETED",
        5000,
        "host.VERIFY_COMPLETED"
    );

    const verifyAPromise = waitForEvent(
        guestA,
        "VERIFY_COMPLETED",
        5000,
        "guestA.VERIFY_COMPLETED"
    );

    const verifyBPromise = waitForEvent(
        guestB,
        "VERIFY_COMPLETED",
        5000,
        "guestB.VERIFY_COMPLETED"
    );

    const revealHostToAPromise = new Promise((resolve, reject) => {

        const timer = setTimeout(() => {

            reject(new Error("Timed out waiting for host profile reveal to guest A"));

        }, 5000);

        function onUpdate(payload) {

            if (
                payload?.playerId === created.playerId
                && payload?.nickname === "Host"
            ) {

                clearTimeout(timer);

                guestA.off("PLAYER_UPDATE", onUpdate);

                resolve(payload);

            }

        }

        guestA.on("PLAYER_UPDATE", onUpdate);

    });

    host.emit("confirmVerify");

    guestA.emit("confirmVerify");

    // Two confirms must not complete Verify yet.
    await new Promise((resolve) => setTimeout(resolve, 300));

    guestB.emit("confirmVerify");

    const [verifyHost, verifyA, verifyB, revealedHostToA] = await Promise.all([
        verifyHostPromise,
        verifyAPromise,
        verifyBPromise,
        revealHostToAPromise
    ]);

    assert(verifyHost.roomId === created.roomId, "VERIFY_COMPLETED for host");

    assert(verifyA.roomId === created.roomId, "VERIFY_COMPLETED for guest A");

    assert(verifyB.roomId === created.roomId, "VERIFY_COMPLETED for guest B");

    assert(
        revealedHostToA.playerId === created.playerId
            && revealedHostToA.nickname === "Host",
        "after Verify, peers receive revealed host profile"
    );

    assert(
        Array.isArray(verifyA.players) && verifyA.players.length === 3,
        "VERIFY_COMPLETED must carry full authoritative roster"
    );

    assert(
        verifyA.players.every((player) => player.nickname),
        "VERIFY_COMPLETED roster must reveal nicknames"
    );

    // C5.8A/B — authoritative Verify → Payment barrier + wallet registration.
    const validWallet = (label) => `EQ${label}${"A".repeat(46 - label.length)}`;

    const hostWallet = validWallet("HOST");
    const guestAWallet = validWallet("GSTA");
    const guestBWallet = validWallet("GSTB");

    assert(hostWallet.length === 48, "host wallet fixture length");

    let earlyPaymentCount = 0;

    const onEarlyPayment = () => {

        earlyPaymentCount += 1;

    };

    host.on("PAYMENT_STAGE_READY", onEarlyPayment);

    guestA.on("PAYMENT_STAGE_READY", onEarlyPayment);

    guestB.on("PAYMENT_STAGE_READY", onEarlyPayment);

    // Invalid wallet must not join the barrier.
    const walletRejectedPromise = waitForEvent(
        guestB,
        "WALLET_REJECTED",
        5000,
        "guestB.WALLET_REJECTED"
    );

    guestB.emit("VERIFY_NEXT_REQUEST", {
        roomId: created.roomId,
        playerId: joinedB.playerId,
        walletAddress: "not-a-wallet"
    });

    const walletRejected = await walletRejectedPromise;

    assert(
        walletRejected.code === "INVALID_WALLET",
        "invalid wallet must return INVALID_WALLET"
    );

    assert(
        harness.playerManager.getIdentity(joinedB.playerId)?.wallet == null,
        "invalid wallet must not populate PlayerIdentity.wallet"
    );

    host.emit("VERIFY_NEXT_REQUEST", {
        roomId: created.roomId,
        playerId: created.playerId,
        walletAddress: hostWallet
    });

    guestA.emit("VERIFY_NEXT_REQUEST", {
        roomId: created.roomId,
        playerId: joined.playerId,
        walletAddress: guestAWallet
    });

    await new Promise((resolve) => setTimeout(resolve, 300));

    assert(
        earlyPaymentCount === 0,
        "PAYMENT_STAGE_READY must wait for all verified players"
    );

    assert(
        harness.playerManager.getIdentity(created.playerId)?.wallet === hostWallet,
        "host wallet must be stored authoritatively"
    );

    assert(
        harness.playerManager.getIdentity(joined.playerId)?.wallet === guestAWallet,
        "guest A wallet must be stored authoritatively"
    );

    const paymentHostPromise = waitForEvent(
        host,
        "PAYMENT_STAGE_READY",
        5000,
        "host.PAYMENT_STAGE_READY"
    );

    const paymentAPromise = waitForEvent(
        guestA,
        "PAYMENT_STAGE_READY",
        5000,
        "guestA.PAYMENT_STAGE_READY"
    );

    const paymentBPromise = waitForEvent(
        guestB,
        "PAYMENT_STAGE_READY",
        5000,
        "guestB.PAYMENT_STAGE_READY"
    );

    const entryHostPromise = waitForEvent(
        host,
        "ENTRY_PAYMENT_SESSION_UPDATED",
        5000,
        "host.ENTRY_PAYMENT_SESSION_UPDATED"
    );

    const entryAPromise = waitForEvent(
        guestA,
        "ENTRY_PAYMENT_SESSION_UPDATED",
        5000,
        "guestA.ENTRY_PAYMENT_SESSION_UPDATED"
    );

    const entryBPromise = waitForEvent(
        guestB,
        "ENTRY_PAYMENT_SESSION_UPDATED",
        5000,
        "guestB.ENTRY_PAYMENT_SESSION_UPDATED"
    );

    // C5.8D — listen for final lifecycle before barrier completes so we do not
    // miss simulated paid / creating / created broadcasts.
    const finalHostPromise = waitForEntryPaymentUpdate(
        host,
        (payload) => payload?.smartContractStatus === "created"
            && payload.players?.every((player) => player.paymentStatus === "paid"),
        5000,
        "host.entryPayment.created"
    );

    const finalAPromise = waitForEntryPaymentUpdate(
        guestA,
        (payload) => payload?.smartContractStatus === "created"
            && payload.players?.every((player) => player.paymentStatus === "paid"),
        5000,
        "guestA.entryPayment.created"
    );

    const finalBPromise = waitForEntryPaymentUpdate(
        guestB,
        (payload) => payload?.smartContractStatus === "created"
            && payload.players?.every((player) => player.paymentStatus === "paid"),
        5000,
        "guestB.entryPayment.created"
    );

    // C5.8E — completion after the authoritative display timer.
    const completedHostPromise = waitForEvent(
        host,
        "ENTRY_PAYMENT_COMPLETED",
        5000,
        "host.ENTRY_PAYMENT_COMPLETED"
    );

    const completedAPromise = waitForEvent(
        guestA,
        "ENTRY_PAYMENT_COMPLETED",
        5000,
        "guestA.ENTRY_PAYMENT_COMPLETED"
    );

    const completedBPromise = waitForEvent(
        guestB,
        "ENTRY_PAYMENT_COMPLETED",
        5000,
        "guestB.ENTRY_PAYMENT_COMPLETED"
    );

    // Corrected valid wallet joins the barrier and completes it.
    guestB.emit("VERIFY_NEXT_REQUEST", {
        roomId: created.roomId,
        playerId: joinedB.playerId,
        walletAddress: guestBWallet
    });

    const [
        paymentHost,
        paymentA,
        paymentB,
        entryHost,
        entryA,
        entryB
    ] = await Promise.all([
        paymentHostPromise,
        paymentAPromise,
        paymentBPromise,
        entryHostPromise,
        entryAPromise,
        entryBPromise
    ]);

    host.off("PAYMENT_STAGE_READY", onEarlyPayment);

    guestA.off("PAYMENT_STAGE_READY", onEarlyPayment);

    guestB.off("PAYMENT_STAGE_READY", onEarlyPayment);

    assert(
        earlyPaymentCount === 3,
        "PAYMENT_STAGE_READY must broadcast exactly once to each of three clients"
    );

    assert(
        harness.playerManager.getIdentity(joinedB.playerId)?.wallet === guestBWallet,
        "guest B corrected wallet must be stored authoritatively"
    );

    // Duplicate NEXT after barrier: no additional room broadcast.
    let lateDuplicateBroadcast = false;

    guestA.once("PAYMENT_STAGE_READY", () => {

        lateDuplicateBroadcast = true;

    });

    host.emit("VERIFY_NEXT_REQUEST", {
        roomId: created.roomId,
        playerId: created.playerId,
        walletAddress: hostWallet
    });

    await new Promise((resolve) => setTimeout(resolve, 200));

    assert(
        lateDuplicateBroadcast === false,
        "late duplicate VERIFY_NEXT_REQUEST must not re-broadcast to the room"
    );

    assert(
        paymentHost.roomId === created.roomId
            && paymentA.roomId === created.roomId
            && paymentB.roomId === created.roomId,
        "PAYMENT_STAGE_READY must reach every client with roomId"
    );

    // C5.8C — EntryPaymentSession created immediately after PAYMENT_STAGE_READY.
    assert(
        entryHost.roomId === created.roomId
            && entryA.roomId === created.roomId
            && entryB.roomId === created.roomId,
        "ENTRY_PAYMENT_SESSION_UPDATED must reach every client"
    );

    assert(
        entryHost.players.length === 3
            && entryA.players.length === 3
            && entryB.players.length === 3,
        "EntryPaymentSession must include all three players"
    );

    assert(
        entryHost.players.every((player) => player.paymentStatus === "waiting"),
        "every entry paymentStatus starts waiting"
    );

    assert(
        entryHost.smartContractStatus === "waiting",
        "smartContractStatus starts waiting"
    );

    assert(
        entryHost.players.every((player) => typeof player.wallet === "string"
            && player.wallet.startsWith("EQ")),
        "EntryPaymentSession carries registered wallets"
    );

    const entrySession = harness.roomLobbyBridge
        ._entryPaymentByRoom.get(created.roomId);

    assert(entrySession, "EntryPaymentSession must exist on server");

    const [finalHost, finalA, finalB] = await Promise.all([
        finalHostPromise,
        finalAPromise,
        finalBPromise
    ]);

    assert(
        finalHost.smartContractStatus === "created"
            && finalA.smartContractStatus === "created"
            && finalB.smartContractStatus === "created",
        "all clients reach smartContractStatus=created"
    );

    assert(
        finalHost.players.every((player) => player.paymentStatus === "paid")
            && finalA.players.every((player) => player.paymentStatus === "paid")
            && finalB.players.every((player) => player.paymentStatus === "paid"),
        "all clients see every player paid"
    );

    const [completedHost, completedA, completedB] = await Promise.all([
        completedHostPromise,
        completedAPromise,
        completedBPromise
    ]);

    assert(
        completedHost.roomId === created.roomId
            && completedA.roomId === created.roomId
            && completedB.roomId === created.roomId,
        "ENTRY_PAYMENT_COMPLETED must reach every client"
    );

    assert(
        harness.roomLobbyBridge._entryPaymentCompletedByRoom.has(created.roomId),
        "server marks entry payment completed"
    );

    host.disconnect();

    guestA.disconnect();

    guestB.disconnect();

    const invalidClient = await connectClient(harness.port);

    invalidClient.emit("joinRoom", "ACDE");

    const invalidJoin = await waitForEvent(invalidClient, "roomError");

    assert(
        invalidJoin.code === "ROOM_NOT_FOUND",
        "valid-format missing room should return ROOM_NOT_FOUND"
    );

    invalidClient.disconnect();

    const malformedClient = await connectClient(harness.port);

    malformedClient.emit("joinRoom", "BAD!");

    const malformedJoin = await waitForEvent(malformedClient, "roomError");

    assert(
        malformedJoin.code === "INVALID_ROOM_ID",
        "invalid room id format should be rejected"
    );

    malformedClient.disconnect();

    const fullRoomHost = await connectClient(harness.port);

    fullRoomHost.emit("createRoom");

    const fullRoom = await waitForEvent(fullRoomHost, "roomCreated");

    const fillerA = await connectClient(harness.port);

    fillerA.emit("joinRoom", fullRoom.roomId);

    await waitForEvent(fillerA, "roomJoined");

    const fillerB = await connectClient(harness.port);

    const fullStartPromise = waitForEvent(
        fullRoomHost,
        "startGame",
        5000,
        "fullRoomHost.startGame"
    );

    fillerB.emit("joinRoom", fullRoom.roomId);

    await waitForEvent(fillerB, "roomJoined");

    await fullStartPromise;

    const blockedClient = await connectClient(harness.port);

    blockedClient.emit("joinRoom", fullRoom.roomId);

    const fullError = await waitForEvent(blockedClient, "roomError");

    assert(
        fullError.code === "ROOM_LOCKED" || fullError.code === "ROOM_FULL",
        "full room should reject additional joins"
    );

    blockedClient.disconnect();

    fullRoomHost.disconnect();

    fillerA.disconnect();

    fillerB.disconnect();

    const creator = await connectClient(harness.port);

    creator.emit("createRoom");

    const creatorRoom = await waitForEvent(creator, "roomCreated");

    const member = await connectClient(harness.port);

    member.emit("joinRoom", creatorRoom.roomId);

    await waitForEvent(member, "roomJoined");

    const closedPromise = waitForEvent(member, "roomClosed");

    creator.disconnect();

    const closed = await closedPromise;

    assert(closed.roomId === creatorRoom.roomId, "roomClosed should include roomId");

    member.disconnect();

    const transientHost = await connectClient(harness.port);

    transientHost.emit("createRoom");

    const transientRoom = await waitForEvent(transientHost, "roomCreated");

    const transientGuest = await connectClient(harness.port);

    transientGuest.emit("joinRoom", transientRoom.roomId);

    await waitForEvent(transientGuest, "roomJoined");

    await waitForEvent(transientHost, "roomState");

    const syncPromise = waitForEvent(transientHost, "roomState");

    transientGuest.disconnect();

    const synced = await syncPromise;

    assert(
        synced.connectedPlayers === 1,
        "disconnect should synchronize remaining room state"
    );

    transientHost.disconnect();

    console.log("RoomLobby integration tests passed");

} finally {

    await harness.shutdown();

}
