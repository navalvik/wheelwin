/**
 * Setup Session restart re-arm — persistence + restore focused tests.
 *
 * Covers:
 * A. create → persist → restore → timer re-armed using the ORIGINAL expiresAt.
 * B. restore does not extend/recalculate the deadline.
 * C. already-expired persisted record is NOT re-armed (terminalized instead).
 * D. terminalized records (EXPIRED / ABORTED) are never restored.
 * E. GAME_INITIALIZED gameplay-ownership guard prevents an unsafe expiry.
 * F. restore is idempotent and does not create duplicate timers.
 * G. existing live expiry behavior remains intact (no persistence dep bound).
 *
 * Uses the real TonFinancialPersistence (tmpdir, autoCheckpoint off) to prove
 * the additive SETUP_SESSION record type end-to-end (envelope validation,
 * storage category, disk round-trip).
 */
import assert from "node:assert/strict";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventBus } from "../events/EventBus.js";
import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { SetupSessionLifecycle } from "../gameplay/SetupSessionLifecycle.js";
import { SETUP_SESSION_STATUS } from "../models/SetupSessionStatus.js";
import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";
import { TON_FINANCIAL_RECORD_TYPES } from "../persistence/TonFinancialRecordTypes.js";
import { LoggerService } from "../services/LoggerService.js";

const SETUP_DURATION_MS = 150;

function wait(ms) {

    return new Promise((resolve) => setTimeout(resolve, ms));

}

function createHarness({ gameManager = null } = {}) {

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
        gameManager,
        roomConfig: { setupDurationMs: SETUP_DURATION_MS }
    });

    lifecycle.initialize();

    return { logger, eventBus, roomManager, lifecycle };

}

function shutdownHarness(harness) {

    harness.lifecycle.shutdown();
    harness.eventBus.shutdown();
    harness.logger.shutdown();

}

function createPersistence(dataDir) {

    const persistence = new TonFinancialPersistence({
        dataDir,
        autoCheckpoint: false
    });

    persistence.initialize();

    return persistence;

}

function listSetupSessionRecords(persistence) {

    return persistence.listActive(TON_FINANCIAL_RECORD_TYPES.SETUP_SESSION);

}

function writeSetupSessionRecord(persistence, {
    roomId,
    setupSessionId,
    startedAt,
    expiresAt,
    state,
    roomFull = false
}) {

    return persistence.create(
        TON_FINANCIAL_RECORD_TYPES.SETUP_SESSION,
        { roomId, setupSessionId, startedAt, expiresAt, state, roomFull },
        { recordId: roomId, roomId, status: state }
    );

}

function cleanupDataDir(dataDir) {

    rmSync(dataDir, { recursive: true, force: true });

}

