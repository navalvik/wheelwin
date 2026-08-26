/**
 * R18.0B — DepositOrchestrator error observability tests.
 *
 * Proves ONLY that the PAYMENT_CONNECTION_READY catch path retains
 * exact error code/message/details in the persisted log output.
 * No payment behavior is changed and no payment success is implied.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DepositOrchestrator } from "../deposit/DepositOrchestrator.js";
import {
    DEPOSIT_ORCHESTRATOR_ERROR_CODES
} from "../deposit/DepositOrchestratorErrors.js";
import { EVENT_TYPES } from "../events/EventTypes.js";

function createCapturingLogger() {

    const errors = [];

    return {
        errors,
        info() {},
        warn() {},
        debug() {},
        error(message, fields) {

            errors.push({ message: String(message), fields: fields ?? null });

        }
    };

}

function createStubEventBus() {

    const subscriptions = new Map();

    return {
        subscriptions,
        subscribe(type, handler) {

            subscriptions.set(type, handler);

        },
        unsubscribe(type) {

            subscriptions.delete(type);

        }
    };

}

function createOrchestrator({ logger, resolver }) {

    const eventBus = createStubEventBus();

    const orchestrator = new DepositOrchestrator({
        logger,
        eventBus,
        depositSessionCoordinator: null,
        depositActivationVerificationCoordinator: null,
        gameplayContextResolver: resolver,
        roomManager: null,
        playerManager: null,
        sessionWalletStore: null,
        env: {}
    });

    orchestrator.initialize();

    return { orchestrator, eventBus };

}

async function settle() {

    await new Promise((resolve) => setImmediate(resolve));

}

test("R18.0B — classified error code and message are retained in the log message", async () => {

    const logger = createCapturingLogger();

    const { eventBus } = createOrchestrator({
        logger,
        resolver: { resolveGameIdByRoomId: () => null }
    });

    const handler = eventBus.subscriptions.get(EVENT_TYPES.PAYMENT_CONNECTION_READY);

    assert.ok(handler, "PAYMENT_CONNECTION_READY handler must be subscribed");

    handler({ payload: { roomId: "room-obs-1" } });

    await settle();

    assert.equal(logger.errors.length, 1);

    const entry = logger.errors[0];

    assert.equal(entry.fields?.roomId, "room-obs-1", "roomId preserved as field");

    assert.equal(
        entry.fields?.code,
        DEPOSIT_ORCHESTRATOR_ERROR_CODES.GAME_NOT_FOUND,
        "error code preserved as field"
    );

    assert.match(entry.message, /DepositOrchestrator PAYMENT_CONNECTION_READY failed/);

    assert.match(entry.message, /code=GAME_NOT_FOUND/, "code embedded in message");

    assert.match(entry.message, /errorName=DepositOrchestratorError/);

});

test("R18.0B — safe error details metadata is preserved when present", async () => {

    const logger = createCapturingLogger();

    const { orchestrator, eventBus } = createOrchestrator({
        logger,
        resolver: { resolveGameIdByRoomId: () => "game-x" }
    });

    class DetailsError extends Error {

        constructor() {

            super("boom");

            this.name = "DetailsError";

            this.code = "CUSTOM_TEST_CODE";

            this.details = Object.freeze({ activationStatus: "REJECTED" });

        }

    }

    orchestrator.handlePaymentConnectionReady = async () => {

        throw new DetailsError();

    };

    eventBus.subscriptions.get(EVENT_TYPES.PAYMENT_CONNECTION_READY)(
        { payload: { roomId: "room-obs-2" } }
    );

    await settle();

    assert.equal(logger.errors.length, 1);

    const entry = logger.errors[0];

    assert.match(entry.message, /code=CUSTOM_TEST_CODE/);

    assert.match(entry.message, /details=\{"activationStatus":"REJECTED"\}/);

    assert.equal(entry.fields?.details?.activationStatus, "REJECTED");

});

test("R18.0B — plain Error without code does not crash logging", async () => {

    const logger = createCapturingLogger();

    const { orchestrator, eventBus } = createOrchestrator({
        logger,
        resolver: { resolveGameIdByRoomId: () => null }
    });

    orchestrator.handlePaymentConnectionReady = async () => {

        throw new Error("plain failure without code");

    };

    eventBus.subscriptions.get(EVENT_TYPES.PAYMENT_CONNECTION_READY)(
        { payload: { roomId: "room-obs-3" } }
    );

    await settle();

    assert.equal(logger.errors.length, 1);

    const entry = logger.errors[0];

    assert.match(entry.message, /code=UNKNOWN/);

    assert.match(entry.message, /error=plain failure without code/);

    assert.ok(!entry.message.includes("details="), "no fabricated details");

});

test("R18.0B — missing roomId payload remains safe", async () => {

    const logger = createCapturingLogger();

    const { eventBus } = createOrchestrator({
        logger,
        resolver: { resolveGameIdByRoomId: () => null }
    });

    eventBus.subscriptions.get(EVENT_TYPES.PAYMENT_CONNECTION_READY)(
        { payload: {} }
    );

    await settle();

    assert.equal(logger.errors.length, 1);

    assert.equal(logger.errors[0].fields?.roomId, null);

    assert.match(logger.errors[0].message, /code=ROOM_NOT_FOUND/);

});


