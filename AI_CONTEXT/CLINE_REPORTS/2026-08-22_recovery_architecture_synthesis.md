# Recovery Architecture Synthesis — R17.9T.6 Hybrid Recovery Architecture

Date: 2026-08-22

Task: READ-ONLY Recovery Architecture Synthesis for WheelWin. Architecture-design phase of R17.9T.6 — Hybrid Recovery Architecture. This report synthesizes three completed READ-ONLY recovery analysis reports into a single architecture decision document. No source code changes, no source file creation, no refactoring, no new APIs, no persistence schema changes, no implementation, no application tests.

## Source Reports Synthesized

1. `AI_CONTEXT/CLINE_REPORTS/2026-08-22_recovery_runtime_managers_mapping.md` — factual inventory of `RoomManager`, `GameManager`, `PlayerManager`.
2. `AI_CONTEXT/CLINE_REPORTS/2026-08-22_recovery_runtime_engines_mapping.md` — factual inventory of `ConfigurationEngine`, `GameStateEngine`, `PhysicsEngine`, `GameClockEngine`, `InputAuthority`, `WinnerEngine`.
3. `AI_CONTEXT/CLINE_REPORTS/2026-08-22_financial_persistence_recovery_mapping.md` — factual inventory of `TonFinancialPersistence`, `TonFinancialRecovery`, financial record types and fields, cross-domain recovery boundary.

---

## 1. Current Recovery Boundary

### 1.1 Financial Recovery

Financial recovery is **durable and implemented**.

- **Persistence mechanism:** File-based JSON persistence via `TonFinancialPersistence` (`server/persistence/TonFinancialPersistence.js`). Atomic writes via temp file + `renameSync`. Schema version 1. Auto-checkpoint after each create/update/delete/archive operation.
- **Physical storage:** `server/data/ton-financial/` with `manifest.json`, `active/`, `archived/`, `immutable/` subdirectories.
- **Record types persisted:** `GAME_CONTRACT`, `PAYMENT_SESSION`, `WALLET_SESSION`, `SETTLEMENT`, `RECOVERY_CHECKPOINT`, `DEPOSIT_SESSION`, `DEPLOYMENT_AUTHORIZATION`, `DEPLOYMENT_COST_SNAPSHOT`, `DEPLOYMENT_REIMBURSEMENT`, `SNAPSHOT`, `AUDIT`, `ARCHIVED_CONTRACT`, `DEPOSIT_OBSERVATION`.
- **Recovery orchestrator:** `TonFinancialRecovery.recover()` runs a mandatory pipeline on server startup with strict phase ordering: WALLETS → CONTRACTS → PAYMENTS → DEPOSITS → AUTHORIZATIONS → SETTLEMENTS → BLOCKCHAIN → SETTLEMENT_RESUME → VALIDATION.
- **What it restores:** Wallet sessions, game contracts (including snapshot and snapshot hash), payment sessions (including participants, seat indices, payment deadlines), settlement sessions (including winner info, settlement transaction hash), deposit sessions, deployment authorizations, blockchain checkpoint and watches.
- **Authoritative source:** GameEscrow / TON blockchain is authoritative for payment and refund truth. The backend cache is synchronized to the chain, never the reverse. `syncFromGameEscrow` reads on-chain `paidMask` and reconciles the cached session.

### 1.2 Gameplay Recovery

Gameplay recovery is **ephemeral and NOT implemented**.

- **Persistence:** None. All nine runtime components (`RoomManager`, `GameManager`, `PlayerManager`, `ConfigurationEngine`, `GameStateEngine`, `PhysicsEngine`, `GameClockEngine`, `InputAuthority`, `WinnerEngine`) store state exclusively in in-memory `Map` / `Set` / `Array` fields. None import or reference any persistence module.
- **SERVER_SHUTDOWN behavior:** All nine components subscribe to `SERVER_SHUTDOWN` and destroy all runtime state in their `_handleServerShutdown()` handlers. No state is persisted before or during shutdown.
- **Reconstruction methods:** None exist. `attachExistingRoom()` → NOT IMPLEMENTED. `attachExistingGame()` → NOT IMPLEMENTED. Player identity restore → NOT IMPLEMENTED. `ConfigurationEngine.restoreConfiguration()` → NOT IMPLEMENTED. `GameStateEngine.restoreState()` → NOT IMPLEMENTED. `PhysicsEngine.attachSimulation()` → NOT IMPLEMENTED. `GameClockEngine.restoreClock()` → NOT IMPLEMENTED (only `restorePhaseSchedule` exists, which requires an existing live clock). `InputAuthority.restoreRegistry()` → NOT IMPLEMENTED. `WinnerEngine.attachResult()` → NOT IMPLEMENTED.
- **After server restart:** All in-memory maps are empty. No data source exists from which gameplay runtime objects can be reconstructed.

### 1.3 The Boundary

The boundary between financial recovery and gameplay recovery is the point where **financial records reference `roomId` / `gameId` / `playerId` values that have no corresponding runtime objects**.

After `TonFinancialRecovery.recover()` completes:

- Financial in-memory structures are fully restored (`GameContractManager._contractsByRoom`, `_contractsById`, `_roomByGameId`; `PaymentSessionManager._sessionsByRoom`; `ContractSettlementManager._byGameId`; wallet sessions; blockchain watches).
- Gameplay runtime structures are empty (`RoomManager._rooms`; `GameManager._games`; `PlayerManager._identities` / `_runtimes`; `ConfigurationEngine._configurations`; `GameStateEngine._states`; `PhysicsEngine._simulations`; `GameClockEngine._clocks`; `InputAuthority._registries`; `WinnerEngine._results`).
- The `TonFinancialRecovery` validation phase reports consistency errors (`payment_session_orphan_player`, `contract_missing_room`) because financial records reference runtime entities that do not exist.

The server reaches a state where: **financial state is restored, gameplay state is empty, and the two domains are inconsistent**.

---

## 2. Recovery Anchor

### 2.1 Evaluation of Candidate Anchors

#### GAME_CONTRACT

- **Can establish:** `contractId`, `gameId`, `roomId`, contract lifecycle `status`, `contractAddress` (after deploy), `deploymentStatus`, `snapshotHash`, `snapshot` (player wallet addresses, required gram amounts, oracle wallet, escrow mode, network, adapter identity).
- **Cannot establish:** Full immutable game configuration (wheel layout, sectors, colors, icons, timers, trace seed, start angles), game state (current phase), physics state, clock state, input state, winner result, player identity data (nickname, icon, age, color, sectorCount, sectorArrangement, baseStake), room state (maxPlayers, room status), game lifecycle status (`GAME_STATUS`).
- **Assessment:** The `GAME_CONTRACT` snapshot is a **financial** snapshot (player wallets and amounts), NOT a gameplay snapshot. It does not contain the committed game configuration. It can serve as a **primary identity anchor** (`contractId` + `gameId` + `roomId`) and provide `snapshotHash` for integrity verification, but it cannot anchor gameplay reconstruction alone.

#### PAYMENT_SESSION

- **Can establish:** `paymentSessionId`, `roomId`, `gameId`, `contractId`, `network`, participant `playerId` values, participant `wallet` addresses, participant `requiredGram` amounts, participant `status` (payment confirmation), participant `playerIndex` (seat index for GameEscrow paidMask mapping), `paymentDeadline`, `status`, `expiresAt`, `completedAt`.
- **Cannot establish:** Full game configuration, game state, physics state, clock state, input state, winner result, player identity data (nickname, icon, age, color, sectorCount, sectorArrangement, baseStake), room state (maxPlayers, room status), game lifecycle status.
- **Assessment:** The `PAYMENT_SESSION` record is the **player identity and seat anchor**. It provides `playerId` values and `playerIndex` (seat assignments) that are essential for reconstructing `PlayerManager` and `InputAuthority` state. However, it contains only `playerId` strings, not full `PlayerIdentity` data.