{
    // ---------------------------------------------------------------------
    // A + B — create → persist → restart → restore → re-armed timer with the
    // ORIGINAL expiresAt (complete/archive transitions update the record).
    // ---------------------------------------------------------------------
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-setup-rearm-ab-"));

    const first = createHarness();
    const persistence = createPersistence(dataDir);

    first.lifecycle.setSetupSessionPersistence({ persistence });

    const roomId = "REARMA";

    first.roomManager.rooms.set(roomId, { roomId, status: "ACTIVE" });

    const session = first.lifecycle.createForRoom({ roomId });

    assert.ok(session, "A: setup session created");

    const persisted = listSetupSessionRecords(persistence);

    assert.equal(persisted.length, 1, "A: exactly one SETUP_SESSION record persisted");
    assert.equal(
        persisted[0]?.recordType,
        TON_FINANCIAL_RECORD_TYPES.SETUP_SESSION,
        "A: record uses the dedicated SETUP_SESSION record type"
    );
    assert.equal(
        persisted[0]?.payload?.state,
        SETUP_SESSION_STATUS.ACTIVE,
        "A: record state ACTIVE on create"
    );
    assert.equal(
        persisted[0]?.payload?.expiresAt,
        session.expiresAt,
        "A: original expiresAt persisted"
    );
    assert.equal(
        persisted[0]?.payload?.setupSessionId,
        session.setupSessionId,
        "A: authoritative setupSessionId persisted"
    );

    await wait(30);

    // complete/archive transitions update the persisted record.
    first.eventBus.emit({
        source: EVENT_SOURCES.ROOM_MANAGER,
        type: EVENT_TYPES.ROOM_FULL,
        payload: { roomId }
    });

    assert.equal(
        first.lifecycle.getSession(roomId)?.state,
        SETUP_SESSION_STATUS.COMPLETED,
        "A: session completed on ROOM_FULL"
    );
    assert.equal(
        listSetupSessionRecords(persistence)[0]?.payload?.state,
        SETUP_SESSION_STATUS.COMPLETED,
        "A: record updated to COMPLETED"
    );
    assert.equal(
        listSetupSessionRecords(persistence)[0]?.payload?.roomFull,
        true,
        "A: roomFull persisted through the update"
    );

    first.lifecycle.archiveForPayment(roomId);

    assert.equal(
        listSetupSessionRecords(persistence)[0]?.payload?.state,
        SETUP_SESSION_STATUS.ARCHIVED,
        "A: record updated to ARCHIVED"
    );

    const originalExpiresAt = session.expiresAt;

    // Simulated restart: tear down the runtime, reopen persistence from disk.
    shutdownHarness(first);
    persistence.shutdown();

    const persistence2 = createPersistence(dataDir);

    const restoredRecords = listSetupSessionRecords(persistence2);

    assert.equal(
        restoredRecords.length,
        1,
        "A: record survives the restart on disk"
    );

    const second = createHarness();

    // The restarted runtime late-binds the same persistence store.
    second.lifecycle.setSetupSessionPersistence({ persistence: persistence2 });

    const expired = [];

    second.eventBus.subscribe(EVENT_TYPES.SETUP_SESSION_EXPIRED, (envelope) => {

        expired.push(envelope.payload);

    });

    const summary = second.lifecycle.restorePersistedSessions({
        records: restoredRecords
    });

    assert.equal(summary.restored, 1, "A/B: exactly one session restored");
    assert.equal(summary.expiredTerminalized, 0, "A: future deadline not terminalized");

    const restoredSession = second.lifecycle.getSession(roomId);

    assert.ok(restoredSession, "A: session reconstructed in the registry");
    assert.equal(
        restoredSession.state,
        SETUP_SESSION_STATUS.ARCHIVED,
        "A: ARCHIVED state reconstructed"
    );
    assert.equal(
        restoredSession.expiresAt,
        originalExpiresAt,
        "B: restore keeps the ORIGINAL deadline (no recalculation, no extension)"
    );
    assert.equal(
        restoredSession.setupSessionId,
        session.setupSessionId,
        "A: authoritative setupSessionId preserved across restart"
    );
    assert.ok(
        restoredSession.remainingTime() < second.lifecycle.getDurationMs(),
        "B: restored remaining time is not a fresh full duration"
    );

    await wait(SETUP_DURATION_MS + 120);

    assert.equal(
        expired.length,
        1,
        "A: re-armed expiry fires exactly once at the original deadline"
    );
    assert.equal(expired[0]?.roomId, roomId, "A: expiry snapshot roomId correct");
    assert.equal(
        expired[0]?.expiresAt,
        originalExpiresAt,
        "A: expiry snapshot carries the ORIGINAL deadline"
    );
    assert.equal(
        listSetupSessionRecords(persistence2)[0]?.payload?.state,
        SETUP_SESSION_STATUS.EXPIRED,
        "A: persisted record terminalized after the re-armed expiry fired"
    );

    persistence2.shutdown();
    shutdownHarness(second);
    cleanupDataDir(dataDir);

    console.log("  restart re-arm A/B (persist/restore/original deadline): OK");
}

{
    // ---------------------------------------------------------------------
    // C — a crash artifact whose deadline already elapsed is NEVER re-armed;
    // it is terminalized instead and emits no synthetic boot-time expiry.
    // ---------------------------------------------------------------------
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-setup-rearm-c-"));

    const harness = createHarness();
    const persistence = createPersistence(dataDir);

    harness.lifecycle.setSetupSessionPersistence({ persistence });

    const roomId = "REARMC";
    const now = Date.now();
    const elapsedExpiresAt = now - 5_000;

    writeSetupSessionRecord(persistence, {
        roomId,
        setupSessionId: "setup-rearm-c",
        startedAt: now - 10_000,
        expiresAt: elapsedExpiresAt,
        state: SETUP_SESSION_STATUS.ACTIVE
    });

    const expired = [];

    harness.eventBus.subscribe(EVENT_TYPES.SETUP_SESSION_EXPIRED, (envelope) => {

        expired.push(envelope.payload);

    });

    const summary = harness.lifecycle.restorePersistedSessions({
        records: listSetupSessionRecords(persistence)
    });

    assert.equal(summary.restored, 0, "C: elapsed deadline is never re-armed");
    assert.equal(summary.expiredTerminalized, 1, "C: elapsed record terminalized");
    assert.equal(
        harness.lifecycle.getSession(roomId),
        null,
        "C: no session reconstructed for an elapsed deadline"
    );

    const record = listSetupSessionRecords(persistence)[0];

    assert.equal(
        record?.payload?.state,
        SETUP_SESSION_STATUS.EXPIRED,
        "C: elapsed record marked EXPIRED"
    );
    assert.equal(
        record?.payload?.expiresAt,
        elapsedExpiresAt,
        "C: original deadline preserved when terminalizing"
    );

    await wait(50);

    assert.equal(expired.length, 0, "C: no synthetic expiry emitted at boot");

    persistence.shutdown();
    shutdownHarness(harness);
    cleanupDataDir(dataDir);

    console.log("  restart re-arm C (elapsed deadline not re-armed): OK");
}

