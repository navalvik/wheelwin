# Recovery Architecture Audit

Date: 2026-08-22

Task: Read-only recovery architecture audit covering server restart recovery, RoomManager recovery, GameManager recovery, PlayerManager recovery, gameplay runtime recovery, PaymentSession recovery interaction, and client reconnect after server restart. No source code changes were allowed.

## 1. Scope

This audit inspected the WheelWin recovery architecture to document the current implementation of server restart recovery, runtime state persistence, reconstruction mechanisms, and client reconnect flows across all gameplay and financial domains.

Analyzed areas:

- Server restart lifecycle (`ApplicationLifecycleManager`, `server/app.js` startup/shutdown wiring).
- RoomManager recovery (`server/managers/RoomManager.js`).
- GameManager recovery (`server/managers/GameManager.js`).
- PlayerManager recovery (`server/managers/PlayerManager.js`).
- Gameplay runtime recovery (`RecoveryEngine`, `RecoverySnapshotCache`, `RecoveryCredentialStore`, `GameStateEngine`, `PhysicsEngine`, `GameClockEngine`, `ConfigurationEngine`, `WinnerEngine`, `InputAuthority`, `SimulationLoop`).
- PaymentSession recovery interaction (`PaymentSessionManager.restorePaymentSessions`, `TonFinancialRecovery`).
- Client reconnect after server restart (`SocketGateway`, `RoomLobbyBridge`, `gameplayRecoveryProtocol`, client `SessionRecoveryEngine`).
- Durable persistence layers (`TonFinancialPersistence`, `server/data/`).
- Historical recovery documentation (`docs/R17.8A`, `docs/R17.8E`, `AI_CONTEXT/DEVELOPMENT_HISTORY.md`).

This was not a behavioral test pass and did not execute application test suites. The audit was structural and architectural only.

## 2. Files Inspected

Context and architecture documentation:

- `AI_CONTEXT/WHEELWIN_MASTER_CONTEXT.md`
- `AI_CONTEXT/ARCHITECTURE_RULES.md`
- `AI_CONTEXT/CURRENT_STATE.md`
- `AI_CONTEXT/AI_WORKING_RULES.md`
- `AI_CONTEXT/DEVELOPMENT_HISTORY.md`
- `AI_CONTEXT/CLINE_REPORTS/2026-08-21_initial_project_audit.md`
- `AI_CONTEXT/CLINE_REPORTS/2026-08-21_financial_architecture_audit.md`

Historical recovery documentation:

- `docs/R17.8A_RECOVERY_SNAPSHOT_AUDIT.md`
- `docs/R17.8E_ROOMLOBBY_RECONNECT_AUDIT.md`

Server lifecycle and composition root:

- `server/lifecycle/ApplicationLifecycleManager.js` (420 lines)
- `server/lifecycle/ApplicationLifecycleStates.js`
- `server/app.js` (startup/shutdown wiring inspected via search)

Managers:

- `server/managers/RoomManager.js` (674 lines)
- `server/managers/GameManager.js` (1222 lines)
- `server/managers/PlayerManager.js` (558 lines)

Gameplay recovery (runtime):

- `server/engines/RecoveryEngine.js` (526 lines)
- `server/gameplay/RecoverySnapshotCache.js` (374 lines)
- `server/gameplay/RecoveryCredentialStore.js` (184 lines)
- `server/engines/recovery/recoveryFreeze.js`
- `server/engines/recovery/RecoveryValidationError.js`

Gameplay engines (in-memory state confirmed via search):

- `server/engines/GameStateEngine.js`
- `server/engines/PhysicsEngine.js`
- `server/engines/GameClockEngine.js`
- `server/engines/ConfigurationEngine.js`
- `server/engines/WinnerEngine.js`
- `server/engines/PaymentEngine.js`
- `server/engines/AuditEngine.js`
- `server/engines/GameReportEngine.js`
- `server/input/InputAuthority.js`
- `server/simulation/SimulationLoop.js`

Financial recovery and persistence:

- `server/recovery/TonFinancialRecovery.js` (1739 lines)
- `server/recovery/TonFinancialRecoveryStates.js`
- `server/recovery/TonFinancialRecoveryErrors.js`
- `server/persistence/TonFinancialPersistence.js`
- `server/persistence/TonFinancialRecordTypes.js`

Payment session recovery:

- `server/gameplay/PaymentSessionManager.js` (2861 lines, `restorePaymentSessions` at line 702)

Socket and reconnect:

