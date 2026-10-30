import {
    APP_PAGES,
    resolveRoomRecoveryPage,
    shouldAcceptRoomRecoverySync
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

console.log("roomRecoverySync.test.js: all assertions passed");