#### SETTLEMENT

- **Can establish:** `settlementSessionId`, `contractId`, `gameId`, `roomId`, `winnerId`, `winnerWallet`, `prizeAmount`, `organizerAmount`, `totalPot`, `traceSeed`, `ownerWallet`, `settlementTransactionHash`, `status`, `settlementDeadline`, `request` (for payout watch re-registration).
- **Cannot establish:** Full winner result (winning sector, winning player object, final wheel angle, final triangle angle, `resolvedAt`), full game configuration, game state, physics state, clock state, input state.
- **Assessment:** The `SETTLEMENT` record is the **terminal-state anchor**. It provides `winnerId`, `prizeAmount`, and critically `traceSeed` (which is one of the randomService outputs needed to rebuild configuration). However, `SETTLEMENT` records only exist for games that reached the settlement phase. For active or pre-settlement games, no `SETTLEMENT` record exists.

#### Immutable SNAPSHOT

- **Can establish:** The `SNAPSHOT` record type exists in `TonFinancialRecordTypes.js` as an immutable-on-create record stored in `immutable/snapshot/`. The record ID is resolved as `metadata.snapshotId ?? payload.snapshotHash ?? payload.gameId`.
- **Cannot establish:** **INSUFFICIENT INFORMATION.** The three source reports did not inspect the contents of `SNAPSHOT` records in detail. The `GAME_CONTRACT.snapshot` field is a financial snapshot (player wallets and amounts), not a gameplay snapshot. Whether any `SNAPSHOT` record in the `immutable/snapshot/` directory contains gameplay state (configuration, physics, game state) was not analyzed.
- **Assessment:** The `SNAPSHOT` record type **may** be a viable gameplay snapshot anchor if it contains committed configuration and/or terminal physics state, but this cannot be confirmed from the three source reports. This is an explicit information gap.

#### GameEscrow / TON Blockchain

- **Can establish:** `paidMask` (which seats have paid), `contractAddress`, deployment transaction hash, settlement transaction hash, refund transaction hashes, on-chain escrow balance.
- **Cannot establish:** Gameplay runtime state (configuration, game state, physics, clock, input, winner). The blockchain contains escrow/payment facts only.
- **Assessment:** GameEscrow / TON is the **financial truth anchor**. It validates payment and refund state but contains no gameplay information. It must be consulted during financial reconciliation but cannot anchor gameplay reconstruction.

### 2.2 Determination

No single source can serve as the authoritative recovery anchor. The recovery anchor must be a **combination**:

| Anchor Role | Source | Establishes |
|-------------|--------|-------------|
| Primary identity anchor | `GAME_CONTRACT` | `contractId`, `gameId`, `roomId`, `snapshotHash` |
| Player identity and seat anchor | `PAYMENT_SESSION` | `playerId` values, `playerIndex` (seat indices), `wallet` addresses, payment status |
| Terminal-state anchor | `SETTLEMENT` (if exists) | `winnerId`, `prizeAmount`, `traceSeed`, `settlementTransactionHash` |
| Financial truth anchor | GameEscrow / TON blockchain | `paidMask`, `contractAddress`, settlement/refund transaction hashes |
| Integrity verification | `GAME_CONTRACT.snapshotHash` | SHA-256 hash for verifying reconstructed state |

**Critical limitation:** This combined anchor can establish **who** was in the game and **what** the financial state was, but it **cannot** establish the full game configuration, current game phase, physics state, clock state, or input state. The anchor is sufficient for identity reconstruction and financial reconciliation, but **insufficient** for active gameplay reconstruction without additional persisted recovery data.

---

## 3. Recovery Eligibility

### 3.1 Eligibility Classification

| State | Financial records exist? | Gameplay reconstructable? | Recovery action |
|-------|------------------------|-------------------------|-----------------|
| Room / setup phase (before contract creation) | NO — no `GAME_CONTRACT` or `PAYMENT_SESSION` exists yet | NO — no anchor | NOT RECOVERABLE. Room/setup phase sessions are ephemeral. No financial obligation exists. Safe to discard. |
| Payment phase (contract created, payments in progress) | YES — `GAME_CONTRACT` and `PAYMENT_SESSION` exist | NO — no gameplay state to reconstruct | FINANCIAL RECOVERY ONLY. Restore financial records. Reconcile with GameEscrow. If payments incomplete, handle via existing payment expiry/refund flow. No gameplay reconstruction needed. |
| Pre-game phase (`GAME_CREATED`, configuration may exist, before `GAME_INITIALIZED`) | YES — `GAME_CONTRACT`, `PAYMENT_SESSION` exist | NO — configuration may or may not have been generated; even if generated, it is not persisted | FINANCIAL RECOVERY ONLY. If entry payments are completed but game was not activated, the financial system must handle refund/escrow unwind. Gameplay cannot be resumed. |
| Active gameplay (`GAME_INITIALIZED` / `RUNNING`, phases `PRE_GAME_READY` through `BRAKE`) | YES — `GAME_CONTRACT`, `PAYMENT_SESSION` exist | NO — game state, physics, clock, input are NOT persisted | FAIL CLOSED for gameplay resume. Financial recovery proceeds. The game cannot be safely resumed because current phase, physics state, clock state, and input state are unknown. Financial obligations (escrow) remain valid and must be reconciled. |
| Result phase (`RESULT`, physics `STOPPED`, winner resolved) | YES — `GAME_CONTRACT`, `PAYMENT_SESSION` exist; `SETTLEMENT` may or may not exist yet | PARTIALLY — `winnerId` may be in `SETTLEMENT` if settlement was initiated; winner result is NOT persisted in `WinnerEngine` | If `SETTLEMENT` exists: terminal recovery (see below). If `SETTLEMENT` does not exist: the winner was resolved in-memory but not persisted. The winner cannot be safely reconstructed without final physics angles. FAIL CLOSED for gameplay. Financial recovery must handle escrow resolution. |
| Settlement phase (`SETTLEMENT_PENDING`) | YES — `SETTLEMENT` record exists | NOT NEEDED — gameplay is complete | FINANCIAL RECOVERY ONLY. `TonFinancialRecovery` already restores settlement sessions and re-registers settlement watches. No gameplay reconstruction needed. |
| Terminal / expired / cancelled | YES (terminal records) | NOT NEEDED | FINANCIAL RECOVERY ONLY. Terminal records are loaded but skipped by individual restore methods. No gameplay reconstruction needed. |

### 3.2 Safe Recovery Boundary

The only states where gameplay runtime reconstruction is **safe** are:

1. **Terminal games** where `SETTLEMENT` exists with `winnerId` and `traceSeed` — the game is complete, and the financial record captures the outcome.
2. **No active gameplay** — games that never reached `GAME_INITIALIZED` have no gameplay state to reconstruct.

The state where gameplay runtime reconstruction is **unsafe** and must FAIL CLOSED:

1. **Active gameplay** (`GAME_INITIALIZED` through `BRAKE`) — current phase, physics state, clock state, and input state are unknown and cannot be determined from persisted data.

### 3.3 Information Gaps

- **INSUFFICIENT INFORMATION:** Whether the `SNAPSHOT` record type (immutable, stored in `immutable/snapshot/`) contains gameplay state that could enable reconstruction of active gameplay. The three source reports did not inspect `SNAPSHOT` record contents.
- **INSUFFICIENT INFORMATION:** Whether any `RECOVERY_CHECKPOINT` record (stored in `active/recovery_checkpoint/`) contains gameplay state beyond blockchain checkpoint data. The financial persistence report noted that `RECOVERY_CHECKPOINT` is used by `BlockchainMonitor.restoreCheckpoint()`, but its full payload was not inventoried.

