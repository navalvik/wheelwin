# Recovery Data Contract — R17.9T.6-B

Date: 2026-08-22

Task: READ-ONLY Recovery Data Contract Definition for WheelWin. Architecture/design task R17.9T.6-B. Define the minimum durable information required to safely reconstruct WheelWin gameplay runtime after SERVER_RESTART. This contract is derived from the completed recovery audits and architecture synthesis. No source code changes, no source file creation, no implementation, no persistence schema changes, no API creation, no refactoring, no application tests.

## Source Reports Synthesized

1. `AI_CONTEXT/CLINE_REPORTS/2026-08-22_recovery_runtime_managers_mapping.md` — factual inventory of `RoomManager`, `GameManager`, `PlayerManager`.
2. `AI_CONTEXT/CLINE_REPORTS/2026-08-22_recovery_runtime_engines_mapping.md` — factual inventory of `ConfigurationEngine`, `GameStateEngine`, `PhysicsEngine`, `GameClockEngine`, `InputAuthority`, `WinnerEngine`.
3. `AI_CONTEXT/CLINE_REPORTS/2026-08-22_financial_persistence_recovery_mapping.md` — factual inventory of `TonFinancialPersistence`, `TonFinancialRecovery`, financial record types and fields, cross-domain recovery boundary.
4. `AI_CONTEXT/CLINE_REPORTS/2026-08-22_recovery_architecture_synthesis.md` — architecture synthesis of the above three reports.
5. `AI_CONTEXT/CLINE_REPORTS/2026-08-22_snapshot_recovery_checkpoint_audit.md` — audit of `SNAPSHOT` and `RECOVERY_CHECKPOINT` persistence records.

---

## 1. Scope

This report defines the **Recovery Data Contract** — the minimum durable authoritative information required to safely reconstruct WheelWin gameplay runtime after `SERVER_RESTART`.

The contract is NOT an implementation. It is a precise architectural specification of:

- what information must exist;
- why it is required;
- what authoritative source it comes from;
- when it becomes immutable;
- what can be derived deterministically;
- what must never be guessed;
- what conditions make recovery impossible.

This report does NOT modify source code, create source files, implement recovery, modify persistence schemas, create APIs, refactor existing code, or run application tests.

---

## 2. Files Inspected

Project context (read before analysis, per `.clinerules`):

- `AI_CONTEXT/WHEELWIN_MASTER_CONTEXT.md`
- `AI_CONTEXT/ARCHITECTURE_RULES.md`
- `AI_CONTEXT/CURRENT_STATE.md`
- `AI_CONTEXT/AI_WORKING_RULES.md`

Prior reports reviewed (all five listed in Source Reports Synthesized above).

No source files were modified. No new source files were created. This report is the only artifact produced.

---

## 3. Architecture Findings

### 3.1 Current State Summary

The five source reports establish the following facts:

1. **Financial persistence is durable and implemented.** `TonFinancialPersistence` provides file-based JSON persistence with atomic writes, schema versioning, and immutable-on-create record types. `TonFinancialRecovery.recover()` runs a mandatory startup pipeline that restores financial in-memory structures.

2. **Gameplay runtime is entirely ephemeral.** All nine runtime components (`RoomManager`, `GameManager`, `PlayerManager`, `ConfigurationEngine`, `GameStateEngine`, `PhysicsEngine`, `GameClockEngine`, `InputAuthority`, `WinnerEngine`) store state exclusively in in-memory `Map`/`Set`/`Array` fields. None persist any state. All destroy state on `SERVER_SHUTDOWN`.

3. **No reconstruction methods exist.** `attachExistingRoom()`, `attachExistingGame()`, player identity restore, `ConfigurationEngine.restoreConfiguration()`, `GameStateEngine.restoreState()`, `PhysicsEngine.attachSimulation()`, `GameClockEngine.restoreClock()`, `InputAuthority.restoreRegistry()`, `WinnerEngine.attachResult()` — all NOT IMPLEMENTED.

4. **Financial records contain identity anchors but NOT gameplay state.** `GAME_CONTRACT`, `PAYMENT_SESSION`, and `SETTLEMENT` records contain `roomId`, `gameId`, `playerId`, `contractId`, `paymentSessionId`, `playerIndex`, wallet addresses, and financial state. They do NOT contain game configuration, game state phase, physics state, clock state, input state, or winner result.

5. **The `SNAPSHOT` record is a financial snapshot, not a gameplay snapshot.** It contains player wallets, required gram amounts, partial sector geometry (when available), and a `snapshotHash` for GameEscrow StateInit integrity. It does NOT contain `traceSeed`, start angles, physics state, game state, clock state, input state, or winner result.

6. **The `RECOVERY_CHECKPOINT` record is a blockchain monitor checkpoint, not a gameplay checkpoint.** It contains blockchain observation state only. It is not even created in production.

7. **`WinnerEngine.resolveResult` is deterministic and idempotent** — given the same configuration and physics final state (STOPPED with correct final angles), it produces the same result. But neither configuration nor physics state is persisted.

8. **`ConfigurationEngine.buildConfiguration` depends on `randomService` outputs** (`traceSeed`, `wheel.startAngle`, `triangle.startAngle`) that are stored only in the in-memory configuration object and are NOT persisted (except `traceSeed` in `SETTLEMENT` for completed games only).

### 3.2 Recovery Data Contract Design Principle

The contract follows the Hybrid Recovery Architecture principle established in the synthesis report:

> Persist a small durable authoritative Recovery Data Contract.
>
> Do NOT persist arbitrary runtime object graphs.
>
> Use deterministic reconstruction/replay only when the contract contains all authoritative inputs required to reproduce the exact state.
>
> Otherwise: FAIL CLOSED.

---

## 4. RECOVERY RECORD IDENTITY

### 4.1 Identity Block Definition

| Field | Required? | Authoritative source | Immutable? | Why recovery needs it |
|-------|-----------|---------------------|------------|----------------------|
| `recoveryRecordId` | REQUIRED | Recovery Data Contract persistence (CURRENTLY MISSING) | Immutable | Uniquely identifies the recovery record. Must be deterministic or content-addressed. Must NOT collide across games. |
| `roomId` | REQUIRED | `GAME_CONTRACT`, `PAYMENT_SESSION`, `SETTLEMENT` envelope + payload | Immutable | Identifies the room. Cross-references financial records. Must be preserved — `createRoom` generates new IDs. |
| `gameId` | REQUIRED | `GAME_CONTRACT`, `PAYMENT_SESSION`, `SETTLEMENT` envelope + payload | Immutable | Identifies the game. Cross-references financial records. Must be preserved — `createGame` generates new IDs. |
| `contractId` | REQUIRED | `GAME_CONTRACT` payload + envelope | Immutable | Links to the financial contract. `GameContractManager.restoreContracts()` already restores this. |
| `paymentSessionId` | REQUIRED | `PAYMENT_SESSION` payload + envelope | Immutable | Links to the payment session. `PaymentSessionManager.restorePaymentSessions()` already restores this. |
| `playerId` | REQUIRED (per player) | `PAYMENT_SESSION.participants[].playerId` | Immutable | Identifies each player. Cross-references financial records. Must be preserved — `createPlayer` can accept `playerId` but is not a recovery method. |
| `playerIndex` | REQUIRED (per player) | `PAYMENT_SESSION.participants[].playerIndex` | Immutable | Seat index for GameEscrow `paidMask` mapping. Determines player position in the game. NOT in `SNAPSHOT` record — must come from `PAYMENT_SESSION`. |
| `correlationId` | OPTIONAL | `GAME_CONTRACT`, `PAYMENT_SESSION` envelope | Immutable | Audit tracing. Not required for reconstruction. Useful for diagnostics. |

### 4.2 Identity Immutability

All identity fields become immutable at the moment the game contract is created (`PAYMENT_SESSION_COMPLETED` → `createContractRequest`). The `roomId`, `gameId`, `contractId`, and `paymentSessionId` are generated during the setup/payment flow and never change afterward. The `playerId` and `playerIndex` are established during payment session creation and are immutable.

### 4.3 ID-Preservation Gap

The source reports establish that `createRoom` always generates a new `roomId`, `createGame` always generates a new `gameId`, and `createPlayer` accepts `playerId` but is not a recovery method. The recovery contract MUST preserve original IDs. Replacement IDs are FORBIDDEN (see Section 16).

---

## 5. PLAYER RECOVERY DATA

### 5.1 Classification

#### A. Required for identity reconstruction

| Field | Authoritative source | Currently persisted? | Purpose |
|-------|---------------------|---------------------|---------|
| `playerId` | `PAYMENT_SESSION.participants[].playerId` | YES | Player identifier |
| `playerIndex` | `PAYMENT_SESSION.participants[].playerIndex` | YES | Seat index for GameEscrow paidMask |
| `wallet` | `PAYMENT_SESSION.participants[].wallet`, `SNAPSHOT.players[].wallet` | YES | Player wallet address for financial reconciliation |

#### B. Required for gameplay configuration reconstruction

| Field | Authoritative source | Currently persisted? | Purpose |
|-------|---------------------|---------------------|---------|
| `nickname` | `PlayerIdentity.nickname` | PARTIAL — in `SNAPSHOT.players[].nickname` | Player display name |
| `baseStake` | `PlayerIdentity.baseStake` | PARTIAL — in `SNAPSHOT.players[].baseStake` + `SNAPSHOT.baseStake` | Base stake for configuration |
| `sectorCount` | `PlayerIdentity.sectorCount` | PARTIAL — in `SNAPSHOT.players[].sectorCount` | Number of sectors (1 or 2) |
| `color` | `PlayerIdentity.color` | PARTIAL — in `SNAPSHOT.players[].colors[]` | Player color assignment |
| `colorSector2` | `PlayerIdentity.colorSector2` | NOT PRESENT as distinct field (may be second entry in `colors[]`) | Second color for 2-sector players |
| `icon` | `PlayerIdentity.icon` | PARTIAL — in `SNAPSHOT.players[].icon` | Player icon |
| `sectorArrangement` | `PlayerIdentity.sectorArrangement` | NOT PRESENT | Sector arrangement pattern |
| `age` | `PlayerIdentity.age` | NOT PRESENT | Player profile field. Not used in gameplay logic or configuration building, but part of `PlayerIdentity` model. |

**Critical gap:** `colorSector2` (as a distinct field), `sectorArrangement`, and `age` are NOT in any financial record. The `SNAPSHOT` record contains `colors[]` (an array) which may encode `colorSector2` as its second element when `sectorCount === 2`, but this is not guaranteed to be a faithful representation of the `PlayerIdentity.colorSector2` field.

#### C. Required only for financial reconciliation

| Field | Authoritative source | Currently persisted? | Purpose |
|-------|---------------------|---------------------|---------|
| `requiredGram` | `PAYMENT_SESSION.participants[].requiredGram`, `SNAPSHOT.players[].requiredGram` | YES | Required payment amount |
| `paymentStatus` | `PAYMENT_SESSION.participants[].status` | YES | Payment confirmation status |
| `paidAmount` | `PAYMENT_SESSION.participants[].paidAmount` | YES | Amount paid |
| `confirmationStatus` | `PAYMENT_SESSION.participants[].confirmationStatus` | YES | Blockchain confirmation status |
| `refunded` | `PAYMENT_SESSION.participants[].refunded` | YES | Refund state |
| `refundTxHash` | `PAYMENT_SESSION.participants[].refundTxHash` | YES | Refund transaction hash |

These fields are already persisted in `PAYMENT_SESSION` records and restored by `TonFinancialRecovery`. The recovery contract REFERENCES them but does NOT duplicate them.

#### D. Runtime-only data that must NOT be persisted

| Field | Reason |
|-------|--------|
| `connectionState` | Transient — reflects live socket connection state. Meaningless after restart. |
| `playerState` | Transient — reflects live player activity state. Must be re-established on reconnect. |
| `ping` | Transient — live network metric. Meaningless after restart. |
| `connectedAt` | Transient — live connection timestamp. |
| `lastSeen` | Transient — live activity timestamp. |

These fields are in `PlayerRuntime` and are inherently ephemeral. They must NOT be part of the recovery contract. They are re-established when players reconnect after restart.

---

## 6. IMMUTABLE GAME CONFIGURATION

### 6.1 Configuration Field Classification

This is a CRITICAL section. The committed game configuration is the blocking dependency for all downstream gameplay reconstruction.

