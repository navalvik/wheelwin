# Recovery Runtime Managers Mapping — RoomManager, GameManager, PlayerManager

Date: 2026-08-22

Task: READ-ONLY Recovery Runtime Managers Mapping for the WheelWin project. Focused analysis step of R17.9T.6 Hybrid Recovery Architecture. Factual inventory of runtime state, in-memory registries, identifiers, create/destroy methods, restore/hydrate/attach/reconstruct methods, SERVER_SHUTDOWN behavior, persistence, reconstructability, and dependencies for three runtime managers only: `RoomManager`, `GameManager`, `PlayerManager`. No source code changes, no implementation, no API design, no financial-module analysis, no RecoveryEngine analysis, no client-reconnect analysis.

## 1. Scope

This report is a factual inventory of three server-side runtime managers:

- `server/managers/RoomManager.js`
- `server/managers/GameManager.js`
- `server/managers/PlayerManager.js`

For each manager, the following were determined from source code only:

1. Runtime state owned by the manager.
2. Internal Maps, Sets, or other in-memory registries.
3. Important identifiers used by the manager.
4. Existing methods that create runtime objects.
5. Existing methods that destroy runtime objects.
6. Existing restore, hydrate, attach, rebind, or reconstruction methods.
7. Whether a recovery/reconstruction method exists (explicit `NOT IMPLEMENTED` if absent).
8. `SERVER_SHUTDOWN` behavior.
9. Whether any state is persisted before shutdown.
10. Whether any state can currently be reconstructed from existing data.
11. Dependencies on other managers or engines that would matter for future reconstruction.

Manager-specific questions were also answered:

- `GameManager`: how a Game is normally created; minimum information required; how `GAME_INITIALIZED` is reached; whether an existing game can be attached using an existing `gameId`; whether the manager can reconstruct a game without creating a new `gameId`.
- `RoomManager`: how a Room is normally created; how players are associated with a room; whether an existing `roomId` can be attached; whether a room can be reconstructed without creating a new `roomId`.
- `PlayerManager`: how player identity is created; what player identity data is retained in memory; what player runtime data is retained in memory; whether player identity can currently be restored after server restart; whether an existing `playerId` can be attached without generating a new identity.

This was not a behavioral test pass and did not execute application test suites. No source code, configuration, or test files were modified. No new APIs were designed. No implementation was recommended. Capabilities not present in the source code were not inferred.

## 2. Files Inspected

Project context (read before analysis, per `.clinerules`):

- `AI_CONTEXT/WHEELWIN_MASTER_CONTEXT.md`
- `AI_CONTEXT/ARCHITECTURE_RULES.md`
- `AI_CONTEXT/CURRENT_STATE.md`
- `AI_CONTEXT/AI_WORKING_RULES.md`

Prior reports reviewed:

- `AI_CONTEXT/CLINE_REPORTS/2026-08-21_initial_project_audit.md`
- `AI_CONTEXT/CLINE_REPORTS/2026-08-22_recovery_architecture_audit.md`
- `AI_CONTEXT/CLINE_REPORTS/2026-08-22_restorePaymentSessions_analysis.md` (diagnostic report)

Source files analyzed (the only source files in scope):

- `server/managers/RoomManager.js` (674 lines, read in full)
- `server/managers/GameManager.js` (1222 lines; lines 1–1000 read in full; lines 1001–1222 enumerated via `search_files` because `read_file` returned a cached first-1000-line view and could not be re-invoked for the tail — see Limitations)
- `server/managers/PlayerManager.js` (558 lines, read in full)

Verification search across all three manager files for recovery/persistence method definitions:

- Regex search for `restore|hydrate|attach|rebind|reconstruct|recovery|recover|persist|save|load|fromRecord|fromSnapshot|toRecord|serialize|deserialize` method definitions in `server/managers/*Manager.js`.

## 3. Architecture Findings

### 3.1 Cross-cutting facts (all three managers)

- All three managers are plain ES classes with a constructor accepting `{ logger, eventBus, ... }`.
- All three managers store runtime state exclusively in in-memory `Map` / `Set` / `Array` fields. None of the three managers import or reference any persistence module (`TonFinancialPersistence`, `fs`, file writes, database clients).
- All three managers subscribe to `EVENT_TYPES.SERVER_SHUTDOWN` inside `initialize()` and destroy all runtime objects in their `_handleServerShutdown()` handler.
- All three managers expose a `shutdown()` method that mirrors `_handleServerShutdown()` and also unsubscribes infrastructure handlers.
- None of the three managers persist any state before shutdown.
- None of the three managers can reconstruct runtime state from existing data after a server restart.
- Verification search confirmed: the only `attach*` method definitions across all three files are `RoomManager.attachSetupSessionLifecycle` and `RoomManager.attachLifecycleGate`, neither of which is a recovery/reconstruction method. There are zero `restore*`, `hydrate*`, `rebind*`, `reconstruct*`, `recovery*`, `recover*`, `persist*`, `save*`, `load*`, `fromRecord*`, `fromSnapshot*`, `toRecord*`, `serialize*`, or `deserialize*` method definitions in any of the three managers.

### 3.2 RoomManager — `server/managers/RoomManager.js` (674 lines)

#### 3.2.1 Runtime state owned

