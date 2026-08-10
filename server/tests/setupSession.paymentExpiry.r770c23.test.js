/**
 * R7.70C23 — ARCHIVED (PAYMENT) Setup Timer expiry + reconnect rejection.
 */
import assert from "node:assert/strict";

import { EVENT_TYPES } from "../events/EventTypes.js";
import { SetupSessionLifecycle } from "../gameplay/SetupSessionLifecycle.js";
import { LoggerService } from "../services/LoggerService.js";
import { EventBus } from "../events/EventBus.js";

function wait(ms) {

    return new Promise((resolve) => setTimeout(resolve, ms));

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
        rooms: new Map(),
        getRoom(roomId) {

            return this.rooms.get(roomId) ?? null;

        },
        hasRoom(roomId) {

            return this.rooms.has(roomId);

        },
        destroyRoom(roomId) {

            this.rooms.delete(roomId);

        }
    };

    const lifecycle = new SetupSessionLifecycle({
        logger,
        eventBus,
        roomManager,
        roomConfig: { setupDurationMs: 60 }
    });

    lifecycle.initialize();

    const roomId = "ROOMC23";

    roomManager.rooms.set(roomId, { roomId, status: "ACTIVE" });

    const session = lifecycle.createForRoom({ roomId });

    assert.ok(session, "setup session created");

    lifecycle.archiveForPayment(roomId);

    assert.equal(
        lifecycle.getSession(roomId)?.state,
        "ARCHIVED",
        "payment handoff archives session"
    );

    assert.equal(
        lifecycle.isRecoverable(roomId),
        true,
        "recoverable before expiresAt"
    );

    const expired = [];

    eventBus.subscribe(EVENT_TYPES.SETUP_SESSION_EXPIRED, (envelope) => {

        expired.push(envelope.payload);

    });

    await wait(80);

    assert.equal(expired.length, 1, "SETUP_SESSION_EXPIRED emits once for ARCHIVED");
    assert.equal(expired[0]?.roomId, roomId);
    assert.equal(
        lifecycle.isRecoverable(roomId),
        false,
        "not recoverable after Setup Timer expiry"
    );
    assert.equal(
        roomManager.hasRoom(roomId),
        false,
        "room destroyed on ARCHIVED setup expiry"
    );

    lifecycle.shutdown();
    eventBus.shutdown();
    logger.shutdown();

    console.log("  setupSession.paymentExpiry.r770c23: OK");
}

console.log("setupSession.paymentExpiry.r770c23.test.js: all assertions passed");
