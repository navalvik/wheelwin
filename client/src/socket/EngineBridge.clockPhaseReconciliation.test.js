import assert from "node:assert/strict";
import { EngineBridge } from "./EngineBridge.js";
import { INCOMING_SOCKET_EVENTS } from "./socketEvents.js";

const calls = [];
const bridge = new EngineBridge();
bridge.register("gameClock", { onClockUpdate: (p) => calls.push(["clock", p.phase]) });
bridge.register("gameState", { onClockUpdate: (p) => calls.push(["state", p.phase]) });
bridge.register("authoritativeSession", {
    onClockUpdate: (p) => calls.push(["session", p.phase])
});
const dispatch = bridge.createDispatcherHandlers();
dispatch[INCOMING_SOCKET_EVENTS.GAME_CLOCK_UPDATE]({
    phase: "PRE_GAME_READY", gameId: "gZde"
});
assert.deepEqual(calls, [
    ["clock", "PRE_GAME_READY"],
    ["state", "PRE_GAME_READY"],
    ["session", "PRE_GAME_READY"]
]);
// The bridge is the sole fan-out; registering no module remains harmless.
const empty = new EngineBridge().createDispatcherHandlers();
assert.doesNotThrow(() => empty[INCOMING_SOCKET_EVENTS.GAME_CLOCK_UPDATE]({
    phase: "RESULT", gameId: "gZde"
}));
console.log("EngineBridge.clockPhaseReconciliation: all assertions passed");
