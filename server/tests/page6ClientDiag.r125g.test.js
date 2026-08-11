/**
 * R12.5G — server sanitize + diagnostic log append for client Page6 diags.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GameDiagnosticLogManager } from "../logging/GameDiagnosticLogManager.js";
import {
    sanitizeIncomingPage6ClientDiag
} from "../logging/page6ClientDiagSanitize.js";
import { LoggingManager } from "../logging/LoggingManager.js";
import { LOG_LEVELS } from "../logging/levels.js";
import { LoggerService } from "../services/LoggerService.js";

{

    const sanitized = sanitizeIncomingPage6ClientDiag({
        event: "INFOBAR_STATE",
        roomId: "R1",
        playerId: "p1",
        currentPage: 8,
        footerMode: "PAGE6_TIME_LEFT",
        timerLabel: "TIME LEFT",
        timerValue: "04:18",
        page6DomPresent: true,
        page6Mounted: true,
        wallet: "secret",
        accessToken: "tok"
    }, { socketId: "s1" });

    assert.equal(sanitized.diagnosticVersion, "R12.5G");
    assert.equal(sanitized.event, "INFOBAR_STATE");
    assert.equal(sanitized.socketId, "s1");
    assert.equal(sanitized.wallet, undefined);
    assert.equal(sanitized.accessToken, undefined);
    assert.equal(sanitized.page6DomPresent, true);
    assert.equal(sanitized.timerLabel, "TIME LEFT");

    console.log("  server sanitize: OK");

}

{

    const directory = mkdtempSync(join(tmpdir(), "wheelwin-r125g-"));

    LoggingManager.resetForTests();

    GameDiagnosticLogManager.resetForTests();

    const loggingManager = LoggingManager.getInstance();

    loggingManager.initialize({
        level: LOG_LEVELS.INFO,
        enableConsole: false,
        enableFile: false,
        format: "console"
    });

    const logger = new LoggerService({ loggingManager });

    logger.initialize();

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const diagnostics = GameDiagnosticLogManager.getInstance();

    diagnostics.initialize({
        enabled: true,
        eventBus,
        loggingManager,
        directory
    });

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.ROOM_CREATED,
        payload: { roomId: "DIAGROOM1", maxPlayers: 3 }
    });

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.CLIENT_PAGE6_DIAGNOSTIC,
        payload: sanitizeIncomingPage6ClientDiag({
            event: "INFOBAR_STATE",
            roomId: "DIAGROOM1",
            playerId: "p1",
            currentPage: 8,
            footerMode: "PAGE6_TIME_LEFT",
            timerLabel: "TIME LEFT",
            timerValue: "04:18",
            page6DomPresent: true,
            page6Mounted: true,
            resultSessionExpiresAt: Date.now() + 100000,
            remainingResultSessionSeconds: 100
        }, { socketId: "sockA" })
    });

    const text = diagnostics.readLog("DIAGROOM1")?.toString("utf8") ?? "";

    assert.match(text, /\[R12\.5G ClientDiag\] INFOBAR_STATE/);
    assert.match(text, /TIME LEFT/);
    assert.match(text, /page6DomPresent/);

    diagnostics.shutdown();

    eventBus.shutdown();

    logger.shutdown();

    LoggingManager.resetForTests();

    GameDiagnosticLogManager.resetForTests();

    rmSync(directory, { recursive: true, force: true });

    console.log("  GameDiagnosticLogManager append: OK");

}

console.log("page6ClientDiag.r125g.test.js: all assertions passed");