- Room lifecycle and room objects (`Room` instances).
- Player-to-room membership index.
- Room-scoped event listener subscriptions (cleared on destroy).
- Drain gate reference (R7.0B).
- Setup Session lifecycle reference (C5.6C).

#### 3.2.2 Internal Maps / Sets / in-memory registries

| Field | Type | Purpose |
|-------|------|---------|
| `this._rooms` | `Map` | `roomId` → `Room` object |
| `this._playerRoomIndex` | `Map` | `playerId` → `roomId` |
| `this._roomListeners` | `Map` | `roomId` → event subscriptions (cleared in `destroyRoom` via `_clearRoomListeners`; no public method adds entries — registry exists for teardown) |
| `this._infrastructureHandlers` | `Array` | `SERVER_SHUTDOWN` subscription record |
| `this._setupSessionLifecycle` | `null \| object` | Attached via `attachSetupSessionLifecycle` |
| `this._lifecycleGate` | `null \| { isAcceptingNewWork }` | Attached via `attachLifecycleGate` |
| `this._initialized` | `boolean` | Set `true` in `initialize()`, `false` in `shutdown()` |

#### 3.2.3 Important identifiers

- `roomId` — generated by `_generateRoomId()` which calls `generateRoomId()` (imported from `./room/roomIdAlphabet.js`) up to 1000 attempts until a value not present in `this._rooms` is found. Returns `null` on exhaustion.
- `playerId` — used as a key in `this._playerRoomIndex`; not generated by `RoomManager` (owned by `PlayerManager`).

#### 3.2.4 Existing methods that create runtime objects

- `createRoom({ maxPlayers } = {})` — generates a new `roomId` via `_generateRoomId()`; constructs `new Room({ roomId, createdAt, status: ROOM_STATUS.CREATED, maxPlayers, players: [] })`; stores in `this._rooms`; calls `this._setupSessionLifecycle.createForRoom(room)`; if setup session creation fails, deletes the room and returns `null`; transitions room to `ROOM_STATUS.WAITING_FOR_PLAYERS`; emits `ROOM_CREATED`. Returns the `Room` (or `null`).
- `addPlayer(roomId, playerId)` — pushes `playerId` into `room.players`; sets `this._playerRoomIndex.set(playerId, roomId)`; transitions to `ROOM_STATUS.FULL` when `room.players.length === room.maxPlayers` and emits `ROOM_FULL`. Returns `boolean`.

#### 3.2.5 Existing methods that destroy runtime objects

- `destroyRoom(roomId)` — sets `room.status = ROOM_STATUS.DESTROYED`; calls `this._setupSessionLifecycle?.abortForRoom(roomId)`; emits `ROOM_DESTROYED`; deletes each player from `this._playerRoomIndex`; clears `room.players`; calls `_clearRoomListeners(roomId)`; deletes from `this._rooms`. Returns `boolean`. Contains extensive `console.log`/`console.trace` forensic diagnostics plus structured logger calls.
- `shutdown()` — iterates `[...this._rooms.keys()]`, registers `server_shutdown` destroy context, calls `destroyRoom(roomId)` for each; unsubscribes infrastructure handlers; sets `this._initialized = false`.
- `_handleServerShutdown()` — iterates `[...this._rooms.keys()]`, registers `server_shutdown` destroy context, calls `destroyRoom(roomId)` for each.

#### 3.2.6 Existing restore / hydrate / attach / rebind / reconstruction methods

- `attachSetupSessionLifecycle(setupSessionLifecycle)` — attaches the Setup Session lifecycle dependency. Not a recovery/reconstruction method.
- `attachLifecycleGate(lifecycleGate)` — attaches the drain gate. Not a recovery/reconstruction method.
- `attachExistingRoom()` — **NOT IMPLEMENTED**.
- Room restore / hydrate / rebind / reconstruct — **NOT IMPLEMENTED**.

#### 3.2.7 SERVER_SHUTDOWN behavior

- `initialize()` subscribes to `EVENT_TYPES.SERVER_SHUTDOWN` → `_handleServerShutdown()`.
- `_handleServerShutdown()` destroys every room via `destroyRoom()` (registering `server_shutdown` destroy context for each).
- `shutdown()` performs the same destruction plus unsubscribes infrastructure handlers and sets `_initialized = false`.

#### 3.2.8 Whether any state is persisted before shutdown

- No. `RoomManager` performs no disk writes, no persistence calls, and no serialization of room or player-room index state before or during shutdown. All state is discarded.

#### 3.2.9 Whether any state can currently be reconstructed from existing data

- No. There is no persistence layer for rooms or the player-room index. After a server restart, `this._rooms` and `this._playerRoomIndex` are empty `Map`s. No data source exists from which rooms could be reconstructed. (`server/data/session-history/` contains `ROOM_DESTROYED` audit records only — historical, not active state; not designed for reconstruction.)

#### 3.2.10 Dependencies on other managers or engines that would matter for future reconstruction

