import {
    isLocalPlayerWinner,
    resolveAuthoritativeWinnerPlayerId,
    resolvePersonalizedResultPresentation
} from "./personalizedResultPresentation.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

{

    assert(
        resolveAuthoritativeWinnerPlayerId({
            result: { winner: { id: "player_a" } }
        }) === "player_a",
        "result.winner.id should resolve"
    );

    assert(
        resolveAuthoritativeWinnerPlayerId({
            result: { winner: { playerId: "player_b" } }
        }) === "player_b",
        "result.winner.playerId should resolve"
    );

    assert(
        isLocalPlayerWinner("player_a", "player_a") === true,
        "local winner match"
    );

    assert(
        isLocalPlayerWinner("player_a", "player_b") === false,
        "local loser mismatch"
    );

    assert(
        resolvePersonalizedResultPresentation(true).headline === "YOU WIN",
        "winner headline"
    );

    assert(
        resolvePersonalizedResultPresentation(false).headline === "YOU LOST",
        "loser headline"
    );

    console.log("  personalized result presentation passed");

}

console.log("personalizedResultPresentation.test.js: all assertions passed");
