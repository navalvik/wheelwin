import assert from "node:assert/strict";
import {
    recordClientGameplaySyncBatch,
    getClientGameplaySyncSnapshot,
    resetClientGameplaySyncStoreForTests
} from "../forensic/ClientGameplaySyncStore.js";

resetClientGameplaySyncStoreForTests();
const identity = { roomId: "ROOMA", gameId: "GAMEA", playerId: "Olga" };
function record(batch, extra = {}) {
    return recordClientGameplaySyncBatch({
        ...identity, ...extra,
        rawBatch: { clientSession: "session-1", batchId: "1",
            events: [{ kind: "ready_attempt", phase: "PRE_GAME_READY",
                wallet: "must-not-appear", token: "never",
                buttonEnabled: false, reason: "a".repeat(200) }], ...batch }
    });
}
assert.deepEqual(record({}), { ok: true, duplicate: false, accepted: 1 });
assert.deepEqual(record({}), { ok: true, duplicate: true, accepted: 0 });
let snapshot = getClientGameplaySyncSnapshot("ROOMA", "GAMEA");
assert.equal(snapshot.observed, true);
assert.equal(snapshot.players.Olga.events.length, 1);
assert.equal(snapshot.players.Olga.events[0].wallet, undefined);
assert.equal(snapshot.players.Olga.events[0].token, undefined);
assert.equal(snapshot.players.Olga.events[0].reason.length, 80);
assert.equal(snapshot.players.Olga.events[0].buttonEnabled, false);
assert.equal(record({ batchId: "2", events: Array(33).fill({kind:"sample"}) }).ok, false);
assert.equal(record({ batchId: "3" }, { gameId: "DIFFERENT" }).reason, "GAME_MISMATCH");
assert.equal(record({}, { roomId: null }).reason, "INVALID_BINDING");
assert.equal(record({ batchId: "4", events: [{kind:"sample", privateKey:"secret"}] }, {
    playerId: "Bob"
}).ok, true);
assert.equal(record({ batchId: "5", events: [{kind:"sample"}] }, {
    playerId: "Lena"
}).ok, true);
assert.equal(record({ batchId: "6", events: [{kind:"sample"}] }, {
    playerId: "Fourth"
}).reason, "PLAYER_LIMIT");
for (let i = 0; i < 250; i++) {
    assert.equal(record({ batchId: String(i + 10), events: [{kind:"sample", sequence:i}] }).ok, true);
}
snapshot = getClientGameplaySyncSnapshot("ROOMA");
assert.equal(snapshot.players.Olga.events.length, 240);
assert.equal(snapshot.players.Olga.events.at(-1).sequence, 249);
resetClientGameplaySyncStoreForTests();
assert.equal(getClientGameplaySyncSnapshot("ROOMA").observed, false);
console.log("clientGameplaySyncStore: OK");