- `SetupSessionLifecycle` (attached via `attachSetupSessionLifecycle`) — `createForRoom(room)`, `abortForRoom(roomId)`. `createRoom` is atomic with setup-session creation; reconstruction would need to coordinate with this lifecycle.
- `lifecycleGate` (attached via `attachLifecycleGate`) — `isAcceptingNewWork()`; gates `createRoom` during drain.
- `EventBus` — `subscribe`, `unsubscribe`, `emit`.
- `Room` model (`../models/Room.js`) — constructor + `toSnapshot()`.
- `ROOM_STATUS` (`../models/RoomStatus.js`).
- `generateRoomId` (`./room/roomIdAlphabet.js`).
- `RoomDestroyForensics` (`../diagnostics/RoomDestroyForensics.js`) — `registerRoomDestroyContext`, `consumeRoomDestroyContext`.
- No direct dependency on `GameManager` or `PlayerManager` inside `RoomManager.js`; however, `room.players` holds `playerId` values owned by `PlayerManager`, and `GameManager` reads rooms via the attached `roomManager` reference (from its own bootstrap, not from `RoomManager`).

#### 3.2.11 RoomManager-specific questions

- **How a Room is normally created:** `createRoom({ maxPlayers })` checks the drain gate and capacity, generates a new `roomId` via `_generateRoomId()` (up to 1000 attempts for uniqueness), constructs a `Room` with `ROOM_STATUS.CREATED`, stores it in `this._rooms`, calls `this._setupSessionLifecycle.createForRoom(room)` (atomic — room is deleted if setup-session creation fails), transitions to `ROOM_STATUS.WAITING_FOR_PLAYERS`, emits `ROOM_CREATED`, and returns the room.
- **How players are associated with a room:** `addPlayer(roomId, playerId)` validates room status (rejects `LOCKED`/`DESTROYED`), rejects duplicate players in the same room, rejects players already present in `this._playerRoomIndex`, enforces `room.maxPlayers`, then pushes `playerId` into `room.players` and sets `this._playerRoomIndex.set(playerId, roomId)`. Transitions to `ROOM_STATUS.FULL` when capacity is reached.
- **Whether an existing `roomId` can be attached:** No. There is no `attachExistingRoom()` method. `createRoom` always generates a new `roomId` via `_generateRoomId()`; the `roomId` is not an accepted input parameter to `createRoom`.
- **Whether a room can be reconstructed without creating a new `roomId`:** No. No reconstruction method exists. `createRoom` always allocates a new `roomId`.

### 3.3 GameManager — `server/managers/GameManager.js` (1222 lines)

#### 3.3.1 Runtime state owned

- Game lifecycle and game objects (`Game` instances).
- Pending gameplay activation index (`roomId` → `gameId` waiting for `ENTRY_PAYMENT_COMPLETED`).
- Pending configuration index (`roomId` → `gameId` waiting for complete Page2 profiles).
- Entry-payment-activated game marker set.
- Gameplay bootstrap dependency bundle (`this._bootstrap`).
- Event subscriptions for `SETUP_SESSION_COMPLETED`, `ALL_PLAYER_PROFILES_READY`, `ENTRY_PAYMENT_COMPLETED`, `SERVER_SHUTDOWN`.

#### 3.3.2 Internal Maps / Sets / in-memory registries

| Field | Type | Purpose |
|-------|------|---------|
| `this._games` | `Map` | `gameId` → `Game` object |
| `this._gameListeners` | `Map` | `gameId` → event subscriptions (cleared in `destroyGame` via `_clearGameListeners`; no public method adds entries — registry exists for teardown) |
| `this._infrastructureHandlers` | `Array` | `SERVER_SHUTDOWN` subscription record |
| `this._bootstrapHandler` | `null \| function` | `SETUP_SESSION_COMPLETED` handler |
| `this._profilesReadyHandler` | `null \| function` | `ALL_PLAYER_PROFILES_READY` handler |
| `this._entryPaymentCompletedHandler` | `null \| function` | `ENTRY_PAYMENT_COMPLETED` handler |
| `this._bootstrap` | `null \| object` | `{ roomManager, playerManager, configurationEngine, gameStateEngine, inputAuthority, physicsEngine, gameClockEngine, gameCatalog, gameplayContextResolver, devMode }` |
| `this._pendingGameplayActivation` | `Map` | `roomId` → `gameId` waiting for `ENTRY_PAYMENT_COMPLETED` (R1.1) |
| `this._pendingConfigurationByRoom` | `Map` | `roomId` → `gameId` waiting for complete Page2 profiles (R5.15) |
| `this._entryPaymentActivatedGames` | `Set` | `gameId`s activated via authoritative `ENTRY_PAYMENT_COMPLETED` (R8.8) |
| `this._initialized` | `boolean` | Set `true` in `initialize()`, `false` in `shutdown()` |

#### 3.3.3 Important identifiers

- `gameId` — generated by `_generateGameId()` which returns `game_${randomUUID()}` (uses `node:crypto.randomUUID`).
- `roomId` — used as a key in pending-activation and pending-configuration maps; stored on the `Game` object; not generated by `GameManager`.

#### 3.3.4 Existing methods that create runtime objects

