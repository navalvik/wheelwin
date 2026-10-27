import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { bindPage4PaymentStatusRecovery } from "../pages/page4PaymentStatusRecovery";
import { OUTGOING_SOCKET_EVENTS } from "../socket/socketEvents";

class FakeSocket extends EventEmitter {
    connected = false;
    requests = [];

    emit(event, payload) {
        if (event === OUTGOING_SOCKET_EVENTS.PAYMENT_STATUS_REQUEST) {
            this.requests.push(payload);
            return true;
        }
        return super.emit(event, payload);
    }
}

{
    const socket = new FakeSocket();
    const stop = bindPage4PaymentStatusRecovery(socket, {
        roomId: "room-1", playerId: "player-1"
    });

    assert.equal(socket.requests.length, 0,
        "no stale request is queued while offline");

    socket.connected = true;
    socket.emit("connect");
    assert.deepEqual(socket.requests, [{ roomId: "room-1", playerId: "player-1" }],
        "first connect asks for authoritative status");

    socket.connected = false;
    socket.emit("disconnect");
    assert.equal(socket.requests.length, 1,
        "disconnect never implies a payment status");

    socket.connected = true;
    socket.emit("connect");
    assert.equal(socket.requests.length, 2,
        "reconnect asks for fresh authoritative status");

    stop();
    socket.emit("connect");
    assert.equal(socket.requests.length, 2,
        "unmounted Page4 never sends another request");
}

{
    const socket = new FakeSocket();
    socket.connected = true;
    const stopFirst = bindPage4PaymentStatusRecovery(socket, {
        roomId: "room-1", playerId: "player-1"
    });
    stopFirst();
    const stopSecond = bindPage4PaymentStatusRecovery(socket, {
        roomId: "room-1", playerId: "player-2"
    });
    assert.deepEqual(socket.requests, [
        { roomId: "room-1", playerId: "player-1" },
        { roomId: "room-1", playerId: "player-2" }
    ], "same-room player identity change re-requests the right status");
    stopSecond();
}

{
    const socket = new FakeSocket();
    socket.connected = true;
    const stop = bindPage4PaymentStatusRecovery(socket, {
        roomId: null, playerId: "player-1"
    });
    socket.emit("connect");
    assert.equal(socket.requests.length, 0, "missing identity never requests");
    stop();
}

process.stdout.write("page4PaymentStatusRecovery.test.js: all assertions passed\\n");
