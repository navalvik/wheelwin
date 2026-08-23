/**
 * R17.9T.6-D3 — RecoveryOrchestrator.
 *
 * Coordinates recovery of ONE persisted recovery candidate (RECOVERY_DATA
 * record) at a time using the completed D1 identity attach APIs and D2
 * runtime engine attach APIs.
 *
 * Responsibilities:
 *   - discover candidates through existing RecoveryDataPersistence APIs;
 *   - classify candidates (pure function over existing contract fields);
 *   - validate candidate data BEFORE any runtime mutation;
 *   - construct Room / Player / Game aggregates via existing constructors;
 *   - attach them via D1 APIs (attachRoom / attachPlayer(player) / attachGame);
 *   - attach runtime engines via D2 APIs (silent, unarmed where applicable);
 *   - perform cross-component consistency validation;
 *   - roll back silently (D3 silent detach primitives) on any failure;
 *   - prevent duplicate reconstruction (idempotency / conflict fail-closed);
 *   - arm only eligible, validated, non-expired clocks (last step);
 *   - return explicit per-candidate recovery results.
 *
 * Explicit boundaries:
 *   - emits NO normal gameplay lifecycle events during construction,
 *     attach, validation, rollback or duplicate detection;
 *   - never registers SimulationLoop;
 *   - never triggers financial behavior; preserves financial reference IDs
 *     only (contractId, paymentSessionId, snapshotHash, winnerId);
 *   - does NOT integrate into server startup (independently callable);
 *   - SELF_TEST / SPEED / BRAKE candidates fail closed (active physics/input
 *     state is not persisted under the current contract).
 */

import { GAME_STATES } from "../engines/gameState/GameStates.js";
import { GAME_STATUS } from "../models/GameStatus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { CONNECTION_STATE } from "../models/ConnectionState.js";
import { ROOM_STATUS } from "../models/RoomStatus.js";
import { PHYSICS_SIMULATION_STATE } from "../engines/physics/PhysicsSimulationState.js";
import { Room } from "../models/Room.js";
import { Game } from "../models/Game.js";
import { PlayerIdentity } from "../models/PlayerIdentity.js";
import { PlayerRuntime } from "../models/PlayerRuntime.js";
import { computePayloadChecksum } from "../persistence/tonFinancialRecordUtils.js";
import {
    RECOVERY_DATA_TERMINAL_STATUSES
} from "../persistence/TonFinancialRecordTypes.js";

/**
 * Gameplay phases eligible for full reconstruction under the current
 * recovery data contract.
 */
const RECOVERABLE_GAME_STATES = Object.freeze([
    GAME_STATES.PRE_GAME_READY,
    GAME_STATES.READY,
    GAME_STATES.RESULT
]);

/**
 * Active motion phases that MUST fail closed: authoritative physics/input
 * state is not persisted under the current contract.
 */
const UNRECOVERABLE_ACTIVE_GAME_STATES = Object.freeze([
    GAME_STATES.SELF_TEST,
    GAME_STATES.SPEED,
    GAME_STATES.BRAKE
]);

/**
 * Expected number of players in a WheelWin game.
 */
const EXPECTED_PLAYER_COUNT = 3;

/**
 * Per-candidate recovery result statuses (in-memory only; no persistence
 * status values are invented by this orchestrator).
 */
export const RECOVERY_RESULT_STATUS = Object.freeze({
    SUCCESS: "SUCCESS",
    ALREADY_RECOVERED: "ALREADY_RECOVERED",
    SKIPPED_NOT_RECOVERABLE: "SKIPPED_NOT_RECOVERABLE",
    SKIPPED_FINANCIAL_ONLY: "SKIPPED_FINANCIAL_ONLY",
    SKIPPED_ALREADY_TERMINAL: "SKIPPED_ALREADY_TERMINAL",
    FAILED_INVALID_RECORD: "FAILED_INVALID_RECORD",
    FAILED_IDENTITY: "FAILED_IDENTITY",
    FAILED_CONFIGURATION: "FAILED_CONFIGURATION",
    FAILED_STATE: "FAILED_STATE",
    FAILED_CLOCK: "FAILED_CLOCK",
    FAILED_EXPIRED: "FAILED_EXPIRED",
    FAILED_PHYSICS: "FAILED_PHYSICS",
    FAILED_INPUT: "FAILED_INPUT",
    FAILED_WINNER: "FAILED_WINNER",
    FAILED_CONSISTENCY: "FAILED_CONSISTENCY",
    FAILED_ATTACH: "FAILED_ATTACH",
    FAILED_ROLLBACK: "FAILED_ROLLBACK"
});

/**
 * @typedef {object} RecoveryOrchestratorOptions
 * @property {object} [logger]
 * @property {object} recoveryDataPersistence - Initialized RecoveryDataPersistence.
 * @property {object} roomManager
 * @property {object} playerManager
 * @property {object} gameManager
 * @property {object} configurationEngine
 * @property {object} gameStateEngine
 * @property {object} gameClockEngine
 * @property {object} physicsEngine
 * @property {object} inputAuthority
 * @property {object} winnerEngine
 * @property {object} [eventBus] - Optional EventBus. When omitted, the bus is
 *   resolved from the injected playerManager (the same authoritative
 *   manager-level EventBus that emits PLAYER_CONNECTED).
 */

export class RecoveryOrchestrator {