- `createGame(roomId, { players = [] } = {})` — requires `roomId`; generates a new `gameId` via `_generateGameId()`; rejects if `gameId` already exists; constructs `new Game({ gameId, roomId, createdAt: Date.now(), status: GAME_STATUS.CREATED, players: [...players], metadata: {} })`; stores in `this._games`; emits `GAME_CREATED`. Returns the `Game` (or `null`).
- `initializeGame(gameId)` — requires `game.status === GAME_STATUS.CREATED`; sets `INITIALIZED`; emits `GAME_INITIALIZED`; then immediately sets `READY`. Returns the game (or `null`).
- `startGame(gameId)` — requires `READY`; sets `RUNNING`; emits `GAME_STARTED`.
- `finishGame(gameId)` — requires `RUNNING`; sets `FINISHED`; emits `GAME_FINISHED`.
- `markEntryPaymentActivated(gameId)` — adds `gameId` to `this._entryPaymentActivatedGames`.
- `_handleSetupSessionCompleted(envelope)` — bootstrap handler: reads room from `roomManager.getRoom(roomId)`; requires `room.players.length === room.maxPlayers`; calls `createGame(roomId, { players: room.players })`; calls `gameplayContextResolver?.activateRoomGame(roomId, gameId)`; calls `inputAuthority.registerPlayers(gameId, room.players)`; calls `physicsEngine.createSimulation(gameId)`; calls `gameClockEngine.createClock(gameId)`; sets `this._pendingGameplayActivation.set(roomId, gameId)` and `this._pendingConfigurationByRoom.set(roomId, gameId)`; calls `_tryGenerateConfiguration(roomId)`.
- `_handleAllPlayerProfilesReady(envelope)` — calls `_tryGenerateConfiguration(roomId)`.
- `_tryGenerateConfiguration(roomId)` — idempotent; reads `gameId` from `this._pendingConfigurationByRoom`; skips if configuration already exists; reads room; requires `areRoomPlayerProfilesComplete(playerManager, room.players)`; builds configuration room/players; calls `configurationEngine.buildConfiguration` → `validateConfiguration` → `freezeConfiguration` → `commitConfiguration`; deletes pending-configuration entry.
- `_handleEntryPaymentCompleted(envelope)` — resolves `gameId` from `this._pendingGameplayActivation.get(roomId) ?? envelope.payload?.gameId`; requires configuration to exist (else defers via `_tryGenerateConfiguration`); calls `_activateGameplaySession(roomId, gameId)`.
- `_activateGameplaySession(roomId, gameId)` — idempotent (requires `game.status === GAME_STATUS.CREATED`); calls `gameStateEngine.initializeGameState(gameId)`; calls `gameClockEngine.startClock(gameId)`; calls `this.initializeGame(gameId)`; calls `this.markEntryPaymentActivated(gameId)`; deletes `this._pendingGameplayActivation` entry.

#### 3.3.5 Existing methods that destroy runtime objects

- `destroyGame(gameId)` — sets `game.status = GAME_STATUS.DESTROYED`; deletes `this._pendingGameplayActivation` and `this._pendingConfigurationByRoom` entries for `game.roomId`; emits `GAME_DESTROYED`; calls `_clearGameListeners(gameId)`; deletes from `this._games`. Returns `boolean`.
- `shutdown()` — unsubscribes bootstrap/profiles-ready/entry-payment handlers; clears `_pendingGameplayActivation`, `_pendingConfigurationByRoom`, `_entryPaymentActivatedGames`; calls `destroyGame(gameId)` for each game; unsubscribes infrastructure handlers; sets `this._bootstrap = null`; sets `this._initialized = false`.
- `_handleServerShutdown()` — calls `destroyGame(gameId)` for each game in `[...this._games.keys()]`.

#### 3.3.6 Existing restore / hydrate / attach / rebind / reconstruction methods

- `configureGameplayBootstrap({ roomManager, playerManager, configurationEngine, gameStateEngine, inputAuthority, physicsEngine, gameClockEngine, gameCatalog, gameplayContextResolver, devMode })` — attaches the gameplay bootstrap dependency bundle. Not a recovery/reconstruction method.
- `linkGameplayContextResolver(gameplayContextResolver)` — links a context resolver into an existing bootstrap bundle. Not a recovery/reconstruction method.
- `attachExistingGame()` — **NOT IMPLEMENTED**.
- Game restore / hydrate / rebind / reconstruct — **NOT IMPLEMENTED**.

#### 3.3.7 SERVER_SHUTDOWN behavior

- `initialize()` subscribes to `EVENT_TYPES.SERVER_SHUTDOWN` → `_handleServerShutdown()` and also calls `_subscribeGameplayBootstrap()` (subscribing to `SETUP_SESSION_COMPLETED`, `ALL_PLAYER_PROFILES_READY`, `ENTRY_PAYMENT_COMPLETED`).
- `_handleServerShutdown()` destroys every game via `destroyGame()`.
- `shutdown()` performs the same destruction plus unsubscribes all handlers, clears all pending maps/sets, nulls `this._bootstrap`, and sets `_initialized = false`.

#### 3.3.8 Whether any state is persisted before shutdown

- No. `GameManager` performs no disk writes, no persistence calls, and no serialization of game, pending-activation, pending-configuration, or entry-payment-activated state before or during shutdown. All state is discarded.

#### 3.3.9 Whether any state can currently be reconstructed from existing data

- No. There is no persistence layer for games, pending-activation, pending-configuration, or entry-payment-activated markers. After a server restart, all `Map`s/`Set`s are empty. No data source exists from which games could be reconstructed. (Restored `GAME_CONTRACT` records in the financial domain reference `gameId` values, but `GameManager` has no method to attach a game using such an `gameId`.)

#### 3.3.10 Dependencies on other managers or engines that would matter for future reconstruction

Via `this._bootstrap` (attached through `configureGameplayBootstrap`):

