import {
    formatAuthoritativeRoomId,
    formatAuthoritativeRoomPlayersDisplay,
    getAuthoritativeRoom,
    resolveRoomMaxPlayers
} from "./authoritativeRoomView.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

{

    const room = getAuthoritativeRoom({});

    assert(room.roomId === null, "room starts empty");

    assert(room.maxPlayers === null, "maxPlayers starts empty");

    assert(room.connectedCount === 0, "connected count starts at zero");

    assert(formatAuthoritativeRoomId(null) === null, "no fabricated room id");

    assert(formatAuthoritativeRoomId("8F4K2S") === "8F4K2S", "pass-through only");

    console.log("  empty room guards passed");

}

{

    const session = {
        roomId: "AB12CD",
        maxPlayers: null,
        players: {
            p1: { playerId: "p1" },
            p2: { playerId: "p2" }
        }
    };

    const room = getAuthoritativeRoom(session);

    assert(room.roomId === "AB12CD", "roomId from session");

    assert(room.connectedCount === 2, "connected count from players");

    assert(
        resolveRoomMaxPlayers(null, 3) === 3,
        "fallback maxPlayers kept when authoritative missing"
    );

    assert(
        resolveRoomMaxPlayers(4, 3) === 4,
        "authoritative maxPlayers preferred when present"
    );

    assert(
        formatAuthoritativeRoomPlayersDisplay(session.players, null, 3) === "2 / 3",
        "players display uses authoritative count + fallback max"
    );

    assert(
        formatAuthoritativeRoomId(room.roomId) === "AB12CD",
        "formatted room id matches server"
    );

    console.log("  authoritative room mapping passed");

}

console.log("authoritativeRoomView.test.js: all assertions passed");