    /**
     * @param {RecoveryOrchestratorOptions} options
     */
    constructor({
        logger = null,
        recoveryDataPersistence,
        roomManager,
        playerManager,
        gameManager,
        configurationEngine,
        gameStateEngine,
        gameClockEngine,
        physicsEngine,
        inputAuthority,
        winnerEngine,
        eventBus = null
    } = {}) {

        if (!recoveryDataPersistence) {

            throw new Error("RecoveryOrchestrator requires recoveryDataPersistence");

        }

        this._logger = logger;

        this._recoveryDataPersistence = recoveryDataPersistence;

        this._roomManager = roomManager;

        this._playerManager = playerManager;

        this._gameManager = gameManager;

        this._configurationEngine = configurationEngine;

        this._gameStateEngine = gameStateEngine;

        this._gameClockEngine = gameClockEngine;

        this._physicsEngine = physicsEngine;

        this._inputAuthority = inputAuthority;

        this._winnerEngine = winnerEngine;

        this._injectedEventBus = eventBus;

        /**
         * R17.9T.6 OPTION B — runtime-only pending recovered-clock tracking.
         * Keyed by gameId; NEVER persisted; NOT part of the Recovery Data
         * Contract; NOT a gameplay state. Entries are removed once the game
         * is armed, fails, rolls back, or becomes ineligible.
         *
         * @type {Map<string, {roomId: string, playerIds: string[]}>}
         */
        this._pendingRecoveredClocks = new Map();

        this._playerConnectedHandler = null;

        this._playerConnectedSubscribed = false;

    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Recover ONE persisted recovery candidate.
     *
     * Accepts either a public persistence record ({ payload, status, ... })
     * as returned by RecoveryDataPersistence, or a bare payload object.
     *
     * The candidate is classified, validated pre-mutation, reconstructed via
     * D1/D2 attach APIs, cross-validated, and its clock armed last (eligible
     * non-expired unpaused PRE_GAME_READY/READY clocks only). Any failure
     * rolls back all components attached for this candidate silently.
     *
     * @param {object} recoveryRecord - Persistence record or bare payload.
     * @returns {object} Explicit recovery result:
     *   { status, classification, recoveryRecordId, gameId, roomId,
     *     failedStep?, reason }
     */
    recoverCandidate(recoveryRecord) {

        this._ensurePlayerConnectedSubscription();

        try {

            return this._recoverCandidateInternal(recoveryRecord);

        } catch (error) {

            // Defensive boundary: the orchestrator must never throw out of a
            // per-candidate recovery attempt; one bad candidate must not
            // break recoverAll() processing of other candidates.
            this._logError(
                `RecoveryOrchestrator: unexpected error during candidate recovery | `
                    + `${error?.message ?? error}`
            );

            return this._buildResult({
                status: RECOVERY_RESULT_STATUS.FAILED_INVALID_RECORD,
                payload: this._extractPayload(recoveryRecord),
                reason: `unexpected_error:${error?.message ?? String(error)}`
            });

        }

    }

    /**
     * Recover ALL persisted recovery candidates.
     *
     * Obtains the candidate list exclusively through
     * RecoveryDataPersistence.listRecoveryRecords(), processes each candidate
     * independently (one failed candidate never corrupts another), and
     * returns per-candidate results plus aggregate counts.
     *
     * Performs NO persistence writes and creates NO synthetic candidates.
     *
     * @returns {object} { results: [...], summary: {...} }
     */
    recoverAll() {

        this._ensurePlayerConnectedSubscription();

        let records;

        try {

            records = this._recoveryDataPersistence.listRecoveryRecords();

        } catch (error) {

            this._logError(
                `RecoveryOrchestrator: candidate discovery failed | `
                    + `${error?.message ?? error}`
            );

            return {
                results: [],
                summary: this._buildSummary([], {
                    discoveryFailed: true,
                    discoveryError: error?.message ?? String(error)
                })
            };

        }

        if (!Array.isArray(records) || records.length === 0) {

            return {
                results: [],
                summary: this._buildSummary([])
            };

        }

        const results = [];

        for (const record of records) {

            results.push(this.recoverCandidate(record));

        }

        return {
            results,
            summary: this._buildSummary(results)
        };

    }

    // -------------------------------------------------------------------------
    // Candidate recovery pipeline
    // -------------------------------------------------------------------------

    _recoverCandidateInternal(recoveryRecord) {

        const payload = this._extractPayload(recoveryRecord);

        // --- Step 1: structural validation of the record -------------------

        if (!payload || typeof payload !== "object") {

            return this._buildResult({
                status: RECOVERY_RESULT_STATUS.FAILED_INVALID_RECORD,
                payload: null,
                reason: "record_missing_or_not_object"
            });

        }

        if (recoveryRecord && typeof recoveryRecord === "object"
            && "payload" in recoveryRecord) {

            const validation = this._recoveryDataPersistence.validateRecoveryRecord(
                recoveryRecord
            );

            if (!validation.valid) {

                return this._buildResult({
                    status: RECOVERY_RESULT_STATUS.FAILED_INVALID_RECORD,
                    payload,
                    reason: `invalid_record:${validation.errors.join(",")}`
                });

            }

        }

        // --- Step 2: classification ----------------------------------------

        const classification = this._classifyCandidate(payload, recoveryRecord);

        switch (classification.type) {

            case "ALREADY_TERMINAL":
                return this._buildResult({
                    status: RECOVERY_RESULT_STATUS.SKIPPED_ALREADY_TERMINAL,
                    payload,
                    classification,
                    reason: classification.reason
                });

            case "FINANCIAL_ONLY":
                return this._buildResult({
                    status: RECOVERY_RESULT_STATUS.SKIPPED_FINANCIAL_ONLY,
                    payload,
                    classification,
                    reason: classification.reason
                });

            case "NOT_RECOVERABLE":
                return this._buildResult({
                    status: RECOVERY_RESULT_STATUS.SKIPPED_NOT_RECOVERABLE,
                    payload,
                    classification,
                    reason: classification.reason
                });

            default:
                break;

        }

        // --- Step 3: duplicate detection (before ANY mutation) --------------

        const duplicateCheck = this._checkDuplicateRuntime(payload);

        if (duplicateCheck.outcome === "already_recovered") {

            return this._buildResult({
                status: RECOVERY_RESULT_STATUS.ALREADY_RECOVERED,
                payload,
                classification,
                reason: "equivalent_runtime_already_present"
            });

        }

        if (duplicateCheck.outcome === "conflict") {

            return this._buildResult({
                status: RECOVERY_RESULT_STATUS.FAILED_IDENTITY,
                payload,
                classification,
                reason: duplicateCheck.reason
            });

        }

        // --- Step 4: pre-mutation candidate validation ----------------------

        const preValidation = this._validateCandidatePreMutation(payload);

        if (!preValidation.ok) {

            return this._buildResult({
                status: preValidation.status,
                payload,
                classification,
                reason: preValidation.reason
            });

        }

        // --- Step 5: aggregate construction (no runtime mutation yet) -------

        const aggregates = this._constructAggregates(payload);

        if (!aggregates.ok) {

            return this._buildResult({
                status: RECOVERY_RESULT_STATUS.FAILED_IDENTITY,
                payload,
                classification,
                reason: aggregates.reason
            });

        }

        // --- Step 6..16: ordered attachment with silent rollback ------------

        const attached = [];

        const fail = (status, step, reason) => {

            const rollback = this._rollbackCandidate(attached);

            return this._buildResult({
                status: rollback.complete
                    ? status
                    : RECOVERY_RESULT_STATUS.FAILED_ROLLBACK,
                payload,
                classification,
                failedStep: step,
                reason: rollback.complete
                    ? reason
                    : `rollback_incomplete_after_${step}:${reason}`
            });

        };

        // 6. Room attach
        const attachedRoom = this._roomManager.attachRoom(aggregates.room);

        if (!attachedRoom) {

            return fail(
                RECOVERY_RESULT_STATUS.FAILED_ATTACH,
                "room_attach",
                "attachRoom returned null (missing identity or duplicate)"
            );

        }

        attached.push({ component: "room", id: payload.roomId });

        // 7. Player attaches
        for (const player of aggregates.players) {

            const attachedPlayer = this._playerManager.attachPlayer(player);

            if (!attachedPlayer) {

                return fail(
                    RECOVERY_RESULT_STATUS.FAILED_ATTACH,
                    "player_attach",
                    `attachPlayer returned null for ${player.playerId}`
                );

            }

            attached.push({ component: "player", id: player.playerId });

        }

        // 8. Validate playerIndex/order against Room ordering
        const orderedIds = aggregates.room.players;

        if (
            JSON.stringify(orderedIds)
                !== JSON.stringify(aggregates.expectedOrderedIds)
        ) {

            return fail(
                RECOVERY_RESULT_STATUS.FAILED_IDENTITY,
                "player_order_validation",
                "room player ordering does not match persisted playerIndex order"
            );

        }

        // 9. Game attach
        const attachedGame = this._gameManager.attachGame(aggregates.game);

        if (!attachedGame) {

            return fail(
                RECOVERY_RESULT_STATUS.FAILED_ATTACH,
                "game_attach",
                "attachGame returned null (missing identity or duplicate)"
            );

        }

        attached.push({ component: "game", id: payload.gameId });

        // 10. Configuration attach
        const attachedConfiguration = this._configurationEngine.attachConfiguration({
            gameId: payload.gameId,
            roomId: payload.roomId,
            configuration: payload.configuration,
            configurationHash: payload.configurationHash
        });

        if (!attachedConfiguration) {

            return fail(
                RECOVERY_RESULT_STATUS.FAILED_CONFIGURATION,
                "configuration_attach",
                "attachConfiguration returned null (hash/identity/duplicate conflict)"
            );

        }

        attached.push({ component: "configuration", id: payload.gameId });

        // 11. GameState attach (enteredAt uses serverTimestampAtCheckpoint —
        // documented approximation: state was entered at or before checkpoint)
        const attachedState = this._gameStateEngine.attachState({
            gameId: payload.gameId,
            currentState: payload.gameState,
            enteredAt: payload.serverTimestampAtCheckpoint,
            previousState: null,
            history: []
        });

        if (!attachedState) {

            return fail(
                RECOVERY_RESULT_STATUS.FAILED_STATE,
                "state_attach",
                "attachState returned null (invalid state/timestamps/conflict)"
            );

        }

        attached.push({ component: "state", id: payload.gameId });

        const isPreGame = payload.gameState === GAME_STATES.PRE_GAME_READY
            || payload.gameState === GAME_STATES.READY;

        const isResult = payload.gameState === GAME_STATES.RESULT;

        // 12. Clock attach (unarmed) — PRE_GAME_READY/READY only.
        // RESULT is terminal: no clock attach, no arming.
        if (isPreGame) {

            const attachedClock = this._gameClockEngine.attachClock({
                gameId: payload.gameId,
                currentPhase: payload.gameState,
                startedAt: payload.clockStartedAt,
                phaseStartedAt: payload.phaseStartedAt,
                paused: payload.clockPaused,
                totalPausedMs: payload.clockTotalPausedMs,
                awaitingResultActivation: payload.awaitingResultActivation,
                resultPhaseStarted: payload.resultPhaseStarted,
                serverTimestampAtCheckpoint: payload.serverTimestampAtCheckpoint
            }, { arm: false });

            if (!attachedClock) {

                return fail(
                    RECOVERY_RESULT_STATUS.FAILED_CLOCK,
                    "clock_attach",
                    "attachClock returned null (invalid fields/expiry/timer/conflict)"
                );

            }

            attached.push({ component: "clock", id: payload.gameId });

        }

        // 13. Input registry attach — PRE_GAME_READY/READY only, safe defaults
        if (isPreGame) {

            const attachedRegistry = this._inputAuthority.attachRegistry({
                gameId: payload.gameId,
                playerIds: orderedIds,
                commandQueue: [],
                acceptedCommands: [],
                sequenceNumber: 0
            });

            if (!attachedRegistry) {

                return fail(
                    RECOVERY_RESULT_STATUS.FAILED_INPUT,
                    "input_attach",
                    "attachRegistry returned null (player set violation)"
                );

            }

            attached.push({ component: "input", id: payload.gameId });

        }

        // 14. Physics attach
        const physicsRuntime = isResult
            ? {
                state: PHYSICS_SIMULATION_STATE.STOPPED,
                angle: payload.physicsFinalAngle,
                triangleAngle: payload.physicsFinalTriangleAngle,
                angularVelocity: 0,
                triangleAngularVelocity: 0,
                angularAcceleration: 0
            }
            : {
                state: PHYSICS_SIMULATION_STATE.CREATED,
                angle: 0,
                triangleAngle: 0,
                angularVelocity: 0,
                triangleAngularVelocity: 0,
                angularAcceleration: 0
            };

        const attachedSimulation = this._physicsEngine.attachSimulation({
            gameId: payload.gameId,
            runtime: physicsRuntime,
            commandLog: []
        }, { emitEvents: false });

        if (!attachedSimulation) {

            return fail(
                RECOVERY_RESULT_STATUS.FAILED_PHYSICS,
                "physics_attach",
                "attachSimulation returned null (shape violation/conflict)"
            );

        }

        attached.push({ component: "physics", id: payload.gameId });

        // 15. Winner restore — RESULT only, silent deterministic recompute
        if (isResult) {

            const restoredResult = this._winnerEngine.restoreResult(payload.gameId);

            if (!restoredResult) {

                return fail(
                    RECOVERY_RESULT_STATUS.FAILED_WINNER,
                    "winner_restore",
                    "restoreResult returned null (resolution failure)"
                );

            }

            // Track for rollback before any further validation so a
            // subsequent failure detaches the restored result silently.
            attached.push({ component: "winner", id: payload.gameId });

            if (payload.winnerId != null
                && restoredResult.winnerPlayerId !== payload.winnerId) {

                return fail(
                    RECOVERY_RESULT_STATUS.FAILED_WINNER,
                    "winner_validation",
                    `restored winner ${restoredResult.winnerPlayerId} does not `
                        + `match persisted winnerId ${payload.winnerId}`
                );

            }

        }

        // 16. Cross-engine consistency validation
        const consistency = this._validateConsistency(payload, { isPreGame, isResult });

        if (!consistency.ok) {

            return fail(
                RECOVERY_RESULT_STATUS.FAILED_CONSISTENCY,
                "consistency_validation",
                consistency.reason
            );

        }

        // 17. R17.9T.6 OPTION B — connectivity-aware recovered clock arming.
        //
        // The reconstructed PRE_GAME_READY/READY clock stays UNARMED-ATTACHED
        // (authoritative state restored, not running, no timeout scheduled,
        // no phase progression, no lifecycle events) and is registered as
        // pending in runtime memory. It transitions to ARMED only when ALL 3
        // registered players report CONNECTED — either they are already
        // connected at reconstruction time (armed exactly once here), or
        // later via the existing manager-level PLAYER_CONNECTED event.
        //
        // The original authoritative deadline is never modified; late arming
        // uses the existing armRecoveredClock() remaining-time computation
        // and its fail-closed expiry behavior.
        if (isPreGame) {

            this._pendingRecoveredClocks.set(payload.gameId, {
                roomId: payload.roomId,
                playerIds: [...orderedIds]
            });

            const armedNow = this._tryArmPendingRecoveredClock(payload.gameId);

            if (!armedNow
                && this._areAllRegisteredPlayersConnected(orderedIds)) {

                // All players reported CONNECTED yet the existing engine
                // refused arming (e.g. deadline elapsed between checkpoint
                // validation and arming): preserve the pre-existing
                // fail-closed FAILED_EXPIRED rollback behavior exactly.
                this._pendingRecoveredClocks.delete(payload.gameId);

                return fail(
                    RECOVERY_RESULT_STATUS.FAILED_EXPIRED,
                    "clock_arm",
                    "armRecoveredClock refused (expired/paused/terminal-invalid)"
                );

            }

        }

        return this._buildResult({
            status: RECOVERY_RESULT_STATUS.SUCCESS,
            payload,
            classification,
            reason: isResult
                ? "terminal_result_recovered"
                : (this._pendingRecoveredClocks.has(payload.gameId)
                    ? "pre_game_candidate_recovered_clock_pending_connectivity"
                    : "pre_game_candidate_recovered_clock_armed")
        });

    }

    // -------------------------------------------------------------------------
    // R17.9T.6 OPTION B — connectivity-aware recovered clock arming
    // -------------------------------------------------------------------------

    /**
     * Resolve the authoritative EventBus. Prefers an explicitly injected bus;
     * falls back to the same manager-level bus held by the injected
     * PlayerManager (the source of PLAYER_CONNECTED). No socket awareness.
     */
    _resolveEventBus() {

        if (this._injectedEventBus) {

            return this._injectedEventBus;

        }

        try {

            return this._playerManager?._eventBus ?? null;

        } catch {

            return null;

        }

    }

    /**
     * Subscribe ONCE per orchestrator instance to the existing manager-level
     * PLAYER_CONNECTED event. Idempotent; no broad lifecycle abstraction.
     */
    _ensurePlayerConnectedSubscription() {

        if (this._playerConnectedSubscribed) {

            return;

        }

        const eventBus = this._resolveEventBus();

        if (!eventBus || typeof eventBus.subscribe !== "function") {

            return;

        }

        this._playerConnectedHandler = (event) => {

            this._handlePlayerConnected(event);

        };

        eventBus.subscribe(
            EVENT_TYPES.PLAYER_CONNECTED,
            this._playerConnectedHandler
        );

        this._playerConnectedSubscribed = true;

    }

    /**
     * PLAYER_CONNECTED consumer. Uses the existing event payload semantics
     * ({ playerId, connectionState, runtime }) to locate affected pending
     * recovered games, re-verifies the CURRENT authoritative connection
     * state of all 3 registered players, and arms exactly once when the
     * predicate holds. Duplicate events and post-arming events are safe
     * no-ops (the pending entry is removed on successful arming).
     */
    _handlePlayerConnected(event) {

        try {

            const payload = event?.payload ?? event;

            const playerId = payload?.playerId;

            if (!playerId) {

                return;

            }

            for (const gameId of [...this._pendingRecoveredClocks.keys()]) {

                const entry = this._pendingRecoveredClocks.get(gameId);

                if (!entry?.playerIds?.includes(playerId)) {

                    continue;

                }

                this._tryArmPendingRecoveredClock(gameId);

            }

        } catch (error) {

            this._logError(
                `RecoveryOrchestrator: PLAYER_CONNECTED handling failed | `
                    + `${error?.message ?? error}`
            );

        }

    }

    /**
     * Authoritative connectivity predicate: ALL 3 REGISTERED players of the
     * recovered game must currently report CONNECTED via the existing
     * PlayerManager connection state.
     */
    _areAllRegisteredPlayersConnected(playerIds) {

        return playerIds.every((playerId) =>

            this._playerManager.hasPlayer(playerId)
            && this._playerManager.getRuntime(playerId)?.connectionState
                === CONNECTION_STATE.CONNECTED

        );

    }

    /**
     * Attempt to arm a pending recovered clock exactly once. Removes the
     * pending entry on successful arming AND on refused arming (fail-closed),
     * so stale entries never survive. Returns true only when the clock was
     * actually armed by this call.
     */
    _tryArmPendingRecoveredClock(gameId) {

        const entry = this._pendingRecoveredClocks.get(gameId);

        if (!entry) {

            return false;

        }

        if (!this._areAllRegisteredPlayersConnected(entry.playerIds)) {

            return false;

        }

        const armed = this._gameClockEngine.armRecoveredClock(gameId);

        // Remove the pending entry regardless of outcome: on success the
        // game is armed (further PLAYER_CONNECTED events must be no-ops);
        // on refusal the existing fail-closed engine behavior is final and
        // no stale pending residue may remain.
        this._pendingRecoveredClocks.delete(gameId);

        if (!armed) {

            this._logError(
                `RecoveryOrchestrator: pending recovered clock arming refused | `
                    + `gameId=${gameId} (existing fail-closed behavior preserved)`
            );

            return false;

        }

        this._logInfo(
            `RecoveryOrchestrator: pending recovered clock armed | `
                + `gameId=${gameId}`
        );

        return true;

    }

    // -------------------------------------------------------------------------
    // Classification (pure function over existing contract fields)
    // -------------------------------------------------------------------------

    _classifyCandidate(payload, recoveryRecord) {

        const envelopeStatus = recoveryRecord && typeof recoveryRecord === "object"
            ? recoveryRecord.status
            : null;

        // ALREADY_TERMINAL: gameplay lifecycle already concluded.
        if (payload.gameStatus === GAME_STATUS.FINISHED
            || payload.gameStatus === GAME_STATUS.DESTROYED) {

            return {
                type: "ALREADY_TERMINAL",
                reason: `gameStatus_${payload.gameStatus}`
            };

        }

        // FINANCIAL_ONLY: terminal-status envelopes where gameplay runtime is
        // unnecessary (settled / refund-closed / terminal records). Financial
        // continuation belongs to the financial recovery architecture.
        if (envelopeStatus != null
            && RECOVERY_DATA_TERMINAL_STATUSES.includes(envelopeStatus)) {

            return {
                type: "FINANCIAL_ONLY",
                reason: `envelope_status_${envelopeStatus}`
            };

        }

        // NOT_RECOVERABLE: active motion phases (physics/input state absent
        // by design) and paused clocks without exact pause timing.
        if (UNRECOVERABLE_ACTIVE_GAME_STATES.includes(payload.gameState)) {

            return {
                type: "NOT_RECOVERABLE",
                reason: `unsupported_active_phase_${payload.gameState}`
            };

        }

        if (payload.clockPaused === true
            && payload.gameState !== GAME_STATES.RESULT) {

            return {
                type: "NOT_RECOVERABLE",
                reason: "paused_clock_exact_timing_not_persisted"
            };

        }

        if (!RECOVERABLE_GAME_STATES.includes(payload.gameState)) {

            return {
                type: "NOT_RECOVERABLE",
                reason: `unsupported_game_state_${String(payload.gameState)}`
            };

        }

        // EXPIRED: unpaused phase deadline already passed at checkpoint time.
        if ((payload.gameState === GAME_STATES.PRE_GAME_READY
            || payload.gameState === GAME_STATES.READY)) {

            const expiry = this._computePhaseExpiry(payload);

            if (expiry.expired) {

                return {
                    type: "EXPIRED",
                    reason: `phase_deadline_expired_at_checkpoint`
                };

            }

        }

        return {
            type: "RECOVERABLE",
            reason: `eligible_phase_${payload.gameState}`
        };

    }

    _computePhaseExpiry(payload) {

        const phase = payload.gameState;

        const timer = payload.configuration?.timers?.[phase];

        const durationMs = timer?.durationMs;

        if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) {

            return { expired: false, durationMs: null };

        }

        const deadline = payload.phaseStartedAt + durationMs;

        return {
            expired: deadline <= payload.serverTimestampAtCheckpoint,
            deadline,
            durationMs
        };

    }

