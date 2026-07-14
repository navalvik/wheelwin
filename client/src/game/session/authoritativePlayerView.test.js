import {
    formatAuthoritativePlayerCount,
    hasAuthoritativePlayers,
    listAuthoritativePlayers,
    mapAuthoritativePlayerToInfoRow
} from "./authoritativePlayerView.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

{

    assert(
        hasAuthoritativePlayers({}) === false,
        "empty map means players not ready"
    );

    assert(
        formatAuthoritativePlayerCount({}) === null,
        "missing players must not fabricate a count"
    );

    console.log("  empty / loading guards passed");

}

{

    const players = {
        p2: { playerId: "p2", nickname: "Bob" },
        p1: { playerId: "p1", nickname: "Alice" }
    };

    const listed = listAuthoritativePlayers(players);

    assert(listed.length === 2, "both authoritative players listed");

    assert(listed[0].playerId === "p1", "players sorted by id");

    assert(
        formatAuthoritativePlayerCount(players, 3) === "2 / 3",
        "count uses authoritative numerator"
    );

    const row = mapAuthoritativePlayerToInfoRow(listed[0], 0);

    assert(row.nickname === "Alice", "nickname passes through");

    assert(row.icon === "—", "missing icon is placeholder, not invented");

    assert(row.age === "—", "missing age is placeholder, not invented");

    console.log("  authoritative player mapping passed");

}

console.log("authoritativePlayerView.test.js: all assertions passed");