---

## 4. Minimum Recovery Contract

### 4.A Already Available (from financial persistence)

| Data | Source record | Field |
|------|--------------|-------|
| `roomId` | `GAME_CONTRACT`, `PAYMENT_SESSION`, `SETTLEMENT` | envelope + payload |
| `gameId` | `GAME_CONTRACT`, `PAYMENT_SESSION`, `SETTLEMENT` | envelope + payload |
| `contractId` | `GAME_CONTRACT` | payload + envelope |
| `paymentSessionId` | `PAYMENT_SESSION` | payload + envelope |
| `playerId` values | `PAYMENT_SESSION.participants[]` | `playerId` |
| Player seat index (`playerIndex`) | `PAYMENT_SESSION.participants[]` | `playerIndex` |
| Player wallet addresses | `PAYMENT_SESSION.participants[]`, `GAME_CONTRACT.snapshot` | `wallet` / `walletAddress` |
| Payment status per participant | `PAYMENT_SESSION.participants[]` | `status`, `confirmationStatus`, `paidAmount` |
| `snapshotHash` | `GAME_CONTRACT` | `snapshotHash` |
| `traceSeed` | `SETTLEMENT` (if exists) | `traceSeed` |
| `winnerId` | `SETTLEMENT` (if exists) | `winnerId` |
| `winnerWallet` | `SETTLEMENT` (if exists) | `winnerWallet` |
| `prizeAmount` | `SETTLEMENT` (if exists) | `prizeAmount` |
| `contractAddress` | `GAME_CONTRACT` (after deploy) | `contractAddress` |
| `tonNetwork` | `GAME_CONTRACT`, `PAYMENT_SESSION` | envelope `tonNetwork` |
| Payment deadline | `PAYMENT_SESSION` | `paymentDeadline`, `expiresAt` |
| Settlement deadline | `SETTLEMENT` | `settlementDeadline` |

### 4.B Deterministically Derivable

| Data | Derivation method | Prerequisite |
|------|------------------|--------------|
| `frozenTimers` (catalog timer snapshot) | `gameCatalog.getTimers()` at recovery time | Catalog is immutable config data; if catalog version matches, timers are derivable. **INSUFFICIENT INFORMATION** on whether catalog version is persisted. |
| Economy object (`ownerFeePercent`, `organizerFeeRate`, `winnerPercentage`) | `ConfigurationEngine.freezeEconomy(gameId)` from configuration + `gameCatalog.getPaymentRules()` | Requires reconstructed configuration. |
| Winner result (for terminal games) | `WinnerEngine.resolveResult(gameId)` — deterministic and idempotent | Requires reconstructed `ConfigurationEngine` state AND `PhysicsEngine` state with `STOPPED` simulation and correct final angles. Both are currently NOT persisted. |
| Payment rules | `gameCatalog.getPaymentRules()` | Catalog is immutable; available at recovery time. |
| Catalog colors, icons, stakes, wheel rules | `gameCatalog.getColors()`, `getIcons()`, `getStakes()`, `getWheelRules()` | Catalog is immutable; available at recovery time. |

### 4.C Currently Missing

| Data | Why it is needed | Current status |
|------|-----------------|----------------|
| Full immutable game configuration (wheel layout, sectors, colors, icons, timers, start angles, polar axis, sector arrangement) | Required to reconstruct `ConfigurationEngine._configurations` | NOT persisted. `buildConfiguration` generates it from live inputs (room, players, catalog, `randomService`). `randomService` outputs (traceSeed, start angles) are stored only in the in-memory configuration object. |
| Player identity data (`nickname`, `icon`, `age`, `color`, `colorSector2`, `sectorCount`, `sectorArrangement`, `baseStake`) | Required to reconstruct `PlayerManager._identities` and to rebuild configuration | NOT persisted. `PlayerManager` performs no disk writes. |
| Player runtime state (`connectionState`, `playerState`, `ping`, `connectedAt`, `lastSeen`) | Required to reconstruct `PlayerManager._runtimes` | NOT persisted. |
| Room state (`maxPlayers`, room status) | Required to reconstruct `RoomManager._rooms` | NOT persisted. `maxPlayers` is not in any financial record. |
| Game lifecycle status (`GAME_STATUS`) | Required to reconstruct `GameManager._games` | NOT persisted. Not in any financial record. |
| Current game state phase (`PRE_GAME_READY` / `READY` / `SELF_TEST` / `SPEED` / `BRAKE` / `RESULT`) | Required to reconstruct `GameStateEngine._states` | NOT persisted. |
| Physics state (`angle`, `triangleAngle`, `angularVelocity`, `angularAcceleration`, `state`, braking flags, `simulationTimeMs`) | Required to reconstruct `PhysicsEngine._simulations` | NOT persisted. |
| Physics command log | Required for deterministic replay reconstruction | NOT persisted. Retained in-memory only. |
| Game clock state (`currentPhase`, `startedAt`, `elapsed`, `totalPausedMs`, `phaseStartedAt`, `phaseEndsAt`, `awaitingResultActivation`, `resultPhaseStarted`) | Required to reconstruct `GameClockEngine._clocks` | NOT persisted. |
| Input authority state (`pressCount`, `buttonPressed`, `lastPressTime`, `lastReleaseAt`, `cooldownUntil`, `locked`, `commandQueue`, `acceptedCommands`, `sequenceNumber`) | Required to reconstruct `InputAuthority._registries` | NOT persisted. |
| Full winner result (`winningSector`, `winningPlayer`, `finalAngle`, `wheelFinalAngle`, `triangleFinalAngle`, `resolvedAt`) | Required to reconstruct `WinnerEngine._results` | NOT persisted. Partial data (`winnerId`, `prizeAmount`) in `SETTLEMENT` for completed games. |
| `GAME_INITIALIZED` / `READY` lifecycle marker | Required to know if game was activated | NOT persisted. `GAME_INITIALIZED` is a `GameManager` lifecycle event, not stored in `GameStateEngine`. |

### 4.D Summary

The minimum recovery contract requires information in three categories:

1. **Identity contract** (partially available): `roomId`, `gameId`, `contractId`, `paymentSessionId`, `playerId`, `playerIndex`, wallet addresses — available from financial persistence.
2. **Configuration contract** (mostly missing): full immutable game configuration including wheel layout, sectors, colors, icons, timers, trace seed, start angles — NOT available from financial persistence. `traceSeed` partially available from `SETTLEMENT` for completed games only.
3. **Gameplay state contract** (entirely missing): current game phase, physics state, clock state, input state — NOT available from any persisted source.

The recovery contract is **not currently satisfiable** for active gameplay reconstruction. It is partially satisfiable for identity reconstruction and terminal-state reconciliation.

---

## 5. Runtime Reconstruction Boundary

### 5.1 Classification Per Component