{
    // ---------------------------------------------------------------------
    // D — terminalized records (ABORTED destroyed room / EXPIRED handled) are
    // never restored, even with a future deadline on the record.
    // ---------------------------------------------------------------------
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-setup-rearm-d-"));

    const harness = createHarness();
    const persistence = createPersistence(dataDir);

    const now = Date.now();
    const futureExpiresAt = now + 60_000;

    writeSetupSessionRecord(persistence, {
        roomId: "REARMDABORT",
        setupSessionId: "setup-rearm-d-abort",
        startedAt: now - 1_000,
        expiresAt: futureExpiresAt,
        state: SETUP_SESSION_STATUS.ABORTED
    });

    writeSetupSessionRecord(persistence, {
        roomId: "REARMDEXPIRED",
        setupSessionId: "setup-rearm-d-expired",
        startedAt: now - 1_000,
        expiresAt: futureExpiresAt,
        state: SETUP_SESSION_STATUS.EXPIRED
    });

    const summary = harness.lifecycle.restorePersistedSessions({
        records: listSetupSessionRecords(persistence)
    });

    assert.equal(summary.restored, 0, "D: terminalized records never restored");
    assert.equal(summary.skippedTerminalized, 2, "D: both terminal records skipped");
    assert.equal(
        harness.lifecycle.getSession("REARMDABORT"),
        null,
        "D: ABORTED (destroyed room) not resurrected"
    );
    assert.equal(
        harness.lifecycle.getSession("REARMDEXPIRED"),
        null,
        "D: EXPIRED (already handled) not resurrected"
    );

    persistence.shutdown();
    shutdownHarness(harness);
    cleanupDataDir(dataDir);

    console.log("  restart re-arm D (terminal records not restored): OK");
}

{
    // ---------------------------------------------------------------------
    // E1 — a room that already reached GAME_INITIALIZED (recovered gameplay)
    // is skipped by the R8.6 ownership guard: no setup ownership is regained
    // and no unsafe expiry/destroy can happen.
    // ---------------------------------------------------------------------
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-setup-rearm-e1-"));

    const initializedRooms = new Set(["REARME1"]);

    const harness = createHarness({
        gameManager: {
            hasInitializedGameplay: (roomId) => initializedRooms.has(roomId)
        }
    });
    const persistence = createPersistence(dataDir);

    const now = Date.now();

    writeSetupSessionRecord(persistence, {
        roomId: "REARME1",
        setupSessionId: "setup-rearm-e1",
        startedAt: now - 1_000,
        expiresAt: now + 40,
        state: SETUP_SESSION_STATUS.ACTIVE
    });

    harness.roomManager.rooms.set("REARME1", { roomId: "REARME1", status: "FULL" });

    const expired = [];

    harness.eventBus.subscribe(EVENT_TYPES.SETUP_SESSION_EXPIRED, (envelope) => {

        expired.push(envelope.payload);

    });

    const summary = harness.lifecycle.restorePersistedSessions({
        records: listSetupSessionRecords(persistence)
    });

    assert.equal(summary.restored, 0, "E1: ownership-released room not restored");
    assert.equal(
        summary.skippedOwnershipReleased,
        1,
        "E1: gameplay-ownership guard skip counted"
    );

    await wait(150);

    assert.equal(
        expired.length,
        0,
        "E1: no expiry authority regained — SETUP_SESSION_EXPIRED never emitted"
    );
    assert.equal(
        harness.roomManager.hasRoom("REARME1"),
        true,
        "E1: recovered game room is not destroyed by setup"
    );

    persistence.shutdown();
    shutdownHarness(harness);
    cleanupDataDir(dataDir);

    console.log("  restart re-arm E1 (GAME_INITIALIZED restore guard): OK");
}

