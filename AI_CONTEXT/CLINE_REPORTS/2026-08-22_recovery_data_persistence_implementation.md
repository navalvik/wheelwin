# Recovery Data Persistence Implementation — R17.9T.6-C

Date: 2026-08-22

Task: Implement the durable persistence layer for the Recovery Data Contract (R17.9T.6-C). This is the FIRST implementation stage of the Hybrid Recovery Architecture. Source code changes were authorized for this stage only. The scope was strictly limited to the persistence layer — no gameplay reconstruction, no runtime manager recovery, no financial reconciliation logic was implemented.

## 1. Scope

Implemented the minimum durable persistence capability required to store Recovery Data Contract records. The implementation supports:

- durable storage;
- atomic writes;
- checksum integrity;
- schema/version metadata;
- immutable terminal recovery records;
- updateable recovery records where the architecture requires mutable active/pre-game state;
- load/list operations;
- corruption detection;
- incompatible-version handling;
- fail-closed behavior for invalid recovery records.

## 2. Files Inspected

Project context (read before implementation, per `.clinerules`):

- `AI_CONTEXT/WHEELWIN_MASTER_CONTEXT.md`
- `AI_CONTEXT/ARCHITECTURE_RULES.md`
- `AI_CONTEXT/CURRENT_STATE.md`
- `AI_CONTEXT/AI_WORKING_RULES.md`

Architecture reports reviewed:

- `AI_CONTEXT/CLINE_REPORTS/2026-08-22_recovery_architecture_synthesis.md`
- `AI_CONTEXT/CLINE_REPORTS/2026-08-22_recovery_data_contract.md`
- `AI_CONTEXT/CLINE_REPORTS/2026-08-22_financial_persistence_recovery_mapping.md`
- `AI_CONTEXT/CLINE_REPORTS/2026-08-22_snapshot_recovery_checkpoint_audit.md`

Source files analyzed before implementation:

- `server/persistence/TonFinancialPersistence.js` (1488 lines, read in full)
- `server/persistence/TonFinancialRecordTypes.js` (91 lines, read in full)
- `server/persistence/tonFinancialRecordUtils.js` (289 lines, read in full)
- `server/persistence/TonFinancialPersistenceErrors.js` (137 lines, read in full)
- `server/tests/tonFinancialPersistence.test.js` (561 lines, read in full)
- `server/package.json` (test configuration)
- `server/scripts/run-tests.js` (test runner)
- `server/engines/configuration/ConfigurationVersion.js` (CONFIGURATION_VERSION constant)

## 3. Architecture Implemented

### 3.1 Reuse Strategy

The pre-implementation audit (financial persistence recovery mapping + snapshot recovery checkpoint audit) confirmed that the existing `TonFinancialPersistence` infrastructure provides:

- File-based JSON persistence with atomic writes (temp file + `renameSync`)
- SHA-256 checksum via `stableStringify` canonicalization
- Schema versioning (`TON_FINANCIAL_SCHEMA_VERSION = 1`)
- Record envelope structure with metadata
- Immutable-on-create record types + terminal-status-based immutability
- In-memory cache + indexes (byRoom, byGame, byContract)
- Corruption detection via `validateRecordEnvelope`
- `CorruptedRecordError` thrown on corrupted records

The safe architectural path was to extend the existing persistence infrastructure with a new `RECOVERY_DATA` record type, rather than creating a parallel JSON storage engine. A thin `RecoveryDataPersistence` wrapper provides recovery-specific validation and fail-closed behavior.

### 3.2 Record Type

A new `RECOVERY_DATA` record type (`"recovery_data"`) was added to `TonFinancialRecordTypes.js`:

- Storage category: `active` (stored in `server/data/ton-financial/active/recovery_data/`)
- Not immutable-on-create (active records are mutable; terminal records become immutable via status)
- Terminal statuses: `TERMINAL`, `SETTLED`, `FAILED_CLOSED` — records with these statuses become immutable
- Record ID resolution: `metadata.recoveryRecordId ?? payload.recoveryRecordId ?? metadata.gameId ?? payload.gameId`

### 3.3 Recovery Data Contract Payload

The recovery record payload stores only durable authoritative data per R17.9T.6-B:

**A. Identity references:**
- `recoveryRecordId`, `roomId`, `gameId`, `contractId`, `paymentSessionId`, `tonNetwork`, `correlationId`

