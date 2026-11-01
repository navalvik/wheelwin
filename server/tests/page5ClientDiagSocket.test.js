import assert from "node:assert/strict";
import { SocketGateway } from "../socket/SocketGateway.js";
import {
    getClientGameplaySyncSnapshot,
    resetClientGameplaySyncStoreForTests
} from "../forensic/ClientGameplaySyncStore.js";

// Directly call the observation-only handler. No gameplay runtime or wallet is created.
resetClientGameplaySyncStoreForTests();
const gateway = Object.create(SocketGateway.prototype);
gateway._gameplayContextResolver = {
    resolve: socketId => socketId === "bound-socket"
        ? { ok: true, roomId: "room-1", gameId: "game-1", playerId: "Olga" }
        : { ok: false, reason: "not bound" }
};
let ack;
const payload = {
    event: "PAGE5_SYNC_BATCH", roomId: "room-1", gameId: "game-1",
    playerId: "Olga",
    syncBatch: { clientSession:"session-1", batchId:"1",
        events:[{ kind:"ready_attempt", buttonEnabled:false, secret:"hidden" }] }
};
const receive = (sockId, p) => {
    ack = null;
    gateway._handlePage6ClientDiag({id:sockId},p,response=>{ack=response;});
    return ack;
};
assert.equal(receive("unbound",payload).reason,"BINDING_MISMATCH");
assert.equal(getClientGameplaySyncSnapshot("room-1").observed,false);
assert.equal(receive("bound-socket",{...payload,roomId:"other"}).reason,"BINDING_MISMATCH");
assert.equal(receive("bound-socket",{...payload,playerId:"Bob"}).reason,"BINDING_MISMATCH");
assert.equal(receive("bound-socket",{...payload,gameId:"other"}).reason,"BINDING_MISMATCH");
assert.equal(receive("bound-socket",payload).ok,true);
assert.equal(receive("bound-socket",payload).duplicate,true);
const events=getClientGameplaySyncSnapshot("room-1","game-1").players.Olga.events;
assert.equal(events.length,1);
assert.equal(events[0].secret,undefined);
resetClientGameplaySyncStoreForTests();
console.log("page5ClientDiagSocket: OK");
