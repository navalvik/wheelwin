# Recovery Runtime Engines Mapping — ConfigurationEngine, GameStateEngine, PhysicsEngine, GameClockEngine, InputAuthority, WinnerEngine

Date: 2026-08-22

Task: READ-ONLY Recovery Runtime Engines Mapping for the WheelWin project. Second focused analysis step of R17.9T.6 Hybrid Recovery Architecture. Factual inventory of runtime state, in-memory Maps/Sets/registries/timers, important identifiers, create/destroy/initialize methods, restore/hydrate/attach/reconstruct methods, SERVER_SHUTDOWN behavior, persistence, reconstructability, and inter-module dependencies for six runtime engines only: `ConfigurationEngine`, `GameStateEngine`, `PhysicsEngine`, `GameClockEngine`, `InputAuthority`, `WinnerEngine`. No source code changes, no implementation, no API design, no financial-module analysis, no client-reconnect analysis, no RoomManager/GameManager/PlayerManager analysis (covered by prior report).

## 1. Scope

This report is a factual inventory of six server-side runtime engines:

- `server/engines/ConfigurationEngine.js`
- `server/engines/GameStateEngine.js`
- `server/engines/PhysicsEngine.js`
- `server/engines/GameClockEngine.js`
- `server/input/InputAuthority.js`
- `server/engines/WinnerEngine.js`

For each engine, the following were determined from source code only:

1. Runtime state owned by the module.
2. Internal Maps, Sets, registries, timers, or other in-memory state.
3. Important identifiers used as keys.
4. Existing methods that create runtime state.
5. Existing methods that destroy runtime state.
6. Existing methods that initialize runtime state.
7. Existing methods that restore, hydrate, attach, rebind, reconstruct, or recover state.
8. If no recovery/reconstruction method exists, explicit `NOT IMPLEMENTED`.
9. `SERVER_SHUTDOWN` behavior.
10. Whether any state is persisted before shutdown.
11. Whether any state can currently be reconstructed after server restart.
12. Dependencies on other runtime modules that would matter for future reconstruction.

Engine-specific questions were also answered for each module (see section 3).

Each module was classified as exactly one of:

- `FULLY_RECONSTRUCTABLE`
- `PARTIALLY_RECONSTRUCTABLE`
- `NOT_RECONSTRUCTABLE`

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
- `AI_CONTEXT/CLINE_REPORTS/2026-08-22_restorePaymentSessions_analysis.md`
- `AI_CONTEXT/CLINE_REPORTS/2026-08-22_recovery_runtime_managers_mapping.md`

Source files analyzed (the only source files in scope):

- `server/engines/ConfigurationEngine.js` (1037 lines; lines 1–1000 read in full; lines 1001–1037 enumerated via `search_files` because `read_file` returned a cached first-1000-line view — see Limitations)
- `server/engines/GameStateEngine.js` (401 lines, read in full)
- `server/engines/PhysicsEngine.js` (1326 lines; lines 1–1000 read in full; lines 1001–1326 enumerated via `search_files` — see Limitations)
- `server/engines/GameClockEngine.js` (965 lines, read in full)
- `server/input/InputAuthority.js` (806 lines, read in full)
- `server/engines/WinnerEngine.js` (423 lines, read in full)

Supporting definition files inspected:

- `server/engines/gameState/GameStates.js` (30 lines, read in full)
- `server/engines/gameState/TransitionTable.js` (28 lines, read in full)
- `server/engines/gameClock/ClockPhases.js` (24 lines, read in full)
- `server/engines/physics/PhysicsSimulationState.js` (32 lines, read in full)

Verification searches across all six engine files for recovery/persistence method definitions:

- Regex search for `restore|hydrate|attach|rebind|reconstruct|recover|persist|save|load|fromRecord|fromSnapshot|toRecord|serialize|deserialize` method definitions in each engine file.
- Regex search for `clear()` / `remove*` / `*.keys()` patterns to confirm `SERVER_SHUTDOWN` behavior.

## 3. Architecture Findings

### 3.1 Cross-cutting facts (all six engines)

- All six engines are plain ES classes with a constructor accepting `{ logger, eventBus, ... }`.
- All six engines store runtime state exclusively in in-memory `Map` / `Set` / `Array` fields. None of the six engines import or reference any persistence module (`TonFinancialPersistence`, `fs`, file writes, database clients).
- All six engines subscribe to `EVENT_TYPES.SERVER_SHUTDOWN` inside `initialize()` and clear their in-memory state in their `_handleServerShutdown()` handler.
- All six engines expose a `shutdown()` method that mirrors `_handleServerShutdown()` and also unsubscribes infrastructure handlers.
- None of the six engines persist any state before shutdown.
- None of the six engines can reconstruct runtime state from existing data after a server restart.
- Verification search confirmed: the only `restore*` method definition across all six files is `GameClockEngine.restorePhaseSchedule` (line 499), which restores a phase schedule within a LIVE clock (client reconnect), not from disk after server restart. There are zero `hydrate*`, `attach*`, `rebind*`, `reconstruct*`, `persist*`, `save*`, `load*`, `fromRecord*`, `fromSnapshot*`, `toRecord*`, `serialize*`, or `deserialize*` method definitions in any of the six engines.

### 3.2 ConfigurationEngine — `server/engines/ConfigurationEngine.js` (1037 lines)

#### 3.2.1 Runtime state owned

- Immutable game configuration objects (frozen via `deepFreezeConfiguration`).
- Frozen payment economy objects (frozen via `Object.freeze`).

#### 3.2.2 Internal Maps / Sets / in-memory registries

| Field | Type | Purpose |
|-------|------|---------|
| `this._configurations` | `Map` | `gameId` → frozen configuration object |
| `this._economies` | `Map` | `gameId` → frozen economy object (`{ ownerFeePercent, organizerFeeRate, winnerPercentage, frozenAt }`) |
| `this._infrastructureHandlers` | `Array` | `SERVER_SHUTDOWN` + `GAME_INITIALIZED` subscription records |
| `this._initialized` | `boolean` | Set `true` in `initialize()`, `false` in `shutdown()` |

#### 3.2.3 Important identifiers

- `gameId` — key for both `_configurations` and `_economies`. Provided externally (by `GameManager`); not generated by `ConfigurationEngine`.

#### 3.2.4 Existing methods that create runtime state

- `generateConfiguration(gameId, room, players)` — orchestrates `buildConfiguration` → `validateConfiguration` → `freezeConfiguration` → `commitConfiguration`. Rejects if configuration already exists for `gameId`.
- `buildConfiguration(gameId, room, players)` — generates a configuration object from catalog colors/timers/wheel rules, player inputs, and `randomService` (trace seed, wheel start angle, triangle start angle, wheel layout). Returns an unfrozen configuration object.
- `commitConfiguration(configuration)` — stores the frozen configuration in `this._configurations` keyed by `configuration.gameId`. Emits `CONFIGURATION_READY`. Rejects if already exists.
- `freezeEconomy(gameId)` — creates and stores a frozen economy object in `this._economies` keyed by `gameId`. Idempotent. Requires configuration to exist. Triggered by `GAME_INITIALIZED` event handler `_handleGameInitialized`.

#### 3.2.5 Existing methods that destroy runtime state

- `removeConfiguration(gameId)` — deletes from both `this._configurations` and `this._economies`. Emits `CONFIGURATION_REMOVED`. Returns `boolean`.
- `shutdown()` — iterates `[...this._configurations.keys()]`, calls `removeConfiguration(gameId)` for each; unsubscribes infrastructure handlers; sets `_initialized = false`.
- `_handleServerShutdown()` — calls `removeConfiguration(gameId)` for each configuration (confirmed via search: `removeConfiguration` appears twice outside its own definition — in `shutdown()` and in `_handleServerShutdown()`).

#### 3.2.6 Existing methods that initialize runtime state

- `initialize()` — subscribes to `SERVER_SHUTDOWN` → `_handleServerShutdown()` and `GAME_INITIALIZED` → `_handleGameInitialized()`. Sets `_initialized = true`. Does NOT create any configuration or economy state.

#### 3.2.7 Existing restore / hydrate / attach / rebind / reconstruction methods

- Configuration restore / hydrate / attach / rebind / reconstruct — **NOT IMPLEMENTED**.
- Verification search confirmed zero matches for `restore|hydrate|attach|rebind|reconstruct|recover|persist|save|load|fromRecord|fromSnapshot|toRecord|serialize|deserialize` (the only search hits were false positives from the substring "load" in "payload").

#### 3.2.8 SERVER_SHUTDOWN behavior

