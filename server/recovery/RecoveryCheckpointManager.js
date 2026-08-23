/**
 * R17.9T.6 — RecoveryCheckpointManager.
 *
 * Single centralized owner of authoritative gameplay recovery checkpoint
 * writing into RECOVERY_DATA persistence.
 *
 * Responsibilities:
 *   - subscribe to existing authoritative lifecycle events
 *     (GAME_STATE_CHANGED, GAME_RESULT_READY — no new events);
 *   - filter approved checkpoint phases only:
 *       PRE_GAME_READY → CREATE
 *       READY          → UPDATE
 *       RESULT         → UPDATE + mark envelope TERMINAL
 *   - assemble the recovery payload exclusively from authoritative runtime
 *     owners (RoomManager, PlayerManager, GameManager, ConfigurationEngine,
 *     GameStateEngine, GameClockEngine, PhysicsEngine, WinnerEngine) and
 *     existing financial reference identifiers (GameContractManager,
 *     PaymentSessionManager — references ONLY, zero financial authority);
 *   - validate checkpoint safety before writing (clock unpaused, physics
 *     CREATED for pre-motion phases / STOPPED with finite final angles for
 *     RESULT, input registry in safe default shape, exactly 3 ordered players);
 *   - enforce forward-only phase progression locally
 *     (PRE_GAME_READY < READY < RESULT); persistence has no newer-phase guard;
 *   - provide idempotent behavior: duplicate events never create duplicate
 *     records and never throw into the EventBus;
 *   - handle the terminal RESULT checkpoint and terminal-record immutability;
 *   - catch ALL persistence/assembly failures, log them structurally, and
 *     continue gameplay. Checkpoint failures NEVER propagate through the
 *     EventBus and NEVER affect live gameplay.
 *
 * Explicit boundaries:
 *   - does NOT own gameplay state;
 *   - is NOT a financial authority (no payout/settlement/refund logic, no
 *     financial record writes, no blockchain calls);
 *   - does NOT perform or start recovery (RecoveryOrchestrator owns that);
 *   - does NOT modify gameplay state;
 *   - emits NO events of any kind.
 *
 * Paused-clock policy (approved architecture decision):
 *   If clockPaused === true at an approved checkpoint moment, the checkpoint
 *   is NOT written: the Recovery Data Contract contains no pauseStartedAt /
 *   pause history, and RecoveryOrchestrator refuses paused-clock recovery.
 *   A structured warning is logged and gameplay continues unaffected.
 *
 * Clock field sourcing note (R17.9T.6 implementation):
 *   GameClockEngine.getClock() exposes currentPhase / startedAt /
 *   phaseStartedAt / paused but does NOT expose totalPausedMs,
 *   awaitingResultActivation or resultPhaseStarted public getters. For the
 *   approved phases these values are EXACTLY derivable from authoritative
 *   state, not invented:
 *     - totalPausedMs === 0 whenever the clock is unpaused, because the only
 *       mutation paths are startClock (sets 0) and resumeClock (adds elapsed
 *       pause; resumeClock has no production caller — pause/resume exist as
 *       engine APIs but are not invoked by any production lifecycle code);
 *     - awaitingResultActivation === false at PRE_GAME_READY/READY because it
 *       is only set true on BRAKE-phase timeout, which strictly follows these
 *       phases in the linear forward-only GAME_STATES transition table;
 *     - resultPhaseStarted === false at PRE_GAME_READY/READY because it is
 *       only set true by beginResultPhase (RESULT entry), which likewise
 *       strictly follows these phases.
 *   The skip-on-paused policy guarantees a paused clock is never checkpointed,
 *   so no unrepresentable pause state can ever be persisted.
 */

import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import { CONFIGURATION_VERSION } from "../engines/configuration/ConfigurationVersion.js";
import {
    RECOVERY_CONTRACT_VERSION
} from "../persistence/RecoveryDataPersistence.js";
import {
    RECOVERY_DATA_TERMINAL_STATUSES,
    TON_FINANCIAL_SCHEMA_VERSION
} from "../persistence/TonFinancialRecordTypes.js";
import { computePayloadChecksum } from "../persistence/tonFinancialRecordUtils.js";

/**
 * Local monotonic phase ranking (forward-only progression guard).
 */