- `roomManager` — `getRoom(roomId)` (used in `_handleSetupSessionCompleted`, `_tryGenerateConfiguration`).
- `playerManager` — passed to `areRoomPlayerProfilesComplete(playerManager, room.players)` (imported from `./playerProfileCompleteness.js`).
- `configurationEngine` — `buildConfiguration`, `validateConfiguration`, `freezeConfiguration`, `commitConfiguration`, `getConfiguration`.
- `gameStateEngine` — `initializeGameState(gameId)`.
- `inputAuthority` — `registerPlayers(gameId, room.players)`.
- `physicsEngine` — `createSimulation(gameId)`.
- `gameClockEngine` — `createClock(gameId)`, `startClock(gameId)`.
- `gameCatalog` — stored in bootstrap; not invoked in the read portion.
- `gameplayContextResolver` — `activateRoomGame(roomId, gameId)` (optional, `?.`).
- `Game` model (`../models/Game.js`) — constructor + `toSnapshot()`.
- `GAME_STATUS` (`../models/GameStatus.js`).
- `playerProfileCompleteness` (`./playerProfileCompleteness.js`) — `areRoomPlayerProfilesComplete`, `isPlayerProfileComplete`.
- `PlayerProfileRules` (`../models/PlayerProfileRules.js`) — `isAllowedBaseStake` (imported; used in `_resolveBootstrapStake` in the unread tail — confirmed present via search).
- `ConfigurationValidationError` (`../engines/configuration/ConfigurationValidationError.js`).

Reconstruction would need to re-establish all of the above engine states (`gameStateEngine`, `physicsEngine`, `gameClockEngine`, `configurationEngine`, `inputAuthority`) for a given `gameId`, because `GameManager` creation bootstraps them as a coupled set.

#### 3.3.11 GameManager-specific questions

- **How a Game is normally created:** `createGame(roomId, { players })` requires `roomId`, generates a new `gameId` via `_generateGameId()` (`game_${randomUUID()}`), constructs a `Game` with `GAME_STATUS.CREATED`, stores it in `this._games`, and emits `GAME_CREATED`. The normal trigger is the `SETUP_SESSION_COMPLETED` event handler `_handleSetupSessionCompleted`, which calls `createGame(roomId, { players: room.players })` after verifying the room is full, then bootstraps `inputAuthority.registerPlayers`, `physicsEngine.createSimulation`, `gameClockEngine.createClock`, and records pending-activation/pending-configuration entries.
- **Minimum information required to create a Game:** `roomId` (required; `createGame` returns `null` without it). `players` is optional and defaults to `[]`. The `gameId` is internally generated and is not an accepted input parameter.
- **How `GAME_INITIALIZED` is reached:** Through the event chain `ENTRY_PAYMENT_COMPLETED` → `_handleEntryPaymentCompleted` → `_activateGameplaySession(roomId, gameId)`, which calls `gameStateEngine.initializeGameState(gameId)`, `gameClockEngine.startClock(gameId)`, then `this.initializeGame(gameId)`. `initializeGame` requires `game.status === GAME_STATUS.CREATED`, sets `INITIALIZED`, emits `GAME_INITIALIZED`, then immediately sets `READY`. Activation also requires an existing committed configuration (`configurationEngine.getConfiguration(gameId)` must be truthy) and is gated on `ENTRY_PAYMENT_COMPLETED`. The `GAME_INITIALIZED` event is emitted from within `initializeGame`.
- **Whether an existing game can be attached using an existing `gameId`:** No. There is no `attachExistingGame()` method. `createGame` always generates a new `gameId` via `_generateGameId()`; `gameId` is not an accepted input parameter to `createGame`.
- **Whether the manager can reconstruct a game without creating a new `gameId`:** No. No reconstruction method exists. `createGame` always allocates a new `gameId`.

### 3.4 PlayerManager — `server/managers/PlayerManager.js` (558 lines)

#### 3.4.1 Runtime state owned

- Player identity objects (`PlayerIdentity` instances).
- Player runtime objects (`PlayerRuntime` instances).
- Identity + runtime are stored as two parallel `Map`s keyed by `playerId`.

#### 3.4.2 Internal Maps / Sets / in-memory registries

| Field | Type | Purpose |
|-------|------|---------|
| `this._identities` | `Map` | `playerId` → `PlayerIdentity` object |
| `this._runtimes` | `Map` | `playerId` → `PlayerRuntime` object |
| `this._infrastructureHandlers` | `Array` | `SERVER_SHUTDOWN` subscription record |
| `this._initialized` | `boolean` | Set `true` in `initialize()`, `false` in `shutdown()` |

Module-level frozen constant:

- `RUNTIME_FIELDS = Object.freeze(["connectionState","playerState","roomId","gameId","pressCount","ping","connectedAt","lastSeen"])` — the only runtime fields `_applyRuntimePatch` will accept.

#### 3.4.3 Important identifiers

- `playerId` — generated by `_generatePlayerId()` which returns `player_${randomUUID()}` (uses `node:crypto.randomUUID`). `createPlayer` also accepts `identityInput.playerId`; if provided, that value is used instead of generating a new one (see 3.4.11).

#### 3.4.4 Existing methods that create runtime objects