- `initialize()` subscribes to `EVENT_TYPES.SERVER_SHUTDOWN` → `_handleServerShutdown()`.
- `_handleServerShutdown()` calls `removeConfiguration(gameId)` for each configuration, which deletes from both `_configurations` and `_economies` and emits `CONFIGURATION_REMOVED`.

#### 3.2.9 Whether any state is persisted before shutdown

- No. `ConfigurationEngine` performs no disk writes, no persistence calls, and no serialization of configuration or economy state before or during shutdown. All state is discarded.

#### 3.2.10 Whether any state can currently be reconstructed after server restart

- No. There is no persistence layer for configurations or economies. After a server restart, `this._configurations` and `this._economies` are empty `Map`s. No data source exists from which configurations could be reconstructed. (Restored `GAME_CONTRACT` records in the financial domain may contain configuration metadata/snapshot hashes, but `ConfigurationEngine` has no method to restore a configuration from such a record.)

#### 3.2.11 Dependencies on other runtime modules that would matter for future reconstruction

- `EventBus` — `subscribe`, `unsubscribe`, `emit`.
- `gameCatalog` — `getColors`, `getTimers`, `getWheelRules`, `getStakes`, `getIcons`, `getCatalogVersion`, `getPaymentRules`. Catalog is immutable configuration data, not runtime state.
- `randomService` — `generateTraceSeed`, `nextInt`. Used during `buildConfiguration` to generate trace seed and start angles. Reconstruction would need the original `traceSeed` and start angles to reproduce the same configuration; these are stored inside the configuration object itself but not persisted.
- `deepFreezeConfiguration` (`./configuration/configurationFreeze.js`).
- `generateWheelLayout`, `validateWheelLayout` (`./configuration/wheelLayoutGenerator.js`).
- `resolvePlayerSetupColors` (`./configuration/colorCatalog.js`).
- `CONFIGURATION_VERSION` (`./configuration/ConfigurationVersion.js`).
- `ConfigurationValidationError` (`./configuration/ConfigurationValidationError.js`).
- No direct dependency on `GameManager`, `GameStateEngine`, `PhysicsEngine`, `GameClockEngine`, `InputAuthority`, or `WinnerEngine` inside `ConfigurationEngine.js`. However, `GameManager._tryGenerateConfiguration` calls `ConfigurationEngine.buildConfiguration` → `validateConfiguration` → `freezeConfiguration` → `commitConfiguration` as a coupled bootstrap step, and `WinnerEngine._readResolutionInputs` calls `ConfigurationEngine.getConfiguration(gameId)`.

#### 3.2.12 ConfigurationEngine-specific questions

- **Where committed configuration is stored:** `this._configurations` `Map`, keyed by `gameId`. The value is the frozen configuration object returned by `deepFreezeConfiguration`.
- **Whether configuration is immutable after commit:** Yes. `freezeConfiguration(configuration)` calls `deepFreezeConfiguration(configuration)` before `commitConfiguration` stores it. The economy is frozen via `Object.freeze`. Both are immutable after storage.
- **Whether configuration can be retrieved by gameId:** Yes. `getConfiguration(gameId)` returns `this._configurations.get(gameId) ?? null`.
- **Whether configuration can be reconstructed from an existing persisted representation:** No. There is no `fromRecord`, `fromSnapshot`, `restore`, or `attach` method. `buildConfiguration` generates a new configuration from live inputs (room, players, catalog, randomService) and cannot reproduce a previously generated configuration without the original `traceSeed` and random outputs.
- **Whether a committed configuration can currently be attached to a reconstructed Game:** No. There is no `attachConfiguration` or `restoreConfiguration` method. `commitConfiguration` rejects if a configuration already exists for the `gameId` but has no path to attach a pre-built configuration object for a `gameId` that was restored from external data.

#### 3.2.13 Recovery capability classification

**NOT_RECONSTRUCTABLE**

No persistence, no restore/attach method, and `buildConfiguration` depends on `randomService` outputs (trace seed, start angles) that are not retained outside the in-memory configuration object.

---

### 3.3 GameStateEngine — `server/engines/GameStateEngine.js` (401 lines)

#### 3.3.1 Runtime state owned

- Game state records: `{ currentState, previousState, enteredAt, history[] }`.
- State transition validation and history tracking.

#### 3.3.2 Internal Maps / Sets / in-memory registries

| Field | Type | Purpose |
|-------|------|---------|
| `this._states` | `Map` | `gameId` → state record `{ currentState, previousState, enteredAt, history: [{ state, enteredAt, reason }] }` |
| `this._infrastructureHandlers` | `Array` | `SERVER_SHUTDOWN` subscription record |
| `this._initialized` | `boolean` | Set `true` in `initialize()`, `false` in `shutdown()` |

#### 3.3.3 Important identifiers

- `gameId` — key for `_states`. Provided externally; not generated by `GameStateEngine`.

#### 3.3.4 Existing methods that create runtime state

- `initializeGameState(gameId, context = {})` — creates a state record with `currentState: GAME_STATES.PRE_GAME_READY`, `previousState: null`, `enteredAt: Date.now()`, `history: [{ state: PRE_GAME_READY, enteredAt, reason }]`. Stores in `this._states`. Emits `GAME_STATE_CHANGED`. Rejects if state already exists for `gameId`.

#### 3.3.5 Existing methods that destroy runtime state

- `removeState(gameId)` — deletes from `this._states`. Returns `boolean`.
- `resetState(gameId, context = {})` — removes existing state and re-initializes with `PRE_GAME_READY`. Not a recovery method; always resets to the initial state.
- `shutdown()` — iterates `[...this._states.keys()]`, calls `removeState(gameId)` for each; unsubscribes infrastructure handlers; sets `_initialized = false`.
- `_handleServerShutdown()` — iterates `[...this._states.keys()]`, calls `removeState(gameId)` for each.

#### 3.3.6 Existing methods that initialize runtime state

- `initialize()` — subscribes to `SERVER_SHUTDOWN` → `_handleServerShutdown()`. Sets `_initialized = true`. Does NOT create any game state.

#### 3.3.7 Existing restore / hydrate / attach / rebind / reconstruction methods

- Game state restore / hydrate / attach / rebind / reconstruct — **NOT IMPLEMENTED**.
- `resetState` is the closest method, but it always resets to `PRE_GAME_READY` — it does not restore a specific previous state.

#### 3.3.8 SERVER_SHUTDOWN behavior

- `initialize()` subscribes to `EVENT_TYPES.SERVER_SHUTDOWN` → `_handleServerShutdown()`.
- `_handleServerShutdown()` iterates `[...this._states.keys()]` and calls `removeState(gameId)` for each.

#### 3.3.9 Whether any state is persisted before shutdown

- No. `GameStateEngine` performs no disk writes, no persistence calls, and no serialization of state records before or during shutdown. All state is discarded.

#### 3.3.10 Whether any state can currently be reconstructed after server restart

- No. There is no persistence layer for game state. After a server restart, `this._states` is an empty `Map`. No data source exists from which state could be reconstructed. `initializeGameState` always creates with `PRE_GAME_READY` and rejects if state already exists.

#### 3.3.11 Dependencies on other runtime modules that would matter for future reconstruction

- `EventBus` — `subscribe`, `unsubscribe`, `emit`.
- `GAME_STATES` (`./gameState/GameStates.js`) — `PRE_GAME_READY`, `READY`, `SELF_TEST`, `SPEED`, `BRAKE`, `RESULT`.
- `TransitionTable` (`./gameState/TransitionTable.js`) — `getAllowedTransitions`, `isTransitionAllowed`, `isValidGameState`.
- No direct dependency on `ConfigurationEngine`, `PhysicsEngine`, `GameClockEngine`, `InputAuthority`, or `WinnerEngine` inside `GameStateEngine.js`. However, `GameManager._activateGameplaySession` calls `gameStateEngine.initializeGameState(gameId)`, and `InputAuthority._handleButtonAction` calls `gameStateEngine.getState(gameId)` to validate that the current state is `SPEED`.

#### 3.3.12 GameStateEngine-specific questions