    // -------------------------------------------------------------------------
    // Duplicate / idempotency detection
    // -------------------------------------------------------------------------

    _checkDuplicateRuntime(payload) {

        const hasRoom = this._roomManager.hasRoom(payload.roomId);

        const hasGame = this._gameManager.hasGame(payload.gameId);

        const playersPresent = payload.players.every((player) =>
            this._playerManager.hasPlayer(player.playerId));

        const presentCount =
            (hasRoom ? 1 : 0)
            + (hasGame ? 1 : 0)
            + (playersPresent ? 1 : 0);

        if (presentCount === 0) {

            return { outcome: "absent" };

        }

        // All identity components already present → verify equivalence.
        if (hasRoom && hasGame && playersPresent) {

            const existingRoom = this._roomManager.getRoom(payload.roomId);

            const existingGame = this._gameManager.getGame(payload.gameId);

            const identityConsistent =
                existingRoom?.roomId === payload.roomId
                && existingGame?.gameId === payload.gameId
                && existingGame?.roomId === payload.roomId;

            if (!identityConsistent) {

                return {
                    outcome: "conflict",
                    reason: "existing_runtime_identity_conflicts_with_candidate"
                };

            }

            // Configuration conflict check: an existing configuration with a
            // different hash must fail closed rather than be overwritten.
            const existingConfiguration = this._configurationEngine.getConfiguration(
                payload.gameId
            );

            if (existingConfiguration != null) {

                const existingHash = computePayloadChecksum(existingConfiguration);

                if (existingHash !== payload.configurationHash) {

                    return {
                        outcome: "conflict",
                        reason: "existing_configuration_hash_conflicts_with_candidate"
                    };

                }

            }

            return { outcome: "already_recovered" };

        }

        // Partial presence → conflicting live runtime state; never destroy
        // existing objects to make recovery succeed.
        return {
            outcome: "conflict",
            reason: "partial_existing_runtime_detected"
        };

    }