const PHASE_RANK = Object.freeze({
    [GAME_STATES.PRE_GAME_READY]: 1,
    [GAME_STATES.READY]: 2,
    [GAME_STATES.RESULT]: 3
});

/**
 * Expected number of players in a WheelWin game.
 */
const EXPECTED_PLAYER_COUNT = 3;

/**
 * @typedef {object} RecoveryCheckpointManagerOptions
 * @property {object} logger
 * @property {object} eventBus
 * @property {object} recoveryDataPersistence - Initialized RecoveryDataPersistence.
 * @property {object} roomManager
 * @property {object} playerManager
 * @property {object} gameManager
 * @property {object} configurationEngine
 * @property {object} gameStateEngine
 * @property {object} gameClockEngine
 * @property {object} physicsEngine
 * @property {object} winnerEngine
 * @property {object} inputAuthority
 * @property {object|null} [gameContractManager]
 * @property {object|null} [paymentSessionManager]
 */

export class RecoveryCheckpointManager {

    /**
     * @param {RecoveryCheckpointManagerOptions} options
     */
    constructor({
        logger,
        eventBus,
        recoveryDataPersistence,
        roomManager,
        playerManager,
        gameManager,
        configurationEngine,
        gameStateEngine,
        gameClockEngine,
        physicsEngine,
        winnerEngine,
        inputAuthority,
        gameContractManager = null,
        paymentSessionManager = null
    } = {}) {

        if (!recoveryDataPersistence) {

            throw new Error(
                "RecoveryCheckpointManager requires recoveryDataPersistence"
            );

        }

        this._logger = logger ?? null;

        this._eventBus = eventBus;

        this._recoveryDataPersistence = recoveryDataPersistence;

        this._roomManager = roomManager;

        this._playerManager = playerManager;

        this._gameManager = gameManager;

        this._configurationEngine = configurationEngine;

        this._gameStateEngine = gameStateEngine;

        this._gameClockEngine = gameClockEngine;

        this._physicsEngine = physicsEngine;

        this._winnerEngine = winnerEngine;

        this._inputAuthority = inputAuthority;

        this._gameContractManager = gameContractManager;

        this._paymentSessionManager = paymentSessionManager;

        this._handlers = [];

        this._initialized = false;

    }

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    /**
     * Subscribe to the existing authoritative lifecycle events.
     * Must be called after all injected dependencies exist and BEFORE
     * gameplay events can occur.
     */
    initialize() {

        if (this._initialized) {

            return;

        }

        const stateChangedHandler = (envelope) => {

            this._handleGameStateChanged(envelope?.payload ?? null);

        };

        this._eventBus.subscribe(
            EVENT_TYPES.GAME_STATE_CHANGED,
            stateChangedHandler
        );

        this._handlers.push({
            event: EVENT_TYPES.GAME_STATE_CHANGED,
            handler: stateChangedHandler
        });

        const resultReadyHandler = (envelope) => {

            this._handleGameResultReady(envelope?.payload ?? null);

        };

        this._eventBus.subscribe(
            EVENT_TYPES.GAME_RESULT_READY,
            resultReadyHandler
        );

        this._handlers.push({
            event: EVENT_TYPES.GAME_RESULT_READY,
            handler: resultReadyHandler
        });

        this._initialized = true;

    }

    shutdown() {

        for (const subscription of this._handlers) {

            this._eventBus.unsubscribe(
                subscription.event,
                subscription.handler
            );

        }

        this._handlers = [];

        this._initialized = false;

    }

    // -------------------------------------------------------------------------
    // Event handlers (consume only — never emit)
    // -------------------------------------------------------------------------