- **How game state is stored:** `this._states` `Map`, `gameId` → record `{ currentState, previousState, enteredAt, history: [{ state, enteredAt, reason }] }`.
- **How the current state is identified by gameId:** `getState(gameId)` returns `record.currentState` from `this._states.get(gameId)`.
- **Whether current phase/state survives server restart:** No. All in-memory. `_handleServerShutdown` removes all states.
- **Whether an existing state can be restored for an existing gameId:** No. `initializeGameState` always creates with `PRE_GAME_READY` and rejects if state already exists. `resetState` removes and re-creates with `PRE_GAME_READY`. No method exists to restore a specific state (e.g., `SPEED` or `BRAKE`) for a `gameId`.
- **Whether timers or transition metadata are retained:** The state record retains `enteredAt` (timestamp of current state entry) and `history` (array of `{ state, enteredAt, reason }` entries). These are in-memory only and lost on restart. No `setTimeout` handles are owned by `GameStateEngine` (timers are owned by `GameClockEngine`).
- **Whether `GAME_INITIALIZED` / `READY` / `COUNTDOWN` / `SELF_TEST` / `SPEED` / `BRAKE` / `RESULT` state can currently be reconstructed:** No. The actual `GAME_STATES` enum (from `GameStates.js`) defines: `PRE_GAME_READY`, `READY`, `SELF_TEST`, `SPEED`, `BRAKE`, `RESULT`. Note:
  - `GAME_INITIALIZED` is **NOT** a `GameStateEngine` state. It is a `GameManager` lifecycle status (`GAME_STATUS.INITIALIZED` from `GameStatus.js`), emitted as the `GAME_INITIALIZED` event by `GameManager.initializeGame`. It is not stored in `GameStateEngine._states`.
  - `COUNTDOWN` does **not exist** in the `GAME_STATES` enum or the `TRANSITIONS` table. The clock phases (`CLOCK_PHASE_SEQUENCE` from `ClockPhases.js`) are: `PRE_GAME_READY`, `READY`, `SELF_TEST`, `SPEED`, `BRAKE`, `RESULT` — same as `GAME_STATES`.
  - The `TRANSITIONS` table is linear and forward-only: `PRE_GAME_READY → READY → SELF_TEST → SPEED → BRAKE → RESULT`. No backward transitions are allowed. There is no method to set an arbitrary state directly; `transition(gameId, nextState, context)` validates against the transition table and rejects invalid transitions.

#### 3.3.13 Recovery capability classification

**NOT_RECONSTRUCTABLE**

No persistence, no restore/attach method, `initializeGameState` always starts at `PRE_GAME_READY`, and the transition table is forward-only with no method to set an arbitrary state.

---

### 3.4 PhysicsEngine — `server/engines/PhysicsEngine.js` (1326 lines)

#### 3.4.1 Runtime state owned

- Physics simulation objects: `{ gameId, parameters, runtime, commandLog }`.
- Simulation lifecycle state transitions (`CREATED → RUNNING → BRAKING → STOPPED → REMOVED`).

#### 3.4.2 Internal Maps / Sets / in-memory registries

| Field | Type | Purpose |
|-------|------|---------|
| `this._simulations` | `Map` | `gameId` → simulation object |
| `this._infrastructureHandlers` | `Array` | `SERVER_SHUTDOWN` subscription record |
| `this._initialized` | `boolean` | Set `true` in `initialize()`, `false` in `shutdown()` |

Each simulation object:

| Sub-field | Type | Purpose |
|-----------|------|---------|
| `gameId` | `string` | Game identifier |
| `parameters` | `object` | Physics parameters (merged from `DEFAULT_PHYSICS_PARAMETERS` + provided overrides) |
| `runtime` | `object` | Live physics state (see below) |
| `commandLog` | `Array` | Log of motion commands (`self_test_begin`, `self_test_end`, `speed_begin`, `speed_hold_update`, `speed_end`, `brake_begin`, `brake`, `acceleration`) |

`runtime` sub-fields:

| Field | Initial value | Purpose |
|-------|---------------|---------|
| `angle` | `0` | Wheel angle (radians) |
| `triangleAngle` | `0` | Triangle angle (radians) |
| `angularVelocity` | `0` | Wheel angular velocity |
| `triangleAngularVelocity` | `0` | Triangle angular velocity |
| `angularAcceleration` | `0` | Angular acceleration |
| `state` | `PHYSICS_SIMULATION_STATE.CREATED` | Simulation lifecycle state |
| `braking` | `false` | Braking flag |
| `selfTestActive` | `false` | Self-test motion active |
| `speedActive` | `false` | Speed motion active |
| `brakeActive` | `false` | Brake motion active |
| `brakeDurationMs` | `0` | Brake duration |
| `brakeElapsedMs` | `0` | Brake elapsed time |
| `brakeStartWheelOmega` | `0` | Wheel angular velocity at brake start |
| `physicsStoppedEmitted` | `false` | Whether `PHYSICS_STOPPED` was emitted |
| `simulationTimeMs` | `0` | Total simulation time |

`PHYSICS_SIMULATION_STATE` (from `PhysicsSimulationState.js`): `CREATED`, `RUNNING`, `BRAKING`, `STOPPED`, `REMOVED`.

#### 3.4.3 Important identifiers

- `gameId` — key for `_simulations`. Provided externally; not generated by `PhysicsEngine`.

#### 3.4.4 Existing methods that create runtime state

- `createSimulation(gameId, parameters = {})` — creates a simulation with `PHYSICS_SIMULATION_STATE.CREATED`, all runtime values zeroed, empty `commandLog`. Stores in `this._simulations`. Rejects if simulation already exists for `gameId`.

#### 3.4.5 Existing methods that destroy runtime state

- `removeSimulation(gameId)` — stops simulation if `RUNNING`/`BRAKING`, then deletes from `this._simulations`. Returns `boolean`.
- `shutdown()` — iterates `this._simulations.keys()`, calls `removeSimulation(gameId)` for each; unsubscribes infrastructure handlers; sets `_initialized = false`.
- `_handleServerShutdown()` — iterates `this._simulations.keys()`, calls `removeSimulation(gameId)` for each (confirmed via search: `removeSimulation` appears twice outside its own definition — in `shutdown()` and in `_handleServerShutdown()`).

#### 3.4.6 Existing methods that initialize runtime state

- `initialize()` — subscribes to `SERVER_SHUTDOWN` → `_handleServerShutdown()`. Sets `_initialized = true`. Does NOT create any simulation.

#### 3.4.7 Existing restore / hydrate / attach / rebind / reconstruction methods

- Physics simulation restore / hydrate / attach / rebind / reconstruct — **NOT IMPLEMENTED**.
- `setPoseDegrees(gameId, wheelAngleDeg, triangleAngleDeg)` (line 266) has a JSDoc comment mentioning "recovery" ("Seed authoritative wheel/triangle pose in degrees (READY / recovery). Does not start motion."). However, this method only sets the `angle` and `triangleAngle` fields of an **existing** simulation's `runtime`. It does not create a simulation, does not restore velocity/acceleration/state, and does not restore from disk. It is a pose-seeding method for `READY` phase or client reconnect, not a recovery/reconstruction method.
- Verification search confirmed zero actual `restore*`, `hydrate*`, `attach*`, `rebind*`, `reconstruct*`, `recover*`, `persist*`, `save*`, `load*`, `fromRecord*`, `fromSnapshot*`, `toRecord*`, `serialize*`, or `deserialize*` method definitions.

#### 3.4.8 SERVER_SHUTDOWN behavior

- `initialize()` subscribes to `EVENT_TYPES.SERVER_SHUTDOWN` → `_handleServerShutdown()`.
- `_handleServerShutdown()` iterates `this._simulations.keys()` and calls `removeSimulation(gameId)` for each, which stops active simulations and deletes them.

#### 3.4.9 Whether any state is persisted before shutdown

- No. `PhysicsEngine` performs no disk writes, no persistence calls, and no serialization of simulation state before or during shutdown. All state is discarded.

#### 3.4.10 Whether any state can currently be reconstructed after server restart

- No. There is no persistence layer for physics simulations. After a server restart, `this._simulations` is an empty `Map`. No data source exists from which simulations could be reconstructed. `createSimulation` always creates with zeroed runtime and `CREATED` state. `setPoseDegrees` can seed an angle but requires an existing simulation and does not restore full state.

#### 3.4.11 Dependencies on other runtime modules that would matter for future reconstruction

- `EventBus` — `subscribe`, `unsubscribe`, `emit`.
- `gameClock` — passed in constructor as `gameClock`; used for clock-related operations (not directly invoked in the read portion, but referenced).
- `metricsService` — optional, `record("physics.tick", duration)`.
- `computeSelfTestVelocities` (`../gameplay/selfTestMotion.js`).
- `computeSpeedVelocities` (`../gameplay/speedMotion.js`).
- `computeBrakeVelocities`, `integrateLinearBrakeAngle` (`../gameplay/brakeMotion.js`).
- `DEFAULT_PHYSICS_PARAMETERS` (`./physics/PhysicsParameters.js`).
- `canTransitionPhysicsState`, `PHYSICS_SIMULATION_STATE` (`./physics/PhysicsSimulationState.js`).
- `normalizeAngleRadians` (`./physics/physicsMath.js`).
- No direct dependency on `ConfigurationEngine`, `GameStateEngine`, `InputAuthority`, or `WinnerEngine` inside `PhysicsEngine.js`. However, `GameManager._handleSetupSessionCompleted` calls `physicsEngine.createSimulation(gameId)`, `InputAuthority._applyCommandToPhysics` calls `physicsEngine.applyAcceleration`, and `WinnerEngine._readResolutionInputs` calls `physicsEngine.getSimulation(gameId)` and requires `physics.runtime.state === STOPPED`.