    // -------------------------------------------------------------------------
    // Pre-mutation validation
    // -------------------------------------------------------------------------

    _validateCandidatePreMutation(payload) {

        // IDENTITY
        for (const field of [
            "roomId", "gameId", "contractId", "paymentSessionId", "tonNetwork"
        ]) {

            if (payload[field] == null || payload[field] === "") {

                return {
                    ok: false,
                    status: RECOVERY_RESULT_STATUS.FAILED_IDENTITY,
                    reason: `identity_field_missing:${field}`
                };

            }

        }

        // PLAYERS: exactly expected count, unique ids, valid indices.
        if (!Array.isArray(payload.players)
            || payload.players.length !== EXPECTED_PLAYER_COUNT) {

            return {
                ok: false,
                status: RECOVERY_RESULT_STATUS.FAILED_IDENTITY,
                reason: `players_count_must_be_${EXPECTED_PLAYER_COUNT}`
            };

        }

        const playerIds = payload.players.map((player) => player.playerId);

        if (new Set(playerIds).size !== playerIds.length) {

            return {
                ok: false,
                status: RECOVERY_RESULT_STATUS.FAILED_IDENTITY,
                reason: "duplicate_player_ids"
            };

        }

        const indices = payload.players.map((player) => player.playerIndex);

        const expectedIndices = [0, 1, 2];

        const sortedByIndex = [...payload.players]
            .sort((a, b) => a.playerIndex - b.playerIndex);

        if (JSON.stringify(indices.slice().sort((a, b) => a - b))
            !== JSON.stringify(expectedIndices)) {

            return {
                ok: false,
                status: RECOVERY_RESULT_STATUS.FAILED_IDENTITY,
                reason: "player_index_set_must_be_0_1_2"
            };

        }

        // CONFIGURATION
        const configuration = payload.configuration;

        if (!configuration || typeof configuration !== "object") {

            return {
                ok: false,
                status: RECOVERY_RESULT_STATUS.FAILED_CONFIGURATION,
                reason: "configuration_missing"
            };

        }

        if (configuration.gameId !== payload.gameId) {

            return {
                ok: false,
                status: RECOVERY_RESULT_STATUS.FAILED_CONFIGURATION,
                reason: "configuration_gameId_mismatch"
            };

        }

        if (configuration.metadata?.roomId !== payload.roomId) {

            return {
                ok: false,
                status: RECOVERY_RESULT_STATUS.FAILED_CONFIGURATION,
                reason: "configuration_metadata_roomId_mismatch"
            };

        }

        if (typeof payload.configurationHash !== "string"
            || payload.configurationHash === "") {

            return {
                ok: false,
                status: RECOVERY_RESULT_STATUS.FAILED_CONFIGURATION,
                reason: "configurationHash_missing"
            };

        }

        const computedHash = computePayloadChecksum(configuration);

        if (computedHash !== payload.configurationHash) {

            return {
                ok: false,
                status: RECOVERY_RESULT_STATUS.FAILED_CONFIGURATION,
                reason: "configurationHash_mismatch"
            };

        }

        if (payload.traceSeed == null
            || configuration.traceSeed == null
            || payload.traceSeed !== configuration.traceSeed) {

            return {
                ok: false,
                status: RECOVERY_RESULT_STATUS.FAILED_CONFIGURATION,
                reason: "traceSeed_mismatch_or_missing"
            };

        }

        if (payload.configurationVersion == null
            || configuration.configurationVersion == null
            || payload.configurationVersion !== configuration.configurationVersion) {

            return {
                ok: false,
                status: RECOVERY_RESULT_STATUS.FAILED_CONFIGURATION,
                reason: "configurationVersion_mismatch_or_missing"
            };

        }

        // Configuration player set must match the recovery player set.
        const configurationPlayerIds = Array.isArray(configuration.players)
            ? configuration.players.map((player) => player.playerId).sort()
            : null;

        if (configurationPlayerIds == null
            || JSON.stringify(configurationPlayerIds)
                !== JSON.stringify([...playerIds].sort())) {

            return {
                ok: false,
                status: RECOVERY_RESULT_STATUS.FAILED_CONFIGURATION,
                reason: "configuration_player_set_mismatch"
            };

        }

        // STATE
        if (!RECOVERABLE_GAME_STATES.includes(payload.gameState)) {

            return {
                ok: false,
                status: RECOVERY_RESULT_STATUS.FAILED_STATE,
                reason: `unsupported_game_state_${String(payload.gameState)}`
            };

        }

        if (payload.gameStatus == null) {

            return {
                ok: false,
                status: RECOVERY_RESULT_STATUS.FAILED_STATE,
                reason: "gameStatus_missing"
            };

        }

        if (typeof payload.serverTimestampAtCheckpoint !== "number"
            || !Number.isFinite(payload.serverTimestampAtCheckpoint)) {

            return {
                ok: false,
                status: RECOVERY_RESULT_STATUS.FAILED_STATE,
                reason: "serverTimestampAtCheckpoint_invalid"
            };

        }

        // CLOCK (PRE_GAME_READY/READY only; RESULT is terminal)
        const isPreGame = payload.gameState === GAME_STATES.PRE_GAME_READY
            || payload.gameState === GAME_STATES.READY;

        if (isPreGame) {

            for (const field of [
                "phaseStartedAt", "clockStartedAt", "clockTotalPausedMs"
            ]) {

                if (typeof payload[field] !== "number"
                    || !Number.isFinite(payload[field])) {

                    return {
                        ok: false,
                        status: RECOVERY_RESULT_STATUS.FAILED_CLOCK,
                        reason: `clock_field_invalid:${field}`
                    };

                }

            }

            if (typeof payload.clockPaused !== "boolean") {

                return {
                    ok: false,
                    status: RECOVERY_RESULT_STATUS.FAILED_CLOCK,
                    reason: "clockPaused_invalid"
                };

            }

            // Paused clocks fail closed: exact pause timing is not persisted.
            if (payload.clockPaused === true) {

                return {
                    ok: false,
                    status: RECOVERY_RESULT_STATUS.FAILED_CLOCK,
                    reason: "paused_clock_exact_timing_not_persisted"
                };

            }

            const expiry = this._computePhaseExpiry(payload);

            if (expiry.durationMs == null) {

                return {
                    ok: false,
                    status: RECOVERY_RESULT_STATUS.FAILED_CLOCK,
                    reason: `timer_definition_missing_for_${payload.gameState}`
                };

            }

            if (expiry.expired) {

                return {
                    ok: false,
                    status: RECOVERY_RESULT_STATUS.FAILED_EXPIRED,
                    reason: "phase_deadline_expired_at_checkpoint"
                };

            }

        }

        // PHYSICS
        const isResult = payload.gameState === GAME_STATES.RESULT;

        if (isResult) {

            if (payload.physicsSimulationState !== PHYSICS_SIMULATION_STATE.STOPPED) {

                return {
                    ok: false,
                    status: RECOVERY_RESULT_STATUS.FAILED_PHYSICS,
                    reason: `terminal_physics_state_must_be_STOPPED_got_`
                        + `${String(payload.physicsSimulationState)}`
                };

            }

            for (const field of ["physicsFinalAngle", "physicsFinalTriangleAngle"]) {

                if (typeof payload[field] !== "number"
                    || !Number.isFinite(payload[field])) {

                    return {
                        ok: false,
                        status: RECOVERY_RESULT_STATUS.FAILED_PHYSICS,
                        reason: `terminal_physics_angle_invalid:${field}`
                    };

                }

            }

        }

        // WINNER (RESULT only): validated after silent restore against
        // payload.winnerId when present.

        return { ok: true };

    }

