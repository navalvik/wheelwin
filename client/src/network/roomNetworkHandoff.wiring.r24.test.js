/**
 * R24 — wiring/structure tests for the client-side room network handoff.
 *
 * The Node client harness has no JSX loader (client/scripts/register.js only
 * appends `.js` for extensionless relative imports), so component wiring is
 * verified against the REAL component sources (same approach as the
 * R18-S109 HeaderBar handoff test): assertions run against verbatim source,
 * never against copies.
 *
 * Covered invariants:
 *  1. Page1 exposes NO Mainnet entry (SHOW_MAINNET_SWITCH=false and Page1
 *     passes the flag through; no hardcoded true anywhere).
 *  2. CreateRoomPanel consumes the Owner-only roomNetworkHandoffReady event
 *     with proper cleanup; the handler is guarded to the Testnet runtime,
 *     validates minimally, stores the handoff, and launches Mainnet.
 *  3. The handoffId never enters room-wide state (no setRoomState in the
 *     handoff handler) and is never displayed.
 *  4. The Mainnet bootstrap component emits `roomNetworkHandoffBootstrapRequest`
 *     with EXACTLY { handoffId } — no identity/room fields.
 *  5. The bootstrap result clears the temporary handoff; RETRY_REQUIRED /
 *     UNAVAILABLE retain it; INVALID is definitive (cleared, no fallback).
 *  6. The bootstrap component never emits createRoom (no CREATE_ROOM
 *     fallback) and never fabricates room state.
 *  7. App.jsx mounts the bootstrap component at the flow root.
 *  8. The Testnet room is not destroyed on transition: no leaveRoom /
 *     roomClosed emission in the handoff path.
 *  9. The socket handshake auth still forwards ONLY telegramInitData
 *     (fresh Mainnet initData; nothing handoff-related is injected).
 */

import { readFileSync } from "node:fs";

import assert from "node:assert/strict";

import { dirname, join } from "node:path";

import { fileURLToPath } from "node:url";

import { SHOW_MAINNET_SWITCH } from "../config/features.js";

const currentDir = dirname(fileURLToPath(import.meta.url));

const srcDir = join(currentDir, "..");

function readSource(relativePath) {

    return readFileSync(join(srcDir, relativePath), "utf8");

}

// 1 — Page1 exposes no Mainnet entry.

{

    assert.equal(
        SHOW_MAINNET_SWITCH,
        false,
        "the Page1 Mainnet switch must stay disabled (R18 decision preserved)"
    );

    const page1Source = readSource("pages/Page1Welcome.jsx");

    assert.equal(
        /showMainnetSwitch=\{(?!SHOW_MAINNET_SWITCH\})/.test(page1Source),
        false,
        "Page1 must pass the flag through unchanged (no hardcoded true)"
    );

    assert.match(
        page1Source,
        /showMainnetSwitch=\{SHOW_MAINNET_SWITCH\}/,
        "Page1 must pass SHOW_MAINNET_SWITCH to the layout"
    );

    assert.equal(
        page1Source.includes("openTelegramLink"),
        false,
        "Page1 must not contain its own Mainnet launch logic"
    );

    console.log("  test 1 (Page1 has no Mainnet entry) passed");

}

// 2 & 3 — CreateRoomPanel consumes the Owner-only handoff event safely.