#### 3.4.12 PhysicsEngine-specific questions

- **How simulations are stored:** `this._simulations` `Map`, `gameId` → simulation object `{ gameId, parameters, runtime, commandLog }`.
- **What runtime state belongs to a simulation:** `angle`, `triangleAngle`, `angularVelocity`, `triangleAngularVelocity`, `angularAcceleration`, `state`, `braking`, `selfTestActive`, `speedActive`, `brakeActive`, `brakeDurationMs`, `brakeElapsedMs`, `brakeStartWheelOmega`, `physicsStoppedEmitted`, `simulationTimeMs`. Plus `commandLog` array.
- **How simulation state is identified:** By `gameId` key in `this._simulations`.
- **Whether wheel angle, velocity, acceleration, target state, or other physics values are retained:** Yes, all retained in-memory in the `runtime` object. `angle` (wheel angle), `triangleAngle`, `angularVelocity`, `triangleAngularVelocity`, `angularAcceleration`, `state` (simulation lifecycle state), `braking`, `selfTestActive`, `speedActive`, `brakeActive`, `brakeDurationMs`, `brakeElapsedMs`, `brakeStartWheelOmega`, `simulationTimeMs` are all stored. However, all are lost on server restart.
- **Whether physics state is persisted:** No. No disk writes, no serialization.
- **Whether an existing simulation can be attached using an existing gameId:** No. `createSimulation` always creates a new simulation with zeroed runtime and `CREATED` state, and rejects if a simulation already exists. There is no `attachSimulation` or `restoreSimulation` method. `setPoseDegrees` can seed an angle on an existing simulation but does not create one or restore full state.
- **Whether physics state can currently survive a server restart:** No. All in-memory. `_handleServerShutdown` removes all simulations.

#### 3.4.13 Recovery capability classification

**NOT_RECONSTRUCTABLE**

No persistence, no restore/attach method, `createSimulation` always starts with zeroed runtime and `CREATED` state. `setPoseDegrees` can seed an angle on an existing simulation but is not a recovery method.

---

### 3.5 GameClockEngine — `server/engines/GameClockEngine.js` (965 lines)

#### 3.5.1 Runtime state owned

- Clock records: `{ gameId, currentPhase, startedAt, pausedAt, elapsed, running, paused, phaseStartedAt, phaseEndsAt, phaseRemainingMs, totalPausedMs, pauseStartedAt, timeoutHandle, awaitingResultActivation, resultPhaseStarted, history[], frozenTimers }`.
- Phase timeout scheduling via `setTimeout`.

#### 3.5.2 Internal Maps / Sets / in-memory registries

| Field | Type | Purpose |
|-------|------|---------|
| `this._clocks` | `Map` | `gameId` → clock record object |
| `this._infrastructureHandlers` | `Array` | `SERVER_SHUTDOWN` subscription record |
| `this._initialized` | `boolean` | Set `true` in `initialize()`, `false` in `shutdown()` |

Each clock record:

| Field | Initial value | Purpose |
|-------|---------------|---------|
| `gameId` | provided | Game identifier |
| `currentPhase` | `null` | Current clock phase (from `CLOCK_PHASE_SEQUENCE`) |
| `startedAt` | `null` | Clock start timestamp |
| `pausedAt` | `null` | Pause timestamp |
| `elapsed` | `0` | Elapsed time (ms) |
| `running` | `false` | Whether clock is running |
| `paused` | `false` | Whether clock is paused |
| `phaseStartedAt` | `null` | Current phase start timestamp |
| `phaseEndsAt` | `null` | Current phase end timestamp |
| `phaseRemainingMs` | `null` | Remaining time in current phase |
| `totalPausedMs` | `0` | Total paused time |
| `pauseStartedAt` | `null` | Current pause start timestamp |
| `timeoutHandle` | `null` | `setTimeout` handle for phase timeout |
| `awaitingResultActivation` | `false` | P5.9 — BRAKE→RESULT gated by `ResultActivation` |
| `resultPhaseStarted` | `false` | Whether RESULT phase has started |
| `history` | `[]` | Phase history entries |
| `frozenTimers` | `Object.freeze(...)` | R17.9G.1 — snapshot of catalog timers at clock creation |

`CLOCK_PHASE_SEQUENCE` (from `ClockPhases.js`): `PRE_GAME_READY`, `READY`, `SELF_TEST`, `SPEED`, `BRAKE`, `RESULT`.

#### 3.5.3 Important identifiers

- `gameId` — key for `_clocks`. Provided externally; not generated by `GameClockEngine`.

#### 3.5.4 Existing methods that create runtime state

- `createClock(gameId)` — creates a clock record with `currentPhase: null`, `running: false`, `paused: false`, `frozenTimers: this._snapshotCatalogTimers()`. Stores in `this._clocks`. Rejects if clock already exists for `gameId`.
- `startClock(gameId)` — sets `running: true`, `currentPhase: CLOCK_PHASE_SEQUENCE[0]` (`PRE_GAME_READY`), `startedAt: now`, schedules phase timeout. Emits `CLOCK_STARTED` and phase started events.

#### 3.5.5 Existing methods that destroy runtime state

- `removeClock(gameId)` — stops clock if running, clears phase timeout, deletes from `this._clocks`. Returns `boolean`.
- `shutdown()` — iterates `[...this._clocks.keys()]`, calls `removeClock(gameId)` for each; unsubscribes infrastructure handlers; sets `_initialized = false`.
- `_handleServerShutdown()` — iterates `[...this._clocks.keys()]`, calls `removeClock(gameId)` for each.

#### 3.5.6 Existing methods that initialize runtime state

- `initialize()` — subscribes to `SERVER_SHUTDOWN` → `_handleServerShutdown()`. Sets `_initialized = true`. Does NOT create any clock.

#### 3.5.7 Existing restore / hydrate / attach / rebind / reconstruction methods

- `restorePhaseSchedule(gameId, { phase, phaseStartedAt, phaseEndsAt })` (line 499) — **EXISTS** but is a **partial** restore method only. It:
  - Requires an **existing** clock record (`this._getClockOrLog` returns null if not found).
  - Requires the clock to be **running** and **not paused**.
  - Requires valid `phase`, `phaseStartedAt`, `phaseEndsAt` parameters.
  - Clears the existing phase timeout.
  - Sets `currentPhase`, `phaseStartedAt`, `phaseEndsAt`, `phaseRemainingMs` (computed as `Math.max(0, phaseEndsAt - Date.now())`).
  - Schedules a new phase timeout.
  - Returns a snapshot.
  - **Limitation:** This method restores the phase schedule within a **LIVE** clock. It does NOT create a clock, does NOT restore `startedAt`, `elapsed`, `totalPausedMs`, `history`, `frozenTimers`, `awaitingResultActivation`, or `resultPhaseStarted`. It is designed for client reconnect (restoring phase schedule after a transient disconnect while the server is running), NOT for server restart recovery (restoring from disk).
- Clock restore / hydrate / attach / rebind / reconstruct (full) — **NOT IMPLEMENTED**. There is no method to create a clock from a persisted representation or to attach a pre-built clock record.

#### 3.5.8 SERVER_SHUTDOWN behavior

- `initialize()` subscribes to `EVENT_TYPES.SERVER_SHUTDOWN` → `_handleServerShutdown()`.
- `_handleServerShutdown()` iterates `[...this._clocks.keys()]` and calls `removeClock(gameId)` for each, which stops running clocks, clears phase timeouts, and deletes clock records.

#### 3.5.9 Whether any state is persisted before shutdown

- No. `GameClockEngine` performs no disk writes, no persistence calls, and no serialization of clock records before or during shutdown. All state is discarded, including `timeoutHandle` (cleared via `clearTimeout` in `removeClock`).

#### 3.5.10 Whether any state can currently be reconstructed after server restart

- No. There is no persistence layer for clocks. After a server restart, `this._clocks` is an empty `Map`. `createClock` creates a new clock with `null` phase and `running: false`. `restorePhaseSchedule` requires an existing live clock and cannot create one. No method exists to restore a clock from a persisted representation.

#### 3.5.11 Dependencies on other runtime modules that would matter for future reconstruction