    // -------------------------------------------------------------------------
    // Aggregate construction (existing constructors; no ID generation)
    // -------------------------------------------------------------------------

    _constructAggregates(payload) {

        const sortedPlayers = [...payload.players]
            .sort((a, b) => a.playerIndex - b.playerIndex);

        const orderedIds = sortedPlayers.map((player) => player.playerId);

        // Room — preserve persisted roomId; createdAt is not persisted and is
        // NOT invented (null); status FULL derives from exactly-3 membership.
        const room = new Room({
            roomId: payload.roomId,
            createdAt: null,
            status: ROOM_STATUS.FULL,
            maxPlayers: EXPECTED_PLAYER_COUNT,
            players: [...orderedIds]
        });

        // Players — preserve persisted playerId/playerIndex and required
        // identity fields verbatim; runtime connection state uses model-safe
        // defaults representing "not connected since restart".
        const players = sortedPlayers.map((persistedPlayer) => {

            const identity = new PlayerIdentity({
                playerId: persistedPlayer.playerId,
                nickname: persistedPlayer.nickname,
                wallet: persistedPlayer.wallet,
                icon: persistedPlayer.icon,
                age: persistedPlayer.age,
                color: persistedPlayer.color,
                colorSector2: persistedPlayer.colorSector2,
                sectorCount: persistedPlayer.sectorCount,
                sectorArrangement: persistedPlayer.sectorArrangement,
                baseStake: persistedPlayer.baseStake,
                createdAt: null
            });

            const runtime = new PlayerRuntime({
                roomId: payload.roomId,
                gameId: payload.gameId,
                lastSeen: null
            });

            return {
                playerId: persistedPlayer.playerId,
                playerIndex: persistedPlayer.playerIndex,
                identity,
                runtime
            };

        });

        // Game — preserve persisted gameId/roomId/gameStatus verbatim.
        const game = new Game({
            gameId: payload.gameId,
            roomId: payload.roomId,
            createdAt: null,
            status: payload.gameStatus,
            players: [...orderedIds],
            metadata: {}
        });

        return {
            ok: true,
            room,
            players,
            game,
            orderedIds,
            expectedOrderedIds: orderedIds
        };

    }

