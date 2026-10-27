import test from "node:test";
import assert from "node:assert/strict";
import { RoomLobbyBridge } from "../socket/RoomLobbyBridge.js";

test("R2 archive starts after room destruction and cannot delay close", async () => {
    const calls = [];
    const roomId = "r2-close-test";
    const bridge = Object.create(RoomLobbyBridge.prototype);
    bridge._roomManager = {
        getRoom: () => ({ roomId, players: [] }),
        destroyRoom: () => { calls.push("destroy"); return true; }
    };
    bridge._logger = {
        decisionTrace: () => {},
        info: () => {},
        error: () => {}
    };
    bridge._recoveryCredentials = { invalidateRoom: () => {} };
    bridge._resultSessionLifecycle = null;
    bridge._gameplayContextResolver = {
        resolveGameIdByRoomId: () => "game-1",
        deactivateRoomGame: () => {}
    };
    bridge._setupSessionLifecycle = null;
    bridge._continueToVerifyByRoom = new Map();
    bridge._profilesRevealedByRoom = new Map();
    bridge._playerToSocket = new Map();
    bridge._roomCreators = new Map();
    bridge._roomNetworkByRoom = new Map();
    bridge._startedRooms = new Set();
    bridge._releaseRoomNetworkHandoff = () => {};
    bridge._releaseTelegramQuota = () => {};
    bridge._clearVerifyBarrier = () => {};
    bridge._deliverToRoom = () => {};
    bridge._cleanupPlayer = () => {};
    bridge._unregisterSocket = () => {};
    bridge._forensicArchiveService = {
        ensureArchivedAndUploaded: () => {
            calls.push("archive");
            // R2 network never responds; game teardown must still finish.
            return new Promise(() => {});
        }
    };

    await Promise.race([
        bridge._closeRoom(roomId, "setup_expired"),
        new Promise((_, reject) => setTimeout(() => reject(Error("room close blocked on R2")), 1000))
    ]);

    assert.deepEqual(calls, ["destroy", "archive"]);
});
