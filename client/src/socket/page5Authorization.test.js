import { EngineBridge } from "./EngineBridge.js";
import { INCOMING_SOCKET_EVENTS } from "./socketEvents.js";

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

for (const gameMode of ["FRIENDS", "NO_FRIENDS"]) {
    const bridge = new EngineBridge();
    const navigations = [];
    bridge.register("pageNavigation", {
        onPaymentStageReady: () => navigations.push("PAYMENT"),
        onOpenPage5: payload => navigations.push(`GAMEPLAY:${payload.gameId}`)
    });
    const handlers = bridge.createDispatcherHandlers();

    // 2/3 settled is not a client navigation event. Only OPEN_PAGE5 from the
    // authoritative server handler can advance the connected clients.
    assert(navigations.length === 0, `${gameMode}: no navigation before OPEN_PAGE5`);
    handlers[INCOMING_SOCKET_EVENTS.OPEN_PAGE5]({ roomId: "room-a", gameId: "game-a" });
    assert(navigations.length === 1 && navigations[0] === "GAMEPLAY:game-a",
        `${gameMode}: authoritative OPEN_PAGE5 is dispatched to navigation`);
}

console.log("page5Authorization.test.js: all assertions passed");