- `EventBus` — `subscribe`, `unsubscribe`, `emit`.
- `gameCatalog` — `getTimers()` (used in `_snapshotCatalogTimers` at clock creation and in `_getPhaseDuration` as fallback if `frozenTimers` is absent).
- `TIMER_PHASES` (`../catalog/Timers.js`) — phase constants.
- `CLOCK_PHASE_SEQUENCE`, `getNextClockPhase` (`./gameClock/ClockPhases.js`).
- `getPhaseCompletedEventType`, `getPhaseStartedEventType` (`../gameplay/GameplayPhaseSequence.js`).
- No direct dependency on `ConfigurationEngine`, `GameStateEngine`, `PhysicsEngine`, `InputAuthority`, or `WinnerEngine` inside `GameClockEngine.js`. However, `GameManager._handleSetupSessionCompleted` calls `gameClockEngine.createClock(gameId)`, `GameManager._activateGameplaySession` calls `gameClockEngine.startClock(gameId)`, and `RecoveryEngine.buildRecoverySnapshot` reads clock state via `gameClock.getPhaseSchedule(gameId)`.

#### 3.5.12 GameClockEngine-specific questions

- **How clocks/timers are stored:** `this._clocks` `Map`, `gameId` → clock record object (see 3.5.2 for full field list).
- **What information is retained for each gameId:** `currentPhase`, `startedAt`, `pausedAt`, `elapsed`, `running`, `paused`, `phaseStartedAt`, `phaseEndsAt`, `phaseRemainingMs`, `totalPausedMs`, `pauseStartedAt`, `timeoutHandle`, `awaitingResultActivation`, `resultPhaseStarted`, `history[]`, `frozenTimers`.
- **Whether elapsed/remaining time survives restart:** No. All in-memory. `_handleServerShutdown` removes all clocks. `timeoutHandle` (the `setTimeout` reference) is cleared via `clearTimeout` in `removeClock`.
- **Whether an existing clock can be reconstructed:** Partially. `restorePhaseSchedule(gameId, { phase, phaseStartedAt, phaseEndsAt })` can restore the phase schedule (`currentPhase`, `phaseStartedAt`, `phaseEndsAt`, `phaseRemainingMs`) within a **LIVE** clock. It does NOT restore `startedAt`, `elapsed`, `totalPausedMs`, `history`, `frozenTimers`, `awaitingResultActivation`, or `resultPhaseStarted`. It requires the clock to already exist and be running. It cannot create a clock from scratch.
- **Whether a clock can be created for an existing gameId:** `createClock(gameId)` creates a new clock for a `gameId`, but rejects if a clock already exists. The `gameId` must be provided externally. The clock starts with `currentPhase: null`, `running: false`. `startClock(gameId)` must be called separately to start the clock and set the initial phase.

#### 3.5.13 Recovery capability classification

**PARTIALLY_RECONSTRUCTABLE**

`GameClockEngine` is the only engine among the six with any restore-like method: `restorePhaseSchedule(gameId, { phase, phaseStartedAt, phaseEndsAt })`. This method can restore the phase schedule within a LIVE clock (client reconnect scenario). However, it cannot create a clock from disk, cannot restore full clock state (`startedAt`, `elapsed`, `totalPausedMs`, `history`, `frozenTimers`), and requires an existing running clock. No persistence exists. After a server restart, no clock can be reconstructed. The partial capability is limited to live-clock phase restoration.

---

### 3.6 InputAuthority — `server/input/InputAuthority.js` (806 lines)

#### 3.6.1 Runtime state owned

- Per-game input registries: `{ gameId, players: Map, commandQueue: [], acceptedCommands: [], sequenceNumber: 0 }`.
- Per-player input states: `{ playerId, pressCount, buttonPressed, lastPressTime, lastReleaseAt, cooldownUntil, locked }`.
- Speed-input-closed flag set (P5.6B).

#### 3.6.2 Internal Maps / Sets / in-memory registries

| Field | Type | Purpose |
|-------|------|---------|
| `this._registries` | `Map` | `gameId` → registry object |
| `this._speedInputClosed` | `Set` | `gameId`s where SPEED input is closed (P5.6B) |
| `this._infrastructureHandlers` | `Array` | `SERVER_SHUTDOWN` subscription record |
| `this._initialized` | `boolean` | Set `true` in `initialize()`, `false` in `shutdown()` |

Each registry:

| Sub-field | Type | Purpose |
|-----------|------|---------|
| `gameId` | `string` | Game identifier |
| `players` | `Map` | `playerId` → input state object |
| `commandQueue` | `Array` | Pending commands for `SimulationLoop` processing |
| `acceptedCommands` | `Array` | All accepted commands (history) |
| `sequenceNumber` | `number` | Monotonic command sequence counter |

Each player input state (from `createDefaultPlayerInputState`):

| Field | Initial value | Purpose |
|-------|---------------|---------|
| `playerId` | provided | Player identifier |
| `pressCount` | `0` | Completed press cycles |
| `buttonPressed` | `false` | Whether button is currently pressed |
| `lastPressTime` | `null` | Last press timestamp |
| `lastReleaseAt` | `null` | Last release timestamp |
| `cooldownUntil` | `0` | Cooldown end timestamp |
| `locked` | `false` | Whether input is locked (max press cycles reached) |

#### 3.6.3 Important identifiers

- `gameId` — key for `_registries`. Provided externally; not generated by `InputAuthority`.
- `playerId` — key within `registry.players`. Provided externally; not generated by `InputAuthority`.

#### 3.6.4 Existing methods that create runtime state

- `registerPlayer(gameId, playerId)` — creates a default input state (`createDefaultPlayerInputState`) and stores in `registry.players`. Creates registry via `_getOrCreateRegistry` if not exists. Rejects if player already registered.
- `registerPlayers(gameId, playerIds)` — iterates `playerIds`, calls `setPlayerState(PLAYING)` on `playerManager`, then `registerPlayer`. Returns array of registered IDs.
- `_getOrCreateRegistry(gameId)` — creates a registry `{ gameId, players: new Map(), commandQueue: [], acceptedCommands: [], sequenceNumber: 0 }` if not exists.

#### 3.6.5 Existing methods that destroy runtime state

- `removePlayer(gameId, playerId)` — deletes from `registry.players`. Returns `boolean`.
- `removeGame(gameId)` — calls `_removeGameRegistry(gameId)` and deletes from `_speedInputClosed`. Returns `boolean`.
- `_removeGameRegistry(gameId)` — deletes from `this._registries`.
- `shutdown()` — iterates `[...this._registries.keys()]`, calls `_removeGameRegistry(gameId)` for each; clears `_speedInputClosed`; unsubscribes infrastructure handlers; sets `_initialized = false`.
- `_handleServerShutdown()` — calls `this._registries.clear()` and `this._speedInputClosed.clear()` directly (does NOT iterate and call `removeGame`).

#### 3.6.6 Existing methods that initialize runtime state

- `initialize()` — subscribes to `SERVER_SHUTDOWN` → `_handleServerShutdown()`. Sets `_initialized = true`. Does NOT create any registry.

#### 3.6.7 Existing restore / hydrate / attach / rebind / reconstruction methods

- Input registry restore / hydrate / attach / rebind / reconstruct — **NOT IMPLEMENTED**.
- `resetPlayer(gameId, playerId)` resets a player's input state to defaults (`createDefaultPlayerInputState`) — not a recovery method.
- Verification search confirmed zero matches for `restore|hydrate|attach|rebind|reconstruct|recover|persist|save|load|fromRecord|fromSnapshot|toRecord|serialize|deserialize` (the only search hits were false positives from the substring "load" in "payload").

#### 3.6.8 SERVER_SHUTDOWN behavior

- `initialize()` subscribes to `EVENT_TYPES.SERVER_SHUTDOWN` → `_handleServerShutdown()`.
- `_handleServerShutdown()` calls `this._registries.clear()` and `this._speedInputClosed.clear()` directly. This is a simpler approach than other engines that iterate and call remove methods. All registries, player input states, command queues, and accepted commands are discarded.

#### 3.6.9 Whether any state is persisted before shutdown

- No. `InputAuthority` performs no disk writes, no persistence calls, and no serialization of registries, player input states, command queues, or accepted commands before or during shutdown. All state is discarded.

#### 3.6.10 Whether any state can currently be reconstructed after server restart

- No. There is no persistence layer for input registries. After a server restart, `this._registries` is an empty `Map` and `this._speedInputClosed` is an empty `Set`. `registerPlayer` creates a default input state (all values zeroed/default). No method exists to restore a previous input state (e.g., `pressCount`, `lastPressTime`, `locked`).

#### 3.6.11 Dependencies on other runtime modules that would matter for future reconstruction