| Component | Classification | Rationale |
|-----------|---------------|-----------|
| `RoomManager` | **MUST RECONSTRUCT** | `roomId` available from financial records. `maxPlayers` and room status are NOT available. Reconstruction requires an attach method that preserves the original `roomId`. `createRoom` always generates a new `roomId` and cannot be used. |
| `GameManager` | **MUST RECONSTRUCT** | `gameId` available from financial records. `GAME_STATUS` is NOT available. Reconstruction requires an attach method that preserves the original `gameId`. `createGame` always generates a new `gameId` and cannot be used. The coupled bootstrap (`inputAuthority`, `physicsEngine`, `gameClockEngine`, `configurationEngine`) must be re-established for the same `gameId`. |
| `PlayerManager` | **MUST RECONSTRUCT** | `playerId` values available from `PAYMENT_SESSION.participants`. Full `PlayerIdentity` data (nickname, icon, age, color, sectorCount, sectorArrangement, baseStake) is NOT available. `createPlayer` accepts `identityInput.playerId` but creates a new identity and is not a recovery method. |
| `ConfigurationEngine` | **MUST RECONSTRUCT** | `gameId` available. `traceSeed` partially available from `SETTLEMENT` (completed games only). Full configuration (wheel layout, sectors, colors, icons, timers, start angles) is NOT persisted. `buildConfiguration` depends on `randomService` outputs that are not retained outside the in-memory configuration object. Reconstruction requires either persisting the committed configuration or persisting the `randomService` outputs needed to reproduce it. |
| `GameStateEngine` | **MUST RECONSTRUCT** | `gameId` available. Current phase is NOT persisted. `initializeGameState` always starts at `PRE_GAME_READY`. The transition table is forward-only with no method to set an arbitrary state. For active games, the correct phase cannot be determined from persisted data. |
| `PhysicsEngine` | **MUST NOT RESTORE** | Physics state must NOT be persisted as an arbitrary runtime object graph. The `runtime` object contains `setTimeout`-independent values (angles, velocities) but also motion flags that are transient. For terminal games: final angles are needed to recompute the winner but are NOT persisted. For active games: reconstruction via deterministic replay is theoretically possible if the `commandLog` and exact time deltas were persisted, but neither is persisted. `setPoseDegrees` can seed an angle on an existing simulation but does not restore full state. **Classification: MUST NOT RESTORE for arbitrary state; TERMINAL ONLY for completed games (requires final angles); UNKNOWN for active games (replay not possible without command log + deltas).** |
| `GameClockEngine` | **MUST RECONSTRUCT** | `gameId` available. Current phase, timing, pause state are NOT persisted. `createClock` starts with `null` phase and `running: false`. `startClock` sets initial phase to `PRE_GAME_READY`. `restorePhaseSchedule` can set a specific phase but requires an existing running clock. `frozenTimers` is derivable from catalog. `timeoutHandle` is a `setTimeout` reference and is inherently non-serializable. |
| `InputAuthority` | **MUST RECONSTRUCT** | `gameId` and `playerId` values available. Input state (`pressCount`, `buttonPressed`, `lastPressTime`, `lastReleaseAt`, `cooldownUntil`, `locked`, `commandQueue`, `acceptedCommands`, `sequenceNumber`) is NOT persisted. `registerPlayer` creates default input state. |
| `WinnerEngine` | **TERMINAL ONLY** | For completed games: `resolveResult` is deterministic and idempotent. If `ConfigurationEngine` and `PhysicsEngine` states were reconstructed to their exact pre-shutdown state (same final angles, same configuration), the winner could be recomputed. However, neither configuration nor physics can currently be reconstructed. For active games: winner has not been resolved yet, so there is nothing to restore. |

### 5.2 Physics State Analysis

The task explicitly asks whether the existing architecture and deterministic rules allow reconstruction instead of persistence.

**Finding:** The physics simulation is deterministic given:
1. The same `DEFAULT_PHYSICS_PARAMETERS`.
2. The same sequence of motion commands (`self_test_begin`, `self_test_end`, `speed_begin`, `speed_hold_update`, `speed_end`, `brake_begin`, `brake`, `acceleration`).
3. The same sequence of `deltaTime` values from the `SimulationLoop`.

The `PhysicsEngine` retains a `commandLog` array of all motion commands, which could support deterministic replay. However:
- The `commandLog` is NOT persisted.
- The `deltaTime` sequence from `SimulationLoop` is real-time dependent and NOT persisted.
- Even if the `commandLog` were persisted, the exact `deltaTime` values would be needed for bit-exact reconstruction.

**Conclusion:** Physics state reconstruction via deterministic replay is **theoretically possible** but **currently not achievable** because neither the `commandLog` nor the `deltaTime` sequence is persisted. Persisting the full physics `runtime` object as an arbitrary snapshot is **not recommended** (it would persist transient motion flags and a non-serializable simulation lifecycle). The safe approach for terminal games is to persist only the **final angles** (`angle`, `triangleAngle`) and the simulation `state` (`STOPPED`), which are the minimal inputs needed for `WinnerEngine.resolveResult`.

For active games, physics reconstruction is **UNKNOWN** — it cannot be safely achieved without either (a) persisting the `commandLog` + `deltaTime` sequence for replay, or (b) persisting the full `runtime` state (which violates the "do not persist arbitrary runtime object graphs" principle).

---

## 6. Identity Preservation

### 6.1 Required Identity Fields

| Identity field | Available from financial persistence? | Current ID-generation gap |
|----------------|--------------------------------------|--------------------------|
| `roomId` | YES — `GAME_CONTRACT`, `PAYMENT_SESSION`, `SETTLEMENT` | `createRoom` always generates a new `roomId` via `_generateRoomId()`. `roomId` is NOT an accepted input parameter. No `attachExistingRoom()` method exists. |
| `gameId` | YES — `GAME_CONTRACT`, `PAYMENT_SESSION`, `SETTLEMENT` | `createGame` always generates a new `gameId` via `_generateGameId()` (`game_${randomUUID()}`). `gameId` is NOT an accepted input parameter. No `attachExistingGame()` method exists. |
| `playerId` | YES — `PAYMENT_SESSION.participants[].playerId`, `SETTLEMENT.winnerId` | `createPlayer` accepts `identityInput.playerId` but creates a new `PlayerIdentity` object. It is the standard creation path, not a recovery method. No `attachExistingPlayer()` or `restoreIdentity()` method exists. |
| Player seat / index | YES — `PAYMENT_SESSION.participants[].playerIndex` | No method exists to restore seat assignment. Seat index is set during `registerPlayers` based on `room.players` array order, which is not persisted. |
| Player identity (`nickname`, `icon`, `age`, `color`, `colorSector2`, `sectorCount`, `sectorArrangement`, `baseStake`) | NO — not in any financial record | `PlayerManager._identities` is not persisted. `createPlayer` requires all identity fields to be supplied by the caller. No authoritative source exists for this data after restart. |
| `contractId` | YES — `GAME_CONTRACT` | `GameContractManager.restoreContracts()` already restores contracts with original `contractId`. No gap. |
| `paymentSessionId` | YES — `PAYMENT_SESSION` | `PaymentSessionManager.restorePaymentSessions()` already restores payment sessions with original `paymentSessionId`. No gap. |

### 6.2 ID-Generation Gaps

1. **`RoomManager._generateRoomId()`**: Generates a new `roomId` via `generateRoomId()` from `./room/roomIdAlphabet.js`. `createRoom` does not accept `roomId` as a parameter. Recovery that needs to preserve the original `roomId` cannot use `createRoom`.

2. **`GameManager._generateGameId()`**: Returns `game_${randomUUID()}`. `createGame` does not accept `gameId` as a parameter. Recovery that needs to preserve the original `gameId` cannot use `createGame`.

3. **`PlayerManager._generatePlayerId()`**: Returns `player_${randomUUID()}`. `createPlayer` accepts `identityInput.playerId` (can use a provided ID), but it creates a new `PlayerIdentity` / `PlayerRuntime` pair and requires all identity fields. It is not a dedicated attach/restore method and does not validate against any authoritative source.

### 6.3 Principle

Recovery must **NEVER** silently create replacement IDs. If the original `roomId`, `gameId`, or `playerId` cannot be preserved, the recovery must FAIL CLOSED. Replacement IDs would break the cross-references between financial records (which reference the original IDs) and runtime objects.

---

## 7. Configuration Recovery

### 7.1 Configuration Data Already Persisted