- `server/socket/SocketGateway.js` (recovery handling inspected via search)
- `server/socket/RoomLobbyBridge.js` (recovery ownership inspected via search)
- `server/socket/gameplayRecoveryProtocol.js` (420 lines)

Client recovery:

- `client/src/game/sessionRecovery/SessionRecoveryEngine.js` (405 lines)
- `client/src/game/sessionRecovery/recoveryFlow.js`
- `client/src/game/sessionRecovery/recoveryReconnectPolicy.js`
- `client/src/game/sessionRecovery/sessionRecoveryEvents.js`
- `client/src/game/sessionRecovery/sessionRecoveryStates.js`

Durable data directories:

- `server/data/ton-financial/` (active, archived, immutable, manifest.json)
- `server/data/session-history/` (ROOM_DESTROYED audit records only)

## 3. Architecture Findings

### Two recovery domains with asymmetric durability

The recovery architecture is split into two domains with fundamentally different durability characteristics:

| Domain | Durability | Persistence | Recovery on startup | Reconstruction |
|--------|-----------|-------------|---------------------|----------------|
| Financial | Durable | `TonFinancialPersistence` (file-based JSON) | `TonFinancialRecovery.recover()` runs on startup | Full pipeline implemented |
| Gameplay | Ephemeral | None (in-memory `Map` only) | None | Not implemented (R17.9T.6 planned) |

This asymmetry is explicitly documented in `WHEELWIN_MASTER_CONTEXT.md` (section 8) and `DEVELOPMENT_HISTORY.md` (R17.9T.6). The project is at milestone R17.9T.6 with a "Hybrid Recovery Architecture" decision selected but not yet implemented.

### Server restart lifecycle

`ApplicationLifecycleManager` manages the operational lifecycle: `STARTING → RUNNING → DRAINING → STOPPED`.

Key characteristics:

- `markRunning()` transitions `STARTING → RUNNING` after `listen()` succeeds.
- `beginDrain()` enters `DRAINING` and waits for in-flight work (setup sessions, active games, payment sessions, settlements, simulations, recovery sessions, result sessions) to reach idle, or until the graceful shutdown timeout expires.
- `markStopped()` transitions to `STOPPED` after resource teardown.
- The manager is operational only — it "does not mutate gameplay engines."
- It does NOT persist any state.
- It does NOT trigger any recovery on startup.
- The `activityProvider` reports in-flight work counts for the drain wait but does not snapshot or persist them.

On shutdown, `server/app.js` emits `SERVER_SHUTDOWN` after the drain wait completes. Every manager and engine subscribes to `SERVER_SHUTDOWN` and clears its in-memory state:

| Module | Shutdown behavior |
|--------|-------------------|
| `RoomManager` | Destroys ALL rooms (`destroyRoom` for each) |
| `GameManager` | Destroys ALL games (`destroyGame` for each) |
| `PlayerManager` | Removes ALL players (`removePlayer` for each) |
| `RecoveryEngine` | Clears `_snapshots` Map |
| `RecoverySnapshotCache` | Clears `_cache` Map |
| `RecoveryCredentialStore` | Clears `_byPlayer` Map (via `RoomLobbyBridge` shutdown) |
| `GameStateEngine` | Clears `_states` Map |
| `PhysicsEngine` | Clears `_simulations` Map |
| `GameClockEngine` | Clears `_clocks` Map |
| `ConfigurationEngine` | Clears `_configurations` Map |
| `WinnerEngine` | Clears `_results` Map |
| `InputAuthority` | Clears `_registries` Map |
| `SimulationLoop` | Clears `_activeGameIds` Set |
| `PaymentEngine` | Clears `_payments` Map |
| `RoomLobbyBridge` | Clears `_recoveryOwnershipBySocket`, `_recoveryOwnershipByPlayer`, `_recoveryCredentials` |

On startup, `server/app.js` calls `initialize()` on every manager and engine (which only subscribes to `SERVER_SHUTDOWN`) and then runs exactly ONE recovery:

```javascript
await this._tonFinancialRecovery.recover({
    trigger: "server_restart",
    reason: "application_startup"
});
```

There is NO equivalent gameplay recovery call on startup. No rooms are restored. No players are restored. No games are restored. No gameplay state is restored.

### Runtime state that survives a server restart

Only financial state survives:

| Record type | Storage | Restored by |
|-------------|---------|-------------|
| `GAME_CONTRACT` | `TonFinancialPersistence` (active) | `GameContractManager.restoreContracts()` |
| `PAYMENT_SESSION` | `TonFinancialPersistence` (active) | `PaymentSessionManager.restorePaymentSessions()` |
| `DEPOSIT_SESSION` | `TonFinancialPersistence` (active) | `DepositSessionCoordinator.restoreActiveSessions()` |
| `DEPLOYMENT_AUTHORIZATION` | `TonFinancialPersistence` (active) | `DeploymentAuthorizationCoordinator.restoreActiveAuthorizations()` |
| `SETTLEMENT` | `TonFinancialPersistence` (active) | `ContractSettlementManager.restoreSettlementSessions()` |
| `WALLET_SESSION` | `TonFinancialPersistence` (active) | `WalletManager.restoreSessions()` |
| `SNAPSHOT` | `TonFinancialPersistence` (immutable) | Restored as immutable evidence |
| `DEPOSIT_OBSERVATION` | `TonFinancialPersistence` (immutable) | Restored as immutable evidence |
| Blockchain monitor checkpoint | `TonFinancialPersistence` | `BlockchainMonitor.restoreCheckpoint()` |

### Runtime state that is lost on a server restart

ALL gameplay, room, player, and recovery state is lost:

| State | Owner | Storage | Lost? |
|-------|-------|---------|-------|
| Rooms | `RoomManager._rooms` | In-memory `Map` | Yes |
| Player-room index | `RoomManager._playerRoomIndex` | In-memory `Map` | Yes |
| Games | `GameManager._games` | In-memory `Map` | Yes |
| Pending gameplay activation | `GameManager._pendingGameplayActivation` | In-memory `Map` | Yes |
| Pending configuration | `GameManager._pendingConfigurationByRoom` | In-memory `Map` | Yes |
| Entry payment activated games | `GameManager._entryPaymentActivatedGames` | In-memory `Set` | Yes |
| Player identities | `PlayerManager._identities` | In-memory `Map` | Yes |
| Player runtimes | `PlayerManager._runtimes` | In-memory `Map` | Yes |
| Game state | `GameStateEngine._states` | In-memory `Map` | Yes |
| Physics simulations | `PhysicsEngine._simulations` | In-memory `Map` | Yes |
| Game clocks | `GameClockEngine._clocks` | In-memory `Map` | Yes |
| Configurations | `ConfigurationEngine._configurations` | In-memory `Map` | Yes |
| Winner results | `WinnerEngine._results` | In-memory `Map` | Yes |
| Input registries | `InputAuthority._registries` | In-memory `Map` | Yes |
| Active simulations | `SimulationLoop._activeGameIds` | In-memory `Set` | Yes |
| Recovery snapshots | `RecoveryEngine._snapshots` | In-memory `Map` | Yes |
| Recovery snapshot cache | `RecoverySnapshotCache._cache` | In-memory `Map` | Yes |
| Recovery credentials | `RecoveryCredentialStore._byPlayer` | In-memory `Map` | Yes |
| Recovery ownership (socket) | `RoomLobbyBridge._recoveryOwnershipBySocket` | In-memory `Map` | Yes |
| Recovery ownership (player) | `RoomLobbyBridge._recoveryOwnershipByPlayer` | In-memory `Map` | Yes |
| Entry payment completion flags | `RoomLobbyBridge._entryPaymentCompletedByRoom` | In-memory `Map` | Yes |
| Setup sessions | `SetupSessionLifecycle` | In-memory | Yes |
| Result sessions | `ResultSessionLifecycle` | In-memory | Yes |

### Persistence layers

| Layer | Path | Purpose | Durable? |
|-------|------|---------|----------|
| `TonFinancialPersistence` | `server/persistence/TonFinancialPersistence.js` | Financial records (contracts, payments, deposits, settlements, wallets, snapshots, observations) | Yes (file-based JSON, atomic writes) |
| `server/data/ton-financial/` | `server/data/ton-financial/{active,archived,immutable}/` | Financial record files + manifest | Yes |
| `server/data/session-history/` | `server/data/session-history/` | Audit records of `ROOM_DESTROYED` events | Yes (audit only, not for recovery) |
| Gameplay persistence | — | — | Does not exist |

There is NO persistence layer for rooms, players, games, configuration, game state, physics, clock, input, or winner state. The `server/data/` directory contains only `ton-financial/` (financial) and `session-history/` (audit records of destroyed rooms).

### Reconstruction mechanisms

