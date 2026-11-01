import assert from "node:assert/strict";
import { resolveReadyPlayerId, isLocalPlayerReady } from "./readyIdentity.js";

const context = {
    identity: { playerId: "player_Olga" },
    setIdentity() {}, clearIdentity() {}, getIdentity() {}
};
assert.equal(resolveReadyPlayerId(context), "player_Olga");
assert.equal(resolveReadyPlayerId({ playerId: "wrong_flat_shape" }), null);
assert.equal(resolveReadyPlayerId({ identity: null }), null);
assert.equal(resolveReadyPlayerId({ identity: {} }), null);
assert.equal(resolveReadyPlayerId(null), null);
assert.equal(isLocalPlayerReady({ player_Olga: true, player_Bob: false }, "player_Olga"), true);
assert.equal(isLocalPlayerReady({ player_Olga: true, player_Bob: false }, "player_Bob"), false);
assert.equal(isLocalPlayerReady({ player_Olga: true }, null), false);
assert.equal(isLocalPlayerReady({ player_Olga: true }, undefined), false);
assert.equal(isLocalPlayerReady({}, "player_Olga"), false);
console.log("readyIdentity: all assertions passed");