| Configuration field | Classification | Authoritative source | Currently persisted? | Notes |
|---------------------|---------------|---------------------|---------------------|-------|
| `configurationVersion` | REQUIRED | `CONFIGURATION_VERSION` constant (`./configuration/ConfigurationVersion.js`) | DERIVABLE — static constant available at recovery time | Must match the version used when configuration was originally committed. |
| `configurationHash` | REQUIRED (for validation) | Recovery Data Contract (CURRENTLY MISSING) | NOT PERSISTED | A hash of the full committed configuration object. `snapshotHash` is NOT this hash — `snapshotHash` is a hash of the financial snapshot. A dedicated configuration hash must be persisted. |
| `traceSeed` | REQUIRED | `randomService.generateTraceSeed()` output | PARTIAL — in `SETTLEMENT.traceSeed` for completed games only. NOT available for active games. | One of the `randomService` outputs needed to reproduce configuration. Without `traceSeed`, `buildConfiguration` cannot reproduce the original configuration. |
| `wheel.startAngle` | REQUIRED | `randomService.nextInt(0, 359)` output | NOT PERSISTED | Wheel start angle. `randomService` output. NOT in any financial record. |
| `triangle.startAngle` | REQUIRED | `randomService.nextInt(0, 359)` output | NOT PERSISTED | Triangle start angle. `randomService` output. NOT in any financial record. |
| `polarAxis` | REQUIRED | Part of configuration object | NOT PERSISTED | Wheel polar axis. Part of the frozen configuration. NOT in any financial record. |
| `sectors[]` | REQUIRED | `generateWheelLayout({ players, randomService })` output | PARTIAL — in `SNAPSHOT.sectors[]` when configuration existed at snapshot creation time. May be empty `[]`. | Sector objects: `sectorId`, `ownerId`, `color`, `colorId`, `icon`, `angleStart`, `angleEnd`. Generated per-game from player inputs + `randomService`. |
| `sector.sectorId` | REQUIRED | `generateWheelLayout` output | PARTIAL — in `SNAPSHOT.sectors[].sectorId` | Sector identifier. |
| `sector.ownerId` | REQUIRED | `generateWheelLayout` output | PARTIAL — in `SNAPSHOT.sectors[].ownerId` | Owning player ID. |
| `sector.color` | REQUIRED | `generateWheelLayout` output | PARTIAL — in `SNAPSHOT.sectors[].color` | Sector color. |
| `sector.colorId` | REQUIRED | `generateWheelLayout` output | PARTIAL — in `SNAPSHOT.sectors[].colorId` | Color identifier. |
| `sector.icon` | REQUIRED | `generateWheelLayout` output | PARTIAL — in `SNAPSHOT.sectors[].icon` | Sector icon. |
| `sector.angleStart` | REQUIRED | `generateWheelLayout` output | PARTIAL — in `SNAPSHOT.sectors[].angleStart` | Sector start angle. |
| `sector.angleEnd` | REQUIRED | `generateWheelLayout` output | PARTIAL — in `SNAPSHOT.sectors[].angleEnd` | Sector end angle. |
| `players[]` (configuration player data) | REQUIRED | `buildConfiguration` output from room + player inputs | PARTIAL — `SNAPSHOT.players[]` has partial player data | Configuration player objects with sector assignments, colors, stakes. |
| `baseStake` (configuration-level) | REQUIRED | `configuration.stake` or first player's `baseStake` | PARTIAL — in `SNAPSHOT.baseStake` | Base stake used for the game. |
| `stake` | REQUIRED | `gameCatalog.getStakes()` | DERIVABLE — catalog is immutable | Stake configuration from catalog. |
| Timing parameters (`frozenTimers`) | DERIVABLE | `gameCatalog.getTimers()` | DERIVABLE — catalog is immutable. `GameClockEngine._snapshotCatalogTimers()` snapshots catalog timers at clock creation. If catalog version is unchanged, timers are derivable. | **INSUFFICIENT INFORMATION** on whether catalog version is persisted in financial records. If catalog changes between original game and recovery, `frozenTimers` would differ. |
| Physics parameters | DERIVABLE | `DEFAULT_PHYSICS_PARAMETERS` (`./physics/PhysicsParameters.js`) | DERIVABLE — static constant | Physics parameters are a static constant. Available at recovery time. |
| Payment rules | DERIVABLE | `gameCatalog.getPaymentRules()` | DERIVABLE — catalog is immutable | Payment rules from catalog. |
| Catalog colors | DERIVABLE | `gameCatalog.getColors()` | DERIVABLE — catalog is immutable | Color catalog. |
| Catalog icons | DERIVABLE | `gameCatalog.getIcons()` | DERIVABLE — catalog is immutable | Icon catalog. |
| Catalog wheel rules | DERIVABLE | `gameCatalog.getWheelRules()` | DERIVABLE — catalog is immutable | Wheel rules from catalog. |
| Economy object (`ownerFeePercent`, `organizerFeeRate`, `winnerPercentage`) | DERIVABLE | `ConfigurationEngine.freezeEconomy(gameId)` from configuration + `gameCatalog.getPaymentRules()` | DERIVABLE — requires reconstructed configuration | Economy is derived from configuration + catalog payment rules. |

### 6.2 Critical Determinism Constraint

**Do NOT assume deterministic recomputation is safe unless all `randomService` inputs required to reproduce the exact committed result are available.**

The `randomService` outputs required to reproduce a configuration are:

1. `traceSeed` — generated by `randomService.generateTraceSeed()`
2. `wheel.startAngle` — generated by `randomService.nextInt(0, 359)`
3. `triangle.startAngle` — generated by `randomService.nextInt(0, 359)`
4. Wheel layout randomization — internal to `generateWheelLayout({ players, randomService })`

Of these, only `traceSeed` is partially available (from `SETTLEMENT` for completed games). The start angles and wheel layout randomization outputs are NOT persisted in any financial record.

**Conclusion:** Configuration CANNOT be safely regenerated via `buildConfiguration` after restart. The committed configuration must be persisted as a frozen object (the preferred approach) OR all `randomService` outputs + original player inputs must be persisted to reproduce it. Regenerating with new `randomService` outputs would produce a DIFFERENT configuration, violating determinism and breaking `snapshotHash` integrity.

### 6.3 Configuration Persistence Requirement

The recovery contract MUST persist one of:

**Option A (Preferred):** The full frozen configuration object (as stored in `ConfigurationEngine._configurations[gameId]` after `deepFreezeConfiguration`). This is the authoritative committed configuration. It is immutable. It contains all fields needed by `WinnerEngine`, `InputAuthority`, and `PhysicsEngine`.

**Option B (Alternative):** All `randomService` outputs (`traceSeed`, `wheel.startAngle`, `triangle.startAngle`, wheel layout seed) + complete player identity data + catalog version. This would allow `buildConfiguration` to reproduce the configuration. However, this requires that `buildConfiguration` is deterministic given the same inputs, which has NOT been verified in the source reports. This option is riskier and requires additional validation.

**Recommendation:** Option A is safer because it persists the exact committed state rather than relying on reproduction. The frozen configuration object is already immutable and can be persisted directly.

---

## 7. GAMEPLAY STATE

### 7.1 State Field Classification

| State field | Classification | Authoritative source | Currently persisted? | Purpose |
|-------------|---------------|---------------------|---------------------|---------|
| `GameState` (current phase) | REQUIRED TO RESUME | `GameStateEngine._states[gameId].currentState` | NOT PERSISTED | Current game phase: `PRE_GAME_READY`, `READY`, `SELF_TEST`, `SPEED`, `BRAKE`, `RESULT`. Determines where the game was when restart occurred. |
| `GAME_STATUS` (lifecycle status) | REQUIRED TO RESUME | `GameManager._games[gameId].status` | NOT PERSISTED | Game lifecycle: `CREATED`, `INITIALIZED`, `READY`, `RUNNING`, `FINISHED`. Determines whether game was activated. |
| Phase transition history | REQUIRED ONLY FOR VALIDATION | `GameStateEngine._states[gameId].history[]` | NOT PERSISTED | Array of `{ state, enteredAt, reason }`. Useful for audit/validation but not required for resume. |
| Phase start timestamp | REQUIRED TO RESUME | `GameStateEngine._states[gameId].enteredAt` | NOT PERSISTED | When the current phase was entered. Needed to compute remaining phase time. |
| Current clock state | REQUIRED TO RESUME | `GameClockEngine._clocks[gameId]` | NOT PERSISTED | See Section 9 (Game Clock Recovery Data). |
| Remaining phase time | DERIVABLE | Computed from `phaseStartedAt` + `frozenTimers[phase]` + server timestamp at checkpoint | NOT PERSISTED (but derivable if phase start timestamp and checkpoint timestamp are persisted) | Can be computed if phase start timestamp and phase duration are known. |
| Pause state | REQUIRED TO RESUME | `GameClockEngine._clocks[gameId].paused`, `pauseStartedAt`, `totalPausedMs` | NOT PERSISTED | Whether the game was paused and for how long. Affects clock reconstruction. |
| Completion state | REQUIRED ONLY FOR VALIDATION | `GameManager._games[gameId].status === FINISHED` | NOT PERSISTED | Whether the game reached completion. |

### 7.2 State Transition Table

The `GAME_STATES` enum defines: `PRE_GAME_READY`, `READY`, `SELF_TEST`, `SPEED`, `BRAKE`, `RESULT`.

The transition table is linear and forward-only:

```
PRE_GAME_READY → READY → SELF_TEST → SPEED → BRAKE → RESULT
```

No backward transitions are allowed. There is no method to set an arbitrary state directly. `initializeGameState` always creates with `PRE_GAME_READY`. `transition(gameId, nextState, context)` validates against the transition table.

**Note:** `GAME_INITIALIZED` is NOT a `GameStateEngine` state. It is a `GameManager` lifecycle status (`GAME_STATUS.INITIALIZED`), emitted as the `GAME_INITIALIZED` event. `COUNTDOWN` does NOT exist in the `GAME_STATES` enum or the `TRANSITIONS` table.

### 7.3 Safe Resume Determination

An active gameplay session can safely resume ONLY if ALL of the following are known:

1. Current `GameState` phase.
2. `GAME_STATUS` lifecycle status.
3. Phase start timestamp (to compute remaining time).
4. Pause state.
5. Full committed configuration.
6. Physics state (for phases `SPEED`/`BRAKE`).
7. Clock state.
8. Input authority state (for phases `SPEED`/`BRAKE`).

If ANY of these is unknown, the game MUST FAIL CLOSED.

---

## 8. PHYSICS RECOVERY DATA

### 8.1 Physics Field Classification

| Physics field | Classification | Authoritative source | Currently persisted? | Notes |
|---------------|---------------|---------------------|---------------------|-------|
| `angle` (wheel angle) | MUST PERSIST (terminal) / MUST PERSIST (active) | `PhysicsEngine._simulations[gameId].runtime.angle` | NOT PERSISTED | Wheel angle in radians. For terminal games: needed for winner recomputation. For active games: needed to resume simulation. |
| `triangleAngle` | MUST PERSIST (terminal) / MUST PERSIST (active) | `PhysicsEngine._simulations[gameId].runtime.triangleAngle` | NOT PERSISTED | Triangle angle in radians. For terminal games: needed for winner recomputation. |
| `angularVelocity` | CAN BE RECONSTRUCTED (active, via replay) / NOT REQUIRED (terminal) | `PhysicsEngine._simulations[gameId].runtime.angularVelocity` | NOT PERSISTED | Wheel angular velocity. For terminal games: zero (STOPPED). For active games: needed to resume, but can be reconstructed via deterministic replay IF command log + deltas are available. |
| `triangleAngularVelocity` | CAN BE RECONSTRUCTED (active, via replay) / NOT REQUIRED (terminal) | `PhysicsEngine._simulations[gameId].runtime.triangleAngularVelocity` | NOT PERSISTED | Triangle angular velocity. Same as above. |
| `angularAcceleration` | CAN BE RECONSTRUCTED (active, via replay) / NOT REQUIRED (terminal) | `PhysicsEngine._simulations[gameId].runtime.angularAcceleration` | NOT PERSISTED | Angular acceleration. Same as above. |
| `state` (simulation lifecycle) | MUST PERSIST | `PhysicsEngine._simulations[gameId].runtime.state` | NOT PERSISTED | `PHYSICS_SIMULATION_STATE`: `CREATED`, `RUNNING`, `BRAKING`, `STOPPED`, `REMOVED`. For terminal games: `STOPPED`. For active games: current state. |
| `braking` | MUST NOT BE ASSUMED | `PhysicsEngine._simulations[gameId].runtime.braking` | NOT PERSISTED | Braking flag. Transient motion flag. |
| `selfTestActive` | MUST NOT BE ASSUMED | `PhysicsEngine._simulations[gameId].runtime.selfTestActive` | NOT PERSISTED | Self-test motion active flag. Transient. |
| `speedActive` | MUST NOT BE ASSUMED | `PhysicsEngine._simulations[gameId].runtime.speedActive` | NOT PERSISTED | Speed motion active flag. Transient. |
| `brakeActive` | MUST NOT BE ASSUMED | `PhysicsEngine._simulations[gameId].runtime.brakeActive` | NOT PERSISTED | Brake motion active flag. Transient. |
| `brakeDurationMs` | CAN BE RECONSTRUCTED (active, via replay) / NOT REQUIRED (terminal) | `PhysicsEngine._simulations[gameId].runtime.brakeDurationMs` | NOT PERSISTED | Brake duration. |
| `brakeElapsedMs` | CAN BE RECONSTRUCTED (active, via replay) / NOT REQUIRED (terminal) | `PhysicsEngine._simulations[gameId].runtime.brakeElapsedMs` | NOT PERSISTED | Brake elapsed time. |
| `brakeStartWheelOmega` | CAN BE RECONSTRUCTED (active, via replay) / NOT REQUIRED (terminal) | `PhysicsEngine._simulations[gameId].runtime.brakeStartWheelOmega` | NOT PERSISTED | Wheel angular velocity at brake start. |
| `physicsStoppedEmitted` | MUST NOT BE ASSUMED | `PhysicsEngine._simulations[gameId].runtime.physicsStoppedEmitted` | NOT PERSISTED | Whether `PHYSICS_STOPPED` was emitted. Transient event flag. |
| `simulationTimeMs` | CAN BE RECONSTRUCTED (active, via replay) / NOT REQUIRED (terminal) | `PhysicsEngine._simulations[gameId].runtime.simulationTimeMs` | NOT PERSISTED | Total simulation time. |
| `commandLog` | CAN BE REPLAYED (active) / NOT REQUIRED (terminal) | `PhysicsEngine._simulations[gameId].commandLog` | NOT PERSISTED | Log of motion commands. Could support deterministic replay for active games. |
| `parameters` | DERIVABLE | `DEFAULT_PHYSICS_PARAMETERS` + overrides | DERIVABLE — static constant | Physics parameters. Available at recovery time. |
| Last update timestamp | MUST NOT BE ASSUMED | Not explicitly stored | NOT PERSISTED | The timestamp of the last physics update. Would be needed to compute time delta for resume. |

