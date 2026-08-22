# SNAPSHOT and RECOVERY_CHECKPOINT Persistence Records Audit

Date: 2026-08-22

Task: READ-ONLY audit of the existing `SNAPSHOT` and `RECOVERY_CHECKPOINT` persistence records in the WheelWin project. Focused information-gap audit for R17.9T.6 — Hybrid Recovery Architecture, before defining the Recovery Data Contract. No source code changes, no implementation, no API design, no persistence schema changes, no tests.

## 1. Scope

This audit determines exactly what information the existing `SNAPSHOT` and `RECOVERY_CHECKPOINT` persistence records already contain and whether either can contribute to gameplay recovery.

Analyzed:

- `TonFinancialRecordTypes.SNAPSHOT` record type definition, storage category, immutability.
- `TonFinancialRecordTypes.RECOVERY_CHECKPOINT` record type definition, storage category, deletability.
- SNAPSHOT record creation, persistence, loading, restoration, and every production caller.
- RECOVERY_CHECKPOINT record creation, persistence, loading, restoration, and every production caller.
- Exact schema/payload of both record types (from source code, not inference).
- Actual persisted production records where available.
- Recovery contribution matrix for both record types.
- Reusability assessment for the future Recovery Data Contract.

This was not a behavioral test pass and did not execute application test suites. No source code, configuration, or test files were modified.

## 2. Files Inspected

Project context (read before analysis, per `.clinerules`):

- `AI_CONTEXT/WHEELWIN_MASTER_CONTEXT.md`
- `AI_CONTEXT/ARCHITECTURE_RULES.md`
- `AI_CONTEXT/CURRENT_STATE.md`
- `AI_CONTEXT/AI_WORKING_RULES.md`

Prior reports reviewed:

- `AI_CONTEXT/CLINE_REPORTS/2026-08-22_recovery_runtime_managers_mapping.md`
- `AI_CONTEXT/CLINE_REPORTS/2026-08-22_recovery_runtime_engines_mapping.md`
- `AI_CONTEXT/CLINE_REPORTS/2026-08-22_financial_persistence_recovery_mapping.md`
- `AI_CONTEXT/CLINE_REPORTS/2026-08-22_recovery_architecture_synthesis.md`

Source files analyzed:

- `server/persistence/TonFinancialPersistence.js` (1488 lines, read in full)
- `server/persistence/TonFinancialRecordTypes.js` (91 lines, read in full)
- `server/persistence/tonFinancialRecordUtils.js` (289 lines, read in full)
- `server/gameplay/GameContractManager.js` (2450 lines; lines 1–1000 read in full; `_persistSnapshot` at line ~1860 read via command extraction; `_hydrateFromPersistenceRecord` at line ~1909 read via command extraction)
- `server/payment/buildGameContractSnapshot.js` (187 lines, read in full)
- `server/payment/BlockchainMonitor.js` (3068 lines; lines 1–1000 read in full; `exportCheckpoint` at line 991 and `restoreCheckpoint` at line ~1050 read via command extraction)
- `server/recovery/TonFinancialRecovery.js` (1739 lines; `_loadBlockchainCheckpoint` at line 1037 read via command extraction; `BLOCKCHAIN_CHECKPOINT_KIND` constant confirmed via search)

Actual persisted data inspected:

- `server/data/ton-financial/immutable/snapshot/` — 2 JSON files found
- `server/data/ton-financial/active/recovery_checkpoint/` — 0 files found (empty directory)

Verification searches:

- Regex search for `TonFinancialRecordTypes.SNAPSHOT|RECORD_TYPES.SNAPSHOT|"snapshot"|'snapshot'` across `server/**/*.js`.
- Regex search for `RECOVERY_CHECKPOINT|recovery_checkpoint` across `server/**/*.js`.
- Regex search for `createRecoveryCheckpoint|createSnapshotRecord|loadSnapshotRecord|loadRecoveryCheckpoint|deleteRecoveryCheckpoint` across `server/**/*.js`.
- Regex search for `BLOCKCHAIN_CHECKPOINT_KIND|monitorCheckpoint` across `server/**/*.js`.
- Regex search for `loadSnapshotRecord|loadRecoveryCheckpoint|SNAPSHOT|RECOVERY_CHECKPOINT|snapshotHash` across `server/recovery/**/*.js`.

## 3. Architecture Findings

### 3.1 Record Type Definitions

From `server/persistence/TonFinancialRecordTypes.js`:

| Property | SNAPSHOT | RECOVERY_CHECKPOINT |
|----------|---------|---------------------|
| String value | `"snapshot"` | `"recovery_checkpoint"` |
| Storage category | `immutable` | `active` |
| Immutable on create | YES (in `IMMUTABLE_ON_CREATE_TYPES`) | NO |
| Deletable | NO | YES (in `DELETABLE_RECORD_TYPES` — the only deletable type) |
| Physical directory | `immutable/snapshot/` | `active/recovery_checkpoint/` |

### 3.2 Record ID Resolution

From `server/persistence/tonFinancialRecordUtils.js` — `resolveRecordId()`:

| Record type | Record ID resolution |
|-------------|---------------------|
| `SNAPSHOT` | `metadata.snapshotId ?? payload.snapshotHash ?? payload.gameId ?? null` |
| `RECOVERY_CHECKPOINT` | `metadata.checkpointId ?? payload.checkpointId ?? randomUUID()` |

### 3.3 Record Envelope Structure

From `server/persistence/tonFinancialRecordUtils.js` — `buildRecordEnvelope()`:

Both record types share the same envelope structure:

```
{
    recordType: string,
    recordId: string,
    createdAt: number,
    updatedAt: number,
    version: number,              // schema version (1)
    status: string,               // metadata.status ?? payload.status ?? "ACTIVE"
    correlationId: string | null,
    roomId: string | null,
    gameId: string | null,
    contractId: string | null,
    tonNetwork: string | null,
    immutable: boolean,           // computed by isImmutableRecord()
    checksum: string,             // SHA-256 of payload via stableStringify
    payload: object               // type-specific payload
}
```

---

## 4. SNAPSHOT RECORD

