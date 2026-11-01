import assert from "node:assert/strict";
import {
    createLatestFrameRenderer,
    MIN_CANVAS_FRAME_INTERVAL_MS
} from "./latestFrameRenderer.js";

function fakeAnimationFrames() {
    const scheduled = new Map();
    let nextId = 1;
    return {
        requestFrame(callback) {
            const id = nextId++;
            scheduled.set(id, callback);
            return id;
        },
        cancelFrame(id) {
            scheduled.delete(id);
        },
        tick(timestamp) {
            const batch = [...scheduled.values()];
            scheduled.clear();
            for (const callback of batch) callback(timestamp);
        },
        get pending() { return scheduled.size; }
    };
}

assert.equal(MIN_CANVAS_FRAME_INTERVAL_MS, 32);

const frames = fakeAnimationFrames();
let newestServerAngle = 0;
const paints = [];
const painter = createLatestFrameRenderer(() => {
    paints.push(newestServerAngle);
}, {
    requestFrame: callback => frames.requestFrame(callback),
    cancelFrame: id => frames.cancelFrame(id)
});

// A 100 Hz server may deliver ten authoritative poses before one display
// frame: render ONLY the newest, never ten queued old positions.
for (let i = 1; i <= 10; i++) {
    newestServerAngle = i * 7;
    painter.request();
}
assert.equal(frames.pending, 1);
frames.tick(100);
assert.deepEqual(paints, [70]);

// A slow device never accumulates old frames; the scheduled paint always
// reads the latest server pose, and the 30 FPS display limit is respected.
for (let i = 11; i <= 20; i++) {
    newestServerAngle = i * 7;
    painter.request();
}
frames.tick(116);
assert.deepEqual(paints, [70], "16 ms is too early for the next canvas draw");
assert.equal(frames.pending, 1);
frames.tick(133);
assert.deepEqual(paints, [70, 140], "draw the newest angle, not the earliest queued");

newestServerAngle = 189;
painter.request();
frames.tick(167);
assert.deepEqual(paints, [70, 140, 189]);

// Unmount cannot leave an orphan RAF callback using a removed Canvas.
painter.request();
assert.equal(frames.pending, 1);
painter.dispose();
assert.equal(frames.pending, 0);
painter.request();
frames.tick(500);
assert.deepEqual(paints, [70, 140, 189]);

assert.throws(() => createLatestFrameRenderer(null), TypeError);

console.log("latestFrameRenderer: all assertions passed");