### 8.2 Deterministic Replay Assessment

**Question:** Is deterministic replay from a validated checkpoint sufficient for physics reconstruction?

**Answer:** Deterministic replay is THEORETICALLY possible but CURRENTLY NOT ACHIEVABLE.

The physics simulation is deterministic given:

1. The same `DEFAULT_PHYSICS_PARAMETERS`.
2. The same sequence of motion commands (`commandLog`).
3. The same sequence of `deltaTime` values from `SimulationLoop`.

However:

- The `commandLog` is NOT persisted.
- The `deltaTime` sequence from `SimulationLoop` is real-time dependent and NOT persisted.
- Even if the `commandLog` were persisted, the exact `deltaTime` values would be needed for bit-exact reconstruction.

**Conclusion for terminal games:** Persisting only the final angles (`angle`, `triangleAngle`) and simulation `state` (`STOPPED`) is sufficient. `WinnerEngine.resolveResult` is deterministic and idempotent — given the same configuration and physics final state, it produces the same result. The full physics `runtime` object does NOT need to be persisted for terminal games.

**Conclusion for active games:** Physics reconstruction via deterministic replay is NOT safe because neither the `commandLog` nor the `deltaTime` sequence is persisted. Persisting the full `runtime` state (including transient motion flags) would violate the "do not persist arbitrary runtime object graphs" principle. Active game physics reconstruction is NOT SAFE and must FAIL CLOSED.

### 8.3 Minimum Physics Recovery Data

**For terminal games (RESULT phase, physics STOPPED):**

| Field | Required? | Purpose |
|-------|-----------|---------|
| `angle` (final wheel angle) | MUST PERSIST | Input to `WinnerEngine.resolveResult` for sector resolution |
| `triangleAngle` (final triangle angle) | MUST PERSIST | Input to `WinnerEngine.resolveResult` for sector resolution |
| `state` | MUST PERSIST (`STOPPED`) | Validation that physics reached terminal state |

**For active games (SPEED/BRAKE phase):**

| Field | Required? | Purpose |
|-------|-----------|---------|
| Full `runtime` state | NOT RECOMMENDED — violates storage principle | Would be needed to resume simulation |
| `commandLog` + `deltaTime` sequence | NOT PERSISTED | Would be needed for deterministic replay |

**Verdict:** Active game physics recovery is NOT SAFE. FAIL CLOSED.

---

## 9. GAME CLOCK RECOVERY DATA

### 9.1 Clock Field Classification

| Clock field | Classification | Authoritative source | Currently persisted? | Notes |
|-------------|---------------|---------------------|---------------------|-------|
| `currentPhase` | REQUIRED TO RESUME | `GameClockEngine._clocks[gameId].currentPhase` | NOT PERSISTED | Current clock phase. Must match `GameState` phase. |
| `startedAt` | REQUIRED TO RESUME | `GameClockEngine._clocks[gameId].startedAt` | NOT PERSISTED | When the clock was started. Needed to compute elapsed time. |
| `elapsed` | DERIVABLE | Computed from `startedAt` + current time - `totalPausedMs` | NOT PERSISTED (derivable if `startedAt` and `totalPausedMs` are persisted) | Elapsed time. |
| `remaining` (phaseRemainingMs) | DERIVABLE | Computed from `phaseEndsAt` - current time | NOT PERSISTED (derivable if `phaseEndsAt` is persisted) | Remaining time in current phase. |
| `duration` (phase duration) | DERIVABLE | `frozenTimers[phase]` or `gameCatalog.getTimers()` | DERIVABLE — from catalog (if catalog version matches) | Phase duration. |
| `paused` | REQUIRED TO RESUME | `GameClockEngine._clocks[gameId].paused` | NOT PERSISTED | Whether the clock is paused. |
| `pauseStartedAt` | REQUIRED TO RESUME (if paused) | `GameClockEngine._clocks[gameId].pauseStartedAt` | NOT PERSISTED | When the current pause started. |
| `totalPausedMs` | REQUIRED TO RESUME | `GameClockEngine._clocks[gameId].totalPausedMs` | NOT PERSISTED | Total paused time. Needed to compute accurate elapsed time. |
| `phaseStartedAt` | REQUIRED TO RESUME | `GameClockEngine._clocks[gameId].phaseStartedAt` | NOT PERSISTED | When the current phase started. Needed to compute remaining time. |
| `phaseEndsAt` | DERIVABLE | `phaseStartedAt` + `frozenTimers[phase]` | NOT PERSISTED (derivable if `phaseStartedAt` and `frozenTimers` are known) | When the current phase ends. |
| `frozenTimers` | DERIVABLE | `gameCatalog.getTimers()` snapshot | DERIVABLE — from catalog (if catalog version matches) | Snapshot of catalog timers at clock creation. |
| `awaitingResultActivation` | REQUIRED TO RESUME | `GameClockEngine._clocks[gameId].awaitingResultActivation` | NOT PERSISTED | P5.9 — BRAKE→RESULT gated by `ResultActivation`. |
| `resultPhaseStarted` | REQUIRED TO RESUME | `GameClockEngine._clocks[gameId].resultPhaseStarted` | NOT PERSISTED | Whether RESULT phase has started. |
| `timeoutHandle` | MUST NOT BE PERSISTED | `setTimeout` reference | NOT PERSISTED (non-serializable) | `setTimeout` handle. Inherently non-serializable. Must be re-scheduled on recovery. |
| `history[]` | REQUIRED ONLY FOR VALIDATION | `GameClockEngine._clocks[gameId].history` | NOT PERSISTED | Phase history. Useful for audit but not required for resume. |
| Server timestamp at checkpoint | REQUIRED TO RESUME | Recovery Data Contract | NOT PERSISTED | The server timestamp when the recovery checkpoint was taken. Needed to compute elapsed/remaining time. |

### 9.2 Clock Reconstruction Assessment

**Question:** Can the clock be safely reconstructed from `checkpoint timestamp + phase duration`?

**Answer:** NO, not from those two values alone.

Safe clock reconstruction requires:

1. `currentPhase` — to know which phase the clock was in.
2. `phaseStartedAt` — to know when the current phase started.
3. `frozenTimers[phase]` (or catalog timers) — to know the phase duration.
4. `paused` — to know if the clock was paused.
5. `totalPausedMs` — to compute accurate elapsed time across pauses.
6. `startedAt` — to know when the clock was originally started.
7. Server timestamp at checkpoint — to compute how much time has passed since the checkpoint.

From `phaseStartedAt` + `frozenTimers[phase]` + server timestamp at checkpoint, the remaining phase time can be computed as:

```
remaining = phaseEndsAt - serverTimestampAtCheckpoint
phaseEndsAt = phaseStartedAt + frozenTimers[phase]
```

However, if the clock was paused, `totalPausedMs` and `pauseStartedAt` are also needed to adjust the computation.

**Conclusion:** Clock reconstruction requires more than just `checkpoint timestamp + phase duration`. It requires `currentPhase`, `phaseStartedAt`, `paused`, `totalPausedMs`, `startedAt`, and the server timestamp at checkpoint.

---

## 10. INPUT AUTHORITY

### 10.1 Input Field Classification

| Input field | Classification | Authoritative source | Currently persisted? | Notes |
|-------------|---------------|---------------------|---------------------|-------|
| Registered players | DERIVABLE | `PAYMENT_SESSION.participants[].playerId` | YES (player IDs available from financial records) | The set of registered players can be derived from `PAYMENT_SESSION.participants`. |
| `playerIndex` | REQUIRED | `PAYMENT_SESSION.participants[].playerIndex` | YES | Seat index. Available from financial records. |
| `pressCount` | MUST PERSIST (active) / NOT REQUIRED (terminal) | `InputAuthority._registries[gameId].players[playerId].pressCount` | NOT PERSISTED | Completed press cycles. For active games: affects physics via acceleration commands. For terminal games: not needed. |
| `buttonPressed` | MUST NOT BE ASSUMED | `InputAuthority._registries[gameId].players[playerId].buttonPressed` | NOT PERSISTED | Whether button is currently pressed. Transient — reset on reconnect. |
| `lastPressTime` | MUST NOT BE ASSUMED | `InputAuthority._registries[gameId].players[playerId].lastPressTime` | NOT PERSISTED | Last press timestamp. Transient. |
| `lastReleaseAt` | MUST NOT BE ASSUMED | `InputAuthority._registries[gameId].players[playerId].lastReleaseAt` | NOT PERSISTED | Last release timestamp. Transient. |
| `cooldownUntil` | MUST NOT BE ASSUMED | `InputAuthority._registries[gameId].players[playerId].cooldownUntil` | NOT PERSISTED | Cooldown end timestamp. Transient. |
| `locked` | MUST PERSIST (active) / NOT REQUIRED (terminal) | `InputAuthority._registries[gameId].players[playerId].locked` | NOT PERSISTED | Whether input is locked (max press cycles reached). For active games: determines if player can still input. |
| `commandQueue` | CAN BE REPLAYED (active) / NOT REQUIRED (terminal) | `InputAuthority._registries[gameId].commandQueue` | NOT PERSISTED | Pending commands for `SimulationLoop` processing. For active games: would be needed for replay. |
| `acceptedCommands` | CAN BE REPLAYED (active) / NOT REQUIRED (terminal) | `InputAuthority._registries[gameId].acceptedCommands` | NOT PERSISTED | All accepted commands (history). For active games: would be needed for replay. |
| `sequenceNumber` | CAN BE REPLAYED (active) / NOT REQUIRED (terminal) | `InputAuthority._registries[gameId].sequenceNumber` | NOT PERSISTED | Monotonic command sequence counter. For active games: would be needed for replay. |
| `_speedInputClosed` | MUST PERSIST (active) / NOT REQUIRED (terminal) | `InputAuthority._speedInputClosed` (Set of `gameId`s) | NOT PERSISTED | P5.6B — whether SPEED input is closed for the game. |

### 10.2 Replay vs. Persistence Assessment

**Question:** Must queued/accepted commands be persisted, or can deterministic replay reconstruct them?

**Answer:** For terminal games, input state is NOT needed (game is over, winner is determined by final physics state). For active games, input state (especially `pressCount`) affects physics because each press generates an acceleration command that modifies the physics simulation. Without `pressCount` and the command history, physics cannot be replayed.

However, the architecture decision (from the synthesis report) is that active gameplay reconstruction must FAIL CLOSED. Therefore, input authority state persistence is only theoretically needed if active game recovery were to be supported, which it is NOT.

**Conclusion:** Input authority state does NOT need to be persisted for the current architecture, because:

- Terminal games: input state is not needed (winner is recomputed from final physics state).
- Active games: FAIL CLOSED — no reconstruction attempted.

If active game recovery were to be supported in the future, `pressCount`, `locked`, `commandQueue`, `acceptedCommands`, `sequenceNumber`, and `_speedInputClosed` would all need to be persisted.

---

## 11. WINNER STATE

### 11.1 Winner Field Classification