| Data | Source | Availability |
|------|--------|-------------|
| `snapshotHash` | `GAME_CONTRACT.snapshotHash` | Available for all games with a contract. Can be used for integrity verification of a reconstructed configuration. |
| `traceSeed` | `SETTLEMENT.traceSeed` | Available ONLY for games that reached settlement phase. One of the `randomService` outputs needed to reproduce configuration. |
| `configurationVersion` | `WinnerEngine` result `metadata.configurationVersion` (in-memory only) | NOT persisted. |
| Catalog data (colors, timers, wheel rules, icons, stakes, payment rules) | `gameCatalog` (immutable config data) | Available at recovery time. The catalog is immutable configuration data, not runtime state. |

### 7.2 Configuration Data Available Elsewhere

| Data | Source | Notes |
|------|--------|-------|
| `CONFIGURATION_VERSION` | `./configuration/ConfigurationVersion.js` | Static constant. Available at recovery time. |
| Catalog colors | `gameCatalog.getColors()` | Immutable. Available at recovery time. |
| Catalog timers | `gameCatalog.getTimers()` | Immutable. Available at recovery time. Used by `GameClockEngine._snapshotCatalogTimers()` for `frozenTimers`. |
| Catalog wheel rules | `gameCatalog.getWheelRules()` | Immutable. Available at recovery time. |
| Catalog icons | `gameCatalog.getIcons()` | Immutable. Available at recovery time. |
| Catalog stakes | `gameCatalog.getStakes()` | Immutable. Available at recovery time. |
| Payment rules | `gameCatalog.getPaymentRules()` | Immutable. Available at recovery time. |
| `DEFAULT_PHYSICS_PARAMETERS` | `./physics/PhysicsParameters.js` | Static constant. Available at recovery time. |

### 7.3 Configuration Data Currently Missing

| Data | Why it is needed | Why it is missing |
|------|-----------------|-----------------|
| **Wheel layout** (sector arrangement on the wheel) | Required to reconstruct `ConfigurationEngine._configurations[gameId].sectors` and for `WinnerEngine` sector resolution | Generated per-game by `generateWheelLayout({ players, randomService })`. The layout depends on `randomService` outputs that are not persisted. |
| **Sectors** (sector objects with index, color, player assignment) | Required for winner determination and player sector mapping | Derived from player inputs + `randomService` during `buildConfiguration`. Not persisted. |
| **Colors** (player-specific color assignments) | Required to reconstruct player identity and configuration | Assigned via `resolvePlayerSetupColors` during `buildConfiguration`. Player identity data (which contains `color`, `colorSector2`) is not persisted. |
| **Icons** (player-specific icon assignments) | Required to reconstruct player identity | Assigned server-side during setup. Player identity data (which contains `icon`) is not persisted. |
| **Timers** (game-specific timer configuration) | Required to reconstruct `GameClockEngine.frozenTimers` | `frozenTimers` is a snapshot of catalog timers at clock creation. If catalog version is unchanged, timers are derivable. **INSUFFICIENT INFORMATION** on whether catalog version is persisted in financial records. |
| **Trace seed** | Required to reproduce configuration via `buildConfiguration` | Generated by `randomService.generateTraceSeed()` during `buildConfiguration`. Stored in the in-memory configuration object. Available from `SETTLEMENT.traceSeed` ONLY for completed games. NOT available for active games. |
| **Start angles** (wheel start angle, triangle start angle) | Required to reproduce configuration and physics initial state | Generated by `randomService.nextInt(0, 359)` during `buildConfiguration`. Stored in the in-memory configuration object. NOT persisted in any financial record. |
| **Polar axis** | Required for wheel geometry | Part of the configuration object. NOT persisted. |
| **Sector arrangement** | Required to reconstruct player sector mapping | Part of player identity data (`sectorCount`, `sectorArrangement`). NOT persisted. |
| **Full frozen configuration object** | Required to reconstruct `ConfigurationEngine._configurations[gameId]` | The complete configuration object (after `deepFreezeConfiguration`) is stored only in `ConfigurationEngine._configurations` in-memory `Map`. NOT persisted. |

### 7.4 Configuration Reconstruction Feasibility

Configuration reconstruction is **NOT currently possible** for active games because:

1. The full committed configuration is not persisted.
2. The `randomService` outputs (`traceSeed`, `wheel.startAngle`, `triangle.startAngle`) are not persisted (except `traceSeed` in `SETTLEMENT` for completed games).
3. The player identity data (which contains `color`, `colorSector2`, `sectorCount`, `sectorArrangement`, `icon`, `baseStake`) needed to rebuild the configuration is not persisted.
4. `buildConfiguration` generates a new configuration from live inputs and cannot reproduce a previously generated configuration without the original `randomService` outputs and player inputs.

For **completed games** where `SETTLEMENT` exists with `traceSeed`, partial reconstruction is theoretically possible if the original player identity data were also available. However, player identity data is not persisted, so even completed games cannot have their configuration fully reconstructed.

**The configuration recovery gap is a blocking dependency for all downstream gameplay reconstruction.**

---

## 8. Gameplay State Recovery

### 8.1 Required Information for Safe Resume

| Information | Required for | Currently persisted? |
|-------------|-------------|---------------------|
| Current `GameState` phase | `GameStateEngine._states` — to know if game is in `PRE_GAME_READY`, `READY`, `SELF_TEST`, `SPEED`, `BRAKE`, or `RESULT` | NO |
| `GAME_STATUS` lifecycle status | `GameManager._games` — to know if game is `CREATED`, `INITIALIZED`, `READY`, `RUNNING`, `FINISHED` | NO |
| Clock phase and timing | `GameClockEngine._clocks` — to know current phase, elapsed time, remaining time, pause state | NO |
| Physics state | `PhysicsEngine._simulations` — to know wheel angle, triangle angle, velocities, simulation state | NO |
| Accepted inputs | `InputAuthority._registries` — to know press counts, button states, cooldowns | NO |
| Command history | `InputAuthority.acceptedCommands`, `PhysicsEngine.commandLog` — for deterministic replay | NO |
| Winner state | `WinnerEngine._results` — for completed games | NO (partial: `winnerId` in `SETTLEMENT`) |
| Committed configuration | `ConfigurationEngine._configurations` — for all gameplay operations | NO (partial: `traceSeed` in `SETTLEMENT`) |

### 8.2 Can an Active Gameplay Session Safely Resume?

**NO.** An active gameplay session cannot safely resume with current persisted information. The following prevents safe recovery:

1. **Current phase is unknown.** `GameStateEngine._states` is empty after restart. `initializeGameState` always starts at `PRE_GAME_READY`. The transition table is forward-only with no method to set an arbitrary state. Without knowing whether the game was in `SPEED`, `BRAKE`, or another phase, the game cannot be resumed at the correct point.

2. **Physics state is unknown.** `PhysicsEngine._simulations` is empty after restart. `createSimulation` always creates with zeroed runtime and `CREATED` state. Without the current wheel angle, triangle angle, and velocities, the physics simulation cannot be resumed. Deterministic replay is not possible because the `commandLog` is not persisted.

3. **Clock state is unknown.** `GameClockEngine._clocks` is empty after restart. `createClock` starts with `null` phase and `running: false`. Without knowing the current phase, elapsed time, and remaining time, the clock cannot be resumed. `restorePhaseSchedule` requires an existing running clock.

4. **Input state is unknown.** `InputAuthority._registries` is empty after restart. `registerPlayer` creates default input state. Without knowing press counts, button states, and command queues, input processing cannot be resumed.

5. **Configuration is unknown.** `ConfigurationEngine._configurations` is empty after restart. Without the committed configuration, `WinnerEngine` cannot resolve results, and `InputAuthority` cannot validate inputs against sector assignments.