- `createPlayer(identityInput = {})` — resolves `playerId = identityInput.playerId ?? this._generatePlayerId()`; rejects if `playerId` already exists in `this._identities`; constructs `new PlayerIdentity({ playerId, nickname, wallet, icon, age, color, colorSector2, sectorCount, sectorArrangement, baseStake, createdAt })` (each field defaults from `identityInput` or `null`, `createdAt` defaults to `Date.now()`); constructs `new PlayerRuntime({ lastSeen: Date.now() })`; stores both in `this._identities` and `this._runtimes`; emits `PLAYER_CREATED`. Returns `Player.fromParts(identity, runtime)` (or `null`).

#### 3.4.5 Existing methods that destroy runtime objects

- `removePlayer(playerId)` — deletes from `this._identities` and `this._runtimes`; emits `PLAYER_REMOVED` with identity and runtime snapshots. Returns `boolean`.
- `shutdown()` — calls `removePlayer(playerId)` for each identity; unsubscribes infrastructure handlers; sets `this._initialized = false`.
- `_handleServerShutdown()` — calls `removePlayer(playerId)` for each identity.

#### 3.4.6 Existing restore / hydrate / attach / rebind / reconstruction methods

- None. There is no `attachExistingPlayer()`, `restoreIdentity()`, `rehydrate()`, `rebind()`, or `reconstruct()` method.
- Player identity restore / hydrate / attach / rebind / reconstruct — **NOT IMPLEMENTED**.

#### 3.4.7 SERVER_SHUTDOWN behavior

- `initialize()` subscribes to `EVENT_TYPES.SERVER_SHUTDOWN` → `_handleServerShutdown()`.
- `_handleServerShutdown()` removes every player via `removePlayer()`.
- `shutdown()` performs the same removal plus unsubscribes infrastructure handlers and sets `_initialized = false`.

#### 3.4.8 Whether any state is persisted before shutdown

- No. `PlayerManager` performs no disk writes, no persistence calls, and no serialization of identity or runtime state before or during shutdown. All state is discarded.

#### 3.4.9 Whether any state can currently be reconstructed from existing data

- No. There is no persistence layer for player identities or runtimes. After a server restart, `this._identities` and `this._runtimes` are empty `Map`s. No data source exists from which identities or runtimes could be reconstructed. (Restored `PAYMENT_SESSION` records in the financial domain reference `playerId` values, but `PlayerManager` has no method to attach an identity using such a `playerId`.)

#### 3.4.10 Dependencies on other managers or engines that would matter for future reconstruction

- `EventBus` — `subscribe`, `unsubscribe`, `emit`.
- `Player` model (`../models/Player.js`) — `Player.fromParts(identity, runtime)` (used in `getPlayer`, `createPlayer`).
- `PlayerIdentity` model (`../models/PlayerIdentity.js`) — constructor + `toSnapshot()`.
- `PlayerRuntime` model (`../models/PlayerRuntime.js`) — constructor + `toSnapshot()`.
- `ConnectionState` (`../models/ConnectionState.js`) — `CONNECTION_STATE` enum; validated in `setConnectionState` and `_applyRuntimePatch`.
- `PlayerState` (`../models/PlayerState.js`) — `PLAYER_STATE` enum; validated in `setPlayerState` and `_applyRuntimePatch`.
- No direct dependency on `RoomManager` or `GameManager` inside `PlayerManager.js`; however, `PlayerRuntime` carries `roomId` and `gameId` fields (part of `RUNTIME_FIELDS`) that are set via `updateRuntime` by external callers and that cross-reference `RoomManager`/`GameManager` state.

#### 3.4.11 PlayerManager-specific questions

- **How player identity is created:** `createPlayer(identityInput = {})` resolves `playerId = identityInput.playerId ?? this._generatePlayerId()` (where `_generatePlayerId()` returns `player_${randomUUID()}`). It rejects if `playerId` already exists in `this._identities`. It constructs a new `PlayerIdentity` from the provided `identityInput` fields (nickname, wallet, icon, age, color, colorSector2, sectorCount, sectorArrangement, baseStake, createdAt — each defaulting to `null` or `Date.now()`), constructs a new `PlayerRuntime({ lastSeen: Date.now() })`, stores both, emits `PLAYER_CREATED`, and returns `Player.fromParts(identity, runtime)`.
- **What player identity data is retained in memory:** The `PlayerIdentity` fields stored in `this._identities`: `playerId`, `nickname`, `wallet`, `icon`, `age`, `color`, `colorSector2`, `sectorCount`, `sectorArrangement`, `baseStake`, `createdAt` (as constructed in `createPlayer` and patched in `updateIdentity`).
- **What player runtime data is retained in memory:** The `PlayerRuntime` fields stored in `this._runtimes`, constrained by `RUNTIME_FIELDS`: `connectionState`, `playerState`, `roomId`, `gameId`, `pressCount`, `ping`, `connectedAt`, `lastSeen`. `lastSeen` is refreshed on every runtime mutation. `connectedAt` is set when `connectionState` becomes `CONNECTED`.
- **Whether player identity can currently be restored after server restart:** No. There is no persistence layer for identities or runtimes. After a server restart, `this._identities` and `this._runtimes` are empty. No restore method exists.
- **Whether an existing `playerId` can be attached without generating a new identity:** Partially, via the normal creation path only. `createPlayer(identityInput)` accepts `identityInput.playerId`; if provided, it uses that `playerId` instead of calling `_generatePlayerId()`. However, this creates a **new** `PlayerIdentity` object (not attaching a pre-existing identity object), requires the caller to supply all identity fields in `identityInput`, and rejects if the `playerId` already exists in `this._identities`. There is no dedicated `attachExistingPlayer()` or `restoreIdentity()` method. This is the standard creation path, not a recovery path.