| Mechanism | Exists? | Purpose | Runs on startup? |
|-----------|---------|---------|-----------------|
| `TonFinancialRecovery.recover()` | Yes | Financial recovery pipeline | Yes |
| `ReimbursementConfirmationService.recoverPendingConfirmations()` | Yes | Reimbursement chain confirmation recovery | Yes |
| `attachExistingRoom()` | No | Room reconstruction | — |
| `attachExistingGame()` | No | Game reconstruction | — |
| Player identity restoration | No | Player identity reconstruction | — |
| PaymentSession rehydration | No | Link restored payment sessions to runtime objects | — |
| Guarded contract reconciliation | No | Link restored contracts to runtime games | — |
| Configuration reconstruction | No | Rebuild immutable game configuration | — |

The missing mechanisms are explicitly documented in `DEVELOPMENT_HISTORY.md` (R17.9T.6) and `WHEELWIN_MASTER_CONTEXT.md` (section 8).

### RecoveryEngine — runtime-only snapshot builder

`RecoveryEngine` builds recovery snapshots from LIVE engine state. Key characteristics:

- `buildRecoverySnapshot(gameId)` collects state from `ConfigurationEngine`, `GameStateEngine`, `GameClock`, `PhysicsEngine`, `InputAuthority`, `WinnerEngine`, `PaymentEngine`, `ResultActivation`, `PreGameReadyActivation`, `ResultSessionLifecycle`.
- `_validateRecoverySources` throws `RecoveryValidationError` if configuration, gameState, physics, clock, or input is missing.
- Snapshots stored in `this._snapshots = new Map()` — in-memory only.
- On `SERVER_SHUTDOWN`, clears all snapshots (`this._snapshots.clear()`).
- Does NOT persist snapshots to disk.
- Designed for CLIENT RECONNECT while the server is running (transient socket disconnect), NOT for SERVER RESTART recovery.

After a server restart, all live engines are empty, so `buildRecoverySnapshot` would throw `RecoveryValidationError` for every source missing.

### RecoverySnapshotCache — RESULT-phase cache

`RecoverySnapshotCache` captures snapshots at terminal `RESULT` state. Key characteristics:

- Captures via `_capture(gameId)` when `GAME_STATE_CHANGED` → `currentState === RESULT`.
- Stores in `this._cache = new Map()` — in-memory only.
- Survives `GameplayLifecycle` teardown so reconnecting clients can restore Page6.
- On `SERVER_SHUTDOWN`, clears the cache (`this._cache.clear()`).
- Does NOT persist to disk.
- Designed for CLIENT RECONNECT after gameplay teardown, NOT for SERVER RESTART recovery.

### RecoveryCredentialStore — in-memory credential hashes

`RecoveryCredentialStore` issues and validates recovery credentials. Key characteristics:

- Stores SHA-256 hashes in `this._byPlayer = new Map()` — in-memory only.
- Credentials bound to `playerId + roomId`.
- Validates with `timingSafeEqual` (constant-time comparison).
- Plaintext never persisted; only SHA-256 digests retained.
- Does NOT persist to disk.
- On server restart, all credentials are lost.

### TonFinancialRecovery — financial recovery pipeline

`TonFinancialRecovery` is the financial recovery coordinator. Key characteristics:

- Runs on startup: `await this._tonFinancialRecovery.recover({ trigger: "server_restart", reason: "application_startup" })`.
- Recovery pipeline (strict phase order):
  1. `WALLETS` — restore wallet sessions.
  2. `CONTRACTS` — restore game contracts.
  3. `PAYMENTS` — restore payment sessions (syncs from GameEscrow).
  4. Deposit sessions restore.
  5. Deposit monitor watches restore.
  6. Deployment authorizations restore.
  7. `SETTLEMENTS` — restore settlement sessions.
  8. `BLOCKCHAIN` — restore blockchain monitor checkpoint + reregister watches.
  9. Settlement resume (probe on-chain state).
  10. `VALIDATION` — consistency validation across all domains.
- Phase order guard prevents out-of-order execution.
- Fail-closed: errors collected but recovery continues; consistency errors cause failure.
- Recovery states: `NOT_STARTED → RECOVERING → VALIDATING → COMPLETED / FAILED`.
- Owns orchestration only — no financial, blockchain, or payment state.

### PaymentSession recovery interaction

`PaymentSessionManager.restorePaymentSessions()` restores payment sessions from `TonFinancialPersistence`. Key characteristics:

- Reads `PAYMENT_SESSION` records from `listActive()`.
- Restores into `this._sessionsByRoom` (in-memory map).
- Sets non-terminal, non-in-progress sessions to `RECOVERED` status.
- Restores seat indices for GameEscrow paidMask mapping.
- Schedules expiry for active payment deadlines.
- Syncs paid seats from GameEscrow chain.
- Rewatches unpaid seats.
- Emits `PAYMENT_SESSION_RECOVERED` events.

**Critical interaction gap:** Restored payment sessions reference `roomId` values that no longer exist in `RoomManager` (which is in-memory only and was cleared on shutdown). The payment session has a `roomId`, but after a server restart, there is no corresponding room, no players, no game, and no gameplay state. This creates a state where:

- Financial recovery restores payment sessions, game contracts, and settlements.
- These financial records reference rooms/games/players that do not exist in runtime.
- The financial system believes payments are active, but there is no gameplay to connect them to.
- Settlement could theoretically proceed for a game that has no runtime state.
- `GameContractManager.restoreContracts()` restores contracts that reference `gameId` values with no corresponding `GameManager` entry.

## 4. Lifecycle Flow

### Current server restart lifecycle

```text
SERVER STOP (SIGTERM / SIGINT / process.exit)
        |
        v
ApplicationLifecycleManager.beginDrain()
        |
        v
DRAINING (wait for in-flight work or timeout)
        |
        v
app.js emits SERVER_SHUTDOWN
        |
        v
ALL managers/engines clear in-memory state:
  RoomManager.destroyRoom() for each room
  GameManager.destroyGame() for each game
  PlayerManager.removePlayer() for each player
  RecoveryEngine._snapshots.clear()
  RecoverySnapshotCache._cache.clear()
  RecoveryCredentialStore._byPlayer.clear()
  GameStateEngine._states.clear()
  PhysicsEngine._simulations.clear()
  GameClockEngine._clocks.clear()
  ConfigurationEngine._configurations.clear()
  WinnerEngine._results.clear()
  InputAuthority._registries.clear()
  SimulationLoop._activeGameIds.clear()
  RoomLobbyBridge recovery ownership cleared
        |
        v
ApplicationLifecycleManager.markStopped()
        |
        v
PROCESS EXIT
        |
        v
SERVER START
        |
        v
app.js initialize() each manager/engine
  (subscribes to SERVER_SHUTDOWN only; no state restored)
        |
        v
TonFinancialPersistence.initialize()
  (loads manifest, validates records)
        |
        v
await TonFinancialRecovery.recover({ trigger: "server_restart" })
  WALLETS → CONTRACTS → PAYMENTS → DEPOSITS → SETTLEMENTS → BLOCKCHAIN → VALIDATION
  (restores financial state from durable persistence)
        |
        v
SocketGateway.initialize()
  (ready to accept client connections)
        |
        v
ApplicationLifecycleManager.markRunning()
        |
        v
SERVER RUNNING
        |
        v
Client connects → SESSION_RECOVERY_REQUEST
        |
        v
RoomLobbyBridge.reconnectGameplaySession()
  → _recoveryOwnershipByPlayer is EMPTY
  → returns { ok: false, reason: "Player session is not recoverable" }
        |
        v
SocketGateway sends SESSION_RECOVERY_FAILED
        |
        v
Client cannot restore session
```

### Documented target lifecycle (R17.9T.6 — not implemented)

```text
SERVER STOP
        |
        v
DRAINING → SERVER_SHUTDOWN → state cleared
        |
        v
PROCESS EXIT
        |
        v
SERVER START
        |
        v
initialize() managers/engines
        |
        v
await TonFinancialRecovery.recover()
  (financial state restored from persistence)
        |
        v
[MISSING] Gameplay Recovery Pipeline
  1. Identity attach (restore player identities)
  2. PaymentSession rehydration (link to runtime objects)
  3. GameContract reconciliation (link to runtime games)
  4. Configuration reconstruction (rebuild immutable config)
  5. Controlled end-to-end validation
        |
        v
[MISSING] attachExistingRoom() / attachExistingGame()
  (reconstruct runtime objects from financial records)
        |
        v
RESTORE ACTIVE STATE
        |
        v
RESUME GAMEPLAY
```

### Client reconnect while server is running (implemented, working)