**B. Player configuration identity:**
- `players[]` array with: `playerId`, `playerIndex`, `wallet`, `nickname`, `baseStake`, `sectorCount`, `color`, `colorSector2`, `icon`, `sectorArrangement`, `age`

**C. Full frozen committed configuration:**
- `configuration` (full frozen configuration object — NOT regenerated)

**D. Configuration integrity:**
- `configurationHash` (SHA-256 of configuration via `computePayloadChecksum`)
- `configurationVersion`
- `traceSeed`
- `snapshotHash`

**E. Gameplay lifecycle state:**
- `gameState` (current GameState phase)
- `gameStatus` (GAME_STATUS lifecycle status)

**F. Clock state:**
- `phaseStartedAt`, `clockStartedAt`, `clockPaused`, `clockTotalPausedMs`, `awaitingResultActivation`, `resultPhaseStarted`, `serverTimestampAtCheckpoint`

**G. Terminal physics state (terminal records only):**
- `physicsFinalAngle`, `physicsFinalTriangleAngle`, `physicsSimulationState`

**H. Financial references only:**
- `contractId`, `paymentSessionId`, `snapshotHash`, `contractAddress`, `winnerId`
- NO duplication of `paymentStatus`, `paidAmount`, `confirmationStatus`, `refundTxHash`, `settlementTransactionHash`, or other financial authority fields

### 3.4 Versioning

Three version fields are persisted with every recovery record:

- `recoveryContractVersion` (currently `1`) — Recovery Data Contract schema version
- `schemaVersion` (currently `1`) — persistence schema version (matches `TON_FINANCIAL_SCHEMA_VERSION`)
- `configurationVersion` (currently `"1.0"`) — configuration schema version

Version handling:
- Compatible additive fields: unknown fields are preserved (not discarded)
- Incompatible major versions: `recoveryContractVersion > MAX_SUPPORTED_RECOVERY_CONTRACT_VERSION` causes fail-closed rejection
- Schema version mismatch: causes fail-closed rejection

### 3.5 Checksum

The recovery record checksum uses the existing project checksum/canonicalization mechanism:

- `computePayloadChecksum(payload)` — SHA-256 of `stableStringify(payload)`
- Computed at creation and update time by `buildRecordEnvelope` / `cloneEnvelopeForUpdate`
- Verified on load by `validateRecordEnvelope` (existing) and `RecoveryDataPersistence.validateRecoveryRecord` (new)
- Corrupted checksums cause `CorruptedRecordError` — records are never silently accepted

### 3.6 Immutability / Update Semantics

- Terminal records (status `TERMINAL`, `SETTLED`, `FAILED_CLOSED`): immutable after creation. `update()` throws `ImmutableRecordError`.
- Active/pre-game records (status `ACTIVE`): mutable. Updates preserve atomic-write semantics, recompute checksum, update `updatedAt` timestamp, and follow existing record-version conventions.

### 3.7 Failure Behavior

Fail-closed handling for:
- Malformed JSON → `CorruptedRecordError` on restore
- Checksum mismatch → `CorruptedRecordError` on restore; validation error on load
- Incompatible `recoveryContractVersion` → `TonFinancialPersistenceError` on create; validation error on load
- Incompatible `schemaVersion` → `TonFinancialPersistenceError` on create; validation error on load
- Missing required identity → `TonFinancialPersistenceError` on create; validation error on load
- Missing required immutable configuration → `TonFinancialPersistenceError` on create; validation error on load
- Invalid `configurationHash` → `TonFinancialPersistenceError` on create; validation error on load
- Invalid record structure → validation error on load; record skipped in `listRecoveryRecords()`

The persistence layer distinguishes:
- Storage corruption (checksum mismatch, malformed JSON) → `CorruptedRecordError`
- Invalid recovery contract (version mismatch, missing fields) → `TonFinancialPersistenceError` or validation errors
- Absence of recovery record → `loadRecoveryRecord()` returns `null`

One invalid recovery candidate does NOT crash the whole server. `listRecoveryRecords()` skips invalid records and logs errors.

## 4. Files Changed

### Modified files:

1. **`server/persistence/TonFinancialRecordTypes.js`**
   - Added `RECOVERY_DATA: "recovery_data"` to `TON_FINANCIAL_RECORD_TYPES`
   - Added `RECOVERY_DATA_TERMINAL_STATUSES` constant (`TERMINAL`, `SETTLED`, `FAILED_CLOSED`)
   - Added `[TON_FINANCIAL_RECORD_TYPES.RECOVERY_DATA]: "active"` to `RECORD_STORAGE_CATEGORY`

