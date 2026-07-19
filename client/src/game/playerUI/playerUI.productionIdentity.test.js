import { PlayerUIEngine } from "./PlayerUIEngine.js";
import { PLAYER_UI_STATES } from "./PlayerState.js";
import { WinnerResolver } from "../winner/WinnerResolver.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

{
    const engine = new PlayerUIEngine();

    assert(engine.getPlayers().length === 0, "PlayerUI starts empty (no DEV roster)");

    engine.syncFromAuthoritativeRoster([
        {
            playerId: "uuid-a",
            nickname: "Ada",
            icon: "dice",
            color: "#f00",
            wallet: "EQaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        {
            playerId: "uuid-b",
            nickname: "Bob",
            icon: "spade"
        },
        {
            playerId: "uuid-c",
            nickname: "Cid",
            icon: "queen"
        }
    ]);

    assert(engine.getPlayers().length === 3, "roster seeds three authoritative seats");

    assert(engine.getPlayer("uuid-a")?.nickname === "Ada", "lookup by UUID");

    assert(engine.getPlayer(1) === null, "numeric DEV ids are not used");

    engine.updatePlayer({
        playerId: "uuid-b",
        state: PLAYER_UI_STATES.SPEED
    });

    assert(
        engine.getPlayer("uuid-b")?.state === PLAYER_UI_STATES.SPEED,
        "PLAYER_UPDATE locates by authoritative playerId"
    );

    engine.applyGameResult("uuid-a");

    assert(
        engine.getPlayer("uuid-a")?.state === PLAYER_UI_STATES.WIN,
        "winner panel uses authoritative id"
    );

    assert(
        engine.getPlayer("uuid-b")?.state === PLAYER_UI_STATES.LOST,
        "losers use authoritative id"
    );

    console.log("  PlayerUIEngine authoritative roster passed");
}

{
    const resolver = new WinnerResolver();

    resolver.setLocalPlayerId("uuid-local");

    const result = resolver.applyServerResult({
        winner: {
            id: "uuid-local",
            nickname: "You",
            icon: "dice"
        },
        winningSector: {
            index: 0,
            color: "#0f0",
            icon: "dice"
        }
    });

    assert(result.localOutcome === "WIN", "local WIN matches authoritative id");

    resolver.reset();

    resolver.setLocalPlayerId("uuid-local");

    const loss = resolver.applyServerResult({
        winner: {
            id: "uuid-other",
            nickname: "Peer",
            icon: "spade"
        },
        winningSector: {
            index: 1,
            color: "#00f",
            icon: "spade"
        }
    });

    assert(loss.localOutcome === "LOSE", "local LOSE matches authoritative id");

    console.log("  WinnerResolver authoritative localPlayerId passed");
}

console.log("playerUI.productionIdentity.test.js: all assertions passed");