6. **Player identity is unknown.** `PlayerManager._identities` is empty after restart. Without player identity data, the system cannot determine which players were in the game, what their sector assignments were, or what their configuration inputs were.

### 8.3 What Prevents Safe Recovery

The fundamental blocker is that **gameplay runtime state is entirely ephemeral**. None of the nine runtime components persist any state. The financial persistence layer contains identity anchors (`roomId`, `gameId`, `playerId`) and financial state, but it does not contain gameplay state. Without gameplay state, resuming an active game would require inventing state, which violates the fail-closed principle.

---

## 9. Financial Reconciliation

### 9.1 Required Relationship

```
Financial Truth (GameEscrow / TON blockchain)
        ↓
    [Authoritative for payment/refund/settlement state]
        ↓
Financial Persistence (TonFinancialPersistence)
        ↓
    [Durable cache of financial state]
        ↓
Financial Recovery (TonFinancialRecovery)
        ↓
    [Restores financial in-memory structures]
        ↓
Gameplay Recovery (NOT YET IMPLEMENTED)
        ↓
    [Must validate against financial truth]
        ↓
Runtime Validation
        ↓
    [Cross-domain consistency check]
```

### 9.2 Principles

1. **GameEscrow / TON remains authoritative** for payment and refund truth. The backend cache is synchronized to the chain, never the reverse. `syncFromGameEscrow` reads the on-chain `paidMask` and reconciles the cached session.

2. **Gameplay recovery must never override financial truth.** If gameplay recovery reconstructs a game, the reconstructed game's financial state must match the financial records. If there is a conflict, financial truth wins.

3. **Gameplay recovery must validate against financial truth.** After reconstructing gameplay runtime objects, the recovery must verify:
   - The reconstructed `roomId` matches the `roomId` in `GAME_CONTRACT` / `PAYMENT_SESSION`.
   - The reconstructed `gameId` matches the `gameId` in `GAME_CONTRACT` / `PAYMENT_SESSION`.
   - The reconstructed `playerId` values match the `playerId` values in `PAYMENT_SESSION.participants`.
   - The reconstructed player seat indices match `PAYMENT_SESSION.participants[].playerIndex`.
   - The reconstructed configuration `snapshotHash` matches `GAME_CONTRACT.snapshotHash`.
   - If `SETTLEMENT` exists, the reconstructed winner matches `SETTLEMENT.winnerId`.

4. **Financial recovery proceeds independently of gameplay recovery.** `TonFinancialRecovery.recover()` runs its full pipeline regardless of whether gameplay reconstruction succeeds. If gameplay reconstruction fails, financial recovery still completes (handling refunds, settlement watches, etc.).

5. **If financial truth and gameplay state conflict, gameplay FAILS CLOSED.** The financial system continues to operate (processing refunds, watching settlements) while the gameplay runtime is not reconstructed.

---

## 10. Recovery Sequence

### 10.1 Architecture-Level Recovery Sequence

```
SERVER START
    ↓
    [Validation: server process initialized]
    ↓
Financial persistence restore
    ↓
    [Validation: TonFinancialPersistence.restore() returns { recordCount, errors };
     if recordCount === 0 && errors.length > 0 → FAIL CLOSED (RecoveryFailureError)]
    ↓
Financial reconciliation
    ↓
    [Validation: TonFinancialRecovery.recover() completes all phases;
     validation phase checks for orphan players, missing rooms, missing contracts;
     consistency errors are EXPECTED because gameplay runtime is empty;
     financial recovery does NOT fail on these — it proceeds]
    ↓
Recovery candidate discovery
    ↓
    [Validation: identify GAME_CONTRACT records that reference gameId values
     not present in GameManager._games;
     for each such record, determine if the game is:
       (a) terminal (SETTLEMENT exists) → terminal recovery candidate
       (b) pre-game (no SETTLEMENT, payment phase) → financial-only candidate
       (c) active gameplay (no SETTLEMENT, payments completed) → FAIL CLOSED candidate
     If no GAME_CONTRACT records exist → no recovery candidates → proceed to normal startup]
    ↓
Identity reconstruction
    ↓
    [Validation: for each recovery candidate, extract roomId, gameId, playerId values
     from GAME_CONTRACT, PAYMENT_SESSION, SETTLEMENT;
     verify that all referenced IDs are present and consistent across records;
     if any ID is missing or inconsistent → FAIL CLOSED for that candidate]
    ↓
Room reconstruction
    ↓
    [Validation: reconstruct Room object with original roomId;
     maxPlayers must be derivable (currently NOT available → FAIL CLOSED unless
     maxPlayers can be inferred from PAYMENT_SESSION.participants.length);
     room status must be set to a recovery-appropriate status;
     if roomId cannot be preserved → FAIL CLOSED]
    ↓
Game reconstruction
    ↓
    [Validation: reconstruct Game object with original gameId;
     GAME_STATUS must be determinable (currently NOT available → FAIL CLOSED
     unless GAME_STATUS can be inferred from financial record status);
     if gameId cannot be preserved → FAIL CLOSED]
    ↓
Configuration reconstruction
    ↓
    [Validation: reconstruct ConfigurationEngine state for gameId;
     verify traceSeed is available (from SETTLEMENT for completed games);
     verify full configuration can be rebuilt (currently NOT possible without
     player identity data and randomService outputs);
     if configuration cannot be fully reconstructed → FAIL CLOSED;
     if reconstructed, verify snapshotHash matches GAME_CONTRACT.snapshotHash;
     if hash mismatch → FAIL CLOSED]
    ↓
Gameplay runtime reconstruction
    ↓
    [Validation: reconstruct GameStateEngine, PhysicsEngine, GameClockEngine,
     InputAuthority states for gameId;
     for terminal games: reconstruct PhysicsEngine to STOPPED state with final angles
     (currently NOT available → FAIL CLOSED unless final angles are persisted);
     for active games: current phase, physics state, clock state, input state
     are all unknown → FAIL CLOSED;
     if any engine state cannot be safely reconstructed → FAIL CLOSED]
    ↓
Cross-domain validation
    ↓
    [Validation: verify reconstructed gameplay state is consistent with
     financial records:
       - roomId matches across GAME_CONTRACT, PAYMENT_SESSION, SETTLEMENT
       - gameId matches across all records
       - playerId values match PAYMENT_SESSION.participants
       - player seat indices match PAYMENT_SESSION.participants[].playerIndex
       - configuration snapshotHash matches GAME_CONTRACT.snapshotHash
       - if SETTLEMENT exists, winnerId matches reconstructed WinnerEngine result
       - payment status matches GameEscrow on-chain state
     if any mismatch → FAIL CLOSED]
    ↓
Resume OR FAIL CLOSED
    ↓
    [If all validations pass: resume game (terminal games can have winner recomputed;
     active games cannot be resumed with current architecture);
     if any validation fails: FAIL CLOSED — financial recovery continues,
     gameplay is not reconstructed, financial obligations are handled
     by the financial recovery pipeline (refunds, settlement watches, etc.)]
```

### 10.2 Transition Validation Conditions

