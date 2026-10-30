import {
    isDuplicateOpenPage5,
    resolveOpenPage5GameKey
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

console.log("pageNavigationPolicy.test.js: all assertions passed");