    // -------------------------------------------------------------------------
    // Cross-engine consistency validation (read-only)
    // -------------------------------------------------------------------------

    _validateConsistency(payload, { isPreGame, isResult }) {

        const gameId = payload.gameId;
        const roomId = payload.roomId;

        // IDENTITY
        const room = this._roomManager.getRoom(roomId);

        const game = this._gameManager.getGame(gameId);

        if (!room || room.roomId !== roomId) {

            return { ok: false, reason: "consistency_room_missing" };

        }

        if (!game || game.gameId !== gameId || game.roomId !== roomId) {

            return { ok: false, reason: "consistency_game_identity" };

        }

        const orderedIds = [...payload.players]
            .sort((a, b) => a.playerIndex - b.playerIndex)
            .map((player) => player.playerId);

        if (JSON.stringify(room.players) !== JSON.stringify(orderedIds)) {

            return { ok: false, reason: "consistency_room_player_membership" };

        }

        if (JSON.stringify(game.players) !== JSON.stringify(orderedIds)) {

            return { ok: false, reason: "consistency_game_player_membership" };

        }

        // CONFIGURATION
        const configuration = this._configurationEngine.getConfiguration(gameId);

        if (!configuration
            || configuration.gameId !== gameId
            || configuration.metadata?.roomId !== roomId) {

            return { ok: false, reason: "consistency_configuration_identity" };

        }

        // GAME STATE
        const currentState = this._gameStateEngine.getState(gameId);

        if (currentState !== payload.gameState) {

            return { ok: false, reason: "consistency_game_state" };

        }

        // CLOCK
        if (isPreGame) {

            const clock = this._gameClockEngine.getClock(gameId);

            if (!clock || clock.currentPhase !== payload.gameState) {

                return { ok: false, reason: "consistency_clock_phase" };

            }

        }

        // PHYSICS
        const simulation = this._physicsEngine.getSimulation(gameId);

        if (!simulation) {

            return { ok: false, reason: "consistency_physics_missing" };

        }

        const expectedPhysicsState = isResult
            ? PHYSICS_SIMULATION_STATE.STOPPED
            : PHYSICS_SIMULATION_STATE.CREATED;

        if (simulation.runtime?.state !== expectedPhysicsState) {

            return { ok: false, reason: "consistency_physics_state" };

        }

        // INPUT
        if (isPreGame) {

            if (!this._inputAuthority.hasGame(gameId)) {

                return { ok: false, reason: "consistency_input_registry_missing" };

            }

        }

        // WINNER
        if (isResult) {

            const result = this._winnerEngine.getResult(gameId);

            if (!result) {

                return { ok: false, reason: "consistency_winner_missing" };

            }

        }

        return { ok: true };

    }