| Winner field | Classification | Authoritative source | Currently persisted? | Notes |
|--------------|---------------|---------------------|---------------------|-------|
| `winningSector` | DERIVABLE (terminal) | `WinnerEngine._results[gameId].winningSector` | NOT PERSISTED | Can be recomputed via `WinnerEngine.resolveResult` if configuration + physics final state are available. |
| `winningPlayer` | DERIVABLE (terminal) | `WinnerEngine._results[gameId].winningPlayer` | NOT PERSISTED | Can be recomputed. |
| `winnerPlayerId` | DERIVABLE (terminal) / VALIDATION (if SETTLEMENT exists) | `WinnerEngine._results[gameId].winnerPlayerId`, `SETTLEMENT.winnerId` | PARTIAL — `winnerId` in `SETTLEMENT` for completed games | Can be recomputed. If `SETTLEMENT` exists, recomputed winner must match `SETTLEMENT.winnerId`. |
| `winnerSectorIndex` | DERIVABLE (terminal) | `WinnerEngine._results[gameId].winnerSectorIndex` | NOT PERSISTED | Can be recomputed. |
| `prize` | DERIVABLE (terminal) | `WinnerEngine._results[gameId].prize` | NOT PERSISTED | Can be recomputed from configuration economy. |
| `payout` | DERIVABLE (terminal) | `WinnerEngine._results[gameId].payout` | NOT PERSISTED | Can be recomputed. |
| `finalAngle` (final wheel angle) | MUST PERSIST (terminal) | `WinnerEngine._results[gameId].finalAngle` | NOT PERSISTED | Same as `PhysicsEngine.runtime.angle` at STOPPED. Needed for winner recomputation. |
| `wheelFinalAngle` | MUST PERSIST (terminal) | `WinnerEngine._results[gameId].wheelFinalAngle` | NOT PERSISTED | Same as `finalAngle`. |
| `triangleFinalAngle` | MUST PERSIST (terminal) | `WinnerEngine._results[gameId].triangleFinalAngle` | NOT PERSISTED | Same as `PhysicsEngine.runtime.triangleAngle` at STOPPED. Needed for winner recomputation. |
| `resolvedAt` | REQUIRED ONLY FOR VALIDATION | `WinnerEngine._results[gameId].resolvedAt` | NOT PERSISTED | Timestamp of resolution. Not needed for recomputation. Useful for audit. |
| `traceSeed` | DERIVABLE (from configuration) | `WinnerEngine._results[gameId].traceSeed` | PARTIAL — in `SETTLEMENT.traceSeed` | Same as `configuration.traceSeed`. Available if configuration is persisted. |
| `metadata.configurationVersion` | DERIVABLE (from configuration) | `WinnerEngine._results[gameId].metadata.configurationVersion` | NOT PERSISTED | Same as `configuration.configurationVersion`. Available if configuration is persisted. |

### 11.2 State Distinction

#### ACTIVE GAME (phases PRE_GAME_READY through BRAKE)

- Winner has NOT been resolved.
- `WinnerEngine._results[gameId]` does not exist.
- No winner state to persist.
- Recovery: FAIL CLOSED (active gameplay cannot be resumed).

#### RESULT PHASE (physics STOPPED, winner resolved in-memory)

- Winner has been resolved by `WinnerEngine.resolveResult`.
- `WinnerEngine._results[gameId]` exists in-memory but is NOT persisted.
- `SETTLEMENT` record may or may not exist yet (settlement may not have been initiated).
- If `SETTLEMENT` does NOT exist: the winner was resolved in-memory but not persisted. The winner cannot be safely reconstructed without final physics angles. FAIL CLOSED for gameplay unless final angles are persisted.
- If `SETTLEMENT` DOES exist: terminal recovery (see below).

#### SETTLED GAME (SETTLEMENT record exists)

- `SETTLEMENT` record exists with `winnerId`, `winnerWallet`, `prizeAmount`, `traceSeed`.
- Winner result can be VALIDATED against `SETTLEMENT.winnerId`.
- If configuration + final physics angles are persisted, `WinnerEngine.resolveResult` can recompute the winner deterministically.
- Recomputed `winnerPlayerId` MUST match `SETTLEMENT.winnerId`. If mismatch → FAIL CLOSED.

### 11.3 Winner Recovery Strategy

For terminal games (RESULT phase or SETTLED):

1. Persist final wheel angle and final triangle angle (from `PhysicsEngine.runtime` at STOPPED).
2. Persist the full committed configuration (Section 6).
3. On recovery: reconstruct `ConfigurationEngine` state → reconstruct `PhysicsEngine` to STOPPED with final angles → call `WinnerEngine.resolveResult(gameId)` → validate against `SETTLEMENT.winnerId` if settlement exists.

The winner result itself does NOT need to be persisted because it is deterministically recomputable from configuration + final physics state.

---

## 12. FINANCIAL CROSS-DOMAIN DATA

### 12.1 Financial Reference Classification

| Financial field | Recovery role | Authoritative source | Currently persisted? | Notes |
|-----------------|--------------|---------------------|---------------------|-------|
| `paymentSessionId` | Recovery anchor | `PAYMENT_SESSION` | YES | Links recovery contract to payment session. |
| `contractId` | Recovery anchor | `GAME_CONTRACT` | YES | Links recovery contract to game contract. |
| `playerId` values | Recovery anchor | `PAYMENT_SESSION.participants[]` | YES | Identifies players. |
| `playerIndex` / paidMask mapping | Recovery anchor | `PAYMENT_SESSION.participants[].playerIndex` | YES | Seat indices for GameEscrow paidMask. |
| `contractAddress` | Recovery anchor | `GAME_CONTRACT.contractAddress` | YES (after deploy) | On-chain GameEscrow address. |
| `deploymentStatus` | Validation-only | `GAME_CONTRACT.deploymentStatus` | YES | Contract deployment lifecycle status. |
| `tonNetwork` | Recovery anchor | `GAME_CONTRACT.tonNetwork`, `PAYMENT_SESSION.network` | YES | TON network identifier. |
| Payment status per participant | Validation-only | `PAYMENT_SESSION.participants[].status` | YES | Payment confirmation status. |
| GameEscrow state (`paidMask`) | Financial truth anchor | GameEscrow / TON blockchain | YES (on-chain) | Authoritative payment truth. Backend cache is synchronized to chain. |
| Settlement state | Validation-only | `SETTLEMENT.status` | YES | Settlement lifecycle status. |
| Winner settlement (`winnerId`, `prizeAmount`) | Validation-only | `SETTLEMENT.winnerId`, `SETTLEMENT.prizeAmount` | YES (if SETTLEMENT exists) | Winner identity for validation. |
| Refund state | Financial-only | `PAYMENT_SESSION.participants[].refunded`, `refundTxHash` | YES | Refund state. Handled by financial recovery. |
| `snapshotHash` | Validation-only | `GAME_CONTRACT.snapshotHash`, `SNAPSHOT` record | YES | SHA-256 hash of the financial snapshot. Used for integrity verification of the financial snapshot. NOT a hash of the full game configuration. |
| `traceSeed` (in SETTLEMENT) | Validation-only (terminal) | `SETTLEMENT.traceSeed` | YES (if SETTLEMENT exists) | Configuration trace seed. Can validate against persisted configuration. |
| `settlementTransactionHash` | Financial-only | `SETTLEMENT.settlementTransactionHash` | YES (if SETTLEMENT exists) | Settlement transaction hash. Handled by financial recovery. |

### 12.2 Principle

The recovery contract must REFERENCE financial data but must NOT DUPLICATE it unnecessarily. Financial records are already persisted and restored by `TonFinancialRecovery`. The recovery contract should store only:

1. References to financial records (`contractId`, `paymentSessionId`) — to link the recovery contract to the financial domain.
2. Gameplay state that is NOT in any financial record (configuration, game state, physics, clock, input, winner).

The recovery contract must NOT re-persist `paymentStatus`, `paidAmount`, `confirmationStatus`, `refunded`, `refundTxHash`, `settlementTransactionHash`, or other financial fields. These are owned by the financial persistence layer.

---

## 13. AUTHORITATIVE SOURCE MATRIX

| Recovery field | Required | Authoritative source | Immutable? | Derivable? | Validation required? |
|----------------|----------|---------------------|-----------|------------|----------------------|
| `recoveryRecordId` | YES | Recovery Data Contract persistence (CURRENTLY MISSING) | YES | NO | YES — must be unique |
| `roomId` | YES | `GAME_CONTRACT`, `PAYMENT_SESSION`, `SETTLEMENT` | YES | NO | YES — must match across all financial records |
| `gameId` | YES | `GAME_CONTRACT`, `PAYMENT_SESSION`, `SETTLEMENT` | YES | NO | YES — must match across all financial records |
| `contractId` | YES | `GAME_CONTRACT` | YES | NO | YES — must match `GAME_CONTRACT` record |
| `paymentSessionId` | YES | `PAYMENT_SESSION` | YES | NO | YES — must match `PAYMENT_SESSION` record |
| `playerId` (per player) | YES | `PAYMENT_SESSION.participants[].playerId` | YES | NO | YES — must match `PAYMENT_SESSION.participants` |
| `playerIndex` (per player) | YES | `PAYMENT_SESSION.participants[].playerIndex` | YES | NO | YES — must match `PAYMENT_SESSION.participants[].playerIndex` |
| `wallet` (per player) | YES | `PAYMENT_SESSION.participants[].wallet` | YES | NO | YES — must match `PAYMENT_SESSION.participants[].wallet` |
| `nickname` (per player) | YES | `PlayerIdentity` (CURRENTLY MISSING) | YES | NO | NO |
| `baseStake` (per player) | YES | `PlayerIdentity` / `SNAPSHOT.players[].baseStake` | YES | NO | NO |
| `sectorCount` (per player) | YES | `PlayerIdentity` / `SNAPSHOT.players[].sectorCount` | YES | NO | NO |
| `color` (per player) | YES | `PlayerIdentity` (CURRENTLY MISSING) | YES | NO | NO |
| `colorSector2` (per player) | YES | `PlayerIdentity` (CURRENTLY MISSING) | YES | NO | NO |
| `icon` (per player) | YES | `PlayerIdentity` / `SNAPSHOT.players[].icon` | YES | NO | NO |
| `sectorArrangement` (per player) | YES | `PlayerIdentity` (CURRENTLY MISSING) | YES | NO | NO |
| `age` (per player) | YES | `PlayerIdentity` (CURRENTLY MISSING) | YES | NO | NO |
| Full frozen configuration | YES | `ConfigurationEngine._configurations[gameId]` (CURRENTLY MISSING) | YES | NO — cannot be regenerated without original `randomService` outputs | YES — `configurationHash` must match |
| `configurationHash` | YES | Recovery Data Contract (CURRENTLY MISSING) | YES | NO | YES — must match persisted configuration |
| `traceSeed` | YES | Configuration object / `SETTLEMENT.traceSeed` (terminal only) | YES | NO — `randomService` output | YES — must match configuration |
| `wheel.startAngle` | YES | Configuration object (CURRENTLY MISSING) | YES | NO — `randomService` output | NO |
| `triangle.startAngle` | YES | Configuration object (CURRENTLY MISSING) | YES | NO — `randomService` output | NO |
| `polarAxis` | YES | Configuration object (CURRENTLY MISSING) | YES | NO | NO |
| `sectors[]` | YES | Configuration object / `SNAPSHOT.sectors[]` (partial) | YES | NO | NO |
| `configurationVersion` | YES | `CONFIGURATION_VERSION` constant | YES | YES — static constant | YES — must match version used at commit time |
| `frozenTimers` | YES | `gameCatalog.getTimers()` snapshot | YES | YES — from catalog (if catalog version matches) | YES — must match catalog version |
| `GameState` (current phase) | YES (active) / YES (terminal) | `GameStateEngine._states[gameId].currentState` (CURRENTLY MISSING) | NO (mutable — changes with phase transitions) | NO | YES — must be consistent with clock phase |
| `GAME_STATUS` | YES | `GameManager._games[gameId].status` (CURRENTLY MISSING) | NO (mutable — lifecycle transitions) | NO | YES — must be consistent with financial records |
| `phaseStartedAt` | YES (active) | `GameClockEngine._clocks[gameId].phaseStartedAt` (CURRENTLY MISSING) | NO (mutable) | NO | YES — must be consistent with `GameState` |
| `startedAt` (clock) | YES (active) | `GameClockEngine._clocks[gameId].startedAt` (CURRENTLY MISSING) | YES | NO | NO |
| `paused` | YES (active) | `GameClockEngine._clocks[gameId].paused` (CURRENTLY MISSING) | NO (mutable) | NO | YES — must be consistent with `GameState` |
| `totalPausedMs` | YES (active) | `GameClockEngine._clocks[gameId].totalPausedMs` (CURRENTLY MISSING) | NO (mutable) | NO | NO |
| `awaitingResultActivation` | YES (active, BRAKE phase) | `GameClockEngine._clocks[gameId].awaitingResultActivation` (CURRENTLY MISSING) | NO (mutable) | NO | YES — must be consistent with `GameState` |
| `resultPhaseStarted` | YES (active, RESULT phase) | `GameClockEngine._clocks[gameId].resultPhaseStarted` (CURRENTLY MISSING) | NO (mutable) | NO | YES — must be consistent with `GameState` |
| Server timestamp at checkpoint | YES | Recovery Data Contract (CURRENTLY MISSING) | YES | NO | YES — must be within acceptable drift |
| Final wheel angle (terminal) | YES (terminal) | `PhysicsEngine.runtime.angle` at STOPPED (CURRENTLY MISSING) | YES | NO | YES — must produce valid sector resolution |
| Final triangle angle (terminal) | YES (terminal) | `PhysicsEngine.runtime.triangleAngle` at STOPPED (CURRENTLY MISSING) | YES | NO | YES — must produce valid sector resolution |
| Physics simulation state (terminal) | YES (terminal) | `PhysicsEngine.runtime.state` (CURRENTLY MISSING) | YES | NO | YES — must be `STOPPED` |
| `snapshotHash` | YES (validation) | `GAME_CONTRACT.snapshotHash` | YES | NO | YES — must match `GAME_CONTRACT` record |
| `correlationId` | OPTIONAL | `GAME_CONTRACT`, `PAYMENT_SESSION` | YES | NO | NO |
| `tonNetwork` | YES | `GAME_CONTRACT.tonNetwork` | YES | NO | YES — must match `GAME_CONTRACT` |
| `winnerId` (if SETTLEMENT exists) | YES (validation, terminal) | `SETTLEMENT.winnerId` | YES | NO | YES — recomputed winner must match |
| `traceSeed` (SETTLEMENT) | YES (validation, terminal) | `SETTLEMENT.traceSeed` | YES | NO | YES — must match configuration `traceSeed` |