### 4.1 SNAPSHOT Record Creation

**Production caller:** `GameContractManager._persistSnapshot(contract)` (line ~1860 in `server/gameplay/GameContractManager.js`).

**Trigger:** `_persistSnapshot(contract)` is called from `createContractRequest(roomId, { gameId, correlationId })` at line 586, immediately after `_persistContract(contract, { create: true })` and before `_emitClientUpdate(contract)`.

This means the SNAPSHOT record is created during the Game Contract creation pipeline, which is triggered by the `PAYMENT_SESSION_COMPLETED` event handler `_handlePaymentSessionCompleted` (subscribed in `initialize()`).

**Creation code (from `_persistSnapshot`):**

```javascript
this._financialPersistence.createSnapshotRecord(
    {
        snapshotHash: contract.snapshotHash,
        gameId: contract.gameId,
        roomId: contract.roomId,
        contractId: contract.contractId,
        snapshot: contract.snapshot
    },
    {
        snapshotId: contract.snapshotHash,
        roomId: contract.roomId,
        gameId: contract.gameId,
        contractId: contract.contractId,
        tonNetwork: contract.tonNetwork,
        correlationId: contract.correlationId,
        status: "FROZEN"
    }
);
```

**Duplicate handling:** If `createSnapshotRecord` throws `DUPLICATE_RECORD` (same `snapshotHash` already exists), the error is silently swallowed (method returns). This is by design — the snapshot is immutable and content-addressed by its hash.

### 4.2 SNAPSHOT Payload Schema

The SNAPSHOT record payload contains exactly these top-level fields:

| Field | Type | Source | Description |
|-------|------|--------|-------------|
| `snapshotHash` | `string` | `contract.snapshotHash` | SHA-256 hash of the game contract snapshot (hex string) |
| `gameId` | `string` | `contract.gameId` | Game identifier |
| `roomId` | `string` | `contract.roomId` | Room identifier |
| `contractId` | `string` | `contract.contractId` | Contract identifier (`contract_${randomUUID()}`) |
| `snapshot` | `object` | `contract.snapshot` | Full game contract snapshot object (see 4.3) |

### 4.3 Game Contract Snapshot Object (nested `snapshot` field)

The `snapshot` field is built by `buildGameContractSnapshot()` (`server/payment/buildGameContractSnapshot.js`).

**Top-level fields of the snapshot object:**

