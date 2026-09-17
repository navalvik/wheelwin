/**
 * Pre-create payment network (task 2026-09-17) — client source-structure
 * wiring (focused, text-based; no JSX execution).
 *
 * Verifies:
 * 1. Page1: the old Page1 MAINNET Telegram Mini App handoff button is gone
 *    (Page1Welcome.jsx + GameLayout.jsx carry no Mainnet handoff markers).
 * 2. Page2: the red MAINNET payment button is rendered ABOVE CREATE ROOM,
 *    defaults to Testnet, toggles to Mainnet, and CREATE ROOM emits
 *    paymentNetwork over the existing createRoom event.
 * 3. Page2 hydration: authoritative paymentNetwork from roomCreated /
 *    roomState restores the toggle (join / reconnect).
 * 4. No wallet-address entry on Page2 (wallet entry stays on Page3).
 * 5. RoomLobby VERIFY transition remains startGame-driven.
 * 6. CSS: .mainnetPaymentButton exists with a red background.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

const currentDir = dirname(fileURLToPath(import.meta.url));

function readSource(relativePath) {

    return readFileSync(join(currentDir, relativePath), "utf8");

}

const page1Welcome = readSource("../pages/Page1Welcome.jsx");

const gameLayout = readSource("../layouts/GameLayout.jsx");

const createRoomPanel = readSource("./CreateRoomPanel.jsx");

const joinRoomPanel = readSource("./JoinRoomPanel.jsx");

const roomLobby = readSource("../pages/RoomLobby.jsx");

const createRoomPanelCss = readSource("../styles/createRoomPanel.css");

// Test 1 — Page1: legacy MAINNET Mini App handoff button is absent.
for (const [name, source] of [
    ["Page1Welcome.jsx", page1Welcome],
    ["GameLayout.jsx", gameLayout]
]) {

    assert(
        !source.includes("MAINNET_MINI_APP_DEEP_LINK")
            && !source.includes("startapp=mainnet")
            && !source.includes("handleMainnetClick")
            && !source.includes("showMainnetSwitch"),
        `${name} must no longer host the legacy Mainnet handoff button`
    );

}

console.log("Test 1 — Page1 legacy MAINNET handoff absent: passed");

// Test 2 — Page2: MAINNET button above CREATE ROOM, default Testnet,
// toggle, and CREATE ROOM emits paymentNetwork.
assert(
    createRoomPanel.includes("PAYMENT_NETWORK_TESTNET")
    && createRoomPanel.includes("PAYMENT_NETWORK_MAINNET"),
    "CreateRoomPanel must define the testnet/mainnet payment constants"
);

const defaultState =
    /useState\(\s*PAYMENT_NETWORK_TESTNET\s*\)/.test(createRoomPanel);

assert(
    defaultState,
    "the pre-create payment selection must default to Testnet"
);

const mainnetButtonIndex = createRoomPanel.indexOf("mainnetPaymentButton");

const createButtonIndex = createRoomPanel.indexOf(
    'className={`primaryButton'
);

assert(
    mainnetButtonIndex !== -1 && createButtonIndex !== -1,
    "both the MAINNET payment button and the CREATE ROOM button must exist"
);
assert(
    mainnetButtonIndex < createButtonIndex,
    "the MAINNET payment button must render ABOVE CREATE ROOM"
);
assert(
    createRoomPanel.includes(
        "selectedPaymentNetwork === PAYMENT_NETWORK_MAINNET"
    )
        && createRoomPanel.includes('"mainnetPaymentButton selected"'),
    "the MAINNET button must reflect the selected state"
);
assert(
    /toggleMainnet/.test(createRoomPanel)
        && /current === PAYMENT_NETWORK_MAINNET\s*\?\s*PAYMENT_NETWORK_TESTNET\s*:\s*PAYMENT_NETWORK_MAINNET/
            .test(createRoomPanel),
    "clicking MAINNET must toggle the selection to Mainnet (and back)"
);
assert(
    createRoomPanel.includes('socket.emit("createRoom"')
        && createRoomPanel.includes(
            "paymentNetwork: selectedPaymentNetwork"
        ),
    "CREATE ROOM must emit paymentNetwork over createRoom"
);

console.log("Test 2 — Page2 MAINNET button + createRoom payload: passed");

// Test 3 — Page2 hydration: authoritative paymentNetwork restores the toggle.
assert(
    createRoomPanel.includes('socket.on("roomCreated", handleRoomCreated)')
    && createRoomPanel.includes('socket.on("roomState", handleRoomState)'),
    "CreateRoomPanel must listen to roomCreated and roomState"
);
assert(
    createRoomPanel.includes(
        "paymentNetwork: data.paymentNetwork ?? prev.paymentNetwork"
    ),
    "room payloads must hydrate paymentNetwork into roomState"
);
assert(
    createRoomPanel.includes(
        "setSelectedPaymentNetwork(data.paymentNetwork)"
    ),
    "authoritative paymentNetwork must restore the Page2 toggle"
);

// Test 4 — Page2 hosts NO wallet-address entry (wallet entry stays on Page3).
assert(
    !/wallet/i.test(createRoomPanel),
    "Page2 must not contain wallet-address entry (Page3 owns wallet entry)"
);
assert(
    !joinRoomPanel.includes("paymentNetwork"),
    "JoinRoomPanel must not carry payment-selection controls"
);

console.log("Test 3/4 — Page2 hydration + no Page2 wallet entry: passed");

// Test 5 — RoomLobby VERIFY transition remains startGame-driven.
assert(
    roomLobby.includes('socket.on("startGame", handleStartGame)')
    && roomLobby.includes("onNavigate(3)"),
    "RoomLobby must keep navigating to VERIFY (page 3) on authoritative "
        + "startGame only"
);
assert(
    !roomLobby.includes("paymentNetwork")
        && !roomLobby.includes("selectRoomNetwork"),
    "RoomLobby must not host payment-network selection controls"
);

console.log("Test 5 — RoomLobby VERIFY transition unchanged: passed");

// Test 6 — CSS: red MAINNET payment button styles exist.
assert(
    createRoomPanelCss.includes(".mainnetPaymentButton{"),
    "createRoomPanel.css must contain the .mainnetPaymentButton rule"
);
assert(
    /\.mainnetPaymentButton\{[^}]*background:#DC2626/s.test(
        createRoomPanelCss
    ),
    "the MAINNET payment button must have a red background (#DC2626)"
);
assert(
    (createRoomPanelCss.match(/\{/g) ?? []).length
        === (createRoomPanelCss.match(/\}/g) ?? []).length,
    "createRoomPanel.css must remain structurally balanced"
);

console.log("Test 6 — MAINNET button red CSS present: passed");

console.log("all assertions passed");