2. **`server/persistence/tonFinancialRecordUtils.js`**
   - Added `RECOVERY_DATA_TERMINAL_STATUSES` to imports
   - Added `RECOVERY_DATA` case to `resolveRecordId()` — resolves via `metadata.recoveryRecordId ?? payload.recoveryRecordId ?? metadata.gameId ?? payload.gameId`
   - Added `RECOVERY_DATA` case to `isImmutableRecord()` — returns `true` when status is in `RECOVERY_DATA_TERMINAL_STATUSES`

3. **`server/persistence/TonFinancialPersistence.js`**
   - Added typed convenience API methods for `RECOVERY_DATA`:
     - `createRecoveryDataRecord(payload, metadata)`
     - `updateRecoveryDataRecord(recordId, payload, metadata)`
     - `loadRecoveryDataRecord(recordId)`
     - `listActiveRecoveryDataRecords()`

### New files:

4. **`server/persistence/RecoveryDataPersistence.js`** (new)
   - Thin wrapper around `TonFinancialPersistence` for recovery-specific validation
   - Exports: `RecoveryDataPersistence` class, `RECOVERY_CONTRACT_VERSION`, `MAX_SUPPORTED_RECOVERY_CONTRACT_VERSION`
   - API: `createRecoveryRecord()`, `loadRecoveryRecord()`, `listRecoveryRecords()`, `updateRecoveryRecord()`, `validateRecoveryRecord()`
   - Validates: recovery contract version, schema version, identity fields, configuration fields, configuration hash, gameplay state, players array, clock state (active records), terminal physics (terminal records), financial authority duplication

5. **`server/tests/recoveryDataPersistence.test.js`** (new)
   - 15 focused tests covering all required test cases

## 5. Persistence API Added

### `RecoveryDataPersistence` class

| Method | Description |
|--------|-------------|
| `createRecoveryRecord(recoveryData, metadata?)` | Create a new recovery data record with full validation |
| `loadRecoveryRecord(recordId)` | Load a recovery record by ID; returns `null` if not found; throws on corrupted/invalid |
| `listRecoveryRecords()` | List all valid active recovery records; invalid records are skipped |
| `updateRecoveryRecord(recordId, recoveryData, metadata?)` | Update a mutable recovery record; throws `ImmutableRecordError` for terminal records |
| `validateRecoveryRecord(record)` | Validate a record's integrity, version, and structure; returns `{valid, errors}` |

### `TonFinancialPersistence` typed convenience methods

| Method | Description |
|--------|-------------|
| `createRecoveryDataRecord(payload, metadata)` | Create via generic `create()` |
| `updateRecoveryDataRecord(recordId, payload, metadata)` | Update via generic `update()` |
| `loadRecoveryDataRecord(recordId)` | Load via generic `load()` |
| `listActiveRecoveryDataRecords()` | List via generic `listActive()` |

## 6. Storage / Reuse Decisions

| Decision | Rationale |
|----------|-----------|
| Reuse `TonFinancialPersistence` infrastructure | Audit confirmed it provides atomic writes, checksum, schema versioning, immutability, corruption detection — no need for a parallel JSON storage engine |
| New `RECOVERY_DATA` record type in `active/` category | Follows existing record type conventions; recovery records are active until terminal |
| Terminal-status-based immutability | Follows existing pattern (SETTLEMENT, DEPOSIT_SESSION, etc.); terminal records become immutable via status |
| Thin `RecoveryDataPersistence` wrapper | Provides recovery-specific validation without duplicating persistence logic |
| Storage location: `server/data/ton-financial/active/recovery_data/` | Follows existing directory layout conventions; no second data directory |
| Checksum: `computePayloadChecksum` (SHA-256 of `stableStringify`) | Reuses existing project checksum/canonicalization mechanism |
| Atomic writes: temp file + `renameSync` | Reuses existing `_writeJsonAtomic` method |

## 7. Tests Added

### `server/tests/recoveryDataPersistence.test.js`

