import {
    formatAuthoritativePlayerCount,
    hasAuthoritativePlayers,
    listAuthoritativePlayers,
    mapAuthoritativePlayerToInfoProp
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
        p2: { playerId: "p2", nickname: "Bob", sectorCount: 1 },
        p1: {
            playerId: "p1",
            nickname: "Alice",
            sectorCount: 2,
            sectorLabel: "TOGETHER SECTORS",
            sectorValue: "2"
        }
    };

    const listed = listAuthoritativePlayers(players);

    assert(listed.length === 2, "both authoritative players listed");

    assert(listed[0].playerId === "p1", "players sorted by id");

    assert(
        formatAuthoritativePlayerCount(players, 3) === "2 / 3",
        "count uses authoritative numerator"
    );

    const localRow = mapAuthoritativePlayerToInfoProp(listed[0], 0, {
        localPlayerId: "p1",
        baseStake: 1
    });

    assert(localRow.nickname === "Alice", "nickname passes through");

    assert(localRow.isLocal === true, "local match uses authoritative playerId");

    assert(
        localRow.labelTitle === "PLAYER 1 — YOU",
        "local card label must identify YOU"
    );

    assert(
        localRow.paymentGram === 2.5,
        "2 sectors → BaseStake × 2.5"
    );

    const otherRow = mapAuthoritativePlayerToInfoProp(listed[1], 1, {
        localPlayerId: "p1",
        baseStake: 1
    });

    assert(otherRow.isLocal === false, "non-local player is not marked YOU");

    assert(
        otherRow.labelTitle === "PLAYER 2",
        "non-local label uses ordinal only"
    );

    assert(
        otherRow.paymentGram === 1,
        "1 sector → BaseStake"
    );

    const tenStake = mapAuthoritativePlayerToInfoProp(listed[0], 0, {
        localPlayerId: "p2",
        baseStake: 10
    });

    assert(
        tenStake.isLocal === false,
        "identity is not array order — p1 is not local when localPlayerId is p2"
    );

    assert(
        tenStake.paymentGram === 25,
        "2 sectors at stake 10 → 25"
    );

    assert(localRow.icon === "—", "missing icon is placeholder, not invented");

    assert(localRow.age === "—", "missing age is placeholder, not invented");

    console.log("  authoritative player mapping passed");

}

{

    const redacted = mapAuthoritativePlayerToInfoProp(
        {
            playerId: "p2",
            nickname: null,
            age: null,
            icon: null,
            sectorCount: null,
            sectorValue: null
        },
        1,
        {
            localPlayerId: "p1",
            baseStake: 10
        }
    );

    assert(
        redacted.nickname === "—",
        "redacted nickname stays placeholder"
    );

    assert(
        redacted.paymentDisplay === "—",
        "redacted peers must not show fabricated payment"
    );

    assert(
        redacted.paymentGram === null,
        "redacted peers have no paymentGram"
    );

    console.log("  verify barrier redaction mapping passed");

}

console.log("authoritativePlayerView.test.js: all assertions passed");
