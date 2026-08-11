/**
 * R12.2 — Terminal navigation, gameplay roomClosed backup, hydration guard.
 */
import assert from "node:assert/strict";

import {
    PAGE5_CONFIG_HYDRATION_GRACE_MS,
    logTerminalNav,
    shouldNavigateOnGameplayRoomClosed
} from "./gameplayTerminal.js";

import { shouldNavigateOnSetupSessionExpiry } from "./setupSessionExpiry.js";

import {
    APP_PAGES,
    isTerminalRecoveryFailure
} from "../sessionRecovery/recoveryFlow.js";

import { useTerminalNavigation } from "./useTerminalNavigation.js";

// ---------------------------------------------------------------------------
// A / B — gameplay roomClosed guard
// ---------------------------------------------------------------------------

{
    assert.equal(
        shouldNavigateOnGameplayRoomClosed(APP_PAGES.GAMEPLAY, true),
        true,
        "page 7 + gameStarted → gameplay roomClosed"
    );

    assert.equal(
        shouldNavigateOnGameplayRoomClosed(APP_PAGES.RESULT, true),
        true,
        "page 8 + gameStarted → gameplay roomClosed"
    );

    assert.equal(
        shouldNavigateOnGameplayRoomClosed(APP_PAGES.GAMEPLAY, false),
        false,
        "page 7 without gameStarted must not use gameplay terminal path"
    );

    assert.equal(
        shouldNavigateOnGameplayRoomClosed(APP_PAGES.PAYMENT, true),
        false,
        "pre-game page must not use gameplay roomClosed path"
    );

    assert(
        !shouldNavigateOnSetupSessionExpiry(APP_PAGES.GAMEPLAY),
        "setup expiry still excludes gameplay"
    );

    console.log("  gameplay roomClosed guard: OK");
}

// ---------------------------------------------------------------------------
// C — idempotent terminal navigation (useTerminalNavigation logic)
// ---------------------------------------------------------------------------

{
    let resetCount = 0;

    let generation = 0;

    function performReset() {

        resetCount += 1;

        generation += 1;

    }

    // Simulate hook behaviour without React runtime.
    const terminalHandledRef = { current: false };

    const sessionGenerationRef = { current: generation };

    function resetToWelcome(event = "resetToWelcome") {

        if (terminalHandledRef.current) {

            logTerminalNav({
                event,
                currentPage: APP_PAGES.WELCOME,
                sessionGeneration: sessionGenerationRef.current,
                skipped: true
            });

            return;

        }

        terminalHandledRef.current = true;

        logTerminalNav({
            event,
            currentPage: APP_PAGES.WELCOME,
            sessionGeneration: sessionGenerationRef.current
        });

        performReset();

    }

    function armNewGameplaySession() {

        terminalHandledRef.current = false;

    }

    resetToWelcome("SESSION_FINISHED");

    assert.equal(resetCount, 1, "first terminal signal resets once");
    assert.equal(generation, 1, "sessionGeneration increments once");

    resetToWelcome("roomClosed");

    assert.equal(resetCount, 1, "duplicate terminal signal is ignored");
    assert.equal(generation, 1, "no second generation bump");

    armNewGameplaySession();

    resetToWelcome("roomClosed");

    assert.equal(resetCount, 2, "after OPEN_PAGE5 arm, terminal reset works again");
    assert.equal(generation, 2, "generation bumps for new session terminal");

    console.log("  idempotent terminal navigation: OK");
}

// ---------------------------------------------------------------------------
// D / E — terminal vs transient recovery failure classification
// ---------------------------------------------------------------------------

{
    assert(
        isTerminalRecoveryFailure({ reason: "Room session is not active" }),
        "inactive room is terminal"
    );

    assert(
        !isTerminalRecoveryFailure({ reason: "Recovery snapshot is unavailable" }),
        "transient snapshot gap is not terminal"
    );

    console.log("  terminal recovery classification: OK");
}

// ---------------------------------------------------------------------------
// F — pre-game roomClosed unchanged
// ---------------------------------------------------------------------------

{
    assert(
        shouldNavigateOnSetupSessionExpiry(APP_PAGES.PAYMENT),
        "page 6 still uses setup expiry"
    );

    assert(
        !shouldNavigateOnGameplayRoomClosed(APP_PAGES.PAYMENT, false),
        "page 6 pre-game roomClosed not gameplay terminal"
    );

    console.log("  pre-game roomClosed preserved: OK");
}

// ---------------------------------------------------------------------------
// G / H — Page5 hydration grace constant
// ---------------------------------------------------------------------------

{
    assert(
        PAGE5_CONFIG_HYDRATION_GRACE_MS >= 1000
        && PAGE5_CONFIG_HYDRATION_GRACE_MS <= 2000,
        "hydration grace within 1–2s range"
    );

    console.log("  Page5 hydration grace: OK");
}

// ---------------------------------------------------------------------------
// useTerminalNavigation module export smoke
// ---------------------------------------------------------------------------

{
    assert.equal(
        typeof useTerminalNavigation,
        "function",
        "useTerminalNavigation export exists"
    );

    console.log("  useTerminalNavigation export: OK");
}

// ---------------------------------------------------------------------------
// Production-path harness — gameplay roomClosed + setup expiry coexistence
// ---------------------------------------------------------------------------

{
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

    let currentPage = APP_PAGES.GAMEPLAY;

    let gameStarted = true;

    let setupNavigated = false;

    let terminalResetCount = 0;

    let setupNavCount = 0;

    function resetToWelcome(event) {

        terminalResetCount += 1;

        void event;

    }

    function onNavigate(page) {

        setupNavCount += 1;

        void page;

    }

    function handleSetupExpired() {

        if (!shouldNavigateOnSetupSessionExpiry(currentPage)) {

            return;

        }

        setupNavigated = true;

        onNavigate(APP_PAGES.WELCOME);

    }

    function handleRoomClosed() {

        if (shouldNavigateOnGameplayRoomClosed(currentPage, gameStarted)) {

            resetToWelcome("roomClosed");

            return;

        }

        handleSetupExpired();

    }

    socket.on("roomClosed", handleRoomClosed);

    handleRoomClosed();

    assert.equal(terminalResetCount, 1, "page 7 roomClosed → resetToWelcome");
    assert.equal(setupNavCount, 0, "gameplay roomClosed must not use setup navigate");

    currentPage = APP_PAGES.RESULT;

    terminalResetCount = 0;

    handleRoomClosed();

    assert.equal(terminalResetCount, 1, "page 8 roomClosed → resetToWelcome");

    currentPage = APP_PAGES.PAYMENT;

    gameStarted = false;

    terminalResetCount = 0;

    setupNavigated = false;

    handleRoomClosed();

    assert.equal(terminalResetCount, 0, "pre-game page 6 must not resetToWelcome");
    assert.equal(setupNavCount, 1, "pre-game page 6 still navigates via setup path");

    console.log("  production roomClosed harness: OK");
}

console.log("gameplayTerminalNavigation.test.js: all assertions passed");