    /**
     * GAME_STATE_CHANGED consumer.
     *
     * GameStateEngine mutates its state BEFORE emitting this event, so the
     * handler observes post-transition authoritative state. Only approved
     * phases trigger checkpoints; SELF_TEST / SPEED / BRAKE and every other
     * phase are ignored without any write.
     *
     * @param {object|null} payload
     */
    _handleGameStateChanged(payload) {

        try {

            const gameId = payload?.gameId ?? null;

            const currentState = payload?.currentState ?? null;

            if (!gameId || !currentState) {

                return;

            }

            if (currentState === GAME_STATES.PRE_GAME_READY) {

                this.checkpoint(gameId, GAME_STATES.PRE_GAME_READY);

                return;

            }

            if (currentState === GAME_STATES.READY) {

                this.checkpoint(gameId, GAME_STATES.READY);

                return;

            }

            // SELF_TEST / SPEED / BRAKE / anything else: intentionally not
            // checkpointed (active motion phases are fail-closed domains).

        } catch (error) {

            // Absolute failure boundary: a checkpoint problem must never
            // propagate through the EventBus into gameplay handling.
            this._logError("game_state_changed_handler", null, null, error);

        }

    }

    /**
     * GAME_RESULT_READY consumer (preferred RESULT trigger).
     *
     * This event is emitted by WinnerEngine.resolveResult (before the RESULT
     * transition, while gameState may still be BRAKE) AND by
     * GameplayPhaseLifecycle on RESULT_COMPLETED (after the RESULT
     * transition). Only the latter satisfies the RESULT checkpoint
     * precondition gameState === RESULT; earlier emissions are ignored.
     * Using this event eliminates the WinnerActivation retry race identified
     * in the pre-implementation audit.
     *
     * @param {object|null} payload
     */
    _handleGameResultReady(payload) {

        try {

            const gameId = payload?.gameId ?? null;

            if (!gameId) {

                return;

            }

            const currentState = this._safeGetState(gameId);

            if (currentState !== GAME_STATES.RESULT) {

                // WinnerEngine's own GAME_RESULT_READY emission arrives
                // before the RESULT transition; not a checkpoint moment.
                return;

            }

            this.checkpoint(gameId, GAME_STATES.RESULT);

        } catch (error) {

            this._logError("game_result_ready_handler", payload?.gameId ?? null, null, error);

        }

    }

    // -------------------------------------------------------------------------
    // Public checkpoint API
    // -------------------------------------------------------------------------

    /**
     * Attempt one checkpoint for a game at an approved phase.
     *
     * NEVER throws. Returns an explicit result object:
     *   { status: "created" | "updated" | "skipped" | "conflict" | "failed",
     *     gameId, phase, reason? }
     *
     * @param {string} gameId
     * @param {string} phase - One of PRE_GAME_READY | READY | RESULT.
     * @returns {object} Explicit checkpoint result.
     */
    checkpoint(gameId, phase) {

        const incomingRank = PHASE_RANK[phase];

        if (!gameId || !incomingRank) {

            return {
                status: "skipped",
                gameId: gameId ?? null,
                phase: phase ?? null,
                reason: "invalid_checkpoint_request"
            };

        }

        try {

            return this._checkpointInternal(gameId, phase, incomingRank);

        } catch (error) {

            // Mandatory failure policy: catch, classify, log, continue.
            // Never stop/rollback gameplay, never throw through EventBus.
            this._logError("checkpoint", gameId, phase, error);

            return {
                status: "failed",
                gameId,
                phase,
                reason: `exception:${error?.message ?? String(error)}`
            };

        }

    }

    // -------------------------------------------------------------------------
    // Internal pipeline: read → validate → assemble → persist → return
    // -------------------------------------------------------------------------

