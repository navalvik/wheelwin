/**
 * R24.1 — client source-structure wiring for the Owner room-network
 * selection gate (focused, text-based; no JSX execution).
 *
 * Verifies:
 * 1. CreateRoomPanel renders the TESTNET/MAINNET selector for the room Owner
 *    while the authoritative room.network is null, driven by hydratable
 *    authoritative state (roomCreated AND roomState), and emits
 *    selectRoomNetwork exactly once per committed choice.
 * 2. Owner identification is derived from server-authoritative state
 *    (identity.playerId === roomState.ownerPlayerId), not exclusively from a
 *    single roomCreated event — so hydration re-appears the selector.
 * 3. Joiners (JoinRoomPanel) never receive network-selection controls.
 * 4. After authoritative selection the selector disappears and the network
 *    state renders via the existing UI (networkStatus).
 * 5. createRoomPanel.css contains structurally balanced network-selection
 *    rules (no unbalanced rule around .networkSelection).
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

const createRoomPanel = readSource("./CreateRoomPanel.jsx");

const joinRoomPanel = readSource("./JoinRoomPanel.jsx");

const roomDefaults = readSource("../utils/roomDefaults.js");

const translations = readSource("../i18n/translations.js");

const createRoomPanelCss = readSource("../styles/createRoomPanel.css");

const roomLobby = readSource("../pages/RoomLobby.jsx");

// ===== TESTS =====

// Test 1 — selector presence, hydration-safe inputs, one-time guard.
assert(
    createRoomPanel.includes('socket.on("roomCreated", handleRoomCreated)')
    && createRoomPanel.includes('socket.on("roomState", handleRoomState)')
    && createRoomPanel.includes(
        'socket.on("roomNetworkSelected", handleRoomNetworkSelected)'
    ),
    "CreateRoomPanel must listen to roomCreated, roomState and " +
    "roomNetworkSelected (hydration-safe, not a single event)"
);
assert(
    createRoomPanel.includes("network: data.network ?? prev.network ?? null")
    && createRoomPanel.includes(
        "ownerPlayerId: data.ownerPlayerId ?? prev.ownerPlayerId ?? null"
    ),
    "room payloads must hydrate network + ownerPlayerId into roomState"
);
assert(
    createRoomPanel.includes("identity?.playerId")
    && createRoomPanel.includes("identity.playerId === roomState.ownerPlayerId"),
    "isCreator must derive from authoritative identity vs ownerPlayerId"
);
assert(
    createRoomPanel.includes(
        "if (!isCreator || roomState.network || selectionPending) return;"
    ),
    "selection must be guarded: owner-only, uncommitted, not in-flight"
);
assert(
    createRoomPanel.includes('socket.emit("selectRoomNetwork", { network })'),
    "the panel must emit selectRoomNetwork with ONLY the requested network"
);

console.log("Test 1 — CreateRoomPanel owner selector wiring: passed");

// Test 2 — joiners never receive owner controls; no initDataUnsafe anywhere.
assert(
    !joinRoomPanel.includes("selectRoomNetwork")
    && !joinRoomPanel.includes("networkSelection")
    && !joinRoomPanel.includes("roomNetworkSelected"),
    "JoinRoomPanel must never contain network-selection controls"
);
assert(
    !createRoomPanel.includes("initDataUnsafe"),
    "client must never use initDataUnsafe"
);

console.log("Test 2 — joiner has no network-selection controls: passed");

// ===== TESTS PART 2 =====

// Test 3 — selector buttons, show-condition, network status, defaults, i18n.
assert(
    createRoomPanel.includes("ROOM_NETWORK_TESTNET")
    && createRoomPanel.includes("ROOM_NETWORK_MAINNET")
    && createRoomPanel.includes('"room.networkTestnet"')
    && createRoomPanel.includes('"room.networkMainnet"')
    && createRoomPanel.includes('"room.networkPrompt"'),
    "the selector must offer TESTNET and MAINNET to the Owner"
);
assert(
    createRoomPanel.includes("showNetworkSelector")
    && createRoomPanel.includes("roomState.roomCreated")
    && createRoomPanel.includes("&& !roomState.network"),
    "the selector renders only for the Owner while network is unset"
);
assert(
    createRoomPanel.includes('className="networkStatus"'),
    "the committed network must render via the networkStatus UI"
);
assert(
    roomDefaults.includes("network: null")
    && roomDefaults.includes("ownerPlayerId: null"),
    "roomDefaults must carry network + ownerPlayerId null defaults"
);
assert(
    translations.includes('"room.networkLabel"')
    && translations.includes('"room.networkPrompt"')
    && translations.includes('"room.networkTestnet"')
    && translations.includes('"room.networkMainnet"'),
    "translations must contain the room.network* keys"
);

console.log("Test 3 — selector UI, defaults + translations: passed");

// Test 4 — CSS structural integrity around the network rules.
const openBraces = (createRoomPanelCss.match(/\{/g) ?? []).length;

const closeBraces = (createRoomPanelCss.match(/\}/g) ?? []).length;

assert(
    openBraces > 0 && openBraces === closeBraces,
    "createRoomPanel.css must be structurally balanced (no unbalanced rule)"
);
assert(
    createRoomPanelCss.includes(".networkSelection{")
    && createRoomPanelCss.includes(".networkButtons{")
    && createRoomPanelCss.includes(".networkButton{")
    && createRoomPanelCss.includes(".networkStatus{"),
    "createRoomPanel.css must contain the network-selection rules"
);
assert(
    /networkSelection\{[^}]*\}/.test(
        createRoomPanelCss.replace(/\s+/g, "")
    ),
    ".networkSelection must be a complete rule, not split by an open block"
);

console.log("Test 4 — CSS structural integrity: passed");

// Test 5 — RoomLobby VERIFY transition remains startGame-driven.
assert(
    roomLobby.includes('socket.on("startGame", handleStartGame)')
    && roomLobby.includes("onNavigate(3)"),
    "RoomLobby must keep navigating to VERIFY (page 3) on authoritative " +
    "startGame only"
);
assert(
    !roomLobby.includes("selectRoomNetwork"),
    "RoomLobby must not host network-selection controls"
);

console.log("Test 5 — RoomLobby VERIFY transition unchanged: passed");

console.log("all assertions passed");