### 13.1 Currently Missing Sources

The following authoritative sources do NOT currently exist and must be created by the Recovery Data Contract persistence (R17.9T.6-C):

1. Recovery Data Contract persistence layer (new persistence record type or mechanism).
2. Full frozen configuration persistence.
3. `configurationHash` (dedicated configuration hash, distinct from `snapshotHash`).
4. `GameState` (current phase) persistence.
5. `GAME_STATUS` persistence.
6. Clock state persistence (`phaseStartedAt`, `startedAt`, `paused`, `totalPausedMs`, `awaitingResultActivation`, `resultPhaseStarted`).
7. Server timestamp at checkpoint.
8. Final physics angles (terminal games).
9. Physics simulation state (terminal games).
10. Complete player identity data (`nickname`, `color`, `colorSector2`, `sectorArrangement`, `age` — fields not in `SNAPSHOT`).

---

## 14. RECOVERY ELIGIBILITY CONTRACT

### 14.1 Eligibility Per State

#### A. SETUP / ROOM (before contract creation)

| Property | Value |
|----------|-------|
| Financial records exist? | NO — no `GAME_CONTRACT` or `PAYMENT_SESSION` exists yet |
| Gameplay reconstructable? | NO — no anchor |
| Recovery action | NOT RECOVERABLE |
| Classification | Terminal (discard) |
| Rationale | Room/setup phase sessions are ephemeral. No financial obligation exists. Safe to discard. |

#### B. PAYMENT (contract created, payments in progress)

| Property | Value |
|----------|-------|
| Financial records exist? | YES — `GAME_CONTRACT` and `PAYMENT_SESSION` exist |
| Gameplay reconstructable? | NO — no gameplay state to reconstruct |
| Recovery action | FINANCIAL RECOVERY ONLY |
| Classification | Recoverable (financial only) |
| Rationale | Restore financial records. Reconcile with GameEscrow. If payments incomplete, handle via existing payment expiry/refund flow. No gameplay reconstruction needed. |

#### C. PRE_GAME_READY (game activated, `GAME_INITIALIZED`, phase `PRE_GAME_READY`)

| Property | Value |
|----------|-------|
| Financial records exist? | YES — `GAME_CONTRACT`, `PAYMENT_SESSION` exist |
| Gameplay reconstructable? | ONLY BY RECONSTRUCTION — requires persisted configuration, game state, clock state |
| Recovery action | Recoverable only by reconstruction IF all required data is persisted |
| Classification | Recoverable only by reconstruction |
| Rationale | Game was activated but no active physics simulation. If configuration + game state + clock state are persisted, the game can be reconstructed to `PRE_GAME_READY` phase. If any required data is missing → FAIL CLOSED. |

#### D. READY (phase `READY`)

| Property | Value |
|----------|-------|
| Financial records exist? | YES |
| Gameplay reconstructable? | ONLY BY RECONSTRUCTION — requires persisted configuration, game state, clock state |
| Recovery action | Recoverable only by reconstruction IF all required data is persisted |
| Classification | Recoverable only by reconstruction |
| Rationale | No active physics simulation yet (physics in CREATED state). If configuration + game state + clock state are persisted, the game can be reconstructed to `READY` phase. If any required data is missing → FAIL CLOSED. |

#### E. COUNTDOWN / SELF_TEST (phase `SELF_TEST`)

**Note:** `COUNTDOWN` does not exist in the `GAME_STATES` enum. The phase is `SELF_TEST`.

| Property | Value |
|----------|-------|
| Financial records exist? | YES |
| Gameplay reconstructable? | ONLY BY RECONSTRUCTION — requires persisted configuration, game state, clock state, physics state (self-test motion) |
| Recovery action | Recoverable only by reconstruction IF all required data is persisted |
| Classification | Recoverable only by reconstruction (with conditions) |
| Rationale | Self-test motion is active. Physics is in `RUNNING` state with self-test velocities. Reconstruction requires physics state (angles, velocities) OR command log + deltas for replay. If physics state is not persisted → FAIL CLOSED. |

#### F. SPEED (phase `SPEED`)

| Property | Value |
|----------|-------|
| Financial records exist? | YES |
| Gameplay reconstructable? | FAIL CLOSED |
| Classification | Fail closed |
| Rationale | Active gameplay. Physics is in `RUNNING` state with player-driven motion. Current wheel angle, angular velocity, angular acceleration, input state (press counts, command queue), and clock state are ALL unknown and NOT persisted. Deterministic replay is NOT possible (command log + deltaTime sequence not persisted). Reconstructing would require inventing state. FAIL CLOSED. |

#### G. BRAKE (phase `BRAKE`)

| Property | Value |
|----------|-------|
| Financial records exist? | YES |
| Gameplay reconstructable? | FAIL CLOSED |
| Classification | Fail closed |
| Rationale | Active gameplay. Physics is in `BRAKING` state. Brake parameters (`brakeDurationMs`, `brakeElapsedMs`, `brakeStartWheelOmega`) are unknown and NOT persisted. Current wheel angle and angular velocity are unknown. Reconstructing would require inventing state. FAIL CLOSED. |

#### H. RESULT (phase `RESULT`, physics `STOPPED`, winner resolved)

| Property | Value |
|----------|-------|
| Financial records exist? | YES — `GAME_CONTRACT`, `PAYMENT_SESSION` exist; `SETTLEMENT` may or may not exist |
| Gameplay reconstructable? | RECOVERABLE (terminal) — IF final angles + configuration are persisted |
| Recovery action | Terminal recovery |
| Classification | Recoverable (terminal) |
| Rationale | Physics is `STOPPED`. Winner can be recomputed via `WinnerEngine.resolveResult` if configuration + final angles are persisted. If `SETTLEMENT` exists, recomputed winner must match `SETTLEMENT.winnerId`. If final angles or configuration are NOT persisted → FAIL CLOSED. |

#### I. SETTLEMENT (SETTLEMENT record exists)

| Property | Value |
|----------|-------|
| Financial records exist? | YES — `SETTLEMENT` record exists |
| Gameplay reconstructable? | NOT NEEDED — gameplay is complete |
| Recovery action | FINANCIAL RECOVERY ONLY |
| Classification | Terminal |
| Rationale | `TonFinancialRecovery` already restores settlement sessions and re-registers settlement watches. No gameplay reconstruction needed. |

### 14.2 Eligibility Summary

| State | Classification |
|-------|---------------|
| A. SETUP / ROOM | Terminal (discard) |
| B. PAYMENT | Recoverable (financial only) |
| C. PRE_GAME_READY | Recoverable only by reconstruction (with conditions) |
| D. READY | Recoverable only by reconstruction (with conditions) |
| E. SELF_TEST | Recoverable only by reconstruction (with conditions) |
| F. SPEED | FAIL CLOSED |
| G. BRAKE | FAIL CLOSED |
| H. RESULT | Recoverable (terminal) |
| I. SETTLEMENT | Terminal |

### 14.3 Critical Note on Active Gameplay

An active `SPEED` or `BRAKE` game is NOT recoverable if authoritative physics state is unavailable. The current architecture does NOT persist physics state, command logs, or deltaTime sequences. Therefore, `SPEED` and `BRAKE` phases MUST FAIL CLOSED.

`SELF_TEST` phase is borderline — it involves physics motion (self-test velocities) but no player input. If physics state (angles, velocities) were persisted, it could theoretically be reconstructed. However, since physics state is NOT currently persisted, `SELF_TEST` also FAILS CLOSED unless the recovery contract is implemented with physics state persistence.

---

## 15. INTEGRITY RULES

### 15.1 Integrity Checks

| Check | Description | Mismatch causes FAIL CLOSED? |
|-------|-------------|------------------------------|
| Record checksum | SHA-256 checksum of the recovery record payload. Must match on load. | YES — corrupted record |
| `configurationHash` | Hash of the full committed configuration. Must match on reconstruction. | YES — configuration mismatch |
| `snapshotHash` | SHA-256 hash of the financial snapshot. Must match `GAME_CONTRACT.snapshotHash`. | YES — financial snapshot mismatch |
| `gameId` consistency | `gameId` must match across `GAME_CONTRACT`, `PAYMENT_SESSION`, `SETTLEMENT`, and recovery contract. | YES — identity corruption |
| `roomId` consistency | `roomId` must match across `GAME_CONTRACT`, `PAYMENT_SESSION`, `SETTLEMENT`, and recovery contract. | YES — identity corruption |
| `playerId` consistency | `playerId` values must match `PAYMENT_SESSION.participants[].playerId`. | YES — identity corruption |
| `playerIndex` consistency | `playerIndex` values must match `PAYMENT_SESSION.participants[].playerIndex`. | YES — seat assignment corruption |
| `contractId` consistency | `contractId` must match `GAME_CONTRACT` record. | YES — contract corruption |
| GameEscrow consistency | Payment status in recovery contract must be consistent with GameEscrow on-chain `paidMask`. | YES — financial truth violation |
| Payment consistency | Payment status must match `PAYMENT_SESSION.participants[].status` after `syncFromGameEscrow`. | YES — payment state mismatch |
| Phase consistency | `GameState` phase must match `GameClockEngine.currentPhase`. | YES — state corruption |
| Physics/configuration consistency | Physics parameters must match `DEFAULT_PHYSICS_PARAMETERS`. Configuration must be immutable (frozen). | YES — configuration mutation |
| Winner consistency (if SETTLEMENT exists) | Recomputed `winnerPlayerId` must match `SETTLEMENT.winnerId`. | YES — winner mismatch |
| `traceSeed` consistency (if SETTLEMENT exists) | Configuration `traceSeed` must match `SETTLEMENT.traceSeed`. | YES — trace seed mismatch |
| `tonNetwork` consistency | `tonNetwork` must match across `GAME_CONTRACT`, `PAYMENT_SESSION`, and recovery contract. | YES — network mismatch |
| Schema version | Recovery contract schema version must be compatible. | YES — incompatible version |

### 15.2 FAIL CLOSED Triggers

The following mismatches cause immediate FAIL CLOSED for the affected recovery candidate:

1. Checksum mismatch → corrupted record.
2. `configurationHash` mismatch → configuration was mutated or incorrectly persisted.
3. `snapshotHash` mismatch → financial snapshot does not match `GAME_CONTRACT`.
4. `gameId` mismatch across records → identity corruption.
5. `roomId` mismatch across records → identity corruption.
6. `playerId` mismatch → player identity corruption.
7. `playerIndex` mismatch → seat assignment corruption.
8. `contractId` mismatch → contract corruption.
9. GameEscrow `paidMask` mismatch after sync → financial truth violation.
10. Phase inconsistency between `GameState` and `GameClockEngine` → state corruption.
11. Winner mismatch (recomputed winner ≠ `SETTLEMENT.winnerId`) → winner corruption.
12. `traceSeed` mismatch → configuration reproduction failure.
13. Schema version incompatibility → incompatible recovery contract version.

---

## 16. FAIL-CLOSED RULE

### 16.1 Explicit Prohibitions

Recovery MUST NOT:

1. **Invent missing configuration.** If the full committed configuration is not available (persisted or reproducible from persisted `randomService` outputs), the recovery must FAIL CLOSED. A new configuration must NOT be generated via `buildConfiguration` with new `randomService` outputs.

2. **Generate a replacement `gameId`.** The original `gameId` from financial records must be preserved. `createGame` always generates a new `gameId` and must NOT be used for recovery. If the original `gameId` cannot be preserved → FAIL CLOSED.

3. **Generate a replacement `roomId`.** The original `roomId` from financial records must be preserved. `createRoom` always generates a new `roomId` and must NOT be used for recovery. If the original `roomId` cannot be preserved → FAIL CLOSED.

4. **Generate replacement `playerId`s.** The original `playerId` values from `PAYMENT_SESSION.participants` must be preserved. If any `playerId` cannot be preserved → FAIL CLOSED.

5. **Guess `GameState`.** The current game phase must NOT be guessed. If the `GameState` phase is not persisted → FAIL CLOSED.

6. **Guess physics state.** The physics state (angles, velocities, simulation state) must NOT be guessed. If physics state is not persisted and cannot be deterministically replayed → FAIL CLOSED.

7. **Silently restart a game.** A game must NOT be silently restarted from the beginning if it was in an active phase. This would lose all progress and produce a different outcome.

8. **Silently create a new game from an old financial record.** A new game must NOT be created using the `gameId` from an old financial record if the original game's state cannot be reconstructed. The financial record references the original game, not a new one.

9. **Override GameEscrow truth.** GameEscrow / TON blockchain is authoritative for payment and refund truth. The recovery contract must NEVER override financial truth. If gameplay state conflicts with financial truth → FAIL CLOSED for gameplay.

10. **Persist arbitrary runtime object graphs.** The recovery contract must NOT persist `setTimeout` handles, `Map` references, transient motion flags, or other non-serializable runtime state. Only durable authoritative data should be persisted.

11. **Bypass validation.** All integrity checks (Section 15) must be performed. No check may be skipped.