| # | Test | Description |
|---|------|-------------|
| 1 | create + load round-trip | Create a recovery record, load it back, verify all fields |
| 2 | checksum validation | Verify checksum matches payload; validate via API |
| 3 | checksum corruption rejection | Corrupt checksum on disk, verify `CorruptedRecordError` on restore |
| 4 | immutable terminal record cannot be modified | Create terminal record, verify `ImmutableRecordError` on update attempt |
| 5 | mutable recovery record can be updated | Update active record, verify changes persisted |
| 6 | incompatible version fails closed | Create with `recoveryContractVersion=99` and `schemaVersion=99`, verify rejection |
| 7 | unknown compatible fields are preserved | Add `futureFieldA` and `futureFieldB`, verify they survive persistence |
| 8 | atomic write path is used | Verify record file exists and no temp files remain |
| 9 | original IDs survive persistence | Verify all original IDs (roomId, gameId, contractId, paymentSessionId, playerId, playerIndex) survive |
| 10 | financial fields stored as references only | Verify forbidden financial authority fields are rejected; verify financial references are stored |
| 11 | list recovery records | List all records, verify all are valid |
| 12 | load non-existent record returns null | Verify `null` return for missing record |
| 13 | missing required identity fails closed | Verify rejection when `roomId` is null |
| 14 | missing required configuration fails closed | Verify rejection when `configuration` is null |
| 15 | invalid configurationHash fails closed | Verify rejection when `configurationHash` doesn't match configuration |

## 8. Test Results

### New tests (`recoveryDataPersistence.test.js`):
```
  1. create + load round-trip: OK
  2. checksum validation: OK
  3. checksum corruption rejection: OK
  4. immutable terminal record cannot be modified: OK
  5. mutable recovery record can be updated: OK
  6. incompatible version fails closed: OK
  7. unknown compatible fields are preserved: OK
  8. atomic write path is used: OK
  9. original IDs survive persistence: OK
  10. financial fields stored as references only: OK
  list recovery records: OK
  load non-existent record returns null: OK
  missing required identity fails closed: OK
  missing required configuration fails closed: OK
  invalid configurationHash fails closed: OK
recoveryDataPersistence tests passed
```

**Result: All 15 tests passed.**

### Existing persistence tests (`tonFinancialPersistence.test.js`):
```
  create record: OK
  update record: OK
  load record: OK
  restore after restart: OK
  payment + wallet session: OK
  recovery checkpoint: OK
  immutable snapshot + audit: OK
  settlement immutability: OK
  archive record: OK
  integrity validation: OK
  corrupted data detection: OK
  duplicate detection: OK
  version mismatch: OK
  checkpoint: OK
  list active + find by contract: OK
  integrity failure report: OK
tonFinancialPersistence tests passed
```

**Result: All 16 existing tests passed. No regressions.**

### Financial recovery tests (`tonFinancialRecovery.test.js`):
**Result: Passed. No regressions.**

### Financial persistence wiring tests (`financialPersistence.wiring.r810.test.js`):
**Result: All assertions passed. No regressions.**

## 9. Invariants Preserved

1. **Server Authoritative architecture** — The persistence layer is server-side only. No client authority was introduced.
2. **Financial authority** — `TonFinancialPersistence` remains the owner of financial records. The recovery persistence layer stores only financial REFERENCES (`contractId`, `paymentSessionId`, `snapshotHash`, `contractAddress`, `winnerId`), not financial authority fields. A `FORBIDDEN_FINANCIAL_AUTHORITY_FIELDS` check prevents duplication of `paymentStatus`, `paidAmount`, `confirmationStatus`, `refundTxHash`, `settlementTransactionHash`, `prizeAmount`, `organizerAmount`, `totalPot`, `requiredGram`.
3. **No arbitrary runtime objects** — Only durable authoritative data is persisted. No `Map` instances, `Set` instances, socket objects, `setTimeout` handles, transient motion flags, or runtime-only connection state are persisted.
4. **No new ID generation** — The persistence layer does not generate any new `gameId`, `roomId`, or `playerId`. It only stores and retrieves existing IDs.
5. **No gameplay reconstruction** — No `attachExistingRoom()`, `attachExistingGame()`, `ConfigurationEngine.restoreConfiguration()`, `GameStateEngine.restoreState()`, `PhysicsEngine.attachSimulation()`, `GameClockEngine.restoreClock()`, `InputAuthority.restoreRegistry()`, or `WinnerEngine.attachResult()` was implemented.
6. **No active SPEED/BRAKE recovery** — No gameplay recovery orchestration was implemented.
7. **No existing financial semantics changed** — The existing `TonFinancialPersistence` generic API, envelope structure, checksum mechanism, and immutability rules were extended, not modified. All existing record types and their behavior remain unchanged.
8. **Fail-closed behavior** — Invalid recovery records are rejected on create, rejected on load (throwing `CorruptedRecordError`), and skipped on list. The server does not crash on a single invalid record.
9. **Immutable terminal records** — Terminal recovery records (status `TERMINAL`, `SETTLED`, `FAILED_CLOSED`) are immutable after creation.
10. **Mutable active records** — Active/pre-game recovery records can be updated with atomic-write semantics, checksum recomputation, and timestamp updates.