| Transition | Validation condition | On failure |
|------------|----------------------|------------|
| SERVER START → Financial persistence restore | Server process initialized | N/A |
| Financial persistence restore → Financial reconciliation | `restore()` returns `recordCount > 0` OR `errors.length === 0` | FAIL CLOSED (`RecoveryFailureError`) |
| Financial reconciliation → Recovery candidate discovery | `TonFinancialRecovery.recover()` completes (consistency errors are expected and tolerated) | Financial recovery failure → server startup failure |
| Recovery candidate discovery → Identity reconstruction | At least one `GAME_CONTRACT` record references a `gameId` not in `GameManager._games` | No recovery candidates → normal startup |
| Identity reconstruction → Room reconstruction | All `roomId`, `gameId`, `playerId` values are present and consistent across `GAME_CONTRACT`, `PAYMENT_SESSION`, `SETTLEMENT` | FAIL CLOSED for candidate |
| Room reconstruction → Game reconstruction | `roomId` preserved; `maxPlayers` derivable (e.g., from `PAYMENT_SESSION.participants.length`) | FAIL CLOSED for candidate |
| Game reconstruction → Configuration reconstruction | `gameId` preserved; `GAME_STATUS` determinable | FAIL CLOSED for candidate |
| Configuration reconstruction → Gameplay runtime reconstruction | Full configuration reconstructed; `snapshotHash` matches `GAME_CONTRACT.snapshotHash` | FAIL CLOSED for candidate |
| Gameplay runtime reconstruction → Cross-domain validation | All engine states safely reconstructed (for terminal: physics `STOPPED` with final angles; for active: all states known) | FAIL CLOSED for candidate |
| Cross-domain validation → Resume | All cross-domain checks pass | FAIL CLOSED for candidate |

---

## 11. Failure Modes

### 11.1 Failure Handling

| Failure mode | Required action | Rationale |
|--------------|----------------|-----------|
| Room record missing | FAIL CLOSED for gameplay. Financial recovery continues. If `GAME_CONTRACT` references a `roomId` but no room can be reconstructed, the game cannot be resumed. Financial obligations (escrow) remain valid and are handled by the financial recovery pipeline. | Cannot reconstruct `RoomManager` state without `roomId`-bearing room data. |
| Game record missing | FAIL CLOSED for gameplay. Financial recovery continues. If `PAYMENT_SESSION` references a `gameId` but no game can be reconstructed, the game cannot be resumed. | Cannot reconstruct `GameManager` state without game data. |
| Player identity missing | FAIL CLOSED for gameplay. If `PAYMENT_SESSION.participants` references a `playerId` but the full `PlayerIdentity` data cannot be reconstructed, the game cannot be resumed. Financial obligations for that player remain valid. | Cannot reconstruct `PlayerManager` state without identity data. |
| Configuration incomplete | FAIL CLOSED for gameplay. If the full immutable game configuration cannot be reconstructed (missing wheel layout, sectors, colors, icons, timers, trace seed, start angles), the game cannot be resumed. | Configuration is a blocking dependency for all gameplay. |
| Configuration hash mismatch | FAIL CLOSED for gameplay. If the reconstructed configuration's hash does not match `GAME_CONTRACT.snapshotHash`, the reconstruction is invalid. | Hash mismatch indicates the reconstructed configuration differs from the original committed configuration. |
| Contract mismatch | FAIL CLOSED for gameplay. If financial records contain conflicting `contractId` / `gameId` / `roomId` mappings, the recovery cannot determine which contract corresponds to which game. | Conflicting financial records indicate data corruption or a serious inconsistency. |
| Payment state mismatch | Sync from GameEscrow first. If `syncFromGameEscrow` reconciles the cached state to match the chain, proceed. If the mismatch persists after sync, FAIL CLOSED for gameplay. Financial recovery continues. | GameEscrow is authoritative; if the cache cannot be reconciled, the financial state is uncertain. |
| Physics state cannot be reconstructed | FAIL CLOSED for gameplay. If physics state (final angles for terminal games, or command log + deltas for active games) is not available, the game cannot be resumed or have its winner recomputed. | Physics state is required for winner determination and gameplay resume. |
| Game state cannot be determined | FAIL CLOSED for gameplay. If the current `GameState` phase cannot be determined from persisted data, the game cannot be resumed. | Without knowing the current phase, resuming gameplay would be non-deterministic. |
| Multiple conflicting financial records exist | FAIL CLOSED for gameplay. If multiple `GAME_CONTRACT` or `PAYMENT_SESSION` records exist for the same `gameId` / `roomId` with conflicting state, the recovery cannot determine the authoritative financial state. Financial recovery's own validation should also catch this. | Conflicting records indicate data corruption. |
| Corrupted persistence record exists | FAIL CLOSED. `TonFinancialPersistence.restore()` throws `CorruptedRecordError` immediately on corrupted records. If `recordCount === 0` and errors exist, throws `RecoveryFailureError`. | Corrupted records cannot be trusted for reconstruction. |

### 11.2 Default Safety Principle

**FAIL CLOSED.** In all failure modes, the default action is to fail closed for gameplay reconstruction. Financial recovery continues independently, handling refunds, settlement watches, and escrow reconciliation. The server starts with financial state restored and gameplay state empty for the failed candidate. The financial recovery pipeline is responsible for ensuring financial obligations are met (refunds, settlements) even when gameplay cannot be resumed.

---

## 12. Hybrid Recovery Decision

### 12.1 Proposed Architecture

> Persist durable authoritative recovery data.
>
> Do NOT persist arbitrary runtime object graphs.
>
> Reconstruct runtime managers and engines from validated recovery data where deterministic reconstruction is safe.
>
> Do NOT reconstruct gameplay when authoritative information is insufficient.

### 12.2 Compatibility Assessment

**Server Authoritative architecture:** COMPATIBLE. Reconstruction is performed server-side. The server remains the single source of truth. Client never owns authoritative gameplay state. Reconstruction does not move authority to the client.

**Deterministic gameplay:** COMPATIBLE WITH CONDITIONS. Deterministic reconstruction is safe for terminal games where `WinnerEngine.resolveResult` is deterministic and idempotent (given the same configuration and physics final state). For active games, deterministic reconstruction is NOT safe because the current phase, physics state, clock state, and input state are unknown and cannot be reproduced without persisting the command log and time deltas.

**Financial authority:** COMPATIBLE. GameEscrow / TON remains authoritative for payment and refund truth. Gameplay recovery validates against financial truth and never overrides it. Financial recovery proceeds independently.

**Immutable configuration principles:** COMPATIBLE WITH CONDITIONS. If the committed configuration is persisted as durable recovery data (not regenerated), the immutability principle is preserved. If the configuration is regenerated via `buildConfiguration`, the `randomService` outputs would differ, producing a different configuration. The configuration must be persisted as a frozen object or reconstructed from persisted `randomService` outputs, not regenerated.

**Original `roomId` / `gameId` / player identities:** COMPATIBLE WITH CONDITIONS. The original IDs are available from financial persistence. However, `createRoom` and `createGame` always generate new IDs. Attach/restore methods that preserve original IDs must be added. `createPlayer` accepts `playerId` but is not a recovery method.

**Fail-closed financial safety:** COMPATIBLE. The proposed architecture explicitly states "Do NOT reconstruct gameplay when authoritative information is insufficient." This aligns with the fail-closed principle.

### 12.3 Safety Analysis

The reports reveal **one reason this model could be unsafe** if implemented without conditions:

**Active gameplay reconstruction is unsafe.** The three reports establish that for active gameplay (games in `SPEED`, `BRAKE`, or other non-terminal phases), the current phase, physics state, clock state, and input state are ALL unknown and ALL not persisted. Reconstructing an active game would require inventing state, which violates determinism and fail-closed safety. The hybrid model must explicitly prohibit active gameplay reconstruction unless ALL coupled engine states can be safely reconstructed.

### 12.4 Verdict

The hybrid recovery architecture is **architecturally compatible with WheelWin**, provided that the conditions in Section 14 are met. The model of persisting durable authoritative recovery data and reconstructing runtime objects from validated data aligns with the server-authoritative, deterministic, fail-closed principles of the project. The key constraint is that reconstruction must only proceed when authoritative information is sufficient, and must fail closed otherwise.

---

## 13. Implementation Boundaries