12. **Assume deterministic recomputation is safe without all inputs.** Configuration recomputation via `buildConfiguration` is NOT safe unless ALL original `randomService` outputs are available. Winner recomputation via `resolveResult` is safe ONLY if configuration + final physics state are available.

---

## 17. MINIMUM RECOVERY CONTRACT

### 17.A Identity

| Field | Type | Required? | Authoritative source | Immutable? | Derivable? | Purpose |
|-------|------|-----------|---------------------|------------|------------|---------|
| `recoveryRecordId` | `string` | REQUIRED | Recovery Data Contract persistence | Immutable | No | Unique recovery record identifier |
| `roomId` | `string` | REQUIRED | `GAME_CONTRACT` / `PAYMENT_SESSION` / `SETTLEMENT` | Immutable | No | Room identity |
| `gameId` | `string` | REQUIRED | `GAME_CONTRACT` / `PAYMENT_SESSION` / `SETTLEMENT` | Immutable | No | Game identity |
| `contractId` | `string` | REQUIRED | `GAME_CONTRACT` | Immutable | No | Contract identity |
| `paymentSessionId` | `string` | REQUIRED | `PAYMENT_SESSION` | Immutable | No | Payment session identity |
| `correlationId` | `string \| null` | OPTIONAL | `GAME_CONTRACT` / `PAYMENT_SESSION` | Immutable | No | Audit tracing |
| `tonNetwork` | `string` | REQUIRED | `GAME_CONTRACT.tonNetwork` | Immutable | No | TON network identifier |

### 17.B Players

| Field | Type | Required? | Authoritative source | Immutable? | Derivable? | Purpose |
|-------|------|-----------|---------------------|------------|------------|---------|
| `players[].playerId` | `string` | REQUIRED | `PAYMENT_SESSION.participants[].playerId` | Immutable | No | Player identity |
| `players[].playerIndex` | `number` | REQUIRED | `PAYMENT_SESSION.participants[].playerIndex` | Immutable | No | Seat index for GameEscrow paidMask |
| `players[].wallet` | `string` | REQUIRED | `PAYMENT_SESSION.participants[].wallet` | Immutable | No | Player wallet address |
| `players[].nickname` | `string \| null` | REQUIRED | `PlayerIdentity.nickname` (CURRENTLY MISSING) | Immutable | No | Player display name |
| `players[].baseStake` | `number` | REQUIRED | `PlayerIdentity.baseStake` | Immutable | No | Base stake |
| `players[].sectorCount` | `number` | REQUIRED | `PlayerIdentity.sectorCount` | Immutable | No | Number of sectors (1 or 2) |
| `players[].color` | `string` | REQUIRED | `PlayerIdentity.color` (CURRENTLY MISSING) | Immutable | No | Player color |
| `players[].colorSector2` | `string \| null` | REQUIRED | `PlayerIdentity.colorSector2` (CURRENTLY MISSING) | Immutable | No | Second color (if sectorCount=2) |
| `players[].icon` | `string \| null` | REQUIRED | `PlayerIdentity.icon` | Immutable | No | Player icon |
| `players[].sectorArrangement` | `string \| null` | REQUIRED | `PlayerIdentity.sectorArrangement` (CURRENTLY MISSING) | Immutable | No | Sector arrangement pattern |
| `players[].age` | `number \| null` | REQUIRED | `PlayerIdentity.age` (CURRENTLY MISSING) | Immutable | No | Player profile field |

### 17.C Immutable Configuration

| Field | Type | Required? | Authoritative source | Immutable? | Derivable? | Purpose |
|-------|------|-----------|---------------------|------------|------------|---------|
| `configuration` (full frozen object) | `object` | REQUIRED | `ConfigurationEngine._configurations[gameId]` (CURRENTLY MISSING) | Immutable | No — cannot be regenerated | Full committed game configuration |
| `configurationHash` | `string` | REQUIRED | Recovery Data Contract (CURRENTLY MISSING) | Immutable | No | Hash of full configuration for integrity verification |
| `configurationVersion` | `string` | REQUIRED | `CONFIGURATION_VERSION` constant | Immutable | Yes — static constant | Configuration schema version |
| `traceSeed` | `string` | REQUIRED | Configuration object / `SETTLEMENT.traceSeed` | Immutable | No — `randomService` output | Configuration trace seed |
| `snapshotHash` | `string` | REQUIRED (validation) | `GAME_CONTRACT.snapshotHash` | Immutable | No | Financial snapshot hash for integrity verification |

**Note:** The full frozen configuration object contains `sectors[]`, `players[]` (configuration player data), `wheel.startAngle`, `triangle.startAngle`, `polarAxis`, `baseStake`, and all other configuration fields. Persisting the full object is preferred over persisting individual fields.

### 17.D Gameplay State

| Field | Type | Required? | Authoritative source | Immutable? | Derivable? | Purpose |
|-------|------|-----------|---------------------|------------|------------|---------|
| `gameState` (current phase) | `string` | REQUIRED | `GameStateEngine._states[gameId].currentState` (CURRENTLY MISSING) | Mutable | No | Current game phase |
| `gameStatus` | `string` | REQUIRED | `GameManager._games[gameId].status` (CURRENTLY MISSING) | Mutable | No | Game lifecycle status |
| `phaseStartedAt` | `number` | REQUIRED (active) | `GameClockEngine._clocks[gameId].phaseStartedAt` (CURRENTLY MISSING) | Mutable | No | When current phase started |
| `gameStateEnteredAt` | `number` | REQUIRED (active) | `GameStateEngine._states[gameId].enteredAt` (CURRENTLY MISSING) | Mutable | No | When current state was entered |

### 17.E Physics / Replay State

| Field | Type | Required? | Authoritative source | Immutable? | Derivable? | Purpose |
|-------|------|-----------|---------------------|------------|------------|---------|
| `physicsFinalAngle` (wheel) | `number` | REQUIRED (terminal) | `PhysicsEngine.runtime.angle` at STOPPED (CURRENTLY MISSING) | Immutable (terminal) | No | Final wheel angle for winner recomputation |
| `physicsFinalTriangleAngle` | `number` | REQUIRED (terminal) | `PhysicsEngine.runtime.triangleAngle` at STOPPED (CURRENTLY MISSING) | Immutable (terminal) | No | Final triangle angle for winner recomputation |
| `physicsSimulationState` | `string` | REQUIRED (terminal) | `PhysicsEngine.runtime.state` (CURRENTLY MISSING) | Immutable (terminal) | No | Must be `STOPPED` for terminal games |

**Note:** For active games, physics state is NOT persisted (FAIL CLOSED). The above fields are only for terminal games.

### 17.F Clock State

| Field | Type | Required? | Authoritative source | Immutable? | Derivable? | Purpose |
|-------|------|-----------|---------------------|------------|------------|---------|
| `clockStartedAt` | `number` | REQUIRED (active) | `GameClockEngine._clocks[gameId].startedAt` (CURRENTLY MISSING) | Immutable | No | When clock was started |
| `clockPaused` | `boolean` | REQUIRED (active) | `GameClockEngine._clocks[gameId].paused` (CURRENTLY MISSING) | Mutable | No | Whether clock is paused |
| `clockTotalPausedMs` | `number` | REQUIRED (active) | `GameClockEngine._clocks[gameId].totalPausedMs` (CURRENTLY MISSING) | Mutable | No | Total paused time |
| `clockAwaitingResultActivation` | `boolean` | REQUIRED (active, BRAKE) | `GameClockEngine._clocks[gameId].awaitingResultActivation` (CURRENTLY MISSING) | Mutable | No | BRAKE→RESULT gate |
| `clockResultPhaseStarted` | `boolean` | REQUIRED (active, RESULT) | `GameClockEngine._clocks[gameId].resultPhaseStarted` (CURRENTLY MISSING) | Mutable | No | Whether RESULT phase started |
| `serverTimestampAtCheckpoint` | `number` | REQUIRED | Recovery Data Contract (CURRENTLY MISSING) | Immutable | No | Server time when checkpoint was taken |

### 17.G Input State

| Field | Type | Required? | Authoritative source | Immutable? | Derivable? | Purpose |
|-------|------|-----------|---------------------|------------|------------|---------|
| (none) | — | — | — | — | — | For terminal games: not needed. For active games: FAIL CLOSED. |

**Note:** Input authority state is NOT part of the minimum recovery contract because:

- Terminal games: input state is not needed (winner is recomputed from final physics state).
- Active games: FAIL CLOSED — no reconstruction attempted.

### 17.H Winner / Result

| Field | Type | Required? | Authoritative source | Immutable? | Derivable? | Purpose |
|-------|------|-----------|---------------------|------------|------------|---------|
| (none — recomputed) | — | — | — | — | Yes (terminal) | Winner result is deterministically recomputable via `WinnerEngine.resolveResult` from configuration + final physics state. |

**Note:** The winner result does NOT need to be persisted because `WinnerEngine.resolveResult` is deterministic and idempotent. If configuration + final physics angles are persisted, the winner can be recomputed. If `SETTLEMENT` exists, the recomputed winner must match `SETTLEMENT.winnerId` (validation).

### 17.I Financial References

| Field | Type | Required? | Authoritative source | Immutable? | Derivable? | Purpose |
|-------|------|-----------|---------------------|------------|------------|---------|
| `contractId` | `string` | REQUIRED | `GAME_CONTRACT` | Immutable | No | Links to financial contract (already in Identity) |
| `paymentSessionId` | `string` | REQUIRED | `PAYMENT_SESSION` | Immutable | No | Links to payment session (already in Identity) |
| `contractAddress` | `string \| null` | REQUIRED (validation) | `GAME_CONTRACT.contractAddress` | Immutable | No | On-chain GameEscrow address |
| `snapshotHash` | `string` | REQUIRED (validation) | `GAME_CONTRACT.snapshotHash` | Immutable | No | Financial snapshot integrity (already in Configuration) |
| `winnerId` (if SETTLEMENT exists) | `string \| null` | OPTIONAL (validation) | `SETTLEMENT.winnerId` | Immutable | No | Winner identity for validation |
| `traceSeed` (SETTLEMENT) | `string \| null` | OPTIONAL (validation) | `SETTLEMENT.traceSeed` | Immutable | No | Trace seed for cross-validation |

**Note:** These are REFERENCES to financial records, not duplicates. The financial records are already persisted and restored by `TonFinancialRecovery`.

### 17.J Integrity / Versioning

| Field | Type | Required? | Authoritative source | Immutable? | Derivable? | Purpose |
|-------|------|-----------|---------------------|------------|------------|---------|
| `recoveryContractVersion` | `number` | REQUIRED | Recovery Data Contract | Immutable | No | Recovery contract schema version |
| `schemaVersion` | `number` | REQUIRED | Recovery Data Contract | Immutable | No | Persistence schema version |
| `configurationVersion` | `string` | REQUIRED | `CONFIGURATION_VERSION` | Immutable | Yes | Configuration schema version |
| `checksum` | `string` | REQUIRED | Computed (SHA-256 of payload) | Immutable | No | Record integrity |
| `createdAt` | `number` | REQUIRED | Recovery Data Contract | Immutable | No | When recovery record was created |
| `updatedAt` | `number` | REQUIRED | Recovery Data Contract | Mutable | No | When recovery record was last updated |

---

## 18. CURRENTLY MISSING DATA

### CURRENTLY MISSING FOR SAFE RECOVERY

The following data is required for safe recovery but does NOT currently exist in any persisted source. Only items where the required authoritative inputs already exist are classified as DERIVABLE.

#### 1. Full Immutable Game Configuration

| Data item | Status | Notes |
|-----------|--------|-------|
| Full frozen configuration object | CURRENTLY MISSING | Stored only in `ConfigurationEngine._configurations[gameId]` in-memory. NOT persisted. |
| `traceSeed` | PARTIALLY AVAILABLE | In `SETTLEMENT.traceSeed` for completed games only. NOT available for active games. |
| `wheel.startAngle` | CURRENTLY MISSING | `randomService` output. NOT in any financial record. |
| `triangle.startAngle` | CURRENTLY MISSING | `randomService` output. NOT in any financial record. |
| `polarAxis` | CURRENTLY MISSING | Part of configuration object. NOT in any financial record. |
| `configurationHash` | CURRENTLY MISSING | No dedicated configuration hash exists. `snapshotHash` is a financial snapshot hash, NOT a configuration hash. |
| `configurationVersion` | DERIVABLE | `CONFIGURATION_VERSION` static constant. Available at recovery time. |
| Wheel layout / sectors | PARTIALLY AVAILABLE | In `SNAPSHOT.sectors[]` when configuration existed at snapshot creation time. May be empty `[]`. |

#### 2. Complete Player Identity Data

| Data item | Status | Notes |
|-----------|--------|-------|
| `nickname` | PARTIALLY AVAILABLE | In `SNAPSHOT.players[].nickname`. |
| `baseStake` | PARTIALLY AVAILABLE | In `SNAPSHOT.players[].baseStake` + `SNAPSHOT.baseStake`. |
| `sectorCount` | PARTIALLY AVAILABLE | In `SNAPSHOT.players[].sectorCount`. |
| `color` | PARTIALLY AVAILABLE | In `SNAPSHOT.players[].colors[]` (array, not distinct field). |
| `colorSector2` | CURRENTLY MISSING | NOT present as distinct field. May be second entry in `colors[]` if `sectorCount=2`, but this is not guaranteed. |
| `icon` | PARTIALLY AVAILABLE | In `SNAPSHOT.players[].icon`. |
| `sectorArrangement` | CURRENTLY MISSING | NOT in any financial record. |
| `age` | CURRENTLY MISSING | NOT in any financial record. |
| `playerIndex` | AVAILABLE | In `PAYMENT_SESSION.participants[].playerIndex`. |

