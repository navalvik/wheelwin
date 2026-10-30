import { EngineBridge } from "./EngineBridge.js";
import { INCOMING_SOCKET_EVENTS } from "./socketEvents.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { resolveOpenPage5Authorization } from "../game/sessionRecovery/pageNavigationPolicy.js";
import { APP_PAGES, shouldBlockNavigationRegression } from "../game/sessionRecovery/recoveryFlow.js";

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const serverSource = readFileSync(resolve(
    fileURLToPath(new URL("../../../server/socket/RoomLobbyBridge.js", import.meta.url))
), "utf8");
assert(/_deliverOpenPage5[\s\S]*?LOBBY_SERVER_EVENTS\.OPEN_PAGE5,[\s\S]*?\{\s*roomId\s*\}/.test(serverSource),
    "production OPEN_PAGE5 payload contract is roomId-only");
assert(/LOBBY_SERVER_EVENTS\.GAME_START_AUTHORIZED,[\s\S]*?gameId:\s*gameStart\.gameId/.test(serverSource),
    "production authorization event provides the authenticated gameId");

const bridge = new EngineBridge();
const navigations = [];
let authenticatedGameId = null;
let previousGameId = null;
const identity = { roomId: "room-a", playerId: "player-a", gameId: "game-old" };
let lastOpenedGameId = null;
bridge.register("pageNavigation", {
    onPaymentStageReady: () => navigations.push("PAYMENT"),
    onGameStartAuthorized: payload => {
        if (payload.roomId !== identity.roomId) return;
        previousGameId = identity.gameId;
        authenticatedGameId = payload.gameId;
        identity.gameId = payload.gameId;
    },
    onOpenPage5: payload => {
        const decision = resolveOpenPage5Authorization({
            payload,
            identity,
            currentPage: 4,
            lastOpenedGameKey: lastOpenedGameId,
            authorizedGame: authenticatedGameId
                ? { gameId: authenticatedGameId, previousGameId }
                : null
        });
        if (!decision) return null;
        lastOpenedGameId = decision.gameId;
        navigations.push(`GAMEPLAY:${decision.gameId}`);
        return { gameId: decision.gameId };
    }
});
bridge.register("gameResult", { onOpenPage5: payload => navigations.push(`RESULT:${payload.gameId}`) });
const handlers = bridge.createDispatcherHandlers();

assert(navigations.length === 0, "no Page5 before authoritative OPEN_PAGE5");
handlers[INCOMING_SOCKET_EVENTS.GAME_START_AUTHORIZED]({ roomId: "room-a", gameId: "game-a" });
assert(navigations.length === 0, "authorization alone never opens Page5");
handlers[INCOMING_SOCKET_EVENTS.OPEN_PAGE5]({ roomId: "room-a" });
assert(navigations.includes("GAMEPLAY:game-a"),
    "roomId-only production OPEN_PAGE5 uses authenticated session gameId");
assert(navigations.includes("RESULT:game-a"),
    "all registered clients receive the same roomId-only OPEN_PAGE5 identity");
handlers[INCOMING_SOCKET_EVENTS.OPEN_PAGE5]({ roomId: "room-a" });
assert(navigations.filter(value => value === "GAMEPLAY:game-a").length === 1,
    "duplicate OPEN_PAGE5 is idempotent");
handlers[INCOMING_SOCKET_EVENTS.OPEN_PAGE5]({ roomId: "room-other" });
assert(navigations.filter(value => value === "GAMEPLAY:game-a").length === 1,
    "OPEN_PAGE5 from another room is ignored");

const secondClient = new EngineBridge();
const secondClientNavigations = [];
let secondClientIdentity = { roomId: "room-a", playerId: "player-b", gameId: "game-old" };
let secondClientAuth = null;
let secondClientLastOpen = null;
secondClient.register("pageNavigation", {
    onGameStartAuthorized: payload => {
        secondClientAuth = { gameId: payload.gameId, previousGameId: secondClientIdentity.gameId };
        secondClientIdentity = { ...secondClientIdentity, gameId: payload.gameId };
    },
    onOpenPage5: payload => {
        const decision = resolveOpenPage5Authorization({
            payload,
            identity: secondClientIdentity,
            currentPage: APP_PAGES.PAYMENT,
            lastOpenedGameKey: secondClientLastOpen,
            authorizedGame: secondClientAuth
        });
        if (!decision) return null;
        secondClientLastOpen = decision.gameId;
        secondClientNavigations.push(decision.gameId);
        return { gameId: decision.gameId };
    }
});
const secondClientHandlers = secondClient.createDispatcherHandlers();
secondClientHandlers[INCOMING_SOCKET_EVENTS.GAME_START_AUTHORIZED](
    { roomId: "room-a", gameId: "game-a" }
);
secondClientHandlers[INCOMING_SOCKET_EVENTS.OPEN_PAGE5]({ roomId: "room-a" });
assert(secondClientNavigations[0] === "game-a",
    "another connected client independently processes room-wide OPEN_PAGE5");
assert(shouldBlockNavigationRegression(APP_PAGES.GAMEPLAY, APP_PAGES.PAYMENT),
    "late Page4/payment event cannot demote Page5");

console.log("page5Authorization.test.js: all assertions passed");