- `EventBus` — `subscribe`, `unsubscribe`, `emit`.
- `gameCatalog` — `getInputRules()` (for `pressCooldownMs`, `maxPressCycles`, `accelerationRadPerSecSq`).
- `playerManager` — `setPlayerState(playerId, PLAYER_STATE.PLAYING)`, `hasPlayer(playerId)`, `getRuntime(playerId)`.
- `physicsEngine` — `applyAcceleration(gameId, value)` (called from `_applyCommandToPhysics` during `processCommandQueue`).
- `gameStateEngine` — `getState(gameId)` (called in `_handleButtonAction` to validate that current state is `SPEED`).
- `GAME_STATES` (`../engines/gameState/GameStates.js`) — used to validate `gameState === SPEED`.
- `INPUT_ACTIONS`, `INPUT_COMMAND_TYPES` (`./InputCommandTypes.js`).
- `PLAYER_STATE` (`../models/PlayerState.js`) — `PLAYER_STATE.PLAYING`.
- `randomUUID` (`node:crypto`) — for `commandId` generation.
- `GameManager._handleSetupSessionCompleted` calls `inputAuthority.registerPlayers(gameId, room.players)`. `SimulationLoop` calls `inputAuthority.processCommandQueue(gameId)`.

#### 3.6.12 InputAuthority-specific questions

- **How player registration is stored:** `this._registries` `Map`, `gameId` → registry `{ gameId, players: Map(playerId → input state), commandQueue: [], acceptedCommands: [], sequenceNumber: 0 }`.
- **How command queues are stored:** `registry.commandQueue` array (pending commands for `SimulationLoop` processing) and `registry.acceptedCommands` array (all accepted commands, history). Each command has `commandId`, `gameId`, `playerId`, `type`, `timestamp`, `sequenceNumber`.
- **Whether queued commands survive restart:** No. All in-memory. `_handleServerShutdown` clears `_registries` directly. All pending commands and accepted command history are lost.
- **Whether players can be registered again for an existing gameId:** Yes. `registerPlayer(gameId, playerId)` calls `_getOrCreateRegistry(gameId)` which creates a registry if it does not exist. However, it rejects if the player is already registered in the registry. After a server restart, all registries are empty, so players can be registered again. But the input state will be default (pressCount=0, buttonPressed=false, etc.), not restored from previous state.
- **Whether existing command/input state can be reconstructed:** No. No restore method exists. `registerPlayer` creates a default input state. `resetPlayer` resets to defaults. No method exists to restore `pressCount`, `lastPressTime`, `lastReleaseAt`, `cooldownUntil`, `locked`, `commandQueue`, or `acceptedCommands` from a persisted representation.

#### 3.6.13 Recovery capability classification

**NOT_RECONSTRUCTABLE**

No persistence, no restore/attach method, `registerPlayer` always creates default input state, and `_handleServerShutdown` clears all registries directly.

---

### 3.7 WinnerEngine — `server/engines/WinnerEngine.js` (423 lines)

#### 3.7.1 Runtime state owned

- Winner result objects (frozen via `deepFreezeResult`).
- Winner resolution from configuration + physics state.

#### 3.7.2 Internal Maps / Sets / in-memory registries

| Field | Type | Purpose |
|-------|------|---------|
| `this._results` | `Map` | `gameId` → frozen result object |
| `this._infrastructureHandlers` | `Array` | `SERVER_SHUTDOWN` subscription record |
| `this._initialized` | `boolean` | Set `true` in `initialize()`, `false` in `shutdown()` |

Each result object (frozen):

| Field | Purpose |
|-------|---------|
| `gameId` | Game identifier |
| `winningSector` | Winning sector object |
| `winningPlayer` | Winning player object |
| `winnerPlayerId` | Winner's player ID |
| `winnerSectorIndex` | Winning sector index |
| `prize` | Prize (initially `null`) |
| `payout` | Payout (initially `null`) |
| `finalAngle` | Final wheel angle (radians) |
| `wheelFinalAngle` | Same as `finalAngle` |
| `triangleFinalAngle` | Final triangle angle (radians) |
| `resolvedAt` | Resolution timestamp |
| `traceSeed` | Configuration trace seed |
| `metadata` | `{ configurationVersion }` |

#### 3.7.3 Important identifiers

- `gameId` — key for `_results`. Provided externally; not generated by `WinnerEngine`.

#### 3.7.4 Existing methods that create runtime state

- `resolveResult(gameId)` — idempotent (returns stored result if already exists). Reads configuration from `configurationEngine.getConfiguration(gameId)` and physics from `physicsEngine.getSimulation(gameId)`. Requires `physics.runtime.state === PHYSICS_SIMULATION_STATE.STOPPED`. Resolves winning sector via `SectorResolver`, winning player via `PlayerResolver`. Validates result. Freezes via `deepFreezeResult`. Stores in `this._results`. Emits `WINNING_SECTOR_RESOLVED` and `GAME_RESULT_READY`.
- `resolveWinningSector(gameId)` — resolves winning sector only (does not store result). Reads configuration and physics.
- `resolveWinningPlayer(gameId, winningSector)` — resolves winning player from configuration and winning sector (does not store result).

#### 3.7.5 Existing methods that destroy runtime state

- `removeResult(gameId)` — deletes from `this._results`. Emits `GAME_RESULT_REMOVED`. Returns `boolean`.
- `shutdown()` — iterates `[...this._results.keys()]`, calls `removeResult(gameId)` for each; unsubscribes infrastructure handlers; sets `_initialized = false`.
- `_handleServerShutdown()` — calls `this._results.clear()` directly (does NOT iterate and call `removeResult`).

#### 3.7.6 Existing methods that initialize runtime state

- `initialize()` — subscribes to `SERVER_SHUTDOWN` → `_handleServerShutdown()`. Sets `_initialized = true`. Does NOT create any result.

#### 3.7.7 Existing restore / hydrate / attach / rebind / reconstruction methods

- Winner result restore / hydrate / attach / rebind / reconstruct — **NOT IMPLEMENTED**.
- `resolveResult` is idempotent and deterministic (computes from configuration + physics), but it requires LIVE engine state (`configurationEngine.getConfiguration` and `physicsEngine.getSimulation` with `STOPPED` state). It is not a restore/attach method; it is a compute-and-store method.
- Verification search confirmed zero matches for `restore|hydrate|attach|rebind|reconstruct|recover|persist|save|load|fromRecord|fromSnapshot|toRecord|serialize|deserialize` (the only search hits were false positives from the substring "load" in "payload").

#### 3.7.8 SERVER_SHUTDOWN behavior

- `initialize()` subscribes to `EVENT_TYPES.SERVER_SHUTDOWN` → `_handleServerShutdown()`.
- `_handleServerShutdown()` calls `this._results.clear()` directly. All winner results are discarded.

#### 3.7.9 Whether any state is persisted before shutdown

- No. `WinnerEngine` performs no disk writes, no persistence calls, and no serialization of result objects before or during shutdown. All state is discarded.

#### 3.7.10 Whether any state can currently be reconstructed after server restart

- No. There is no persistence layer for winner results. After a server restart, `this._results` is an empty `Map`. `resolveResult` requires LIVE configuration and physics state (with `STOPPED` simulation), which are also lost on restart. No method exists to attach a pre-computed result.
- However, `resolveResult` is **deterministic**: given the same configuration and physics state (final angles), it will produce the same result. If `ConfigurationEngine` and `PhysicsEngine` states were reconstructed, the winner could be recomputed. But currently, neither configuration nor physics can be reconstructed, and there is no method to attach a pre-computed result.

#### 3.7.11 Dependencies on other runtime modules that would matter for future reconstruction

- `EventBus` — `subscribe`, `unsubscribe`, `emit`.
- `physicsEngine` — `getSimulation(gameId)` (requires `physics.runtime.state === STOPPED`, reads `physics.runtime.angle` and `physics.runtime.triangleAngle`).
- `configurationEngine` — `getConfiguration(gameId)` (reads `configuration.players`, `configuration.sectors`, `configuration.traceSeed`, `configuration.configurationVersion`).
- `gameCatalog` — `getWinnerRules()` (for `angleToleranceRadians` used in `GeometryAdapter`).
- `GeometryAdapter` (`./winner/GeometryAdapter.js`) — sector resolution from angle.
- `PlayerResolver` (`./winner/PlayerResolver.js`) — player resolution from sector.
- `SectorResolver` (`./winner/SectorResolver.js`) — sector resolution.
- `deepFreezeResult` (`./winner/resultFreeze.js`).
- `WinnerResolutionError` (`./winner/WinnerResolutionError.js`).
- `PHYSICS_SIMULATION_STATE` (`./physics/PhysicsSimulationState.js`) — `STOPPED` validation.
- `WinnerActivation` calls `resolveResult(gameId)`. `RecoveryEngine.buildRecoverySnapshot` reads winner state via `winnerEngine.getResult(gameId)`.