```text
Client socket disconnects (transient)
        |
        v
RoomLobbyBridge stashes recovery ownership
  (_recoveryOwnershipBySocket, _recoveryOwnershipByPlayer)
        |
        v
Client socket reconnects
        |
        v
Client sends SESSION_RECOVERY_REQUEST
  { playerId, roomId, recoveryCredential }
        |
        v
SocketGateway._handleRecoveryRequest()
  → RoomLobbyBridge.reconnectGameplaySession(socket.id, claim)
  → validates recovery credential
  → resolves recovery identity from _recoveryOwnershipByPlayer
  → rebinds socket to player seat
        |
        v
resolveRecoveryRoute()
  → setupActive: PRE_GAME_SUCCESS (lobby sync)
  → gameState exists: GAMEPLAY_SNAPSHOT (RecoveryEngine)
  → RESULT cache exists: GAMEPLAY_SNAPSHOT (RecoverySnapshotCache)
  → no gameId: FAIL
        |
        v
RecoveryEngine.recoverPlayer(gameId, playerId)
  → buildRecoverySnapshot from live engines
  → SESSION_SNAPSHOT sent to client
        |
        v
Client restores modules from snapshot
```

This flow works correctly for transient socket disconnects while the server is running. It does NOT work after a server restart because all in-memory state is lost.

## 5. Ownership Boundaries

### Financial recovery domain

Owned by `TonFinancialRecovery`:
- Recovery pipeline orchestration.
- Phase ordering and validation.
- Consistency validation across all financial domains.
- Recovery state management.
- Recovery reporting.

Supported by:
- `WalletManager.restoreSessions()` — wallet session restoration.
- `GameContractManager.restoreContracts()` — contract restoration.
- `PaymentSessionManager.restorePaymentSessions()` — payment session restoration.
- `ContractSettlementManager.restoreSettlementSessions()` — settlement restoration.
- `BlockchainMonitor.restoreCheckpoint()` — blockchain monitor restoration.
- `DepositSessionCoordinator.restoreActiveSessions()` — deposit session restoration.
- `DeploymentAuthorizationCoordinator.restoreActiveAuthorizations()` — authorization restoration.

### Gameplay recovery domain (not implemented)

The gameplay recovery domain is documented but not implemented. Planned owners:

- `RoomManager.attachExistingRoom()` — room reconstruction (missing).
- `GameManager.attachExistingGame()` — game reconstruction (missing).
- `PlayerManager` identity restoration — player identity reconstruction (missing).
- `PaymentSessionManager` rehydration — link restored sessions to runtime objects (missing).
- `GameContractManager` reconciliation — link restored contracts to runtime games (missing).
- `ConfigurationEngine` reconstruction — rebuild immutable configuration (missing).

### Runtime recovery domain (client reconnect only)

Owned by `RecoveryEngine`:
- Build recovery snapshots from live engines.
- Validate that all required sources are present.
- Store snapshots in-memory for client reconnect.

Owned by `RecoverySnapshotCache`:
- Capture snapshots at RESULT state.
- Survive gameplay teardown for Page6 reconnect.
- Enrich with payment/audit status.

Owned by `RecoveryCredentialStore`:
- Issue and validate recovery credentials.
- Bind credentials to playerId + roomId.

Owned by `RoomLobbyBridge`:
- Stash and resolve recovery ownership.
- Rebind sockets to player seats.
- Re-deliver lobby/payment sync events.

### Shutdown ownership

Owned by `ApplicationLifecycleManager`:
- Drain coordination.
- Graceful shutdown timeout.
- Activity monitoring.
- Does NOT persist state or trigger recovery.

## 6. Risks

### Critical

- **No gameplay state persistence**: ALL gameplay state (rooms, players, games, configuration, game state, physics, clock, input, winner) is ephemeral. On server restart, ALL active games are lost. Players who paid and were mid-game lose their session entirely. This is an architecture violation of the server-authoritative model for any production deployment where server restarts are possible.

- **No gameplay reconstruction mechanism**: The `attachExistingRoom()`, `attachExistingGame()`, player identity restoration, PaymentSession rehydration, and guarded contract reconciliation capabilities documented in `DEVELOPMENT_HISTORY.md` (R17.9T.6) are NOT implemented. There is no mechanism to reconstruct runtime gameplay objects after a server restart.

- **Financial-gameplay state inconsistency after restart**: `TonFinancialRecovery` restores payment sessions, game contracts, and settlements from durable persistence on startup. However, these financial records reference `roomId` and `gameId` values that no longer exist in the runtime `RoomManager` and `GameManager` (which are in-memory only). This creates a dangerous state where:
  - Financial state is restored and believes payments are active.
  - Gameplay state is missing — no rooms, players, or games exist.
  - Settlement could theoretically proceed for a game with no runtime state.
  - The financial system and gameplay system are in inconsistent states.

