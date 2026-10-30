import {
    isDuplicateOpenPage5,
    resolveOpenPage5GameKey,
    resolveOpenPage5Authorization
} from "./pageNavigationPolicy.js";

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const identity = { roomId: "room-a", gameId: "game-a" };
assert(resolveOpenPage5GameKey({ gameId: "game-b" }, identity) === "game-b",
    "the authoritative event gameId scopes Page5");
assert(isDuplicateOpenPage5("game-a", { gameId: "game-a" }, identity),
    "duplicate OPEN_PAGE5 for one game is idempotent");
assert(!isDuplicateOpenPage5("game-a", { gameId: "game-b" }, identity),
    "a distinct authorized game remains eligible");
assert(!isDuplicateOpenPage5("game-a", {}, { roomId: "room-b" }),
    "a different room is not conflated by a reused wallet or game key");

const authorizedIdentity = { roomId: "room-a", playerId: "player-a", gameId: "game-b" };
const serverOpenPage5 = { roomId: "room-a" };
const decision = resolveOpenPage5Authorization({
    payload: serverOpenPage5,
    identity: authorizedIdentity,
    currentPage: 4,
    lastOpenedGameKey: null,
    authorizedGame: { gameId: "game-b", previousGameId: "game-a" }
});
assert(decision?.gameId === "game-b" && decision.authoritativeNewGame,
    "roomId-only OPEN_PAGE5 uses a previously authenticated gameId");
assert(resolveOpenPage5Authorization({
    payload: serverOpenPage5,
    identity: authorizedIdentity,
    currentPage: 8,
    lastOpenedGameKey: "game-b",
    authorizedGame: { gameId: "game-b", previousGameId: "game-a" }
}) === null, "duplicate OPEN_PAGE5 cannot demote Page6");
assert(resolveOpenPage5Authorization({
    payload: serverOpenPage5,
    identity: authorizedIdentity,
    currentPage: 8,
    lastOpenedGameKey: "game-a",
    authorizedGame: null
}) === null, "unidentified OPEN_PAGE5 cannot demote Page6");
assert(resolveOpenPage5Authorization({
    payload: { roomId: "other-room" },
    identity: authorizedIdentity,
    currentPage: 4,
    lastOpenedGameKey: null,
    authorizedGame: null
}) === null, "stale other-room Page4 event is ignored");

console.log("pageNavigationPolicy.test.js: all assertions passed");