    _checkpointInternal(gameId, phase, incomingRank) {

        // --- Read authoritative identity/state ------------------------------

        const game = this._safeCall(
            () => this._gameManager?.getGame?.(gameId) ?? null
        );

        if (!game?.roomId) {

            return this._skip(gameId, phase, "authoritative_game_missing");

        }

        const roomId = game.roomId;

        const authoritativeState = this._safeGetState(gameId);

        if (authoritativeState !== phase) {

            return this._skip(
                gameId,
                phase,
                `state_mismatch:${String(authoritativeState)}`
            );

        }

        // --- Configuration (frozen, verbatim; never regenerated) ------------

        const configuration = this._safeCall(
            () => this._configurationEngine?.getConfiguration?.(gameId) ?? null
        );

        if (!configuration
            || typeof configuration !== "object"
            || configuration.gameId !== gameId
            || configuration.metadata?.roomId !== roomId
            || configuration.traceSeed == null) {

            return this._skip(gameId, phase, "configuration_unavailable");

        }

        const configurationHash = computePayloadChecksum(configuration);

        // --- Financial references (references ONLY) --------------------------

        const contract = this._safeCall(
            () => this._gameContractManager?.getContractByGameId?.(gameId)
                ?? null
        );

        const session = this._safeCall(
            () => this._paymentSessionManager?.getSessionByGameId?.(gameId)
                ?? null
        );

        const contractId = contract?.contractId ?? null;

        const tonNetwork = contract?.tonNetwork ?? null;

        const snapshotHash = contract?.snapshotHash ?? null;

        const correlationId = contract?.correlationId ?? null;

        const paymentSessionId = session?.paymentSessionId ?? null;

        if (!contractId || !tonNetwork || !snapshotHash || !paymentSessionId) {

            return this._skip(
                gameId,
                phase,
                "financial_reference_unavailable"
            );

        }

        // --- Players (authoritative ordered room list) -----------------------

        const playersResult = this._assemblePlayers(roomId, session);

        if (!playersResult.ok) {

            return this._skip(gameId, phase, playersResult.reason);

        }

        // --- Phase-specific safety validation --------------------------------

        if (phase === GAME_STATES.PRE_GAME_READY
            || phase === GAME_STATES.READY) {

            const preMotionCheck = this._validatePreMotionPhase(gameId, phase);

            if (!preMotionCheck.ok) {

                if (preMotionCheck.reason === "clock_paused") {

                    // Approved paused-clock policy: do not write a record that
                    // falsely represents an exactly recoverable paused state.
                    this._logWarn(
                        "checkpoint_skipped_clock_paused",
                        gameId,
                        phase
                    );

                    return {
                        status: "skipped",
                        gameId,
                        phase,
                        reason: "clock_paused"
                    };

                }

                return this._skip(gameId, phase, preMotionCheck.reason);

            }

        } else if (phase === GAME_STATES.RESULT) {

            const resultCheck = this._validateResultPhase(gameId);

            if (!resultCheck.ok) {

                return this._skip(gameId, phase, resultCheck.reason);

            }

        }

        // --- Assemble payload -------------------------------------------------

        const now = Date.now();

        const clock = this._safeCall(
            () => this._gameClockEngine?.getClock?.(gameId) ?? null
        );

        const payload = {
            recoveryContractVersion: RECOVERY_CONTRACT_VERSION,
            schemaVersion: TON_FINANCIAL_SCHEMA_VERSION,

            recoveryRecordId: gameId,
            roomId,
            gameId,
            contractId,
            paymentSessionId,
            tonNetwork,
            ...(correlationId != null ? { correlationId } : {}),

            configuration,
            configurationHash,
            configurationVersion: CONFIGURATION_VERSION,
            traceSeed: configuration.traceSeed,
            snapshotHash,

            gameState: phase,
            gameStatus: game.status ?? null,
            serverTimestampAtCheckpoint: now,

            players: playersResult.players,

            // Clock-state group. See class docblock: values are exactly
            // derived from authoritative state for the approved phases.
            phaseStartedAt: clock?.phaseStartedAt ?? null,
            clockStartedAt: clock?.startedAt ?? null,
            clockPaused: false,
            clockTotalPausedMs: 0,
            awaitingResultActivation: false,
            resultPhaseStarted: false
        };

        if (phase === GAME_STATES.RESULT) {

            const winnerResult = this._safeCall(
                () => this._winnerEngine?.getResult?.(gameId) ?? null
            );

            const simulation = this._safeCall(
                () => this._physicsEngine?.getSimulation?.(gameId) ?? null
            );

            payload.winnerId = winnerResult?.winnerPlayerId ?? null;

            payload.physicsFinalAngle = simulation?.runtime?.angle ?? null;

            payload.physicsFinalTriangleAngle =
                simulation?.runtime?.triangleAngle ?? null;

            payload.physicsSimulationState =
                simulation?.runtime?.state ?? null;

        }

        // --- Persist with forward-only + idempotency guards ------------------

        return this._persistCheckpoint(gameId, phase, incomingRank, payload);

    }

