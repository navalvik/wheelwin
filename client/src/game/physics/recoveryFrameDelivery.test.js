import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createPhysicsFrameStore } from "./physicsFrameStore.js";

const store = createPhysicsFrameStore();
const calls = [];
const engine = {
    writeSnapshot(frame) {
        frame.wheelAngle = 143;
        frame.triangleAngle = 274;
        frame.isBraking = true;
        return frame;
    }
};
store.subscribeFrame(() => {
    calls.push({ kind: "canvas", wheel: store.getFrame().wheelAngle });
});
store.subscribeDiscrete(() => {
    calls.push({ kind: "discrete", angle: store.getFrame().triangleAngle });
});
store.publishFrame(engine);
store.publishDiscrete(engine);
assert.deepEqual(calls, [
    { kind: "canvas", wheel: 143 },
    { kind: "discrete", angle: 274 }
]);
const source = readFileSync(resolve(
    dirname(fileURLToPath(import.meta.url)), "../../context/PhysicsContext.jsx"
), "utf8");
assert.match(source,
    /restorePhysics:\s*\(snapshot\)\s*=>\s*\{[\s\S]*?restoreSessionSnapshot\(snapshot\);[\s\S]*?frameStore\.publishFrame\(engineRef\.current\);[\s\S]*?publishDiscrete\(\);/,
    "a recovered authoritative pose must refresh canvas frame subscribers");
console.log("recoveryFrameDelivery: all assertions passed");