| Field | Type | Description |
|-------|------|-------------|
| `gameId` | `string` | Game identifier |
| `roomId` | `string` | Room identifier |
| `players` | `Array<object>` | Frozen array of player objects (see 4.3.1) |
| `sectors` | `Array<object>` | Frozen array of sector objects (see 4.3.2) |
| `baseStake` | `number` | Base stake amount (from `configuration.stake` or first player's baseStake) |
| `totalPot` | `number` | Total pot (sum of all players' `requiredGram`) |
| `organizerFee` | `number` | Organizer fee (`totalPot * feeRate`) |
| `payoutAmount` | `number` | Payout amount (`totalPot - organizerFee`) |
| `organizerFeeRate` | `number` | Fee rate (from `paymentRules.platformFeeRate`, default 0.05) |
| `winnerPercentage` | `number` | Winner percentage (`1 - feeRate`, rounded to 2 decimals) |
| `currency` | `string` | Currency identifier (`"GRM"`) |
| `ownerWallet` | `string` | Owner wallet address (from `OwnerConfiguration.getOwnerWallet()`) |
| `oracleWallet` | `string \| null` | Oracle wallet address (from `tonConfig.oracleAddress`) |
| `escrowMode` | `string \| null` | Escrow mode (`"game"` or `"v4"`) |
| `network` | `string \| null` | TON network identifier |
| `adapterIdentity` | `string \| null` | Deploy adapter class name |
| `contractAddress` | `string \| null` | On-chain contract address (`null` at snapshot creation time) |
| `frozenAt` | `number` | Timestamp when snapshot was frozen |

#### 4.3.1 Player objects (inside `snapshot.players[]`)

| Field | Type | Description |
|-------|------|-------------|
| `playerId` | `string` | Player identifier |
| `nickname` | `string \| null` | Player nickname (from `PlayerIdentity` or configuration) |
| `wallet` | `string \| null` | Player wallet address (from `sessionWalletStore.getWallet`) |
| `baseStake` | `number` | Base stake (from `PlayerIdentity.baseStake` or `configuration.stake`) |
| `sectorCount` | `number` | Sector count (1 or 2, from `PlayerIdentity.sectorCount` or configuration) |
| `requiredGram` | `number` | Required gram amount (computed via `calculateRequiredGram`) |
| `colors` | `Array<string>` | Frozen array of color identifiers (1 or 2 entries) |
| `icon` | `string \| null` | Player icon (from `PlayerIdentity.icon` or configuration) |

#### 4.3.2 Sector objects (inside `snapshot.sectors[]`)

| Field | Type | Description |
|-------|------|-------------|
| `sectorId` | `string \| null` | Sector identifier |
| `ownerId` | `string \| null` | Owning player ID |
| `color` | `string \| null` | Sector color |
| `colorId` | `string \| null` | Color identifier |
| `icon` | `string \| null` | Sector icon |
| `angleStart` | `number \| null` | Sector start angle |
| `angleEnd` | `number \| null` | Sector end angle |

**Note:** `snapshot.sectors` is populated from `configuration.sectors` if the configuration exists at snapshot creation time. If configuration does not exist (e.g., contract created before configuration is generated), `sectors` is an empty frozen array `[]`.

### 4.4 SNAPSHOT Envelope Metadata

The envelope metadata for a SNAPSHOT record (from the actual persisted record):

| Envelope field | Value |
|----------------|-------|
| `recordType` | `"snapshot"` |
| `recordId` | The `snapshotHash` (content-addressed) |
| `createdAt` | Timestamp of creation |
| `updatedAt` | Same as `createdAt` (immutable, never updated) |
| `version` | `1` (schema version) |
| `status` | `"FROZEN"` |
| `correlationId` | Contract correlation ID |
| `roomId` | Contract room ID |
| `gameId` | Contract game ID |
| `contractId` | Contract ID |
| `tonNetwork` | TON network identifier |
| `immutable` | `true` (immutable on create) |
| `checksum` | SHA-256 of payload |

### 4.5 SNAPSHOT Field Inventory Against Task Requirements

| Requested field | Present in SNAPSHOT? | Location / Notes |
|-----------------|---------------------|-------------------|
| `roomId` | YES | Envelope + payload + snapshot.roomId |
| `gameId` | YES | Envelope + payload + snapshot.gameId |
| `contractId` | YES | Envelope + payload |
| `paymentSessionId` | NOT PRESENT | |
| `playerId` | YES | snapshot.players[].playerId |
| `player identity` | PARTIAL | nickname, wallet, baseStake, sectorCount, colors, icon present. `age` NOT PRESENT. `colorSector2` NOT PRESENT as a distinct field (may be in `colors[]` array if sectorCount=2). `sectorArrangement` NOT PRESENT. |
| `playerIndex` | NOT PRESENT | No seat index / player index in snapshot |
| `wallet` | YES | snapshot.players[].wallet |
| `baseStake` | YES | snapshot.players[].baseStake + snapshot.baseStake |
| `sectorCount` | YES | snapshot.players[].sectorCount |
| `sectorArrangement` | NOT PRESENT | |
| `color` | PARTIAL | snapshot.players[].colors[] (array) + snapshot.sectors[].color |
| `colorSector2` | NOT PRESENT | As a distinct field. May be second entry in `colors[]` array if sectorCount=2. |
| `icon` | YES | snapshot.players[].icon + snapshot.sectors[].icon |
| `nickname` | YES | snapshot.players[].nickname |
| `age` | NOT PRESENT | |
| `wheel layout` | PARTIAL | snapshot.sectors[] contains sectorId, ownerId, color, colorId, icon, angleStart, angleEnd. Does NOT contain wheel start angle, polar axis, or full wheel geometry. |
| `sectors` | YES | snapshot.sectors[] |
| `sector assignments` | PARTIAL | snapshot.sectors[].ownerId maps sectors to players |
| `wheel start angle` | NOT PRESENT | |
| `triangle start angle` | NOT PRESENT | |
| `polar axis` | NOT PRESENT | |
| `timers` | NOT PRESENT | |
| `configuration version` | NOT PRESENT | |
| `traceSeed` | NOT PRESENT | |
| `physics angle` | NOT PRESENT | |
| `triangle angle` | NOT PRESENT | |
| `angular velocity` | NOT PRESENT | |
| `angular acceleration` | NOT PRESENT | |
| `simulation state` | NOT PRESENT | |
| `GameState` | NOT PRESENT | |
| `current phase` | NOT PRESENT | |
| `GameClock state` | NOT PRESENT | |
| `input state` | NOT PRESENT | |
| `command history` | NOT PRESENT | |
| `winner result` | NOT PRESENT | |
| `settlement state` | NOT PRESENT | |
| `configuration hash` | PARTIAL | `snapshotHash` is the SHA-256 hash of the game contract snapshot (financial snapshot), NOT a hash of the full game configuration. It can be used for integrity verification of the financial snapshot but does not verify the full committed configuration. |

### 4.6 SNAPSHOT Loading and Restoration

**Loading method:** `loadSnapshotRecord(snapshotId)` in `TonFinancialPersistence.js` (line 991).

**Production callers of `loadSnapshotRecord`:** NONE. No production code calls `loadSnapshotRecord`. The method exists in the persistence API but is not consumed by any runtime manager, recovery component, or engine.

**Automatic restoration during startup:** NO. `TonFinancialPersistence.restore()` loads ALL records (including SNAPSHOT records) into the in-memory `_records` Map and indexes them by room/game/contract. However, no recovery component reads SNAPSHOT records from the in-memory cache during the recovery pipeline. `TonFinancialRecovery.recover()` does not call `loadSnapshotRecord` or filter for SNAPSHOT records.

**Consumed by any current recovery component:** NO. Verification search across `server/recovery/**/*.js` confirmed zero references to `SNAPSHOT`, `loadSnapshotRecord`, or `snapshotHash` in the recovery directory.

---

## 5. SNAPSHOT SEMANTICS

### 5.1 Classification

**FINANCIAL SNAPSHOT**

### 5.2 Evidence

The SNAPSHOT record is created by `GameContractManager._persistSnapshot(contract)` during the Game Contract creation pipeline. The snapshot object is built by `buildGameContractSnapshot()`, which explicitly documents its purpose in its JSDoc:

> "P6.4 — Build an immutable Game Contract snapshot from authoritative sources. Values freeze at request time and must never change afterward."

The snapshot contains:
- Player wallet addresses and required gram amounts (financial obligations).
- Total pot, organizer fee, payout amount, fee rate, winner percentage (financial economy).
- Owner wallet, oracle wallet, escrow mode, network (blockchain deployment configuration).
- Sector geometry (from configuration, if available) — but NOT the full game configuration.

The snapshot does NOT contain:
- Game state (current phase).
- Physics state (angles, velocities, acceleration).
- Game clock state (phase, timing, pause/resume).
- Input authority state (press counts, command queues).
- Winner result (winning sector, winning player, final angles).
- Trace seed, start angles, polar axis (randomService outputs).
- Configuration version.
- Player runtime state (connectionState, playerState, ping).

The `snapshotHash` is a SHA-256 hash of this financial snapshot object, used for GameEscrow StateInit integrity verification on-chain. It is NOT a hash of the full game configuration.

### 5.3 Lifecycle

| Question | Answer |
|----------|--------|
| When is the snapshot created? | During `createContractRequest(roomId, { gameId })`, immediately after the `GAME_CONTRACT` record is persisted and before client update emission. |
| What event triggers creation? | The `PAYMENT_SESSION_COMPLETED` event → `_handlePaymentSessionCompleted` → `createContractRequest` → `_persistSnapshot`. |
| Is it immutable? | YES. `SNAPSHOT` is in `IMMUTABLE_ON_CREATE_TYPES`. The `immutable` flag is `true` on the envelope. `update()` throws `ImmutableRecordError` for immutable records. |
| Is it updated? | NO. Immutable on create. Cannot be updated. |
| Is it archived? | NO. SNAPSHOT records remain in `immutable/snapshot/` permanently. There is no archive operation for SNAPSHOT records. |
| Is it restored automatically during startup? | NO. `TonFinancialPersistence.restore()` loads SNAPSHOT records into the in-memory `_records` Map (so they are available via `loadSnapshotRecord`), but no recovery component reads them. |
| Does any current recovery component consume it? | NO. Zero references to SNAPSHOT or `loadSnapshotRecord` in `server/recovery/`. |

---

## 6. RECOVERY_CHECKPOINT

### 6.1 RECOVERY_CHECKPOINT Record Creation

**Persistence API:** `createRecoveryCheckpoint(payload, metadata)` in `TonFinancialPersistence.js` (line ~1090).

**Production callers of `createRecoveryCheckpoint`:** NONE. The method exists in the persistence API but is not called by any production code. It is only called in test files:
- `server/tests/tonFinancialRecovery.test.js` (line 513)
- `server/tests/tonFinancialPersistence.test.js`

**BlockchainMonitor.exportCheckpoint():** The `BlockchainMonitor` class has an `exportCheckpoint()` method (line 991) that exports the monitor's in-memory state as a frozen object. However, `exportCheckpoint()` is only called from `BlockchainMonitor.restart()` (line 466), which is a live restart method — it does NOT persist the checkpoint to disk. There is no production code path that calls `createRecoveryCheckpoint` with the output of `exportCheckpoint()`.

**Conclusion:** RECOVERY_CHECKPOINT records are NOT created in production. The persistence API and the recovery loading path exist, but the write path (persisting a blockchain checkpoint to disk) is not wired in production code.

### 6.2 RECOVERY_CHECKPOINT Payload Schema

Since no production records exist, the payload schema is determined from:
1. The test file `server/tests/tonFinancialRecovery.test.js` (line 513) — the only place `createRecoveryCheckpoint` is called with a realistic payload.
2. The `TonFinancialRecovery._loadBlockchainCheckpoint()` method (line 1037) — which reads and filters the records.
3. The `BlockchainMonitor.exportCheckpoint()` method (line 991) — which produces the checkpoint object structure.

**Expected payload structure (from test + loader):**

| Field | Type | Description |
|-------|------|-------------|
| `kind` | `string` | Checkpoint kind identifier. Must be `"blockchain_monitor"` (matching `BLOCKCHAIN_CHECKPOINT_KIND` constant) OR the payload must have a `monitorCheckpoint` field. |
| `checkpointAt` | `number` | Timestamp when checkpoint was created (used for sorting — latest wins) |
| `monitorCheckpoint` | `object` | The blockchain monitor checkpoint object (see 6.3) |

**Alternative payload structure:** If `payload.monitorCheckpoint` exists, the loader uses `payload.monitorCheckpoint` as the checkpoint. Otherwise, it uses `payload` itself as the checkpoint. The filter accepts records where `payload.kind === "blockchain_monitor"` OR `payload.monitorCheckpoint` is truthy.

### 6.3 Blockchain Monitor Checkpoint Object (nested `monitorCheckpoint` field)

From `BlockchainMonitor.exportCheckpoint()` (line 991):

| Field | Type | Description |
|-------|------|-------------|
| `exportedAt` | `number` | Timestamp when checkpoint was exported |
| `network` | `string \| null` | TON network identifier |
| `contracts` | `Array<object>` | Contract watch descriptors (see 6.3.1) |
| `transactions` | `Array<object>` | Pending transaction watch descriptors (filtered to `status === "PENDING"`) |
| `paymentWatches` | `Array<object>` | Payment watch descriptors |
| `gameEscrowRefundWatches` | `Array<object>` | Pending GameEscrow refund watch descriptors (filtered to `status === "PENDING"`) |
| `seenTxByRoom` | `object` | Map of `roomId` → array of seen transaction hashes |
| `confirmedRefsByRoom` | `object` | Map of `roomId` → array of confirmed payment references |
| `emittedObservations` | `Array<string>` | Global observation keys for duplicate protection |

**Note:** `gameEscrowSettlements` (GameEscrow payout watches) are NOT included in `exportCheckpoint()`. This is a gap — settlement watches are not checkpointed.

#### 6.3.1 Contract watch descriptor (inside `monitorCheckpoint.contracts[]`)

| Field | Type | Description |
|-------|------|-------------|
| `contractId` | `string` | Contract identifier |
| `address` | `string` | Normalized TON address |
| `roomId` | `string \| null` | Room identifier |
| `gameId` | `string \| null` | Game identifier |
| `correlationId` | `string \| null` | Correlation identifier |
| `expectDeployment` | `boolean` | Whether deployment is expected |
| `registeredAt` | `number` | Registration timestamp |
| `updatedAt` | `number` | Last update timestamp |
| `lastStatus` | `string \| null` | Last observed status |
| `lastSeenAt` | `number \| null` | Last seen timestamp |
| `deploymentConfirmed` | `boolean` | Whether deployment was confirmed |

### 6.4 RECOVERY_CHECKPOINT Loading and Restoration

**Loading method:** `TonFinancialRecovery._loadBlockchainCheckpoint()` (line 1037 in `server/recovery/TonFinancialRecovery.js`).

**Loading process:**
1. Calls `this._financialPersistence.listActive(TON_FINANCIAL_RECORD_TYPES.RECOVERY_CHECKPOINT)`.
2. Maps each record to `{ record, payload, sortKey }` where `sortKey = payload.checkpointAt ?? record.updatedAt ?? record.createdAt ?? 0`.
3. Filters for records where `payload.kind === BLOCKCHAIN_CHECKPOINT_KIND` (`"blockchain_monitor"`) OR `payload.monitorCheckpoint` is truthy.
4. Sorts by `sortKey` descending (latest checkpoint first).
5. Takes the first (latest) record.
6. Extracts `checkpoint = payload.monitorCheckpoint ?? payload`.
7. Validates that `checkpoint` is a non-null object.
8. Returns the checkpoint (or `null` if no matching records).

**Restoration method:** `BlockchainMonitor.restoreCheckpoint(checkpoint)` (line ~1050 in `server/payment/BlockchainMonitor.js`).

**Restoration process:**
1. Clears `_contracts`, `_transactions`, `_watches`.
2. Restores contract watches from `checkpoint.contracts[]` into `_contracts` Map (keyed by `contractId`).
3. Restores transaction watches from `checkpoint.transactions[]` into `_transactions` Map (keyed by `watchId`).
4. Restores payment watches from `checkpoint.paymentWatches[]` into `_watches` Map.
5. Restores `seenTxByRoom` from `checkpoint.seenTxByRoom`.
6. Restores `confirmedRefsByRoom` from `checkpoint.confirmedRefsByRoom`.
7. Restores `emittedObservations` from `checkpoint.emittedObservations`.

**Called during startup recovery:** YES. `TonFinancialRecovery.recover()` calls `_loadBlockchainCheckpoint()` during the BLOCKCHAIN phase (line 678), and if a checkpoint is found, calls `this._blockchainMonitor.restoreCheckpoint(checkpoint)`.

### 6.5 RECOVERY_CHECKPOINT Field Inventory Against Task Requirements

| Requested field | Present in RECOVERY_CHECKPOINT? | Location / Notes |
|-----------------|--------------------------------|-------------------|
| `roomId` | PARTIAL | Not at top level. Present inside `monitorCheckpoint.contracts[].roomId` for contract watches. Not a reliable room identity anchor. |
| `gameId` | PARTIAL | Not at top level. Present inside `monitorCheckpoint.contracts[].gameId` for contract watches. Not a reliable game identity anchor. |
| `contractId` | PARTIAL | Not at top level. Present inside `monitorCheckpoint.contracts[].contractId` for contract watches. |
| `playerId` | NOT PRESENT | |
| `paymentSessionId` | NOT PRESENT | |
| `configuration` | NOT PRESENT | |
| `configuration hash` | NOT PRESENT | |
| `game state` | NOT PRESENT | |
| `phase` | NOT PRESENT | |
| `physics state` | NOT PRESENT | |
| `clock state` | NOT PRESENT | |
| `input state` | NOT PRESENT | |
| `command history` | NOT PRESENT | |
| `winner state` | NOT PRESENT | |
| `blockchain checkpoint data` | YES | This IS the blockchain checkpoint data. The entire payload is a blockchain monitor checkpoint. |
| `transaction information` | PARTIAL | `monitorCheckpoint.transactions[]` contains pending transaction watches with `transactionId`, `address`, `contractId`, `roomId`, `gameId`, `kind`, `status`, `startedAt`, `timeoutMs`. |
| `settlement information` | NOT PRESENT | GameEscrow settlement watches are NOT included in `exportCheckpoint()`. |
| `timestamps` | YES | `checkpointAt` (payload), `exportedAt` (inside monitorCheckpoint), `registeredAt`/`updatedAt` (inside contract watches), `startedAt` (inside transaction watches). |
| `recovery metadata` | PARTIAL | `kind` ("blockchain_monitor"), `checkpointAt`. No explicit recovery metadata beyond the blockchain monitor kind. |

---

## 7. RECOVERY_CHECKPOINT SEMANTICS

### 7.1 Classification

**BLOCKCHAIN CHECKPOINT**

### 7.2 Evidence

The RECOVERY_CHECKPOINT record is:
- Created (in tests only) with `kind: "blockchain_monitor"` and a `monitorCheckpoint` object.
- Loaded by `TonFinancialRecovery._loadBlockchainCheckpoint()` which filters for `kind === "blockchain_monitor"` or `payload.monitorCheckpoint`.
- Restored by `BlockchainMonitor.restoreCheckpoint(checkpoint)` which populates the monitor's in-memory maps (contracts, transactions, payment watches, seen transactions, confirmed refs, emitted observations).

The checkpoint contains ONLY blockchain monitor observation state — contract watches, transaction watches, payment watches, seen transaction hashes, confirmed payment references, and emitted observation keys. It contains NO gameplay state, NO configuration, NO physics, NO game state, NO clock state, NO input state, NO winner state.

### 7.3 Lifecycle

| Question | Answer |
|----------|--------|
| When is it created? | NOT created in production. The `createRecoveryCheckpoint` API exists but is not called by any production code. `BlockchainMonitor.exportCheckpoint()` exists but is only called from `restart()` (live restart), not from a persistence path. |
| Which subsystem creates it? | No production subsystem. The API is designed for `BlockchainMonitor.exportCheckpoint()` output to be persisted via `createRecoveryCheckpoint()`, but this wiring does not exist. |
| Which subsystem reads it? | `TonFinancialRecovery._loadBlockchainCheckpoint()` reads it during the BLOCKCHAIN recovery phase. `BlockchainMonitor.restoreCheckpoint()` consumes the loaded checkpoint. |
| What state does it restore? | BlockchainMonitor in-memory state: contract watches, pending transaction watches, payment watches, seen transaction hashes by room, confirmed payment references by room, emitted observation keys. |
| Can it identify a gameplay session? | PARTIALLY. Contract watches inside the checkpoint contain `contractId`, `roomId`, and `gameId` — but these are blockchain observation references, not gameplay session identifiers. The checkpoint does not contain gameplay session metadata. |
| Can it reconstruct gameplay runtime? | NO. The checkpoint contains zero gameplay runtime state. It cannot reconstruct any gameplay engine, manager, or runtime object. |

---

## 8. ACTUAL FILE CONTENT

### 8.1 SNAPSHOT Records

**Directory:** `server/data/ton-financial/immutable/snapshot/`

**Files found:** 2

1. `83b0f392d6be1a5c5f0c1bb4ac54ad9eea12bce4623918eeb61da6e44ab529b9.json`
2. `86a0449f55c131e309560be48f1b190b4121255df4262fd6214ca432b5543246.json`

**Record 1 inspected (file 1):**

- **Filename/identifier:** `83b0f392d6be1a5c5f0c1bb4ac54ad9eea12bce4623918eeb61da6e44ab529b9` (SHA-256 hash, content-addressed)
- **Record type:** `"snapshot"`
- **Status:** `"FROZEN"`
- **Immutable:** `true`
- **roomId:** `"room-r179t3-1787244256775"`
- **gameId:** `"game-r179t3-1787244256775"`
- **contractId:** `"contract_1365c832-da09-455a-97db-ff6e25a64137"`
- **tonNetwork:** `"testnet"`
- **Payload structure:** Matches source-code schema exactly.
  - `snapshotHash`: matches filename
  - `snapshot.players[]`: 3 players (p0, p1, p2) with wallet addresses, baseStake=1, sectorCount=1, requiredGram=1, colors=[], icon=null, nickname=null
  - `snapshot.sectors`: empty array `[]` (configuration was not yet generated at snapshot creation time)
  - `snapshot.baseStake`: 1
  - `snapshot.totalPot`: 3
  - `snapshot.organizerFee`: 0.15
  - `snapshot.payoutAmount`: 2.85
  - `snapshot.organizerFeeRate`: 0.05
  - `snapshot.winnerPercentage`: 0.95
  - `snapshot.currency`: `"GRM"`
  - `snapshot.ownerWallet`: present (redacted — wallet address)
  - `snapshot.oracleWallet`: present (redacted — wallet address)
  - `snapshot.escrowMode`: `"game"`
  - `snapshot.network`: `"testnet"`
  - `snapshot.adapterIdentity`: `"TonGameContractAdapter"`
  - `snapshot.contractAddress`: `null` (not yet deployed at snapshot time)
  - `snapshot.frozenAt`: timestamp present
- **Checksum:** present and valid (SHA-256 of payload)

**Actual persisted payload matches source-code schema:** YES. The persisted record's payload structure exactly matches what `_persistSnapshot()` creates and what `buildGameContractSnapshot()` produces. The `sectors` array is empty in this record, confirming that the snapshot was created before configuration was generated (or configuration was not available).

**Note:** Wallet addresses and owner/oracle wallet addresses are present in the actual records but are NOT reproduced in this report per the task instruction to not expose secrets, private keys, credentials, or sensitive wallet secrets.

### 8.2 RECOVERY_CHECKPOINT Records

**Directory:** `server/data/ton-financial/active/recovery_checkpoint/`

**Files found:** 0

**NO PRODUCTION RECORDS AVAILABLE FOR INSPECTION**

The directory exists (created by `_ensureStorageLayout()` during `TonFinancialPersistence.initialize()`) but contains no JSON files. This is consistent with the finding that `createRecoveryCheckpoint` is not called by any production code.

---

## 9. RECOVERY CONTRIBUTION

### 9.1 Recovery Contribution Matrix

| Runtime domain | SNAPSHOT | RECOVERY_CHECKPOINT |
|---|---|---|
| Room identity | YES | PARTIAL |
| Game identity | YES | PARTIAL |
| Player identity | PARTIAL | NO |
| Player seats | NO | NO |
| Configuration | PARTIAL | NO |
| GameState | NO | NO |
| Physics | NO | NO |
| GameClock | NO | NO |
| InputAuthority | NO | NO |
| Winner | NO | NO |
| Financial state | YES | PARTIAL |
| Blockchain state | NO | YES |

### 9.2 Detailed Justification

**Room identity:**
- SNAPSHOT: YES — `roomId` present in envelope, payload, and snapshot.
- RECOVERY_CHECKPOINT: PARTIAL — `roomId` appears inside contract watch descriptors (`monitorCheckpoint.contracts[].roomId`) but not at the checkpoint top level. Not a reliable room identity anchor.

**Game identity:**
- SNAPSHOT: YES — `gameId` present in envelope, payload, and snapshot.
- RECOVERY_CHECKPOINT: PARTIAL — `gameId` appears inside contract watch descriptors but not at the checkpoint top level.

**Player identity:**
- SNAPSHOT: PARTIAL — `playerId`, `nickname`, `wallet`, `baseStake`, `sectorCount`, `colors`, `icon` present in `snapshot.players[]`. Missing: `age`, `colorSector2` (as distinct field), `sectorArrangement`.
- RECOVERY_CHECKPOINT: NO — no player identity data.

**Player seats:**
- SNAPSHOT: NO — no `playerIndex` or seat index field.
- RECOVERY_CHECKPOINT: NO — no player seat data.

**Configuration:**
- SNAPSHOT: PARTIAL — `snapshot.sectors[]` contains sector geometry (sectorId, ownerId, color, colorId, icon, angleStart, angleEnd) IF configuration existed at snapshot creation time. Missing: `traceSeed`, start angles, polar axis, configuration version, full wheel layout. Note: in the inspected production record, `sectors` was empty `[]` (configuration was not yet generated).
- RECOVERY_CHECKPOINT: NO — no configuration data.

**GameState:**
- SNAPSHOT: NO — no game state phase.
- RECOVERY_CHECKPOINT: NO — no game state.

**Physics:**
- SNAPSHOT: NO — no physics state.
- RECOVERY_CHECKPOINT: NO — no physics state.

**GameClock:**
- SNAPSHOT: NO — no clock state.
- RECOVERY_CHECKPOINT: NO — no clock state.

**InputAuthority:**
- SNAPSHOT: NO — no input state.
- RECOVERY_CHECKPOINT: NO — no input state.

**Winner:**
- SNAPSHOT: NO — no winner result.
- RECOVERY_CHECKPOINT: NO — no winner state.

**Financial state:**
- SNAPSHOT: YES — player wallet addresses, required gram amounts, total pot, organizer fee, payout amount, fee rate, winner percentage, owner wallet, oracle wallet, escrow mode, network, contract address (null at creation).
- RECOVERY_CHECKPOINT: PARTIAL — blockchain observation state (contract watches, transaction watches, payment watches) provides indirect financial observation context but not authoritative financial state.

**Blockchain state:**
- SNAPSHOT: NO — no blockchain observation state. `contractAddress` is `null` at snapshot creation time.
- RECOVERY_CHECKPOINT: YES — the entire payload IS blockchain monitor checkpoint data (contract watches, transaction watches, payment watches, seen transactions, confirmed refs, emitted observations).

---

## 10. DUPLICATION / REUSE QUESTION

### 10.1 SNAPSHOT Record

**Reusable partially.**

The SNAPSHOT record contains durable financial snapshot data that is already content-addressed (by `snapshotHash`) and immutable. It provides:
- `roomId`, `gameId`, `contractId` — identity anchors.
- Player wallet addresses and required gram amounts — financial identity.
- Sector geometry (when available) — partial configuration data.
- `snapshotHash` — integrity verification hash for the financial snapshot.

However, it is NOT sufficient for gameplay recovery because it lacks:
- Full game configuration (traceSeed, start angles, polar axis, configuration version).
- Game state (current phase).
- Physics state.
- Clock state.
- Input state.
- Winner result.
- Player identity completeness (missing `age`, `colorSector2`, `sectorArrangement`).
- Player seat indices.

The SNAPSHOT record should NOT be reused as-is as the Recovery Data Contract. It can serve as a supplementary integrity-verification anchor (`snapshotHash`) and as a partial identity/financial anchor, but the gameplay recovery data contract requires additional fields that the SNAPSHOT does not contain.

### 10.2 RECOVERY_CHECKPOINT Record

**Not suitable.**

The RECOVERY_CHECKPOINT record:
- Contains ONLY blockchain monitor observation state.
- Contains ZERO gameplay state.
- Is NOT created in production (the write path is not wired).
- Cannot identify gameplay sessions reliably (roomId/gameId only appear inside contract watch descriptors, not at top level).
- Cannot reconstruct any gameplay runtime object.

The RECOVERY_CHECKPOINT record should NOT be reused as part of the Recovery Data Contract. It serves a different purpose (blockchain monitor state restoration) and contains no gameplay recovery data.

---

## 11. CRITICAL ARCHITECTURE CONSTRAINT

### 11.1 SNAPSHOT Name vs. Semantics

The name "SNAPSHOT" does NOT mean gameplay snapshot. The SNAPSHOT record is a **financial snapshot** — it captures player wallet addresses, required gram amounts, total pot, fees, and escrow configuration at Game Contract creation time. It does NOT capture game configuration, game state, physics, clock, input, or winner state.

**Evidence:** The snapshot is built by `buildGameContractSnapshot()` which explicitly documents: "Build an immutable Game Contract snapshot from authoritative sources." The snapshot is persisted by `GameContractManager._persistSnapshot()` during the contract creation pipeline. The `snapshotHash` is used for GameEscrow StateInit integrity verification on-chain.

### 11.2 RECOVERY_CHECKPOINT Name vs. Semantics

The name "RECOVERY_CHECKPOINT" does NOT mean gameplay recovery checkpoint. The RECOVERY_CHECKPOINT record is a **blockchain monitor checkpoint** — it captures the BlockchainMonitor's in-memory observation state (contract watches, transaction watches, payment watches, seen transactions, confirmed refs). It does NOT capture any gameplay state.

**Evidence:** The record is loaded by `TonFinancialRecovery._loadBlockchainCheckpoint()` which filters for `kind === "blockchain_monitor"`. The checkpoint is restored by `BlockchainMonitor.restoreCheckpoint()` which populates only blockchain monitor maps. The `BLOCKCHAIN_CHECKPOINT_KIND` constant is `"blockchain_monitor"`.

---

## 12. Risks

### Critical

- **SNAPSHOT sectors may be empty:** In the inspected production record, `snapshot.sectors` was an empty array `[]` because the configuration was not yet generated at snapshot creation time. This means the SNAPSHOT record cannot be relied upon to contain sector geometry. Any future reuse of the SNAPSHOT record for configuration reconstruction must handle the case where `sectors` is empty.

- **RECOVERY_CHECKPOINT is not created in production:** The `createRecoveryCheckpoint` API exists but is not called by any production code. The `BlockchainMonitor.exportCheckpoint()` method exists but is only called from `restart()` (live restart), not from a persistence path. This means the blockchain monitor checkpoint is NOT persisted to disk in production, and the `_loadBlockchainCheckpoint()` recovery path will always return `null` in production.

### High

- **SNAPSHOT does not contain traceSeed:** The `traceSeed` (one of the `randomService` outputs needed to reproduce configuration) is NOT in the SNAPSHOT record. It is only available from `SETTLEMENT.traceSeed` for completed games. This means the SNAPSHOT cannot contribute to configuration reconstruction for active games.

- **SNAPSHOT does not contain player seat indices:** The `playerIndex` field (used for GameEscrow paidMask mapping) is NOT in the SNAPSHOT record. It is only available from `PAYMENT_SESSION.participants[].playerIndex`. Any reconstruction that needs seat assignments must source them from the PAYMENT_SESSION record, not the SNAPSHOT.

- **SNAPSHOT player identity is incomplete:** The SNAPSHOT contains `nickname`, `wallet`, `baseStake`, `sectorCount`, `colors`, `icon` but does NOT contain `age`, `colorSector2` (as a distinct field), or `sectorArrangement`. Any reconstruction that needs the full `PlayerIdentity` cannot rely on the SNAPSHOT alone.

### Medium

- **SNAPSHOT is created before configuration is committed:** The SNAPSHOT is created during `createContractRequest()`, which is triggered by `PAYMENT_SESSION_COMPLETED`. At this point, the configuration may or may not have been generated (configuration is generated by `GameManager._tryGenerateConfiguration` which is triggered by `ALL_PLAYER_PROFILES_READY`). If configuration was not yet generated, `snapshot.sectors` is empty.

- **RECOVERY_CHECKPOINT is deletable:** The RECOVERY_CHECKPOINT is the only record type in `DELETABLE_RECORD_TYPES`. Even if production records were created, they could be deleted via `deleteRecoveryCheckpoint()`. This is by design (temporary monitor state) but means the checkpoint is not durable.

### Low

- **SNAPSHOT duplicate handling is silent:** If `createSnapshotRecord` throws `DUPLICATE_RECORD` (same `snapshotHash`), the error is silently swallowed. This is correct for content-addressed immutable records but means duplicate snapshot attempts are invisible.

---

## 13. Recommendations

This section is included to satisfy the `.clinerules` report format. Per task constraints, this report makes **no implementation recommendations** and designs **no new APIs**. The following are factual observations only, not implementation proposals:

- The SNAPSHOT record is a financial snapshot, not a gameplay snapshot. It can serve as a supplementary identity and integrity anchor but cannot serve as the gameplay recovery data contract.
- The RECOVERY_CHECKPOINT record is a blockchain monitor checkpoint, not a gameplay recovery checkpoint. It contains zero gameplay state and is not even created in production.
- Neither record type should be reused as-is for the Recovery Data Contract. The SNAPSHOT can be partially reused for identity/financial/integrity data; the RECOVERY_CHECKPOINT should not be reused for gameplay recovery.
- These observations are inventory only; no changes are recommended or designed in this report.

---

## 14. Changes Made

No files modified. No source code, configuration, or test files were changed. This report is the only artifact created:

- `AI_CONTEXT/CLINE_REPORTS/2026-08-22_snapshot_recovery_checkpoint_audit.md`

---

## 15. FINAL VERDICT

### SNAPSHOT Verdict

**PARTIALLY USEFUL FOR GAMEPLAY RECOVERY**

The SNAPSHOT record contains durable financial snapshot data (identity anchors, player wallets, required gram amounts, sector geometry when available, integrity hash) that can partially contribute to gameplay recovery as a supplementary identity and integrity anchor. However, it lacks all gameplay runtime state (game state, physics, clock, input, winner), full game configuration (traceSeed, start angles, polar axis), and complete player identity data. It is a financial snapshot, not a gameplay snapshot.

### RECOVERY_CHECKPOINT Verdict

**NOT USEFUL FOR GAMEPLAY RECOVERY**

The RECOVERY_CHECKPOINT record contains only blockchain monitor observation state. It contains zero gameplay state, zero configuration data, zero physics/clock/input/winner state. It is not even created in production (the write path is not wired). It cannot contribute to gameplay recovery in any way.

### Recovery Data Contract Impact

After inspecting both record types, the following information gaps remain for the Recovery Data Contract:

**Still missing (NOT available from SNAPSHOT or RECOVERY_CHECKPOINT):**

1. Full immutable game configuration:
   - `traceSeed` (only available from `SETTLEMENT` for completed games)
   - Wheel start angle
   - Triangle start angle
   - Polar axis
   - Configuration version
   - Full wheel layout (when SNAPSHOT.sectors is empty)

2. Complete player identity data:
   - `age`
   - `colorSector2` (as a distinct field)
   - `sectorArrangement`
   - `playerIndex` (seat index — only available from `PAYMENT_SESSION`)

3. Game state:
   - Current `GameState` phase (`PRE_GAME_READY` / `READY` / `SELF_TEST` / `SPEED` / `BRAKE` / `RESULT`)
   - `GAME_STATUS` lifecycle status

4. Physics state:
   - Wheel angle, triangle angle
   - Angular velocity, angular acceleration
   - Simulation state
   - Command log (for deterministic replay)

5. Game clock state:
   - Current phase
   - Started at, elapsed, remaining
   - Pause state
   - Frozen timers snapshot

6. Input authority state:
   - Press counts
   - Button states
   - Command queues
   - Accepted commands
   - Sequence numbers

7. Winner result:
   - Winning sector
   - Winning player object
   - Final angles
   - ResolvedAt

**Partially available (from SNAPSHOT, with caveats):**

- `roomId`, `gameId`, `contractId` — fully available.
- Player `playerId`, `wallet`, `baseStake`, `sectorCount`, `colors`, `icon`, `nickname` — available but incomplete.
- `snapshotHash` — available for integrity verification of the financial snapshot.
- Sector geometry — available ONLY when configuration existed at snapshot creation time (may be empty `[]`).
- Financial economy (totalPot, organizerFee, payoutAmount, feeRate, winnerPercentage) — available.

**Already available from other financial records (not SNAPSHOT/RECOVERY_CHECKPOINT):**

- `paymentSessionId`, `playerIndex`, payment status — from `PAYMENT_SESSION`.
- `winnerId`, `winnerWallet`, `prizeAmount`, `traceSeed` — from `SETTLEMENT` (completed games only).
- `contractAddress`, deployment status — from `GAME_CONTRACT`.

The Recovery Data Contract must define new persisted fields for items 1–7 above. Neither the SNAPSHOT nor the RECOVERY_CHECKPOINT record can fill these gaps. Do NOT propose implementation yet.

---

## 16. Scope Discipline

This was a READ-ONLY evidence-gathering task.

- No source changes.
- No persistence changes.
- No API changes.
- No implementation.
- No tests.
- No schema modifications.
- No new APIs designed.

## Limitations

- `server/gameplay/GameContractManager.js` is 2450 lines. Lines 1–1000 were read in full via `read_file`. The `_persistSnapshot` method (line ~1860) and `_hydrateFromPersistenceRecord` method (line ~1909) were read via `powershell Get-Content` command extraction. The recovery-relevant findings are fully established from the extracted sections.
- `server/payment/BlockchainMonitor.js` is 3068 lines. Lines 1–1000 were read in full via `read_file`. The `exportCheckpoint` method (line 991) and `restoreCheckpoint` method (line ~1050) were read via `powershell Get-Content` command extraction. The checkpoint-relevant findings are fully established from the extracted sections.
- `server/recovery/TonFinancialRecovery.js` is 1739 lines. The `_loadBlockchainCheckpoint` method (line 1037) was read via `powershell Get-Content` command extraction. The `BLOCKCHAIN_CHECKPOINT_KIND` constant was confirmed via search.
- No application tests were run.
- Only 1 of 2 actual SNAPSHOT records was inspected in detail. The second record (`86a0449f...`) was confirmed to exist but was not read. Both records are in the same directory and follow the same schema.
- The RECOVERY_CHECKPOINT payload schema was determined from test code and source-code analysis, not from an actual production record (none exist).