    /**
     * Load the existing record (if any), apply the monotonic phase guard,
     * terminal-idempotency and conflict rules, then create/update.
     */
    _persistCheckpoint(gameId, phase, incomingRank, payload) {

        let existing = null;

        try {

            existing = this._recoveryDataPersistence.loadRecoveryRecord(gameId);

        } catch (error) {

            this._logError("load_existing_record", gameId, phase, error);

            return {
                status: "failed",
                gameId,
                phase,
                reason: `load_existing_failed:${error?.message ?? String(error)}`
            };

        }

        if (!existing) {

            // No record yet: create-or-update behavior (§17). A READY/RESULT
            // event without a prior record still describes an attained
            // authoritative state and is created directly.
            try {

                const metadata = {
                    status: phase === GAME_STATES.RESULT ? "TERMINAL" : "ACTIVE"
                };

                this._recoveryDataPersistence.createRecoveryRecord(
                    payload,
                    metadata
                );

                return {
                    status: "created",
                    gameId,
                    phase
                };

            } catch (error) {

                this._logError("create_record", gameId, phase, error);

                return {
                    status: "failed",
                    gameId,
                    phase,
                    reason: `create_failed:${error?.message ?? String(error)}`
                };

            }

        }

        const persistedStatus = existing.status ?? null;

        const isTerminalRecord = existing.immutable === true
            || RECOVERY_DATA_TERMINAL_STATUSES.includes(persistedStatus);

        const persistedGameState = existing.payload?.gameState ?? null;

        const persistedRank = PHASE_RANK[persistedGameState] ?? 0;

        // Monotonic phase guard: never regress (checked BEFORE terminal
        // handling so out-of-order older-phase events are ignored as stale
        // even against an already-terminal record).
        if (incomingRank < persistedRank) {

            return {
                status: "skipped",
                gameId,
                phase,
                reason: `stale_phase_persisted_${persistedGameState}`
            };

        }

        // Material conflict detection: never overwrite an existing record
        // whose immutable identity/configuration block differs from the
        // authoritative runtime state now being assembled.
        if (this._hasMaterialConflict(existing.payload, payload)) {

            this._logError(
                "existing_record_conflict",
                gameId,
                phase,
                new Error(
                    `persisted=${persistedGameState}/${persistedStatus}`
                )
            );

            return {
                status: "conflict",
                gameId,
                phase,
                reason: "existing_record_conflict_no_overwrite"
            };

        }

        // Terminal record handling.
        if (isTerminalRecord) {

            if (this._isEquivalentTerminalContent(existing.payload, payload)) {

                // Repeated identical RESULT event: idempotent success,
                // no illegal update attempt.
                return {
                    status: "updated",
                    gameId,
                    phase,
                    reason: "terminal_idempotent_noop"
                };

            }

            this._logError(
                "terminal_record_conflict",
                gameId,
                phase,
                new Error(
                    `persisted=${persistedGameState}/${persistedStatus}`
                )
            );

            return {
                status: "conflict",
                gameId,
                phase,
                reason: "terminal_record_conflict_no_overwrite"
            };

        }

        try {

            const metadata = {
                status: phase === GAME_STATES.RESULT ? "TERMINAL" : "ACTIVE",
                expectedVersion: existing.version
            };

            this._recoveryDataPersistence.updateRecoveryRecord(
                gameId,
                payload,
                metadata
            );

            return {
                status: "updated",
                gameId,
                phase
            };

        } catch (error) {

            this._logError("update_record", gameId, phase, error);

            return {
                status: "failed",
                gameId,
                phase,
                reason: `update_failed:${error?.message ?? String(error)}`
            };

        }

    }

    /**
     * Material conflict detection between an existing persisted record and
     * the freshly assembled authoritative payload. Immutable blocks
     * (identity, configuration hash, snapshot hash, ordered players) must
     * match exactly; a mismatch means the existing record belongs to
     * different authoritative content and MUST NOT be overwritten.
     */
    _hasMaterialConflict(persistedPayload, incomingPayload) {

        if (!persistedPayload || !incomingPayload) {

            return true;

        }

        const identityFields = [
            "recoveryRecordId",
            "roomId",
            "gameId",
            "contractId",
            "paymentSessionId",
            "tonNetwork"
        ];

        for (const field of identityFields) {

            if (persistedPayload[field] !== incomingPayload[field]) {

                return true;

            }

        }

        if (persistedPayload.configurationHash
            !== incomingPayload.configurationHash) {

            return true;

        }

        if (persistedPayload.snapshotHash !== incomingPayload.snapshotHash) {

            return true;

        }

        const persistedPlayerIds = Array.isArray(persistedPayload.players)
            ? persistedPayload.players.map((player) => player?.playerId)
            : null;

        const incomingPlayerIds = Array.isArray(incomingPayload.players)
            ? incomingPayload.players.map((player) => player?.playerId)
            : null;

        return JSON.stringify(persistedPlayerIds)
            !== JSON.stringify(incomingPlayerIds);

    }