    // -------------------------------------------------------------------------
    // Silent rollback (reverse order of successful attachment)
    // -------------------------------------------------------------------------

    _rollbackCandidate(attached) {

        let complete = true;

        // Reverse order: winner → physics → input → clock → state →
        // configuration → game → players → room. Only approved silent detach
        // APIs and demonstrably silent removals are used.
        for (let i = attached.length - 1; i >= 0; i -= 1) {

            const entry = attached[i];

            try {

                switch (entry.component) {

                    case "winner":
                        this._winnerEngine.detachResult(entry.id);
                        break;

                    case "physics":
                        // D2-attached simulations are CREATED/STOPPED ⇒
                        // removeSimulation is silent for these shapes.
                        this._physicsEngine.removeSimulation(entry.id);
                        break;

                    case "input":
                        this._inputAuthority.removeGame(entry.id);
                        break;

                    case "clock":
                        // Unarmed attached clock (running=false) is removed
                        // silently by removeClock.
                        this._gameClockEngine.removeClock(entry.id);
                        break;

                    case "state":
                        this._gameStateEngine.removeState(entry.id);
                        break;

                    case "configuration":
                        this._configurationEngine.detachConfiguration(entry.id);
                        break;

                    case "game":
                        this._gameManager.detachGame(entry.id);
                        break;

                    case "player":
                        this._playerManager.detachPlayer(entry.id);
                        break;

                    case "room":
                        this._roomManager.detachRoom(entry.id);
                        break;

                    default:
                        complete = false;
                        break;

                }

            } catch (error) {

                complete = false;

                this._logError(
                    `RecoveryOrchestrator: rollback step failed | `
                        + `component=${entry.component} id=${entry.id} | `
                        + `${error?.message ?? error}`
                );

            }

        }

        return { complete };

    }