## 4. Lifecycle Flow

### 4.1 Normal creation lifecycle (per manager)

```text
RoomManager:
  createRoom({ maxPlayers })
    → _generateRoomId() (up to 1000 attempts)
    → new Room({ roomId, status: CREATED, maxPlayers, players: [] })
    → _rooms.set(roomId, room)
    → _setupSessionLifecycle.createForRoom(room)
    → room.status = WAITING_FOR_PLAYERS
    → emit ROOM_CREATED
  addPlayer(roomId, playerId)
    → room.players.push(playerId)
    → _playerRoomIndex.set(playerId, roomId)
    → (at capacity) room.status = FULL; emit ROOM_FULL

GameManager:
  SETUP_SESSION_COMPLETED event
    → _handleSetupSessionCompleted
      → roomManager.getRoom(roomId) (must be full)
      → createGame(roomId, { players: room.players })
        → _generateGameId() → game_${randomUUID()}
        → new Game({ gameId, roomId, status: CREATED, players, metadata: {} })
        → _games.set(gameId, game)
        → emit GAME_CREATED
      → inputAuthority.registerPlayers(gameId, players)
      → physicsEngine.createSimulation(gameId)
      → gameClockEngine.createClock(gameId)
      → _pendingGameplayActivation.set(roomId, gameId)
      → _pendingConfigurationByRoom.set(roomId, gameId)
      → _tryGenerateConfiguration(roomId)
  ALL_PLAYER_PROFILES_READY event
    → _handleAllPlayerProfilesReady → _tryGenerateConfiguration(roomId)
  ENTRY_PAYMENT_COMPLETED event
    → _handleEntryPaymentCompleted
      → resolve gameId from _pendingGameplayActivation or payload
      → require configurationEngine.getConfiguration(gameId)
      → _activateGameplaySession(roomId, gameId)
        → gameStateEngine.initializeGameState(gameId)
        → gameClockEngine.startClock(gameId)
        → initializeGame(gameId)
          → game.status = INITIALIZED
          → emit GAME_INITIALIZED
          → game.status = READY
        → markEntryPaymentActivated(gameId)
        → _pendingGameplayActivation.delete(roomId)

PlayerManager:
  createPlayer(identityInput)
    → playerId = identityInput.playerId ?? _generatePlayerId()  (player_${randomUUID()})
    → new PlayerIdentity({ ...identityInput fields })
    → new PlayerRuntime({ lastSeen: Date.now() })
    → _identities.set(playerId, identity)
    → _runtimes.set(playerId, runtime)
    → emit PLAYER_CREATED
    → return Player.fromParts(identity, runtime)
```

### 4.2 SERVER_SHUTDOWN lifecycle (all three managers)

```text
SERVER_SHUTDOWN event emitted by app.js
        |
        v
RoomManager._handleServerShutdown()
  → for each roomId: registerRoomDestroyContext(server_shutdown); destroyRoom(roomId)
GameManager._handleServerShutdown()
  → for each gameId: destroyGame(gameId)
PlayerManager._handleServerShutdown()
  → for each playerId: removePlayer(playerId)
        |
        v
ALL in-memory state discarded. No persistence. No serialization.
```

### 4.3 Reconstruction lifecycle

```text
SERVER RESTART
        |
        v
initialize() on each manager
  → subscribes to SERVER_SHUTDOWN only
  → NO state restored
  → _rooms / _games / _identities / _runtimes = empty Map
  → _pendingGameplayActivation / _pendingConfigurationByRoom = empty Map
  → _entryPaymentActivatedGames = empty Set
        |
        v
[NO RECONSTRUCTION PATH EXISTS]
  RoomManager.attachExistingRoom()      → NOT IMPLEMENTED
  GameManager.attachExistingGame()      → NOT IMPLEMENTED
  PlayerManager identity restore        → NOT IMPLEMENTED
```

## 5. Ownership Boundaries

- `RoomManager` owns: room objects, room lifecycle status, room-player membership index, room-scoped listener teardown. Does not own player identity (owned by `PlayerManager`) or game state (owned by `GameManager`).
- `GameManager` owns: game objects, game lifecycle status, pending-activation/pending-configuration indices, entry-payment-activated marker set, gameplay bootstrap wiring. Does not own rooms or players directly; reads rooms via attached `roomManager` and reads player-profile completeness via attached `playerManager`.
- `PlayerManager` owns: player identity objects, player runtime objects, connection/player state transitions. Does not own rooms or games directly; runtime carries `roomId`/`gameId` cross-references set by external callers.
- None of the three managers own persistence. Financial persistence is owned by `TonFinancialPersistence` (out of scope for this report).
- None of the three managers own recovery orchestration. Financial recovery is owned by `TonFinancialRecovery` (out of scope). Gameplay runtime recovery (`RecoveryEngine`) is out of scope per task constraints.
- This report did not alter any ownership boundaries.

## 6. Risks

### Critical