No implementation is performed in this report. The following future implementation stages are identified only.

### R17.9T.6-A — Recovery Architecture Specification

- **Objective:** Define the formal recovery architecture specification document based on this synthesis.
- **Architectural scope:** Recovery anchor selection, recovery eligibility rules, minimum recovery contract, runtime reconstruction boundary, failure mode handling, recovery sequence.
- **Dependencies:** This synthesis report. Approval of the architecture decision (Section 14).
- **Validation requirement:** Architecture review confirms compatibility with server-authoritative, deterministic, fail-closed principles.

### R17.9T.6-B — Recovery Data Contract

- **Objective:** Define the minimum recovery data contract — the durable authoritative data that must be persisted to enable reconstruction.
- **Architectural scope:** Identity fields (`roomId`, `gameId`, `playerId`, `playerIndex`, `contractId`, `paymentSessionId`), configuration fields (full frozen configuration or `randomService` outputs + player inputs), terminal state fields (final angles, winner result), game state phase, clock state. Must NOT include arbitrary runtime object graphs (`setTimeout` handles, `Map` references, transient motion flags).
- **Dependencies:** R17.9T.6-A.
- **Validation requirement:** Recovery data contract must be sufficient to reconstruct terminal games and must explicitly identify what is insufficient for active game reconstruction.

### R17.9T.6-C — Identity / Room / Game Reconstruction

- **Objective:** Implement `attachExistingRoom()`, `attachExistingGame()`, and player identity restoration methods that preserve original IDs.
- **Architectural scope:** `RoomManager.attachExistingRoom()`, `GameManager.attachExistingGame()`, `PlayerManager` identity restore. Must preserve original `roomId`, `gameId`, `playerId`. Must validate against financial records.
- **Dependencies:** R17.9T.6-B.
- **Validation requirement:** Reconstructed IDs match financial records. No replacement IDs are generated. `createRoom` / `createGame` / `createPlayer` are not used for recovery.

### R17.9T.6-D — Configuration Reconstruction

- **Objective:** Implement `ConfigurationEngine` restore/attach method that reconstructs the committed configuration from persisted recovery data.
- **Architectural scope:** `ConfigurationEngine.restoreConfiguration()` or `attachConfiguration()`. Must reconstruct the frozen configuration object. Must verify `snapshotHash` matches `GAME_CONTRACT.snapshotHash`.
- **Dependencies:** R17.9T.6-B, R17.9T.6-C.
- **Validation requirement:** Reconstructed configuration hash matches `GAME_CONTRACT.snapshotHash`. Configuration is immutable after reconstruction.

### R17.9T.6-E — Gameplay Runtime Reconstruction

- **Objective:** Implement reconstruction methods for `GameStateEngine`, `PhysicsEngine`, `GameClockEngine`, `InputAuthority`, `WinnerEngine`.
- **Architectural scope:** For terminal games: reconstruct `PhysicsEngine` to `STOPPED` state with final angles; recompute winner via `WinnerEngine.resolveResult`. For active games: FAIL CLOSED unless all coupled engine states can be safely reconstructed.
- **Dependencies:** R17.9T.6-B, R17.9T.6-C, R17.9T.6-D.
- **Validation requirement:** All coupled engine states are reconstructed for the same `gameId`. Physics state is `STOPPED` for terminal games. Winner recomputation is deterministic and matches `SETTLEMENT.winnerId` if settlement exists.

### R17.9T.6-F — Financial ↔ Gameplay Reconciliation

- **Objective:** Implement cross-domain validation between reconstructed gameplay state and restored financial state.
- **Architectural scope:** Verify `roomId`, `gameId`, `playerId`, `playerIndex`, `snapshotHash`, `winnerId` consistency across gameplay and financial domains. GameEscrow / TON remains authoritative.
- **Dependencies:** R17.9T.6-C, R17.9T.6-D, R17.9T.6-E.
- **Validation requirement:** All cross-domain checks pass. Financial truth is never overridden. Mismatches cause FAIL CLOSED.

### R17.9T.6-G — Restart / Recovery Validation

- **Objective:** Implement the end-to-end recovery validation sequence and failure handling.
- **Architectural scope:** Recovery candidate discovery, transition validation conditions, failure mode handling, fail-closed behavior.
- **Dependencies:** R17.9T.6-C, R17.9T.6-D, R17.9T.6-E, R17.9T.6-F.
- **Validation requirement:** All transitions in the recovery sequence are validated. All failure modes fail closed. Financial recovery proceeds independently of gameplay reconstruction. No gameplay state is invented.

---

## 14. Architecture Decision

### Verdict: APPROVED WITH CONDITIONS

The Hybrid Recovery Architecture is architecturally compatible with WheelWin's server-authoritative, deterministic, fail-closed principles. The model of persisting durable authoritative recovery data and reconstructing runtime objects from validated data is sound. However, approval is conditional on the following:

### Conditions

1. **Active gameplay reconstruction must be prohibited.** Games in active gameplay phases (`GAME_INITIALIZED` through `BRAKE`) must NOT be reconstructed. The current phase, physics state, clock state, and input state are all unknown and not persisted. Reconstructing active gameplay would require inventing state, violating determinism and fail-closed safety. Only terminal games (where `SETTLEMENT` exists or where final angles are available) may be reconstructed.

2. **A recovery data contract must be defined.** The minimum recovery data (identity fields, full frozen configuration or `randomService` outputs + player identity data, terminal physics state for completed games, game state phase) must be persisted as durable authoritative data. This data does not exist today. The contract must NOT include arbitrary runtime object graphs (`setTimeout` handles, `Map` references, transient motion flags).

3. **Attach/restore methods must preserve original IDs.** `attachExistingRoom()`, `attachExistingGame()`, and player identity restoration must preserve the original `roomId`, `gameId`, and `playerId` from financial records. `createRoom` / `createGame` / `createPlayer` must NOT be used for recovery. Recovery must NEVER silently create replacement IDs.

4. **Configuration reconstruction must not regenerate configuration.** The committed configuration must be reconstructed from persisted recovery data (frozen configuration object or original `randomService` outputs + player identity data), NOT regenerated via `buildConfiguration` with new `randomService` outputs. The reconstructed configuration's `snapshotHash` must match `GAME_CONTRACT.snapshotHash`.

5. **Financial truth must remain authoritative.** GameEscrow / TON remains the authoritative source for payment and refund truth. Gameplay recovery must validate against financial truth and must never override it. If financial truth and gameplay state conflict, gameplay FAILS CLOSED.

6. **All failure modes must fail closed.** Every failure mode identified in Section 11 must result in FAIL CLOSED for gameplay reconstruction. Financial recovery continues independently. No gameplay state is invented.

7. **The coupled bootstrap must be respected.** `GameManager` bootstraps `ConfigurationEngine`, `GameStateEngine`, `PhysicsEngine`, `GameClockEngine`, and `InputAuthority` as a coupled set per `gameId`. Reconstruction of any one engine's state for a `gameId` requires all five to be reconstructed. Partial reconstruction is unsafe.

8. **Player identity data must be persisted or sourced authoritatively.** The current `PlayerIdentity` fields (nickname, icon, age, color, colorSector2, sectorCount, sectorArrangement, baseStake) are not persisted in any financial record and are not available after restart. Either these fields must be added to the recovery data contract, or an authoritative source for this data must be identified. Without player identity data, configuration reconstruction is not possible.

Do not implement any condition in this report.

---

## 15. Scope Discipline

This report is an architecture synthesis only.

- No source code changes.
- No persistence changes.
- No API changes.
- No implementation.
- No tests.
- No new source files.

The only artifact created is this report:

- `AI_CONTEXT/CLINE_REPORTS/2026-08-22_recovery_architecture_synthesis.md`