{
    // ---------------------------------------------------------------------
    // E2 — a successfully restored session whose gameplay initializes later
    // has its re-armed timer cleared by the existing GAME_INITIALIZED handler
    // (R8.6): the expiry can never destroy an active game room.
    // ---------------------------------------------------------------------
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-setup-rearm-e2-"));

    const harness = createHarness();
    const persistence = createPersistence(dataDir);

    const now = Date.now();

    writeSetupSessionRecord(persistence, {
        roomId: "REARME2",
        setupSessionId: "setup-rearm-e2",
        startedAt: now - 1_000,
        expiresAt: now + 120,
        state: SETUP_SESSION_STATUS.ACTIVE
    });

    harness.roomManager.rooms.set("REARME2", { roomId: "REARME2", status: "FULL" });

    const summary = harness.lifecycle.restorePersistedSessions({
        records: listSetupSessionRecords(persistence)
    });

    assert.equal(summary.restored, 1, "E2: session restored while pre-init");

    harness.eventBus.emit({
        source: EVENT_SOURCES.GAME_MANAGER,
        type: EVENT_TYPES.GAME_INITIALIZED,
        payload: { roomId: "REARME2" }
    });

    const expired = [];

    harness.eventBus.subscribe(EVENT_TYPES.SETUP_SESSION_EXPIRED, (envelope) => {

        expired.push(envelope.payload);

    });

    await wait(200);

    assert.equal(
        expired.length,
        0,
        "E2: re-armed timer cleared at GAME_INITIALIZED — no unsafe expiry"
    );
    assert.equal(
        harness.roomManager.hasRoom("REARME2"),
        true,
        "E2: room survives — setup has no destroy authority after GAME_INITIALIZED"
    );

    persistence.shutdown();
    shutdownHarness(harness);
    cleanupDataDir(dataDir);

    console.log("  restart re-arm E2 (re-armed timer cleared on GAME_INITIALIZED): OK");
}

{
    // ---------------------------------------------------------------------
    // F — restore is idempotent: the second restore is a no-op and exactly
    // one timer exists (expiry fires exactly once).
    // ---------------------------------------------------------------------
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-setup-rearm-f-"));

    const first = createHarness();
    const persistence = createPersistence(dataDir);

    first.lifecycle.setSetupSessionPersistence({ persistence });

    const roomId = "REARMF";

    first.roomManager.rooms.set(roomId, { roomId, status: "ACTIVE" });

    first.lifecycle.createForRoom({ roomId });

    shutdownHarness(first);
    persistence.shutdown();

    const persistence2 = createPersistence(dataDir);
    const second = createHarness();

    // The restarted runtime late-binds the same persistence store.
    second.lifecycle.setSetupSessionPersistence({ persistence: persistence2 });

    const records = listSetupSessionRecords(persistence2);

    const firstSummary = second.lifecycle.restorePersistedSessions({ records });
    const secondSummary = second.lifecycle.restorePersistedSessions({ records });

    assert.equal(firstSummary.restored, 1, "F: first restore restores one session");
    assert.equal(secondSummary.restored, 0, "F: second restore is a no-op");
    assert.equal(
        secondSummary.skippedExisting,
        1,
        "F: in-memory session wins — restore is idempotent"
    );
    assert.equal(
        second.lifecycle.getDebugSnapshot().activeCount,
        1,
        "F: exactly one session in the registry after repeated restores"
    );

    const expired = [];

    second.eventBus.subscribe(EVENT_TYPES.SETUP_SESSION_EXPIRED, (envelope) => {

        expired.push(envelope.payload);

    });

    await wait(SETUP_DURATION_MS + 120);

    assert.equal(
        expired.length,
        1,
        "F: single timer — expiry fires exactly once (no duplicate timers)"
    );

    persistence2.shutdown();
    shutdownHarness(second);
    cleanupDataDir(dataDir);

    console.log("  restart re-arm F (idempotent restore, no duplicate timers): OK");
}

{
    // ---------------------------------------------------------------------
    // G — live create/expiry behavior is unchanged when no persistence dep is
    // bound (fail-open optionality).
    // ---------------------------------------------------------------------
    const harness = createHarness();

    const roomId = "REARMG";

    harness.roomManager.rooms.set(roomId, { roomId, status: "ACTIVE" });

    const session = harness.lifecycle.createForRoom({ roomId });

    assert.ok(session, "G: live create unchanged without persistence dep");
    assert.equal(
        session.expiresAt,
        session.startedAt + SETUP_DURATION_MS,
        "G: live deadline derivation unchanged"
    );

    const expired = [];

    harness.eventBus.subscribe(EVENT_TYPES.SETUP_SESSION_EXPIRED, (envelope) => {

        expired.push(envelope.payload);

    });

    await wait(SETUP_DURATION_MS + 120);

    assert.equal(expired.length, 1, "G: live expiry unchanged (fires once)");
    assert.equal(expired[0]?.roomId, roomId, "G: live expiry roomId correct");
    assert.equal(
        harness.roomManager.hasRoom(roomId),
        false,
        "G: room destroyed on live expiry as before"
    );
    assert.equal(
        harness.lifecycle.getSession(roomId),
        null,
        "G: session removed after live expiry as before"
    );

    shutdownHarness(harness);

    console.log("  restart re-arm G (live behavior unchanged, dep optional): OK");
}

console.log("setupSessionRestartRearm.test.js: all assertions passed");