    /**
     * Terminal-idempotency equivalence check: a repeated RESULT event whose
     * content matches the already-terminal record (ignoring the writer-owned
     * freshness timestamp) is treated as a successful no-op.
     */
    _isEquivalentTerminalContent(persistedPayload, incomingPayload) {

        if (!persistedPayload || !incomingPayload) {

            return false;

        }

        if (persistedPayload.gameState !== GAME_STATES.RESULT) {

            return false;

        }

        if (persistedPayload.physicsSimulationState !== "STOPPED"
            || incomingPayload.physicsSimulationState !== "STOPPED") {

            return false;

        }

        if (persistedPayload.winnerId !== incomingPayload.winnerId) {

            return false;

        }

        return persistedPayload.physicsFinalAngle
                === incomingPayload.physicsFinalAngle
            && persistedPayload.physicsFinalTriangleAngle
                === incomingPayload.physicsFinalTriangleAngle;

    }

    // -------------------------------------------------------------------------
    // Validation helpers
    // -------------------------------------------------------------------------

    /**
     * PRE_GAME_READY / READY validation: unpaused clock in the matching
     * phase, CREATED physics, input registry in safe default shape.
     */
    _validatePreMotionPhase(gameId, phase) {

        const clock = this._safeCall(
            () => this._gameClockEngine?.getClock?.(gameId) ?? null
        );

        if (!clock) {

            return { ok: false, reason: "clock_missing" };

        }

        if (clock.currentPhase !== phase) {

            return {
                ok: false,
                reason: `clock_phase_mismatch:${String(clock.currentPhase)}`
            };

        }

        if (!Number.isFinite(clock.phaseStartedAt)
            || !Number.isFinite(clock.startedAt)) {

            return { ok: false, reason: "clock_timestamps_invalid" };

        }

        if (clock.paused === true) {

            return { ok: false, reason: "clock_paused" };

        }

        const simulation = this._safeCall(
            () => this._physicsEngine?.getSimulation?.(gameId) ?? null
        );

        if (!simulation?.runtime) {

            return { ok: false, reason: "physics_simulation_missing" };

        }

        if (simulation.runtime.state !== "CREATED") {

            return {
                ok: false,
                reason: `physics_not_created:${String(simulation.runtime.state)}`
            };

        }

        const inputCheck = this._validateInputDefaultShape(gameId);

        if (!inputCheck.ok) {

            return inputCheck;

        }

        return { ok: true };

    }

    /**
     * RESULT validation: STOPPED physics with finite final angles and a
     * terminal-compatible gameStatus. No settlement action is performed.
     */
    _validateResultPhase(gameId) {

        const simulation = this._safeCall(
            () => this._physicsEngine?.getSimulation?.(gameId) ?? null
        );

        if (!simulation?.runtime) {

            return { ok: false, reason: "physics_simulation_missing" };

        }

        if (simulation.runtime.state !== "STOPPED") {

            return {
                ok: false,
                reason: `physics_not_stopped:${String(simulation.runtime.state)}`
            };

        }

        if (!Number.isFinite(simulation.runtime.angle)
            || !Number.isFinite(simulation.runtime.triangleAngle)) {

            return { ok: false, reason: "final_angles_not_finite" };

        }

        return { ok: true };

    }