- **No persistence in any of the three managers:** `RoomManager`, `GameManager`, and `PlayerManager` perform zero disk writes and hold all state in in-memory `Map`/`Set`. On server restart, all rooms, games, player identities, player runtimes, pending-activation indices, pending-configuration indices, and entry-payment-activated markers are permanently lost. This is the core gap documented in `WHEELWIN_MASTER_CONTEXT.md` section 8 and `DEVELOPMENT_HISTORY.md` R17.9T.6.
- **No reconstruction methods in any of the three managers:** `attachExistingRoom()`, `attachExistingGame()`, and player identity restoration are all `NOT IMPLEMENTED`. There is no code path to reconstruct runtime objects from restored financial records (which reference `roomId`/`gameId`/`playerId` values).
- **`GAME_INITIALIZED` cannot be directly restored:** `GAME_INITIALIZED` is reached only through the live event chain `SETUP_SESSION_COMPLETED → createGame → ENTRY_PAYMENT_COMPLETED → _activateGameplaySession → initializeGame`. After a server restart, none of these events can be replayed because the setup session, room, players, and payment state are all gone, and `createGame` always generates a new `gameId`.

### High

- **`createRoom` always generates a new `roomId`:** `createRoom` does not accept a `roomId` parameter. Any future reconstruction that needs to preserve the original `roomId` (to match restored financial records) cannot use `createRoom` as-is.
- **`createGame` always generates a new `gameId`:** `createGame` does not accept a `gameId` parameter. Any future reconstruction that needs to preserve the original `gameId` (to match restored `GAME_CONTRACT` records) cannot use `createGame` as-is.
- **`createPlayer` accepts `playerId` but is not a recovery method:** `createPlayer(identityInput.playerId)` can use a provided `playerId`, but it creates a new `PlayerIdentity`/`PlayerRuntime` pair and requires all identity fields to be supplied by the caller. It is not a dedicated attach/restore method and does not validate against any authoritative source.
- **GameManager bootstrap is a coupled set:** `createGame` (via `_handleSetupSessionCompleted`) bootstraps `inputAuthority`, `physicsEngine`, `gameClockEngine`, and (via `_tryGenerateConfiguration`) `configurationEngine` as a coupled set. Reconstruction of a game would need to re-establish all of these engine states for the same `gameId`, not just the `Game` object in `GameManager._games`.

### Medium

- **`_roomListeners` / `_gameListeners` registries have no public adders:** Both `RoomManager._roomListeners` and `GameManager._gameListeners` are cleared in `destroyRoom`/`destroyGame` but no public method in the read portions adds entries to them. Their population path is outside the three files analyzed; reconstruction would need to understand how these registries are populated.
- **`destroyRoom` forensic `console.log`/`console.trace`:** `RoomManager.destroyRoom` contains extensive `console.log` and `console.trace` diagnostics (lines 449–466) alongside structured logger calls. These write raw state to stdout and are not production-grade structured logging. (Previously noted in the 2026-08-22 recovery architecture audit.)

### Low

- **`_generateRoomId` exhaustion:** `RoomManager._generateRoomId` returns `null` after 1000 failed uniqueness attempts; `createRoom` returns `null` in that case. Not a recovery risk, but a runtime limit.
- **`createPlayer` duplicate-`playerId` rejection:** `createPlayer` returns `null` if the provided `identityInput.playerId` already exists. This is correct for normal creation but means a caller cannot "re-attach" an identity that is already in memory.

## 7. Recommendations

This section is included to satisfy the `.clinerules` report format. Per task constraints, this report makes **no implementation recommendations** and designs **no new APIs**. The following are factual observations only, not implementation proposals:

- The three managers are factually incapable of reconstruction today: no persistence, no attach/restore methods, and `createRoom`/`createGame` always generate new IDs.
- Any future reconstruction work (R17.9T.6) would need to address the ID-preservation gap (`createRoom` ignores `roomId`; `createGame` ignores `gameId`) and the coupled-bootstrap gap (`GameManager` bootstraps multiple engines per game).
- `createPlayer` is the only of the three creation methods that already accepts an externally supplied ID (`identityInput.playerId`), but it is not a recovery method and does not source identity data from an authoritative store.
- These observations are inventory only; no changes are recommended or designed in this report.

## 8. Changes Made

No files modified. No source code, configuration, or test files were changed. This report is the only artifact created:

- `AI_CONTEXT/CLINE_REPORTS/2026-08-22_recovery_runtime_managers_mapping.md`

## Limitations

- `server/managers/GameManager.js` is 1222 lines. `read_file` returned a cached first-1000-line view and could not be re-invoked to display lines 1001–1222 (duplicate-read guard). The tail was enumerated via `search_files` for method definitions, which confirmed the only methods in lines 1001–1222 are `_emitGameplayActivationFailed`, `_resolveBootstrapStake`, `_buildConfigurationPlayers`, `_logWheelConfigurationDiagnostic`, and `_logBootstrap` — all helper/diagnostic methods, none of which are restore/hydrate/attach/reconstruct/recovery methods. The recovery-relevant findings (no `attachExistingGame`, no persistence, `createGame` always generates a new `gameId`) are fully established from lines 1–1000 and the verification search.
- No application tests were run.
- Financial modules, `RecoveryEngine`, and client reconnect were explicitly out of scope per task constraints and were not analyzed in this report.