#### 3.7.12 WinnerEngine-specific questions

- **How winner state is stored:** `this._results` `Map`, `gameId` → frozen result object (see 3.7.2 for full field list).
- **Whether winner determination is persisted:** No. No disk writes, no serialization. All in-memory.
- **Whether an existing winner result can be restored:** No. No restore/attach method exists. `resolveResult` computes from live configuration + physics and is idempotent (returns stored result if exists), but it requires live engine state and is not a restore method.
- **Whether winner state is reconstructable from existing authoritative data:** Partially in principle, but NOT in practice. `resolveResult` is deterministic and computes from `configurationEngine.getConfiguration(gameId)` and `physicsEngine.getSimulation(gameId)` (with `STOPPED` state). If configuration and physics were reconstructed to their exact pre-shutdown state (same final angles, same configuration), the winner could be recomputed. However: (a) neither `ConfigurationEngine` nor `PhysicsEngine` can currently be reconstructed; (b) there is no method to attach a pre-computed result; (c) the result includes `resolvedAt` (timestamp) which would differ on recompute. The deterministic recomputability is a property of the algorithm, not a recovery capability of the engine.
- **What happens to winner state during SERVER_SHUTDOWN:** `_handleServerShutdown()` calls `this._results.clear()`. All winner results are permanently lost.

#### 3.7.13 Recovery capability classification

**NOT_RECONSTRUCTABLE**

No persistence, no restore/attach method, `resolveResult` requires live configuration + physics state (which are also lost on restart). While the resolution algorithm is deterministic, there is no method to attach a pre-computed result, and the dependencies (`ConfigurationEngine`, `PhysicsEngine`) are themselves not reconstructable.

---

## 4. Lifecycle Flow

### 4.1 Normal creation lifecycle (per engine)

```text
ConfigurationEngine:
  GameManager._tryGenerateConfiguration(roomId)
    → configurationEngine.buildConfiguration(gameId, room, players)
      → randomService.generateTraceSeed() → traceSeed
      → randomService.nextInt(0, 359) → wheel.startAngle, triangle.startAngle
      → generateWheelLayout({ players, randomService }) → sectors
    → configurationEngine.validateConfiguration(configuration)
    → configurationEngine.freezeConfiguration(configuration) → deepFreezeConfiguration
    → configurationEngine.commitConfiguration(configuration) → _configurations.set(gameId, frozen)
    → emit CONFIGURATION_READY
  GAME_INITIALIZED event
    → _handleGameInitialized → freezeEconomy(gameId) → _economies.set(gameId, frozen)

GameStateEngine:
  GameManager._activateGameplaySession(roomId, gameId)
    → gameStateEngine.initializeGameState(gameId)
      → _states.set(gameId, { currentState: PRE_GAME_READY, previousState: null, enteredAt, history: [...] })
      → emit GAME_STATE_CHANGED
  Phase controllers call transition(gameId, nextState, context)
    → PRE_GAME_READY → READY → SELF_TEST → SPEED → BRAKE → RESULT (linear, forward-only)

PhysicsEngine:
  GameManager._handleSetupSessionCompleted
    → physicsEngine.createSimulation(gameId)
      → _simulations.set(gameId, { gameId, parameters: DEFAULT_PHYSICS_PARAMETERS, runtime: { angle: 0, ... state: CREATED }, commandLog: [] })
  Phase controllers call startSimulation / beginSelfTest / endSelfTest / beginSpeed / setSpeedHoldCount / endSpeed / beginBrake / completeBrake / stopSimulation
  SimulationLoop calls updateSimulation(gameId, deltaTime) → _integrateStep

GameClockEngine:
  GameManager._handleSetupSessionCompleted
    → gameClockEngine.createClock(gameId)
      → _clocks.set(gameId, { currentPhase: null, running: false, frozenTimers: snapshot, ... })
  GameManager._activateGameplaySession
    → gameClockEngine.startClock(gameId)
      → currentPhase = CLOCK_PHASE_SEQUENCE[0] (PRE_GAME_READY)
      → _schedulePhaseTimeout(record) → setTimeout(...)
  Phase timeouts advance: PRE_GAME_READY → READY → SELF_TEST → SPEED → BRAKE → (awaitingResultActivation) → RESULT

InputAuthority:
  GameManager._handleSetupSessionCompleted
    → inputAuthority.registerPlayers(gameId, room.players)
      → _getOrCreateRegistry(gameId) → { players: Map, commandQueue: [], acceptedCommands: [], sequenceNumber: 0 }
      → registerPlayer(gameId, playerId) → createDefaultPlayerInputState(playerId) → { pressCount: 0, buttonPressed: false, ... }
  Player socket events call handleButtonPress / handleButtonRelease
    → _handleButtonAction → _validateInput (requires gameState === SPEED) → _enqueueCommand
  SimulationLoop calls processCommandQueue(gameId) → _applyCommandToPhysics → physicsEngine.applyAcceleration

WinnerEngine:
  WinnerActivation calls resolveResult(gameId)
    → _readResolutionInputs(gameId) → configurationEngine.getConfiguration + physicsEngine.getSimulation (requires STOPPED)
    → SectorResolver.resolve({ configuration, finalWheelAngleRadians, triangleAngleDegrees }) → winningSector
    → PlayerResolver.resolve({ configuration, winningSector }) → winningPlayer
    → _validateResult(result, configuration)
    → deepFreezeResult(result) → _results.set(gameId, frozenResult)
    → emit WINNING_SECTOR_RESOLVED, GAME_RESULT_READY
```

### 4.2 SERVER_SHUTDOWN lifecycle (all six engines)

```text
SERVER_SHUTDOWN event emitted by app.js
         |
         v
ConfigurationEngine._handleServerShutdown()
  → for each gameId: removeConfiguration(gameId) → _configurations.delete + _economies.delete
GameStateEngine._handleServerShutdown()
  → for each gameId: removeState(gameId) → _states.delete
PhysicsEngine._handleServerShutdown()
  → for each gameId: removeSimulation(gameId) → stopSimulation if active → _simulations.delete
GameClockEngine._handleServerShutdown()
  → for each gameId: removeClock(gameId) → stopClock if running → clearTimeout → _clocks.delete
InputAuthority._handleServerShutdown()
  → _registries.clear() + _speedInputClosed.clear()
WinnerEngine._handleServerShutdown()
  → _results.clear()
         |
         v
ALL in-memory state discarded. No persistence. No serialization.
```

### 4.3 Reconstruction lifecycle

```text
SERVER RESTART
         |
         v
initialize() on each engine
  → subscribes to SERVER_SHUTDOWN only
  → NO state restored
  → _configurations / _states / _simulations / _clocks / _registries / _results = empty Map
         |
         v
[NO RECONSTRUCTION PATH EXISTS]
  ConfigurationEngine.restoreConfiguration()  → NOT IMPLEMENTED
  GameStateEngine.restoreState()             → NOT IMPLEMENTED
  PhysicsEngine.attachSimulation()           → NOT IMPLEMENTED
  GameClockEngine.restoreClock()             → NOT IMPLEMENTED (restorePhaseSchedule requires existing live clock)
  InputAuthority.restoreRegistry()           → NOT IMPLEMENTED
  WinnerEngine.attachResult()                → NOT IMPLEMENTED
```

## 5. Ownership Boundaries

- `ConfigurationEngine` owns: immutable game configuration objects, frozen payment economy objects. Does not own game lifecycle, physics, or winner state.
- `GameStateEngine` owns: game state records (currentState, previousState, enteredAt, history). Does not own game lifecycle status (owned by `GameManager`), clock phases (owned by `GameClockEngine`), or physics state.
- `PhysicsEngine` owns: physics simulation objects (angle, velocity, acceleration, simulation state, command log). Does not own game state or clock phases.
- `GameClockEngine` owns: clock records (phase, timing, pause/resume, timeout handles, frozen timers). Does not own game state (owned by `GameStateEngine`) or physics state.
- `InputAuthority` owns: per-game input registries, per-player input states, command queues, accepted commands, speed-input-closed flags. Does not own player identity (owned by `PlayerManager`) or physics state.
- `WinnerEngine` owns: winner result objects (winning sector, winning player, final angles, resolvedAt). Does not own configuration or physics state; reads them as inputs to `resolveResult`.
- None of the six engines own persistence. Financial persistence is owned by `TonFinancialPersistence` (out of scope).
- None of the six engines own recovery orchestration. Financial recovery is owned by `TonFinancialRecovery` (out of scope). Gameplay runtime recovery (`RecoveryEngine`) is out of scope per task constraints.
- This report did not alter any ownership boundaries.