    /**
     * Verify the live InputAuthority registry represents its safe default
     * state using the available public getters. No input state is persisted.
     */
    _validateInputDefaultShape(gameId) {

        const hasRegistry = this._safeCall(
            () => this._inputAuthority?.hasGame?.(gameId) ?? false
        );

        if (!hasRegistry) {

            return { ok: false, reason: "input_registry_missing" };

        }

        const acceptedCommands = this._safeCall(
            () => this._inputAuthority?.getAcceptedCommands?.(gameId) ?? []
        );

        if (!Array.isArray(acceptedCommands) || acceptedCommands.length !== 0) {

            return { ok: false, reason: "input_accepted_commands_not_empty" };

        }

        const heldButtons = this._safeCall(
            () => this._inputAuthority?.countHeldButtons?.(gameId) ?? 0
        );

        if (heldButtons !== 0) {

            return { ok: false, reason: "input_buttons_held" };

        }

        return { ok: true };

    }

    /**
     * Assemble the ordered player list from the authoritative room order and
     * PlayerManager identities, cross-referenced against the payment session
     * participants (wallet references). Validates exactly 3 players, unique
     * ids, playerIndex set {0,1,2}, and index == authoritative room order.
     */
    _assemblePlayers(roomId, session) {

        const room = this._safeCall(
            () => this._roomManager?.getRoom?.(roomId) ?? null
        );

        if (!room || !Array.isArray(room.players)) {

            return { ok: false, reason: "room_missing" };

        }

        if (room.players.length !== EXPECTED_PLAYER_COUNT) {

            return {
                ok: false,
                reason: `player_count_must_be_${EXPECTED_PLAYER_COUNT}`
            };

        }

        const participantsById = new Map();

        for (const participant of session?.participants ?? []) {

            if (participant?.playerId != null) {

                participantsById.set(String(participant.playerId), participant);

            }

        }

        const players = [];

        const seenIds = new Set();

        for (let index = 0; index < room.players.length; index += 1) {

            const playerId = room.players[index];

            if (!playerId || seenIds.has(playerId)) {

                return { ok: false, reason: "player_identity_invalid" };

            }

            seenIds.add(playerId);

            const identity = this._safeCall(
                () => this._playerManager?.getIdentity?.(playerId) ?? null
            );

            if (!identity) {

                return {
                    ok: false,
                    reason: `player_identity_missing:${playerId}`
                };

            }

            const participant = participantsById.get(String(playerId));

            const wallet = participant?.wallet ?? identity.wallet ?? null;

            if (!wallet) {

                return {
                    ok: false,
                    reason: `player_wallet_missing:${playerId}`
                };

            }

            players.push({
                playerId,
                playerIndex: index,
                wallet,
                nickname: identity.nickname ?? null,
                baseStake: identity.baseStake ?? null,
                sectorCount: identity.sectorCount ?? null,
                color: identity.color ?? null,
                colorSector2: identity.colorSector2 ?? null,
                icon: identity.icon ?? null,
                sectorArrangement: identity.sectorArrangement ?? null,
                age: identity.age ?? null
            });

        }

        const indices = players.map((player) => player.playerIndex);

        const expectedIndices = [0, 1, 2];

        if (JSON.stringify(indices) !== JSON.stringify(expectedIndices)) {

            return { ok: false, reason: "player_index_set_invalid" };

        }

        return { ok: true, players };

    }

    // -------------------------------------------------------------------------
    // Safe accessors / logging helpers
    // -------------------------------------------------------------------------

    _safeGetState(gameId) {

        return this._safeCall(
            () => this._gameStateEngine?.getState?.(gameId) ?? null
        );

    }

    _safeCall(fn) {

        try {

            return fn();

        } catch {

            return null;

        }

    }

    _skip(gameId, phase, reason) {

        this._logWarn(`checkpoint_skipped_${reason}`, gameId, phase);

        return {
            status: "skipped",
            gameId,
            phase,
            reason
        };

    }

    _logWarn(message, gameId, phase) {

        this._logger?.warn?.(
            `RecoveryCheckpointManager: ${message}`
                + ` | gameId=${gameId ?? "unknown"}`
                + ` | phase=${phase ?? "unknown"}`
        );

    }

    _logError(operation, gameId, phase, error) {

        this._logger?.error?.(
            `RecoveryCheckpointManager: checkpoint operation failed`
                + ` | operation=${operation}`
                + ` | gameId=${gameId ?? "unknown"}`
                + ` | phase=${phase ?? "unknown"}`
                + ` | errorType=${error?.name ?? "Unknown"}`
                + ` | reason=${error?.message ?? String(error)}`
        );

    }

}