## 10. Known Limitations

1. **No gameplay reconstruction** — This stage implements ONLY the persistence layer. No runtime manager recovery, no engine restoration, no gameplay recovery orchestration was implemented. Those belong to later stages (R17.9T.6-D through R17.9T.6-H).
2. **No production wiring** — The `RecoveryDataPersistence` is not yet wired into the server startup sequence or game lifecycle events. No production code calls `createRecoveryRecord()` yet. This is by design — the persistence layer is ready for use by later stages.
3. **No recovery record deletion** — Recovery records are not deletable (not in `DELETABLE_RECORD_TYPES`). This is by design — recovery records must survive for audit and terminal-state validation. Terminal records are immutable; active records remain until they reach terminal state.
4. **No end-to-end server restart recovery tests** — Per task instructions, end-to-end recovery tests belong to R17.9T.6-H.
5. **Catalog version not persisted** — The recovery data contract does not yet include a catalog version field. This was noted as an information gap in the source reports. The `frozenTimers` are derivable from the catalog if the catalog version matches, but catalog version persistence is deferred to a future stage if needed.

## 11. Explicit Confirmation

**Gameplay reconstruction was NOT implemented in this stage.**

This stage implemented ONLY the durable persistence layer for the Recovery Data Contract. Specifically:

- ✅ Durable storage for recovery data records
- ✅ Atomic writes, checksum integrity, schema/version metadata
- ✅ Immutable terminal records, mutable active records
- ✅ Load/list operations, corruption detection, fail-closed behavior
- ❌ No `attachExistingRoom()` — NOT implemented
- ❌ No `attachExistingGame()` — NOT implemented
- ❌ No `PlayerManager` recovery — NOT implemented
- ❌ No `ConfigurationEngine` restoration — NOT implemented
- ❌ No `GameStateEngine` restoration — NOT implemented
- ❌ No `PhysicsEngine` restoration — NOT implemented
- ❌ No `GameClockEngine` restoration — NOT implemented
- ❌ No `InputAuthority` restoration — NOT implemented
- ❌ No `WinnerEngine` restoration — NOT implemented
- ❌ No gameplay recovery orchestration — NOT implemented
- ❌ No server restart gameplay reconstruction — NOT implemented
- ❌ No active gameplay resume — NOT implemented
- ❌ No financial reconciliation logic — NOT implemented

## 12. Lifecycle Flow

### Recovery Record Creation Flow (future wiring):

```
Game lifecycle event (configuration committed / phase transition / game completion)
        |
        v
RecoveryDataPersistence.createRecoveryRecord(recoveryData)
  → validates payload (version, identity, configuration, gameplay state, players, financial authority)
  → delegates to TonFinancialPersistence.createRecoveryDataRecord()
  → buildRecordEnvelope() computes checksum
  → _writeJsonAtomic() writes to disk (temp file + rename)
  → record indexed by room/game/contract
  → auto-checkpoint (if enabled)
        |
        v
Recovery record available for SERVER_RESTART reconstruction
```

### Recovery Record Load Flow (future wiring):

```
SERVER RESTART
        |
        v
TonFinancialPersistence.restore()
  → loads ALL records from disk (including RECOVERY_DATA)
  → validates envelope (checksum, schema version)
  → CorruptedRecordError on corrupted records
        |
        v
RecoveryDataPersistence.listRecoveryRecords()
  → lists active RECOVERY_DATA records
  → validates each record (version, identity, configuration, gameplay state)
  → skips invalid records (fail-closed per record, not server-wide)
        |
        v
RecoveryDataPersistence.loadRecoveryRecord(recordId)
  → loads specific record
  → validates record
  → returns null if not found
  → throws CorruptedRecordError if invalid