## 6. Risks

### Critical

- **No persistence in any of the six engines:** `ConfigurationEngine`, `GameStateEngine`, `PhysicsEngine`, `GameClockEngine`, `InputAuthority`, and `WinnerEngine` perform zero disk writes and hold all state in in-memory `Map`/`Set`. On server restart, all configurations, economies, game states, physics simulations, clocks, input registries, command queues, and winner results are permanently lost. This is the core gap documented in `WHEELWIN_MASTER_CONTEXT.md` section 8 and `DEVELOPMENT_HISTORY.md` R17.9T.6.
- **No reconstruction methods in five of six engines:** `ConfigurationEngine`, `GameStateEngine`, `PhysicsEngine`, `InputAuthority`, and `WinnerEngine` have no restore/hydrate/attach/reconstruct methods. There is no code path to reconstruct engine state from restored financial records (which reference `gameId` values).
- **`GameClockEngine.restorePhaseSchedule` is live-clock-only:** The only restore-like method among the six engines (`restorePhaseSchedule`) requires an existing running clock and only restores the phase schedule. It cannot create a clock from disk or restore full clock state. After a server restart, it is unusable because no clocks exist.
- **Coupled bootstrap dependency:** `GameManager._handleSetupSessionCompleted` bootstraps `ConfigurationEngine`, `GameStateEngine`, `PhysicsEngine`, `GameClockEngine`, and `InputAuthority` as a coupled set for a given `gameId`. Reconstruction of any one engine's state for a `gameId` would require all five to be reconstructed, because they are interdependent (e.g., `InputAuthority._validateInput` requires `gameStateEngine.getState(gameId) === SPEED`; `WinnerEngine._readResolutionInputs` requires `configurationEngine.getConfiguration` and `physicsEngine.getSimulation` with `STOPPED` state).

### High

- **`createSimulation` always starts with zeroed runtime:** `PhysicsEngine.createSimulation` creates with `angle: 0`, `angularVelocity: 0`, `state: CREATED`. Any future reconstruction that needs to preserve the final wheel angle (for winner recomputation) cannot use `createSimulation` as-is. `setPoseDegrees` can seed an angle on an existing simulation but does not restore velocity, state, or command log.
- **`initializeGameState` always starts with `PRE_GAME_READY`:** `GameStateEngine.initializeGameState` creates with `PRE_GAME_READY` and rejects if state already exists. The transition table is forward-only (`PRE_GAME_READY → READY → SELF_TEST → SPEED → BRAKE → RESULT`). There is no method to set an arbitrary state directly. Any future reconstruction that needs to restore a mid-game state (e.g., `SPEED` or `BRAKE`) cannot use `initializeGameState` or `transition` as-is.
- **`createClock` always starts with `null` phase and `running: false`:** `GameClockEngine.createClock` creates with `currentPhase: null`, `running: false`. `startClock` sets the initial phase to `PRE_GAME_READY`. Any future reconstruction that needs to restore a mid-game phase (e.g., `SPEED` or `BRAKE`) cannot use `createClock` + `startClock` as-is. `restorePhaseSchedule` can set a specific phase but requires an existing running clock.
- **`resolveResult` requires `STOPPED` physics state:** `WinnerEngine.resolveResult` requires `physics.runtime.state === PHYSICS_SIMULATION_STATE.STOPPED`. Any future reconstruction that wants to recompute the winner must first reconstruct the physics simulation to `STOPPED` state with the correct final angles.
- **`_handleServerShutdown` uses `clear()` directly in two engines:** `InputAuthority._handleServerShutdown` calls `this._registries.clear()` and `WinnerEngine._handleServerShutdown` calls `this._results.clear()`. Unlike other engines that iterate and call remove methods (which emit removal events), these two engines clear silently with no removal events emitted. This is not a recovery risk per se, but it means no `GAME_RESULT_REMOVED` or input removal events are emitted during shutdown.

### Medium

- **`setPoseDegrees` comment mentions "recovery" but is not a recovery method:** The JSDoc comment on `PhysicsEngine.setPoseDegrees` (line 263) says "Seed authoritative wheel/triangle pose in degrees (READY / recovery). Does not start motion." This could mislead future developers into thinking physics recovery exists. The method only sets `angle` and `triangleAngle` on an existing simulation; it does not create a simulation, restore velocity/acceleration/state, or restore from disk.
- **`frozenTimers` is a snapshot of catalog timers at clock creation:** `GameClockEngine._snapshotCatalogTimers` freezes the catalog timers at clock creation time (R17.9G.1). Any future reconstruction would need to reproduce the same `frozenTimers` snapshot, which depends on the catalog state at the time of the original clock creation.
- **`timeoutHandle` is a `setTimeout` reference:** `GameClockEngine` stores `timeoutHandle` (a `setTimeout` return value) in each clock record. This is inherently non-serializable and non-restorable. On shutdown, `clearTimeout` is called. On restart, a new `setTimeout` would need to be scheduled based on `phaseRemainingMs`.

### Low

- **`commandLog` is retained in-memory but not persisted:** `PhysicsEngine` retains a `commandLog` array of all motion commands (`self_test_begin`, `speed_begin`, `brake_begin`, etc.) for each simulation. This could be useful for deterministic replay but is not persisted and is lost on restart.
- **`acceptedCommands` is retained in-memory but not persisted:** `InputAuthority` retains an `acceptedCommands` array of all accepted commands for each game. This could be useful for deterministic replay but is not persisted and is lost on restart.
- **`history` arrays are retained in-memory but not persisted:** Both `GameStateEngine` (state history) and `GameClockEngine` (phase history) retain `history` arrays. These could be useful for audit/replay but are not persisted and are lost on restart.

## 7. Recommendations

This section is included to satisfy the `.clinerules` report format. Per task constraints, this report makes **no implementation recommendations** and designs **no new APIs**. The following are factual observations only, not implementation proposals:

- Five of the six engines (`ConfigurationEngine`, `GameStateEngine`, `PhysicsEngine`, `InputAuthority`, `WinnerEngine`) are factually incapable of reconstruction today: no persistence, no restore/attach methods, and create methods always generate default/initial state.
- `GameClockEngine` is the only engine with a partial restore method (`restorePhaseSchedule`), but it requires an existing live clock and only restores the phase schedule, not full clock state.
- Any future reconstruction work (R17.9T.6) would need to address: (a) the coupled-bootstrap gap (`GameManager` bootstraps all five gameplay engines per game); (b) the ID-preservation gap (all engines use externally provided `gameId` but have no attach method); (c) the state-initialization gap (all create methods start with default/initial state, not mid-game state); (d) the `setTimeout` handle gap (`GameClockEngine` timeout handles are non-serializable).
- `WinnerEngine.resolveResult` is deterministic and idempotent, meaning if `ConfigurationEngine` and `PhysicsEngine` were reconstructed to their exact pre-shutdown state, the winner could be recomputed without a dedicated restore method. This is a property of the algorithm, not a current recovery capability.
- These observations are inventory only; no changes are recommended or designed in this report.

## 8. Changes Made

No files modified. No source code, configuration, or test files were changed. This report is the only artifact created:

- `AI_CONTEXT/CLINE_REPORTS/2026-08-22_recovery_runtime_engines_mapping.md`

## Limitations

- `server/engines/ConfigurationEngine.js` is 1037 lines. `read_file` returned a cached first-1000-line view and could not be re-invoked to display lines 1001–1037 (duplicate-read guard). The tail was enumerated via `search_files` for method definitions and `removeConfiguration`/`clear()` patterns, which confirmed `_handleServerShutdown()` calls `removeConfiguration(gameId)` for each configuration (the second `removeConfiguration` call outside its own definition). The recovery-relevant findings (no restore/attach method, no persistence, `commitConfiguration` stores in `_configurations`) are fully established from lines 1–1000 and the verification search.
- `server/engines/PhysicsEngine.js` is 1326 lines. `read_file` returned a cached first-1000-line view and could not be re-invoked to display lines 1001–1326 (duplicate-read guard). The tail was enumerated via `search_files` for method definitions and `removeSimulation`/`clear()` patterns, which confirmed `_handleServerShutdown()` calls `removeSimulation(gameId)` for each simulation (the second `removeSimulation` call outside its own definition). The recovery-relevant findings (no restore/attach method, no persistence, `createSimulation` always starts with zeroed runtime, `setPoseDegrees` only seeds an angle) are fully established from lines 1–1000 and the verification search.
- No application tests were run.
- Financial modules, `RecoveryEngine`, `RoomManager`, `GameManager`, `PlayerManager`, and client reconnect were explicitly out of scope per task constraints and were not analyzed in this report.