    // -------------------------------------------------------------------------
    // Result building / helpers
    // -------------------------------------------------------------------------

    _extractPayload(recoveryRecord) {

        if (recoveryRecord && typeof recoveryRecord === "object"
            && "payload" in recoveryRecord) {

            return recoveryRecord.payload;

        }

        return recoveryRecord;

    }

    _buildResult({
        status,
        payload,
        classification = null,
        failedStep = null,
        reason = ""
    }) {

        const result = {
            status,
            classification: classification?.type ?? null,
            recoveryRecordId: payload?.recoveryRecordId ?? null,
            gameId: payload?.gameId ?? null,
            roomId: payload?.roomId ?? null,
            reason
        };

        if (failedStep != null) {

            result.failedStep = failedStep;

        }

        if (status !== RECOVERY_RESULT_STATUS.SUCCESS) {

            this._logError(
                `RecoveryOrchestrator: candidate not recovered | `
                    + `status=${status} gameId=${result.gameId} `
                    + `step=${failedStep ?? "-"} reason=${reason}`
            );

        } else {

            this._logInfo(
                `RecoveryOrchestrator: candidate recovered | `
                    + `gameId=${result.gameId} phase=${payload?.gameState}`
            );

        }

        return result;

    }

    _buildSummary(results, extra = {}) {

        const counts = {};

        for (const value of Object.values(RECOVERY_RESULT_STATUS)) {

            counts[value] = 0;

        }

        for (const result of results) {

            if (counts[result.status] !== undefined) {

                counts[result.status] += 1;

            }

        }

        return {
            total: results.length,
            success: counts[RECOVERY_RESULT_STATUS.SUCCESS],
            alreadyRecovered: counts[RECOVERY_RESULT_STATUS.ALREADY_RECOVERED],
            skippedNotRecoverable:
                counts[RECOVERY_RESULT_STATUS.SKIPPED_NOT_RECOVERABLE],
            skippedFinancialOnly:
                counts[RECOVERY_RESULT_STATUS.SKIPPED_FINANCIAL_ONLY],
            skippedAlreadyTerminal:
                counts[RECOVERY_RESULT_STATUS.SKIPPED_ALREADY_TERMINAL],
            failed: results.length
                - counts[RECOVERY_RESULT_STATUS.SUCCESS]
                - counts[RECOVERY_RESULT_STATUS.ALREADY_RECOVERED]
                - counts[RECOVERY_RESULT_STATUS.SKIPPED_NOT_RECOVERABLE]
                - counts[RECOVERY_RESULT_STATUS.SKIPPED_FINANCIAL_ONLY]
                - counts[RECOVERY_RESULT_STATUS.SKIPPED_ALREADY_TERMINAL],
            ...extra
        };

    }

    _logInfo(message) {

        this._logger?.info?.(message);

    }

    _logError(message) {

        this._logger?.error?.(message);

    }

}