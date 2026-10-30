import {
    APP_PAGES,
    resolveRoomRecoveryPage,
    shouldAcceptRoomRecoverySync,
    buildRoomRecoveryIdentityUpdate
} from "./recoveryFlow.js";

const expected = {
    LOBBY: APP_PAGES.LOBBY,
    PLAYER_SETUP: APP_PAGES.PLAYER_SETUP,
    MATRIX: APP_PAGES.MATRIX,
    VERIFY: APP_PAGES.VERIFY,
    PAYMENT: APP_PAGES.PAYMENT,
    NO_FRIENDS_OPTIONS: APP_PAGES.NO_FRIENDS_OPTIONS
};

for (const [stage, page] of Object.entries(expected)) {
    if (resolveRoomRecoveryPage(stage) !== page) {
        throw new Error(`Authoritative stage ${stage} did not map to page ${page}`);
    }
}

for (const stage of ["GAMEPLAY", "RESULT", "UNKNOWN"]) {
    if (resolveRoomRecoveryPage(stage) !== null) {
        throw new Error(`${stage} must remain under the existing gameplay recovery protocol`);
    }
}

const payload = { roomId: "room-1", playerId: "player-1", stage: "MATRIX" };
if (!shouldAcceptRoomRecoverySync({
    payload,
    identity: {},
    currentPage: APP_PAGES.WELCOME,
    recoveryInFlight: true
})) {
    throw new Error("In-flight recovery sync was not accepted");
}

if (shouldAcceptRoomRecoverySync({
    payload,
    identity: { roomId: "room-1", playerId: "other-player" },
    currentPage: APP_PAGES.VERIFY
})) {
    throw new Error("Stage sync for a different seat was accepted");
}

if (!shouldAcceptRoomRecoverySync({
    payload,
    identity: { roomId: "room-1", playerId: "player-1" },
    currentPage: APP_PAGES.VERIFY
})) {
    throw new Error("The current server-owned seat was rejected");
}


const existingIdentity = {
    roomId: "room-1",
    playerId: "player-1",
    gameId: "game-1",
    recoveryCredential: "current-credential"
};
const baseSync = { ...payload, gameId: "game-1" };

function applyAuthorizedSync(identity, syncPayload, recoveryInFlight = false) {
    if (!shouldAcceptRoomRecoverySync({
        payload: syncPayload,
        identity,
        currentPage: APP_PAGES.WELCOME,
        recoveryInFlight
    })) return identity;
    return { ...identity, ...buildRoomRecoveryIdentityUpdate(syncPayload, identity) };
}

// Two consecutive authenticated recoveries must preserve the active token
// when the server sends null/omits recoveryCredential.
let restored = applyAuthorizedSync(existingIdentity, {
    ...baseSync,
    recoveryCredential: null
}, true);
if (restored.recoveryCredential !== "current-credential") {
    throw new Error("First recovery cleared the active seat credential");
}
restored = applyAuthorizedSync(restored, { ...baseSync }, true);
if (restored.recoveryCredential !== "current-credential") {
    throw new Error("Second recovery lost the credential retained by the first");
}

// The server can rotate a credential for a verified Telegram seat.
restored = applyAuthorizedSync(restored, {
    ...baseSync,
    recoveryCredential: "fresh-server-credential"
}, true);
if (restored.recoveryCredential !== "fresh-server-credential") {
    throw new Error("A newly issued server credential must replace the old token");
}
restored = applyAuthorizedSync(restored, {
    ...baseSync,
    recoveryCredential: null
}, true);
if (restored.recoveryCredential !== "fresh-server-credential") {
    throw new Error("A later null credential must not erase the rotated token");
}

// A delayed response for another seat must not win just because a recovery
// is in flight or the UI currently displays Welcome / matchmaking.
for (const currentPage of [APP_PAGES.WELCOME, APP_PAGES.NO_FRIENDS_QUEUE]) {
    for (const mismatch of [
        { roomId: "other-room", playerId: "player-1" },
        { roomId: "room-1", playerId: "other-player" }
    ]) {
        if (shouldAcceptRoomRecoverySync({
            payload: { ...baseSync, ...mismatch },
            identity: existingIdentity,
            currentPage,
            recoveryInFlight: true
        })) {
            throw new Error("A stale/different room or player displaced an established seat");
        }
    }
}

// A missing initial match/room event can still be recovered for a trusted
// Telegram player who has not yet stored any room/player identity.
if (!shouldAcceptRoomRecoverySync({
    payload: baseSync,
    identity: {},
    currentPage: APP_PAGES.NO_FRIENDS_QUEUE,
    recoveryInFlight: true
})) {
    throw new Error("Fresh Telegram seat recovery was incorrectly rejected");
}

// Do not carry a previous room's bearer token into a different seat.
const separateSeat = buildRoomRecoveryIdentityUpdate({
    roomId: "other-room",
    playerId: "other-player",
    stage: "PLAYER_SETUP",
    recoveryCredential: null
}, existingIdentity);
if (separateSeat.recoveryCredential !== null || separateSeat.gameId !== null) {
    throw new Error("An unrelated seat inherited a prior game's credentials");
}

console.log("roomRecoverySync.test.js: all assertions passed");
