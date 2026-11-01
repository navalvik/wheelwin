import assert from "node:assert/strict";
import { EngineBridge } from "../../socket/EngineBridge.js";
import { SessionRecoveryEngine } from "./SessionRecoveryEngine.js";

const names = {
    wheel: "restoreWheel",
    physics: "restorePhysics",
    gameState: "restoreGameState",
    gameClock: "restoreClock",
    playerUI: "restorePlayerUI",
    button: "restoreButton",
    audio: "restoreAudio",
    winnerResolver: "restoreWinnerResult"
};
const calls = [];
const bridge = new EngineBridge();
for (const [moduleName, method] of Object.entries(names)) {
    const api = {
        [method](snapshot) {
            assert.equal(this, api, "restorer uses its registered module object");
            assert.ok(snapshot && typeof snapshot === "object");
            calls.push({ moduleName, gameState: snapshot.gameState, wheelAngle: snapshot.physics?.wheelAngle });
        }
    };
    bridge.register(moduleName, api);
}
const engine = new SessionRecoveryEngine({
    localPlayerId: "player_olga",
    getModules: () => bridge.getModules(),
    onStateChange: () => {}
});
const brake = {
    timestamp: 1793545214801, roomId: "JNcR", playerId: "player_olga",
    gameId: "game_jncr", gameState: "BRAKE",
    physics: { wheelAngle: 119.5, triangleAngle: 24.1, isBraking: true },
    remainingGameTime: 5200
};
const normalized = engine.restoreSession(brake);
assert.equal(normalized.gameState, "BRAKE");
assert.equal(normalized.physics.wheelAngle, 119.5);
assert.deepEqual(calls.map(x => x.moduleName), [
    "wheel", "physics", "gameState", "gameClock", "playerUI", "button", "audio"
]);
assert.equal(calls.find(x => x.moduleName === "physics").wheelAngle, 119.5);
assert.equal(engine.getStatus().recoveredGameState, "BRAKE");
// Repeated delivery of the same snapshot must be idempotent.
engine.restoreSession(brake);
assert.equal(calls.length, 7, "no replay of duplicate BRAKE restore");
const result = {
    ...brake, timestamp: brake.timestamp + 6000,
    gameState: "RESULT", gameResult: { winnerPlayerId: "player_bob" }
};
engine.restoreSession(result);
assert.equal(calls.filter(x => x.moduleName === "winnerResolver").length, 1);
assert.equal(engine.getStatus().recoveredGameState, "RESULT");
// A registered module's own method must be called, never a flattened alias.
assert.equal(engine.restoreModule("physics", normalized, { restorePhysics() {
    throw Error("Must never use flattened restoration API");
} }), false);
console.log("SessionRecoveryEngine.moduleDispatch: all assertions passed");
