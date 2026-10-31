import assert from "node:assert/strict";
import {
    STALE_GAMEPLAY_PHASE_GRACE_MS,
    shouldRequestStaleGameplayPhaseRecovery
} from "./staleGameplayPhasePolicy.js";

const now = 100_000;
const args = {
    currentPage: 7,
    gameplayPage: 7,
    phase: "SPEED",
    gameId: "game-o32D",
    clockGameId: "game-o32D",
    endsAt: now - STALE_GAMEPLAY_PHASE_GRACE_MS - 1,
    now,
    connected: true,
    recoveryInFlight: false
};
assert.equal(shouldRequestStaleGameplayPhaseRecovery(args), true,
    "connected client stuck at SPINNING 00:00 requests server snapshot");
for (const phase of ["READY", "SELF_TEST", "SPEED", "BRAKE", "RESULT"]) {
    assert.equal(shouldRequestStaleGameplayPhaseRecovery({ ...args, phase }), true,
        "old authoritative phase " + phase + " may request recovery");
}
assert.equal(shouldRequestStaleGameplayPhaseRecovery({
    ...args,
    endsAt: now - STALE_GAMEPLAY_PHASE_GRACE_MS + 1
}), false, "active/new deadline must not trigger early recovery");
assert.equal(shouldRequestStaleGameplayPhaseRecovery({
    ...args, connected: false
}), false, "socket disconnect uses existing recovery path");
assert.equal(shouldRequestStaleGameplayPhaseRecovery({
    ...args, recoveryInFlight: true
}), false, "never duplicate in-flight authenticated recovery");
assert.equal(shouldRequestStaleGameplayPhaseRecovery({
    ...args, clockGameId: "other-game"
}), false, "never recover using stale clock from another game");
assert.equal(shouldRequestStaleGameplayPhaseRecovery({
    ...args, currentPage: 8
}), false, "Page6 remains untouched until FINISH");
assert.equal(shouldRequestStaleGameplayPhaseRecovery({
    ...args, phase: "PRE_GAME_READY"
}), false, "preparation is not changed by phase-staleness policy");
assert.equal(shouldRequestStaleGameplayPhaseRecovery({
    ...args, phase: null
}), false, "missing authoritative phase is not guessed");
assert.equal(shouldRequestStaleGameplayPhaseRecovery({
    ...args, gameId: null
}), false, "unbound gameplay identity cannot trigger request");
console.log("staleGameplayPhasePolicy.test.js: all assertions passed");
