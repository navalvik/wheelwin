import assert from "node:assert/strict";

import { SECTOR_COLOR_OPTIONS } from "./sectorColors.js";

const EXPECTED = [
    "Red",
    "Green",
    "Blue",
    "Yellow",
    "Orange",
    "Violet",
    "Light Blue",
    "Light Green",
    "Light Red",
    "Beige"
];

assert.equal(
    SECTOR_COLOR_OPTIONS.length,
    10,
    "PLAYER SETUP must expose 10 sector colors"
);

assert.deepEqual(
    [...SECTOR_COLOR_OPTIONS],
    EXPECTED,
    "sector color catalog must match R5.12A specification"
);

console.log("sectorColors.test.js: all assertions passed");