#### 3. Game State

| Data item | Status | Notes |
|-----------|--------|-------|
| Current `GameState` phase | CURRENTLY MISSING | NOT persisted. `GameStateEngine._states` is in-memory only. |
| `GAME_STATUS` lifecycle status | CURRENTLY MISSING | NOT persisted. `GameManager._games` is in-memory only. |
| Phase start timestamp | CURRENTLY MISSING | NOT persisted. |
| Phase transition history | CURRENTLY MISSING | NOT persisted. (Required only for validation.) |

#### 4. Physics State (Terminal Games)

| Data item | Status | Notes |
|-----------|--------|-------|
| Final wheel angle | CURRENTLY MISSING | NOT persisted. `PhysicsEngine._simulations` is in-memory only. |
| Final triangle angle | CURRENTLY MISSING | NOT persisted. |
| Simulation state (`STOPPED`) | CURRENTLY MISSING | NOT persisted. |

#### 5. Game Clock State

| Data item | Status | Notes |
|-----------|--------|-------|
| `currentPhase` | CURRENTLY MISSING | NOT persisted. (Can be sourced from `GameState` phase if game state is persisted.) |
| `startedAt` | CURRENTLY MISSING | NOT persisted. |
| `paused` | CURRENTLY MISSING | NOT persisted. |
| `totalPausedMs` | CURRENTLY MISSING | NOT persisted. |
| `phaseStartedAt` | CURRENTLY MISSING | NOT persisted. |
| `awaitingResultActivation` | CURRENTLY MISSING | NOT persisted. |
| `resultPhaseStarted` | CURRENTLY MISSING | NOT persisted. |
| `frozenTimers` | DERIVABLE | From `gameCatalog.getTimers()` if catalog version matches. **INSUFFICIENT INFORMATION** on whether catalog version is persisted. |
| Server timestamp at checkpoint | CURRENTLY MISSING | NOT persisted. |

#### 6. Input Authority State

| Data item | Status | Notes |
|-----------|--------|-------|
| `pressCount` | CURRENTLY MISSING | NOT persisted. (Not needed for terminal games.) |
| `locked` | CURRENTLY MISSING | NOT persisted. (Not needed for terminal games.) |
| `commandQueue` | CURRENTLY MISSING | NOT persisted. (Not needed for terminal games.) |
| `acceptedCommands` | CURRENTLY MISSING | NOT persisted. (Not needed for terminal games.) |
| `sequenceNumber` | CURRENTLY MISSING | NOT persisted. (Not needed for terminal games.) |
| `_speedInputClosed` | CURRENTLY MISSING | NOT persisted. (Not needed for terminal games.) |

#### 7. Winner Result

| Data item | Status | Notes |
|-----------|--------|-------|
| Winning sector | DERIVABLE (terminal) | Recomputable via `WinnerEngine.resolveResult` if configuration + final angles available. |
| Winning player | DERIVABLE (terminal) | Recomputable. |
| Final angles | CURRENTLY MISSING | NOT persisted. Needed for recomputation. |
| `resolvedAt` | CURRENTLY MISSING | NOT persisted. (Required only for validation.) |

#### 8. Recovery Contract Infrastructure

| Data item | Status | Notes |
|-----------|--------|-------|
| `recoveryRecordId` | CURRENTLY MISSING | No recovery contract persistence exists. |
| `recoveryContractVersion` | CURRENTLY MISSING | No recovery contract versioning exists. |
| `checksum` | CURRENTLY MISSING | No recovery contract checksum exists. |
| `configurationHash` | CURRENTLY MISSING | No dedicated configuration hash exists. |

### 18.1 Summary of Missing Data

The recovery contract is **NOT currently satisfiable** for active gameplay reconstruction. It is **partially satisfiable** for:

- Identity reconstruction (from financial records).
- Terminal-state reconciliation (if final angles + configuration are persisted).

The recovery contract is **NOT satisfiable** for:

- Active gameplay reconstruction (SPEED/BRAKE phases) — FAIL CLOSED.
- Configuration reconstruction (without persisting the full configuration or all `randomService` outputs).
- Physics state reconstruction (without persisting final angles for terminal games).

---

## 19. CONTRACT VERSIONING

### 19.1 Architecture-Level Requirements

| Requirement | Description |
|-------------|-------------|
| `recoveryContractVersion` | A numeric version field identifying the Recovery Data Contract schema. Must be persisted with every recovery record. Initial version: `1`. |
| `configurationVersion` | The `CONFIGURATION_VERSION` from `./configuration/ConfigurationVersion.js`. Identifies the configuration schema version used when the configuration was originally committed. Must match at recovery time. |
| `schemaVersion` | The persistence schema version (currently `TON_FINANCIAL_SCHEMA_VERSION = 1` for financial records). The recovery contract should have its own schema version or extend the financial schema version. |
| Forward compatibility | The recovery contract must be designed to support forward compatibility. Unknown fields in future versions must be preserved (not discarded) but not interpreted by older versions. |
| Unknown-field handling | Unknown fields in recovery records must be tolerated (not cause failure) if the `recoveryContractVersion` is compatible. Unknown fields must NOT be silently dropped. |
| Incompatible version handling | If `recoveryContractVersion` is incompatible (e.g., a future version with breaking changes), the recovery must FAIL CLOSED for that record. The financial recovery pipeline continues independently. |
| Catalog version | The catalog version (from `gameCatalog.getCatalogVersion()`) must be recorded in the recovery contract to verify that `frozenTimers` and other catalog-derived data are consistent between original game creation and recovery. **INSUFFICIENT INFORMATION** on whether catalog version is currently persisted. |

### 19.2 Versioning Strategy

- **Major version changes** (breaking changes to the contract schema): MUST FAIL CLOSED for records with incompatible versions. Financial recovery continues.
- **Minor version changes** (additive changes): Unknown fields must be tolerated. Recovery proceeds.
- **Configuration version mismatch**: MUST FAIL CLOSED. The configuration schema version must match.
- **Schema version mismatch**: MUST FAIL CLOSED. The persistence schema version must be compatible.

### 19.3 No Implementation

This section defines architecture-level requirements only. No versioning mechanism is implemented in this report.

---

## 20. STORAGE PRINCIPLE

### 20.1 Proposed Storage Architecture

> Persist a small durable authoritative Recovery Data Contract.
>
> Do NOT persist arbitrary runtime object graphs.
>
> Use deterministic reconstruction/replay only when the contract contains all authoritative inputs required to reproduce the exact state.
>
> Otherwise: FAIL CLOSED.

### 20.2 Compatibility Assessment

| Principle | Compatible? | Rationale |
|-----------|-------------|-----------|
| Server Authoritative architecture | COMPATIBLE | Reconstruction is performed server-side. Server remains the single source of truth. Client never owns authoritative gameplay state. |
| Deterministic gameplay | COMPATIBLE WITH CONDITIONS | Deterministic reconstruction is safe for terminal games where `WinnerEngine.resolveResult` is deterministic and idempotent. For active games, deterministic reconstruction is NOT safe because current phase, physics state, clock state, and input state are unknown. |
| Financial authority | COMPATIBLE | GameEscrow / TON remains authoritative for payment and refund truth. Gameplay recovery validates against financial truth and never overrides it. |
| Immutable configuration | COMPATIBLE WITH CONDITIONS | If the committed configuration is persisted as durable recovery data (not regenerated), immutability is preserved. Regeneration via `buildConfiguration` with new `randomService` outputs would produce a different configuration. |
| Fail-closed financial safety | COMPATIBLE | The architecture explicitly states "FAIL CLOSED when authoritative information is insufficient." |
| Original ID preservation | COMPATIBLE WITH CONDITIONS | Original IDs are available from financial persistence. Attach/restore methods that preserve original IDs must be added. |
| No arbitrary runtime object graphs | COMPATIBLE | The contract persists only durable authoritative data (configuration, identity, game state, final angles, clock state). It does NOT persist `setTimeout` handles, `Map` references, transient motion flags, or other non-serializable state. |

### 20.3 What Must NOT Be Persisted

| Data | Reason |
|------|--------|
| `setTimeout` handles | Non-serializable. Re-scheduled on recovery. |
| `Map` / `Set` internal references | Implementation details. Not authoritative data. |
| Transient motion flags (`braking`, `selfTestActive`, `speedActive`, `brakeActive`, `physicsStoppedEmitted`) | Transient state. Not needed for terminal recovery. Not safe for active recovery (FAIL CLOSED). |
| `timeoutHandle` | Non-serializable `setTimeout` reference. |
| Player runtime state (`connectionState`, `playerState`, `ping`, `connectedAt`, `lastSeen`) | Transient. Re-established on reconnect. |
| Button state (`buttonPressed`, `lastPressTime`, `lastReleaseAt`, `cooldownUntil`) | Transient. Not needed for terminal recovery. Not safe for active recovery (FAIL CLOSED). |
| `commandQueue` / `acceptedCommands` / `sequenceNumber` | Not needed for terminal recovery. Not safe for active recovery (FAIL CLOSED). |
| `commandLog` (physics) | Not needed for terminal recovery. Not safe for active recovery (FAIL CLOSED). |
| Phase transition history | Required only for validation, not for resume. Optional. |
| Clock `history[]` | Required only for validation, not for resume. Optional. |

### 20.4 Verdict

The proposed storage architecture is **COMPATIBLE** with WheelWin, provided that:

1. Only durable authoritative data is persisted (not arbitrary runtime object graphs).
2. Deterministic reconstruction is used only when all authoritative inputs are available.
3. FAIL CLOSED is enforced when information is insufficient.
4. Original IDs are preserved (no replacement IDs).
5. Configuration is persisted as a frozen object (not regenerated).
6. Financial truth remains authoritative.

---

## 21. IMPLEMENTATION BOUNDARY

No implementation is performed in this report. The following future implementation stages are identified only.

### R17.9T.6-C — Recovery Data Persistence

- **Objective:** Implement the persistence mechanism for the Recovery Data Contract.
- **Dependencies:** This report (R17.9T.6-B). Approval of the architecture decision (Section 22).
- **Validation criteria:**
  - Recovery records are persisted durably (survive server restart).
  - Atomic writes (temp file + rename).
  - Checksum integrity on every record.
  - Schema versioning (`recoveryContractVersion`, `schemaVersion`).
  - Records are immutable for terminal games.
  - Records are updatable for active games (game state, clock state changes).
- **Rollback/fail-closed behavior:** If persistence fails, the game continues in-memory (no crash). The lack of a persisted recovery record means the game is NOT recoverable after restart. This is acceptable — it is the current behavior.

### R17.9T.6-D — Identity / Room / Game Reconstruction

- **Objective:** Implement `attachExistingRoom()`, `attachExistingGame()`, and player identity restoration methods that preserve original IDs.
- **Dependencies:** R17.9T.6-C.
- **Validation criteria:**
  - Reconstructed `roomId` matches financial records.
  - Reconstructed `gameId` matches financial records.
  - Reconstructed `playerId` values match `PAYMENT_SESSION.participants`.
  - Reconstructed `playerIndex` values match `PAYMENT_SESSION.participants[].playerIndex`.
  - No replacement IDs are generated.
  - `createRoom` / `createGame` / `createPlayer` are NOT used for recovery.
- **Rollback/fail-closed behavior:** If any ID cannot be preserved → FAIL CLOSED for that candidate. Financial recovery continues.

### R17.9T.6-E — Configuration Reconstruction

- **Objective:** Implement `ConfigurationEngine` restore/attach method that reconstructs the committed configuration from persisted recovery data.
- **Dependencies:** R17.9T.6-C, R17.9T.6-D.
- **Validation criteria:**
  - Reconstructed configuration is the exact frozen object from the recovery contract.
  - `configurationHash` matches.
  - Configuration is NOT regenerated via `buildConfiguration`.
  - `snapshotHash` matches `GAME_CONTRACT.snapshotHash`.
  - `traceSeed` matches `SETTLEMENT.traceSeed` (if SETTLEMENT exists).
  - Configuration is immutable after reconstruction.
- **Rollback/fail-closed behavior:** If configuration cannot be fully reconstructed → FAIL CLOSED. If `configurationHash` or `snapshotHash` mismatch → FAIL CLOSED.

### R17.9T.6-F — Gameplay Runtime Reconstruction

- **Objective:** Implement reconstruction methods for `GameStateEngine`, `PhysicsEngine`, `GameClockEngine`, `InputAuthority`, `WinnerEngine`.
- **Dependencies:** R17.9T.6-C, R17.9T.6-D, R17.9T.6-E.
- **Validation criteria:**
  - For terminal games: `PhysicsEngine` reconstructed to `STOPPED` with final angles; `WinnerEngine.resolveResult` recomputes winner; recomputed winner matches `SETTLEMENT.winnerId` (if SETTLEMENT exists).
  - For active games: FAIL CLOSED (no reconstruction attempted for SPEED/BRAKE).
  - All coupled engine states are reconstructed for the same `gameId`.
  - `GameState` phase matches `GameClockEngine.currentPhase`.