- **Player identity and seat loss after restart**: `RecoveryCredentialStore` and `RoomLobbyBridge._recoveryOwnershipByPlayer` are in-memory only. After a server restart, all recovery credentials and ownership maps are lost. Players cannot reclaim their seats. The client sends `SESSION_RECOVERY_REQUEST` with `playerId`, `roomId`, and `recoveryCredential`, but the server has no record of these and returns "Player session is not recoverable."

- **GAME_INITIALIZED state cannot be restored**: The `GAME_INITIALIZED` state is reached through an event chain: `SETUP_SESSION_COMPLETED → createGame → ENTRY_PAYMENT_COMPLETED → initializeGameState → startClock → GAME_INITIALIZED`. After a server restart, none of these events can be replayed because the setup session, room, players, and payment state are all lost. There is no mechanism to restore the `GAME_INITIALIZED` state directly.

### High

- **No PaymentSession rehydration**: `PaymentSessionManager.restorePaymentSessions()` restores payment sessions from persistence, but they are not linked to any runtime room, game, or player objects. The restored sessions exist in a financial limbo — they have `roomId` and `gameId` references but no corresponding runtime objects. This makes it impossible to resume payment collection, issue payment requests, or properly handle payment completion.

- **No GameContract reconciliation**: `GameContractManager.restoreContracts()` restores contract records from persistence, but they reference `gameId` values with no corresponding `GameManager` entry. The restored contracts have immutable snapshots and deployment state, but no game to connect them to. This makes it impossible to properly coordinate contract lifecycle with gameplay lifecycle.

- **No configuration reconstruction**: `ConfigurationEngine` stores configurations in an in-memory `Map`. After a server restart, all immutable game configurations are lost. The `RecoveryEngine.buildRecoverySnapshot()` requires configuration as a mandatory source and throws `RecoveryValidationError` if it is missing. Without configuration reconstruction, no recovery snapshot can be built.

- **No recovery credential persistence**: Recovery credentials are SHA-256 hashes stored in-memory. After a server restart, all credentials are lost. Even if player identities were restored, clients would need new credentials issued, which requires a new room join flow — defeating the purpose of recovery.

- **RecoveryEngine is runtime-only**: The `RecoveryEngine` is designed for client reconnect while the server is running, NOT for server restart recovery. It builds snapshots from LIVE engine state. After a server restart, all live engines are empty, so `buildRecoverySnapshot` throws `RecoveryValidationError` for every missing source. There is no mechanism to restore the live engine state first and then build a snapshot.

### Medium

- **ApplicationLifecycleManager only handles drain, not recovery**: The `ApplicationLifecycleManager` manages the shutdown drain (RUNNING → DRAINING → STOPPED) but does not persist any state or trigger any recovery on startup. It tracks activity counts (setupSessions, activeGames, paymentSessions, etc.) for the drain wait but does not snapshot or persist them. A future enhancement could persist these counts to inform recovery scope.

- **RecoverySnapshotCache is RESULT-only**: The cache captures snapshots only at terminal `RESULT` state. It cannot cover mid-gameplay disconnects before RESULT (though the live `RecoveryEngine` handles those while the server is running). After a server restart, the cache is empty regardless of game phase.

- **GameClockEngine has `restorePhaseSchedule` but no disk restore**: The `GameClockEngine` has a `restorePhaseSchedule(gameId, { phase, phaseStartedAt, phaseEndsAt })` method, but this is for restoring a phase schedule within a LIVE clock (client reconnect), not for restoring from disk after server restart. The clock itself is in-memory only.

- **Console.log diagnostics in RoomManager.destroyRoom**: The `destroyRoom` method contains extensive `console.log` forensic diagnostics that should use the project logger. These can leak state to stdout and are not structured for production logging.

### Low

- **Hybrid Recovery Architecture is documented but not implemented**: The `DEVELOPMENT_HISTORY.md` documents the R17.9T.6 decision and implementation order, but none of the required additions (`attachExistingRoom()`, `attachExistingGame()`, etc.) have been implemented yet. The documentation is clear and the plan is sound; implementation is pending.

- **Session history is audit-only**: `server/data/session-history/` contains `ROOM_DESTROYED` audit records. These are historical records of completed/destroyed rooms, not active state for recovery. They could potentially be used to inform recovery scope (which rooms existed before restart) but are not currently designed for that purpose.