{

    const source = readSource("components/CreateRoomPanel.jsx");

    assert.match(
        source,
        /socket\.on\(\s*"roomNetworkHandoffReady"/,
        "CreateRoomPanel must listen for the Owner-only handoff-ready event"
    );

    assert.match(
        source,
        /socket\.off\(\s*"roomNetworkHandoffReady"/,
        "the handoff-ready listener must be removed on cleanup"
    );

    // Extract the handler body between the R24 marker and the socket.on
    // registration block to assert its behavior precisely.
    const handlerStart = source.indexOf(
        "function handleRoomNetworkHandoffReady"
    );

    assert.notEqual(
        handlerStart,
        -1,
        "the R24 handoff-ready handler must exist"
    );

    const registrationIndex = source.indexOf(
        "socket.on(\"roomNetworkHandoffReady\"",
        handlerStart
    );

    assert.notEqual(registrationIndex, -1);

    const handlerBody = source.slice(handlerStart, registrationIndex);

    assert.match(
        handlerBody,
        /isTestnetRuntime\(\)/,
        "the handler must be guarded to the Testnet runtime (no Mainnet loop)"
    );

    assert.match(
        handlerBody,
        /validateHandoffReadyPayload\(data\)/,
        "the handler must validate the payload minimally before use"
    );

    assert.match(
        handlerBody,
        /storeHandoff\(handoff\)/,
        "the handler must persist the handoff through the narrow module"
    );

    assert.match(
        handlerBody,
        /launchMainnetMiniApp\(\)/,
        "the handler must launch the Mainnet runtime via the established mechanism"
    );

    assert.equal(
        handlerBody.includes("setRoomState"),
        false,
        "the handoffId must never enter room-wide state"
    );

    // The handler must not render or display the raw handoffId: the render
    // section of the component (after the listener registration) must not
    // reference handoff material at all.
    const renderSection = source.slice(
        source.indexOf("return (", registrationIndex)
    );

    assert.equal(
        renderSection.includes("handoff"),
        false,
        "the component render must never display or reference handoff material"
    );

    console.log("  tests 2 & 3 (owner-only handoff consumption) passed");

}

// 4 & 5 & 6 — Mainnet bootstrap component: exact request payload, result
// handling, retry retention, no CREATE_ROOM fallback, no fabrication.

{

    const source = readSource("components/RoomNetworkHandoffBootstrap.jsx");

    // 4 — the bootstrap request carries EXACTLY { handoffId }.
    const emitMatches = [
        ...source.matchAll(
            /socket\.emit\(\s*BOOTSTRAP_REQUEST_EVENT,\s*\{([\s\S]*?)\}\s*\)/g
        )
    ];

    assert.ok(
        emitMatches.length >= 1,
        "the bootstrap request must be emitted via socket.emit"
    );

    for (const match of emitMatches) {

        const payloadBody = match[1];

        assert.match(
            payloadBody,
            /handoffId/,
            "the bootstrap request payload must carry handoffId"
        );

        assert.equal(
            /telegramUserId|ownerTelegramUserId|initData|playerId|roomId|network|mainnetRoomId|walletAddress/.test(payloadBody),
            false,
            "the bootstrap request payload must carry NOTHING except handoffId"
        );

    }

    // 5 — result + error handling.
    assert.match(
        source,
        /socket\.on\(\s*BOOTSTRAP_RESULT_EVENT/,
        "the bootstrap component must listen for the authoritative result"
    );

    assert.match(
        source,
        /socket\.on\(\s*ROOM_ERROR_EVENT/,
        "the bootstrap component must listen for the controlled roomError codes"
    );

    assert.match(
        source,
        /CODE_HANDOFF_INVALID/,
        "the INVALID code must be handled definitively"
    );

    assert.match(
        source,
        /CODE_HANDOFF_RETRY_REQUIRED/,
        "the RETRY_REQUIRED code must be handled with retention"
    );

    // The success path clears the handoff storage.
    const successIndex = source.indexOf(
        "Success: the authoritative Mainnet room exists"
    );

    assert.notEqual(successIndex, -1, "the success path must exist");

    const successBlock = source.slice(successIndex, successIndex + 700);

    assert.match(
        successBlock,
        /clearHandoff\(\)/,
        "a successful bootstrap must clear the temporary handoff"
    );

    // The definitive INVALID path clears the handoff too.
    const invalidIndex = source.indexOf("code === CODE_HANDOFF_INVALID");

    assert.notEqual(invalidIndex, -1);

    const invalidBlock = source.slice(invalidIndex, invalidIndex + 800);

    assert.match(
        invalidBlock,
        /clearHandoff\(\)/,
        "a definitive INVALID rejection must clear the temporary handoff"
    );

    // The retryable path retains the handoff (no clearHandoff in the
    // retryable branch after the INVALID block).
    const retryableIndex = source.indexOf(
        "Everything else (RETRY_REQUIRED, UNAVAILABLE"
    );

    assert.notEqual(retryableIndex, -1);

    const retryableBlock = source.slice(retryableIndex, retryableIndex + 400);

    assert.equal(
        retryableBlock.includes("clearHandoff"),
        false,
        "retryable failures must retain the handoff"
    );

    // 6 — no CREATE_ROOM fallback and no fabricated room state (comments
    // are stripped so the check runs against actual code only).
    const codeWithoutComments = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/[^\n]*$/gm, "")
        .replace(/([^{])\/\/[^\n]*/g, "$1");

    assert.equal(
        codeWithoutComments.includes("socket.emit(\"createRoom\""),
        false,
        "the bootstrap component must never emit createRoom (no fallback)"
    );

    assert.equal(
        codeWithoutComments.includes("players:"),
        false,
        "the bootstrap component must never fabricate a player list"
    );

    assert.equal(
        codeWithoutComments.includes("roomState"),
        false,
        "the bootstrap component must never fabricate room-wide state"
    );

    console.log(
        "  tests 4-6 (bootstrap request/result/error handling) passed"
    );

}

// 7 — App.jsx mounts the bootstrap component at the flow root.

{

    const appSource = readSource("App.jsx");

    assert.match(
        appSource,
        /import RoomNetworkHandoffBootstrap from "\.\/components\/RoomNetworkHandoffBootstrap"/,
        "App.jsx must import the bootstrap component"
    );

    assert.match(
        appSource,
        /<RoomNetworkHandoffBootstrap\s+onNavigate=\{navigate\} \/>/,
        "App.jsx must mount the bootstrap component with the flow navigation"
    );

    console.log("  test 7 (App mounts the bootstrap component) passed");

}

// 8 — the Testnet room is not destroyed on transition.

{

    const panelSource = readSource("components/CreateRoomPanel.jsx");

    const handoffHandlerStart = panelSource.indexOf(
        "function handleRoomNetworkHandoffReady"
    );

    const registrationIndex = panelSource.indexOf(
        "socket.on(\"roomNetworkHandoffReady\""
    );

    const handlerBody = panelSource.slice(
        handoffHandlerStart,
        registrationIndex
    );

    assert.equal(
        /leaveRoom|roomClosed|disconnect\(\)/.test(handlerBody),
        false,
        "the Testnet room must NOT be left/destroyed by the handoff transition"
    );

    assert.equal(
        handlerBody.includes("createRoom"),
        false,
        "the handoff transition must not trigger any room creation"
    );

    const bootstrapSource = readSource(
        "components/RoomNetworkHandoffBootstrap.jsx"
    );

    const bootstrapCode = bootstrapSource
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/[^\n]*$/gm, "")
        .replace(/([^{])\/\/[^\n]*/g, "$1");

    assert.equal(
        /leaveRoom|socket\.disconnect\(\)/.test(bootstrapCode),
        false,
        "the Mainnet bootstrap must not disconnect or destroy anything"
    );

    console.log("  test 8 (Testnet room untouched on transition) passed");

}

// 9 — the socket handshake still forwards ONLY fresh telegramInitData.

{

    const socketSource = readSource("socket/socket.js");

    const authIndex = socketSource.indexOf("auth: {");

    assert.notEqual(authIndex, -1, "socket.js must keep the auth block");

    const authBlock = socketSource.slice(authIndex, authIndex + 300);

    assert.match(
        authBlock,
        /telegramInitData:\s*resolveTelegramInitData\(\)/,
        "the handshake auth must forward the fresh Telegram initData"
    );

    assert.equal(
        /handoff/i.test(authBlock),
        false,
        "the socket handshake must carry NO handoff material"
    );

    assert.equal(
        socketSource.includes("initDataUnsafe"),
        false,
        "socket.js must never read initDataUnsafe (identity comes from initData)"
    );

    console.log("  test 9 (socket handshake unchanged) passed");

}

console.log(
    "roomNetworkHandoff.wiring.r24.test.js: all assertions passed"
);