- **Rollback/fail-closed behavior:** If any engine state cannot be safely reconstructed → FAIL CLOSED. If phase inconsistency → FAIL CLOSED. If winner mismatch → FAIL CLOSED.

### R17.9T.6-G — Financial ↔ Gameplay Reconciliation

- **Objective:** Implement cross-domain validation between reconstructed gameplay state and restored financial state.
- **Dependencies:** R17.9T.6-D, R17.9T.6-E, R17.9T.6-F.
- **Validation criteria:**
  - `roomId` matches across `GAME_CONTRACT`, `PAYMENT_SESSION`, `SETTLEMENT`, and recovery contract.
  - `gameId` matches across all records.
  - `playerId` values match `PAYMENT_SESSION.participants`.
  - `playerIndex` values match `PAYMENT_SESSION.participants[].playerIndex`.
  - `snapshotHash` matches `GAME_CONTRACT.snapshotHash`.
  - If `SETTLEMENT` exists, recomputed winner matches `SETTLEMENT.winnerId`.
  - Payment status matches GameEscrow on-chain state.
  - GameEscrow / TON remains authoritative.
- **Rollback/fail-closed behavior:** If any cross-domain check fails → FAIL CLOSED. Financial recovery continues independently. No gameplay state is invented.

### R17.9T.6-H — Restart / Recovery Validation

- **Objective:** Implement the end-to-end recovery validation sequence and failure handling.
- **Dependencies:** R17.9T.6-D, R17.9T.6-E, R17.9T.6-F, R17.9T.6-G.
- **Validation criteria:**
  - All transitions in the recovery sequence are validated.
  - All failure modes fail closed.
  - Financial recovery proceeds independently of gameplay reconstruction.
  - No gameplay state is invented.
  - Recovery candidate discovery correctly identifies terminal, pre-game, and active game candidates.
  - Active game candidates (SPEED/BRAKE) are correctly classified as FAIL CLOSED.
- **Rollback/fail-closed behavior:** Any validation failure → FAIL CLOSED for the affected candidate. Financial recovery continues. Server starts with financial state restored and gameplay state empty for failed candidates.

---

## 22. ARCHITECTURE DECISION

### Verdict: APPROVED WITH CONDITIONS

The Recovery Data Contract is architecturally compatible with WheelWin's server-authoritative, deterministic, fail-closed principles. The contract defines the minimum durable authoritative data required to safely reconstruct gameplay runtime after `SERVER_RESTART`, while explicitly prohibiting the persistence of arbitrary runtime object graphs and the invention of missing state.

### Conditions

1. **Active gameplay reconstruction must be prohibited.** Games in active gameplay phases (`SPEED`, `BRAKE`) must NOT be reconstructed. The current phase, physics state, clock state, and input state are all unknown and not persisted. Only terminal games (where physics is `STOPPED` and final angles are available) may be reconstructed.

2. **The full committed configuration must be persisted.** The configuration must be persisted as a frozen object (Option A, Section 6.3), NOT regenerated via `buildConfiguration` with new `randomService` outputs. The `randomService` outputs (`traceSeed`, `wheel.startAngle`, `triangle.startAngle`) are not persisted (except `traceSeed` in `SETTLEMENT` for completed games) and cannot be reproduced. A dedicated `configurationHash` must be persisted for integrity verification.

3. **Complete player identity data must be persisted.** The `PlayerIdentity` fields (`nickname`, `color`, `colorSector2`, `sectorArrangement`, `age`) that are NOT in any financial record must be added to the recovery contract. Without these fields, configuration reconstruction is not possible.

4. **Attach/restore methods must preserve original IDs.** `attachExistingRoom()`, `attachExistingGame()`, and player identity restoration must preserve the original `roomId`, `gameId`, and `playerId` from financial records. `createRoom` / `createGame` / `createPlayer` must NOT be used for recovery. Recovery must NEVER silently create replacement IDs.

5. **Financial truth must remain authoritative.** GameEscrow / TON remains the authoritative source for payment and refund truth. Gameplay recovery must validate against financial truth and must never override it. If financial truth and gameplay state conflict, gameplay FAILS CLOSED.

6. **All failure modes must fail closed.** Every failure mode identified in Section 16 must result in FAIL CLOSED for gameplay reconstruction. Financial recovery continues independently. No gameplay state is invented.

7. **The coupled bootstrap must be respected.** `GameManager` bootstraps `ConfigurationEngine`, `GameStateEngine`, `PhysicsEngine`, `GameClockEngine`, and `InputAuthority` as a coupled set per `gameId`. Reconstruction of any one engine's state for a `gameId` requires all five to be reconstructed. Partial reconstruction is unsafe.

8. **Terminal game recovery requires final physics angles.** For terminal games (RESULT phase, physics STOPPED), the final wheel angle and final triangle angle must be persisted. Without these, `WinnerEngine.resolveResult` cannot recompute the winner. If final angles are not available → FAIL CLOSED.

9. **Clock state must be persisted for recoverable phases.** For phases that are recoverable by reconstruction (`PRE_GAME_READY`, `READY`, `SELF_TEST`), the clock state (`currentPhase`, `startedAt`, `paused`, `totalPausedMs`, `phaseStartedAt`) must be persisted. Without clock state, the game cannot be resumed at the correct point.

10. **Recovery contract versioning must be implemented.** The `recoveryContractVersion`, `configurationVersion`, and `schemaVersion` must be persisted with every recovery record. Incompatible versions must cause FAIL CLOSED.

Do not implement any condition in this report.

---

## 23. Lifecycle Flow

### 23.1 Recovery Contract Creation Flow

```text
Game lifecycle event (configuration committed / phase transition / game completion)
        |
        v
Recovery Data Contract updated
  → identity fields (immutable, set once)
  → configuration (immutable, set at commit time)
  → game state (mutable, updated on phase transitions)
  → clock state (mutable, updated on phase transitions)
  → physics final angles (immutable, set at STOPPED)
  → server timestamp at checkpoint
  → checksum recomputed
  → persisted durably (atomic write)
        |
        v
Recovery contract available for SERVER_RESTART reconstruction
```

### 23.2 Recovery Contract Consumption Flow

```text
SERVER RESTART
        |
        v
TonFinancialPersistence.restore()
  → loads ALL financial records (existing)
        |
        v
TonFinancialRecovery.recover()
  → restores financial in-memory structures (existing)
  → validation phase reports consistency errors (expected — gameplay runtime empty)
        |
        v
Recovery Data Contract loaded
  → reads recovery records from persistence
  → validates checksum
  → validates schema version
        |
        v
Recovery candidate discovery
  → for each recovery record:
    → validate identity (roomId, gameId, playerId, playerIndex match financial records)
    → determine game state (terminal, pre-game, active)
    → classify eligibility:
      → terminal (RESULT/SETTLED) → reconstruct
      → pre-game (PRE_GAME_READY/READY) → reconstruct (if all data available)
      → active (SPEED/BRAKE) → FAIL CLOSED
        |
        v
For each recoverable candidate:
  → Identity reconstruction (R17.9T.6-D)
  → Configuration reconstruction (R17.9T.6-E)
  → Gameplay runtime reconstruction (R17.9T.6-F)
  → Financial ↔ Gameplay reconciliation (R17.9T.6-G)
        |
        v
Cross-domain validation
  → all integrity checks pass → resume
  → any check fails → FAIL CLOSED
        |
        v
SERVER RUNNING (financial state restored, gameplay state reconstructed for eligible candidates)
```

---

## 24. Ownership Boundaries

- **Recovery Data Contract persistence:** Owned by the future Recovery Data Contract persistence layer (R17.9T.6-C). Does NOT duplicate financial persistence.
- **Financial records:** Owned by `TonFinancialPersistence` and restored by `TonFinancialRecovery`. The recovery contract REFERENCES but does NOT duplicate financial data.
- **Gameplay runtime state:** Owned by the nine runtime components (`RoomManager`, `GameManager`, `PlayerManager`, `ConfigurationEngine`, `GameStateEngine`, `PhysicsEngine`, `GameClockEngine`, `InputAuthority`, `WinnerEngine`). The recovery contract provides the data to reconstruct these components but does NOT own the runtime state itself.
- **GameEscrow / TON blockchain:** Authoritative for payment and refund truth. The recovery contract validates against but does NOT override financial truth.
- **This report did not alter any ownership boundaries.**

---

## 25. Risks

### Critical

- **Recovery Data Contract does not exist.** The contract defined in this report is a specification only. No persistence mechanism, no recovery records, no attach/restore methods exist. Until R17.9T.6-C through R17.9T.6-H are implemented, gameplay runtime reconstruction after `SERVER_RESTART` is NOT possible.

- **Active gameplay is NOT recoverable.** Games in `SPEED` or `BRAKE` phases must FAIL CLOSED. The current phase, physics state, clock state, and input state are all unknown and not persisted. This is an architectural limitation that can only be resolved by persisting the full coupled engine state (which violates the "no arbitrary runtime object graphs" principle) or by implementing deterministic replay (which requires persisting command logs + deltaTime sequences).

- **Configuration is NOT persisted.** The full committed configuration (including `randomService` outputs) is not persisted in any financial record. Without persisting the configuration, terminal game recovery is NOT possible (winner cannot be recomputed).

- **Player identity data is incomplete in financial records.** The `SNAPSHOT` record contains partial player identity data but is missing `colorSector2` (as distinct field), `sectorArrangement`, and `age`. Without complete player identity data, configuration reconstruction is NOT possible.

### High

- **`snapshotHash` is NOT a configuration hash.** The `snapshotHash` in `GAME_CONTRACT` is a hash of the financial snapshot, NOT a hash of the full game configuration. A dedicated `configurationHash` must be persisted for configuration integrity verification.

- **`SNAPSHOT.sectors` may be empty.** The `SNAPSHOT` record is created during `createContractRequest`, which may occur before configuration is generated. If `SNAPSHOT.sectors` is empty `[]`, the snapshot cannot contribute to configuration reconstruction.

- **Catalog version persistence is UNKNOWN.** `frozenTimers` is a snapshot of catalog timers at clock creation. If the catalog changes between original game creation and recovery, `frozenTimers` would differ. **INSUFFICIENT INFORMATION** on whether catalog version is persisted.

- **Clock state is mutable and must be updated on phase transitions.** Unlike identity and configuration (which are immutable), clock state changes with each phase transition. The recovery contract must be updated on every phase transition, which introduces a write-on-transition requirement.

### Medium

- **`SELF_TEST` phase recoverability is borderline.** `SELF_TEST` involves physics motion (self-test velocities) but no player input. If physics state were persisted, it could theoretically be reconstructed. However, since physics state is NOT currently persisted, `SELF_TEST` also FAILS CLOSED unless the recovery contract is implemented with physics state persistence.

- **Recovery contract write frequency.** The recovery contract must be updated on every phase transition (for active games) and at terminal state (for terminal games). This introduces additional I/O on phase transitions.

### Low

- **`correlationId` is optional.** Its absence does not affect recovery.

---

## 26. Recommendations

This section is included to satisfy the `.clinerules` report format. Per task constraints, this report makes **no implementation recommendations** and designs **no new APIs**. The following are factual observations only, not implementation proposals:

- The Recovery Data Contract defined in this report is the minimum durable authoritative data required for safe gameplay reconstruction. It does NOT include arbitrary runtime object graphs.
- The contract is partially satisfiable today (identity anchors from financial records) but requires new persistence for configuration, game state, clock state, and terminal physics angles.
- Active gameplay (SPEED/BRAKE) is NOT recoverable and must FAIL CLOSED. This is an architectural decision, not a gap to be filled.
- Terminal game recovery is feasible if the full configuration + final physics angles are persisted.
- Pre-game recovery (PRE_GAME_READY/READY) is feasible if the full configuration + game state + clock state are persisted.
- These observations are architectural specifications only; no changes are recommended or designed in this report.

---

## 27. Changes Made

No files modified. No source code, configuration, or test files were changed. This report is the only artifact created:

- `AI_CONTEXT/CLINE_REPORTS/2026-08-22_recovery_data_contract.md`

---

## 28. Scope Discipline

This was a READ-ONLY architecture/design task.

- No source code changes.
- No source file creation.
- No implementation.
- No persistence schema changes.
- No API creation.
- No refactoring.
- No application tests.
- No new APIs designed.

The only artifact created is this report.

---

## Limitations

- This report is derived entirely from the five source reports listed in "Source Reports Synthesized." No additional source code was inspected.
- The `SNAPSHOT` record's `colors[]` array may encode `colorSector2` as its second element when `sectorCount === 2`, but this has NOT been verified from source code. The relationship between `PlayerIdentity.color` / `PlayerIdentity.colorSector2` and `SNAPSHOT.players[].colors[]` is inferred, not confirmed.
- Whether `buildConfiguration` is fully deterministic given the same inputs (same `randomService` outputs + same player inputs + same catalog) has NOT been verified in the source reports. This report assumes it is deterministic (as required by the project's deterministic gameplay principle) but does not confirm it from source code.
- Whether the catalog version is persisted in any financial record is UNKNOWN. The source reports note this as an information gap.
- No application tests were run.