/**
 * R7.70C19 / R7.70C19A — restored timer defaults + Setup Timer non-reset.
 */
import assert from "node:assert/strict";

import { TIMERS, TIMER_PHASES } from "../catalog/Timers.js";
import { loadGameplayPhaseConfig } from "../config/gameplayPhases.js";
import { loadRoomConfig } from "../config/rooms.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import { EventBus } from "../events/EventBus.js";
import { SetupSessionLifecycle } from "../gameplay/SetupSessionLifecycle.js";
import { LoggerService } from "../services/LoggerService.js";

const FIVE_MIN_MS = 5 * 60 * 1000;

{
    const config = loadRoomConfig({
        ROOM_MAX_PLAYERS: "3"
    });

    assert.equal(
        config.setupDurationMs,
        FIVE_MIN_MS,
        "rooms.js default Setup Timer must be 5 minutes"
    );
    assert.equal(
        config.paymentSessionDurationMs,
        FIVE_MIN_MS,
        "R7.70C19A Payment Session default must be 5 minutes"
    );
    assert.equal(
        config.walletConnectionDurationMs,
        FIVE_MIN_MS,
        "R7.70C19A Wallet Connection default must be 5 minutes"
    );
    assert.equal(
        config.resultSessionDurationMs,
        FIVE_MIN_MS,
        "R7.70C19A Result Session default must be 5 minutes"
    );
    assert.equal(
        config.gameStartAuthorizationDurationMs,
        60 * 1000,
        "R7.70C19A Game Start Authorization default must be 60 seconds"
    );
    assert.equal(
        config.gameContractDeployTimeoutMs,
        2 * 60 * 1000,
        "deploy timeout must remain 2 minutes"
    );

    console.log("  loadRoomConfig C19/C19A restored defaults: OK");
}

{
    const phases = loadGameplayPhaseConfig({});

    assert.equal(
        phases.preGameReadyDurationMs,
        180000,
        "R7.70C19A PRE_GAME_READY config default must be 180 seconds"
    );
    assert.equal(
        TIMERS[TIMER_PHASES.PRE_GAME_READY].durationMs,
        180000,
        "R7.70C19A PRE_GAME_READY catalog default must be 180 seconds"
    );
    assert.equal(phases.readyDurationMs, 3000, "READY unchanged");
    assert.equal(phases.selfTestDurationMs, 1500, "SELF_TEST unchanged");
    assert.equal(phases.speedDurationMs, 8000, "SPEED unchanged");
    assert.equal(phases.brakeDurationMs, 6000, "BRAKE unchanged");
    assert.equal(phases.resultDurationMs, 4000, "RESULT clock phase unchanged");
    assert.equal(
        GAME_STATES.PRE_GAME_READY,
        TIMER_PHASES.PRE_GAME_READY,
        "phase key alignment"
    );

    console.log("  gameplayPhases/Timers PRE_GAME_READY=180s: OK");
}

{
    const logger = new LoggerService({ logLevel: "error" });
    logger.initialize();

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });
    eventBus.initialize();

    const roomManager = {
        getRoom: () => ({ roomId: "ROOMC19", status: "ACTIVE" })
    };

    const lifecycle = new SetupSessionLifecycle({
        logger,
        eventBus,
        roomManager,
        roomConfig: { setupDurationMs: FIVE_MIN_MS }
    });

    lifecycle.initialize();

    const room = { roomId: "ROOMC19" };
    const session = lifecycle.createForRoom(room);
    assert.ok(session, "setup session created");

    const snapshot1 = session.toSnapshot();
    assert.equal(
        snapshot1.expiresAt - snapshot1.startedAt,
        FIVE_MIN_MS,
        "authoritative expiresAt span is 5 minutes"
    );

    const expiresAtFixed = snapshot1.expiresAt;

    // Page2 → Matrix → Verify → Payment must not recreate / reset Setup Timer.
    const again = lifecycle.createForRoom(room);
    assert.equal(again, null, "second createForRoom must fail (no reset)");

    const still = lifecycle.getSession("ROOMC19");
    assert.equal(
        still.expiresAt,
        expiresAtFixed,
        "expiresAt unchanged after failed re-create"
    );

    lifecycle.archiveForPayment("ROOMC19");

    const afterArchive = lifecycle.getSession("ROOMC19");
    assert.ok(afterArchive, "session still present after archiveForPayment");
    assert.equal(
        afterArchive.expiresAt,
        expiresAtFixed,
        "expiresAt unchanged across archive/payment transition"
    );

    const sync = lifecycle.buildSyncPayload("ROOMC19");
    assert.equal(
        sync?.expiresAt,
        expiresAtFixed,
        "SYNC payload still exposes original expiresAt"
    );

    lifecycle.shutdown();
    eventBus.shutdown();
    logger.shutdown();

    console.log("  SetupSessionLifecycle 5min + no reset: OK");
}

console.log("setupTimer.r770c19.test.js: all assertions passed");
