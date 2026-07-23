import assert from "node:assert/strict";

import { SessionWalletStore } from "../session/SessionWalletStore.js";

const store = new SessionWalletStore();

assert.equal(store.getWallet("room-1", "p1"), null);

store.setWallet("room-1", "p1", "EQaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

assert.equal(
    store.getWallet("room-1", "p1"),
    "EQaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
);

store.setWallet("room-1", "p2", "EQbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

assert.deepEqual(store.getRoomWallets("room-1"), {
    p1: "EQaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    p2: "EQbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
});

store.clearRoom("room-1");

assert.equal(store.getWallet("room-1", "p1"), null);

assert.deepEqual(store.getRoomWallets("room-1"), {});

console.log("sessionWalletStore.test.js: all assertions passed");
