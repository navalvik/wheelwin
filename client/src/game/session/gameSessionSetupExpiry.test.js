/**
 * R7.70C23 — Setup Session expiry navigation (Web + PAYMENT / ARCHIVED path).
 */
import assert from "node:assert/strict";

import {
    SETUP_EXPIRY_NAVIGATION_MAX_EXCLUSIVE_PAGE,
    SETUP_EXPIRY_NAVIGATION_MIN_PAGE,
    shouldNavigateOnSetupSessionExpiry
} from "./setupSessionExpiry.js";

import { INCOMING_SOCKET_EVENTS } from "../../socket/socketEvents.js";

const APP_PAGES = Object.freeze({
    WELCOME: 1,
    LOBBY: 2,
    PLAYER_SETUP: 3,
    MATRIX: 4,
    VERIFY: 5,
    PAYMENT: 6,
    GAMEPLAY: 7,
    RESULT: 8
});

{
    assert.equal(SETUP_EXPIRY_NAVIGATION_MIN_PAGE, APP_PAGES.PLAYER_SETUP);
    assert.equal(
        SETUP_EXPIRY_NAVIGATION_MAX_EXCLUSIVE_PAGE,
        APP_PAGES.GAMEPLAY
    );

    assert(
        shouldNavigateOnSetupSessionExpiry(APP_PAGES.PLAYER_SETUP),
        "page 3 navigates on setup expiry"
    );

    assert(
        shouldNavigateOnSetupSessionExpiry(APP_PAGES.PAYMENT),
        "page 6 PAYMENT navigates on setup expiry"
    );

    assert(
        !shouldNavigateOnSetupSessionExpiry(APP_PAGES.WELCOME),
        "page 1 must not navigate"
    );

    assert(
        !shouldNavigateOnSetupSessionExpiry(APP_PAGES.LOBBY),
        "page 2 lobby must not navigate via setup expiry handler"
    );

    assert(
        !shouldNavigateOnSetupSessionExpiry(APP_PAGES.GAMEPLAY),
        "page 7 gameplay must not navigate via setup expiry handler"
    );

    console.log("  setupSessionExpiry page guard: OK");
}

{
    // Minimal production-path harness mirroring GameSessionContext socket wiring.
    const listeners = new Map();

    const socket = {
        on(event, handler) {

            listeners.set(event, handler);

        },
        off(event) {

            listeners.delete(event);

        },
        emit(event, payload) {

            listeners.get(event)?.(payload);

        }
    };

    let currentPage = APP_PAGES.PAYMENT;

    let navigatedTo = null;

    let destroyCount = 0;

    let expiredHandled = false;

    function resetExpiryState() {

        navigatedTo = null;

        expiredHandled = false;

    }

    function destroySession() {

        destroyCount += 1;

        expiredHandled = false;

    }

    function onNavigate(page) {

        navigatedTo = page;

    }

    function handleSetupExpired() {

        if (expiredHandled) {

            return;

        }

        if (!shouldNavigateOnSetupSessionExpiry(currentPage)) {

            return;

        }

        expiredHandled = true;

        destroySession();

        expiredHandled = true;

        onNavigate(APP_PAGES.WELCOME);

    }

    socket.on(
        INCOMING_SOCKET_EVENTS.SETUP_SESSION_EXPIRED,
        handleSetupExpired
    );

    socket.on("roomClosed", handleSetupExpired);

    socket.on(
        INCOMING_SOCKET_EVENTS.PAYMENT_SESSION_FAILED,
        handleSetupExpired
    );

    // Case 1 — Web-style pre-game page (VERIFY).
    currentPage = APP_PAGES.VERIFY;

    resetExpiryState();

    socket.emit(INCOMING_SOCKET_EVENTS.SETUP_SESSION_EXPIRED, {
        roomId: "ROOMWEB1"
    });

    assert.equal(navigatedTo, APP_PAGES.WELCOME, "VERIFY → SETUP_SESSION_EXPIRED → Page1");
    assert.equal(destroyCount, 1, "destroySession once after VERIFY expiry");

    // Case 2 — Telegram-compatible PAYMENT path (same handler, page 6).
    currentPage = APP_PAGES.PAYMENT;

    resetExpiryState();

    socket.emit(INCOMING_SOCKET_EVENTS.SETUP_SESSION_EXPIRED, {
        roomId: "ROOMTG1"
    });

    assert.equal(
        navigatedTo,
        APP_PAGES.WELCOME,
        "PAYMENT → SETUP_SESSION_EXPIRED → Page1"
    );

    assert.equal(destroyCount, 2, "destroySession after PAYMENT expiry");

    // Idempotent — duplicate server events must not double-navigate.
    socket.emit(INCOMING_SOCKET_EVENTS.SETUP_SESSION_EXPIRED, {
        roomId: "ROOMTG1"
    });

    assert.equal(destroyCount, 2, "duplicate SETUP_SESSION_EXPIRED is ignored");
    assert.equal(navigatedTo, APP_PAGES.WELCOME, "navigation unchanged on duplicate");

    // roomClosed fallback (missed EXPIRED while WebView suspended).
    currentPage = APP_PAGES.PAYMENT;

    resetExpiryState();

    socket.emit("roomClosed", { roomId: "ROOMTG1", reason: "setup_expired" });

    assert.equal(
        navigatedTo,
        APP_PAGES.WELCOME,
        "PAYMENT → roomClosed → Page1"
    );

    assert.equal(destroyCount, 3, "destroySession after roomClosed fallback");

    console.log("  GameSessionContext production expiry handlers: OK");
}

console.log("gameSessionSetupExpiry.test.js: all assertions passed");
