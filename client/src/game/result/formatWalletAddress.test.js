import assert from "node:assert/strict";

import { formatWalletAddress } from "./formatWalletAddress.js";

assert.equal(formatWalletAddress(null), "");
assert.equal(formatWalletAddress(undefined), "");
assert.equal(formatWalletAddress(""), "");
assert.equal(formatWalletAddress("   "), "");
assert.equal(formatWalletAddress("EQB83s"), "EQB83s");
assert.equal(
    formatWalletAddress("EQB83s1234567890abcdefXYZ123"),
    "EQB83s...XYZ123"
);
assert.equal(
    formatWalletAddress("abcdefghijkl"),
    "abcdefghijkl"
);

console.log("formatWalletAddress.test.js passed");
