/**
 * R6.38 — PAYMENT_STAGE_READY transfers room lifecycle ownership away from
 * Setup Timer; PaymentSession owns the Page4 payment deadline.
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

    assert.equal(
        expired.length,
        0,
        "ARCHIVED payment handoff must not fire Setup Timer expiry"
    );
    assert.equal(
        lifecycle.isRecoverable(roomId),
        true,
        "ARCHIVED payment handoff remains recoverable for payment reconnect/SYNC"
    );
    assert.equal(
        roomManager.hasRoom(roomId),
        true,
        "Setup Timer must not destroy a room after PAYMENT_STAGE_READY"
    );

    lifecycle.shutdown();
    eventBus.shutdown();
    logger.shutdown();

    console.log("  setupSession.paymentExpiry.r770c23: OK");
}

console.log("setupSession.paymentExpiry.r770c23.test.js: all assertions passed");