- **Startup demonstration code in app.js**: There is a "recovery-demo-game" demonstration in `app.js` that creates a fake game and tests recovery. This is dev-mode only and does not represent a production recovery path.

## 7. Recommendations

These recommendations are for future architecture decisions only. Do not implement automatically.

### Architecture decisions

1. **Implement the documented Hybrid Recovery Architecture (R17.9T.6).** The plan in `DEVELOPMENT_HISTORY.md` is sound: keep financial persistence as source of truth, reconstruct missing runtime objects, do not persist gameplay physics, do not create duplicate rooms/games, preserve original IDs. The implementation order (identity attach → PaymentSession rehydration → GameContract reconciliation → configuration reconstruction → validation) is correct.

2. **Do NOT persist gameplay physics state.** The `DEVELOPMENT_HISTORY.md` explicitly states "Do not persist gameplay physics." Physics is deterministic and can be reconstructed from configuration + input history. Persisting physics would create a second source of truth and risk determinism violations.

3. **Use financial persistence as the anchor for gameplay reconstruction.** Restored `PAYMENT_SESSION` and `GAME_CONTRACT` records contain `roomId` and `gameId` references. These can serve as the starting point for reconstruction: for each restored payment session, reconstruct the corresponding room, players, and game.

4. **Preserve original IDs during reconstruction.** The `DEVELOPMENT_HISTORY.md` states "Preserve original IDs." When reconstructing rooms and games, use the `roomId` and `gameId` from restored financial records, not newly generated IDs. This ensures financial records remain linked to runtime objects.

### Implementation priorities

1. **Identity attach (highest priority).** Without player identity restoration, no other reconstruction is possible. Players must be able to reclaim their seats after a server restart. This requires either persisting player identities or deriving them from restored financial records (payment session participants).

2. **PaymentSession rehydration.** Link restored payment sessions to runtime room/game objects. This requires `attachExistingRoom()` and `attachExistingGame()` to exist in `RoomManager` and `GameManager` respectively.

3. **GameContract reconciliation.** Link restored game contracts to runtime game objects. This requires the game to exist first (via `attachExistingGame()`).

4. **Configuration reconstruction.** Rebuild immutable game configuration from the restored contract snapshot (which contains the snapshot hash and configuration metadata). The `ConfigurationEngine` needs a method to restore a frozen configuration from a record.

5. **Controlled end-to-end validation.** Validate that all reconstructed objects are consistent: room has correct players, game has correct configuration, payment session has correct contract, contract has correct snapshot, etc.

### Safety constraints

1. **Recovery must remain fail-closed.** If reconstruction fails for any game, that game must be terminated and refunds issued. Never invent gameplay state. Never allow a game to proceed with partial reconstruction.

2. **Never restore financial state from client data.** Financial truth must come from `TonFinancialPersistence` and blockchain probes only. Client-presented `playerId`, `roomId`, and `recoveryCredential` are lookup keys only, not authoritative state.

3. **Do not create parallel recovery flows.** The existing `TonFinancialRecovery` pipeline should be extended or complemented, not replaced. A new gameplay recovery coordinator should follow the same pattern: strict phase order, fail-closed, consistency validation.

4. **Do not move server logic to client.** The client must continue to display server state only. Recovery reconstruction is a server-side responsibility.

5. **Consider the financial-gameplay consistency window.** Between financial recovery completion and gameplay reconstruction completion, the system is in an inconsistent state. Consider gating client connections until gameplay reconstruction is complete, or providing a clear "recovery in progress" signal to clients.

### Documentation

1. **Document the recovery architecture in a dedicated document.** The current documentation in `AI_CONTEXT/` provides high-level principles, but a detailed recovery architecture document would help future developers understand the financial recovery pipeline, the planned gameplay reconstruction, the interaction between the two, and the fail-closed guarantees.

2. **Clarify the startup recovery sequence.** Document that `TonFinancialRecovery.recover()` runs on startup but gameplay reconstruction does not yet exist. This is critical context for operators and developers.

3. **Document the financial-gameplay inconsistency risk.** After a server restart with the current architecture, financial state is restored but gameplay state is lost. This is a known, documented gap (R17.9T.6) but should be clearly communicated to operators.

## 8. Changes Made

Created this report only:

- `AI_CONTEXT/CLINE_REPORTS/2026-08-22_recovery_architecture_audit.md`

No source code files modified.