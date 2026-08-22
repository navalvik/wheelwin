# Financial Persistence and Recovery Mapping

Date: 2026-08-22

Task: READ-ONLY Financial Persistence and Recovery Mapping for the WheelWin project. Third focused analysis step of R17.9T.6 Hybrid Recovery Architecture. Factual inventory of financial persistence mechanisms, persisted record types and fields, financial recovery pipeline behavior, cross-domain recovery boundary, authoritative sources, recovery lifecycle, and recovery capability classification. No source code changes, no implementation, no API design, no schema changes, no RecoveryEngine analysis, no client-reconnect analysis, no RoomManager/GameManager/PlayerManager analysis, no runtime engine analysis.

## 1. Scope

This report maps the financial persistence layer and financial recovery layer of WheelWin. It establishes exactly what financial persistence survives a server restart and what authoritative information is available for a future gameplay-runtime reconstruction.

Analyzed areas:

- Persistence mechanism, physical storage, record types, record identifiers, survival, write model, startup loading, active/terminal distinction.
- `GAME_CONTRACT` record field inventory.
- `PAYMENT_SESSION` record field inventory.
- `SETTLEMENT` record field inventory (required for financial recovery boundary).
- `TonFinancialRecovery` pipeline: what it restores, what in-memory structures it reconstructs, and what it does NOT reconstruct.
- `PaymentSessionManager.restorePaymentSessions()` surrounding persistence/recovery behavior.
- Cross-domain recovery boundary between financial recovery and gameplay runtime recovery.
- Authoritative sources for each persisted field.
- Actual startup recovery sequence.
- Recovery capability classification.

This was not a behavioral test pass and did not execute application test suites. No source code, configuration, or test files were modified.

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
- `AI_CONTEXT/CLINE_REPORTS/2026-08-22_recovery_runtime_engines_mapping.md`

Primary source files analyzed:

- `server/persistence/TonFinancialPersistence.js` (1488 lines, read in full)
- `server/persistence/TonFinancialRecordTypes.js` (91 lines, read in full)
- `server/persistence/tonFinancialRecordUtils.js` (289 lines, read in full)
- `server/persistence/TonFinancialPersistenceErrors.js` (referenced via imports)
- `server/recovery/TonFinancialRecovery.js` (1739 lines, read in full)
- `server/recovery/TonFinancialRecoveryStates.js` (referenced via imports)
- `server/recovery/TonFinancialRecoveryErrors.js` (referenced via imports)
- `server/gameplay/PaymentSessionManager.js` (2861 lines; `_persistSession` at line 2667, `restorePaymentSessions` at line 702 per prior report)
- `server/gameplay/GameContractManager.js` (2450 lines; `restoreContracts` at line 1024, `_persistContract` at line 1775, `_hydrateFromPersistenceRecord` at line 1909)
- `server/payment/ContractSettlementManager.js` (2862 lines; `restoreSettlementSessions` at line 432, `_persistSession` at line 2610)

Directly imported persistence record definitions:

- `server/models/PaymentSession.js` (539 lines, read in full — `toPayload()`, `fromRecord()`, `PaymentParticipant` class)
- `server/payment/SettlementSession.js` (296 lines, read in full — `toPayload()`, `fromRecord()`)
- `server/models/GameContract.js` (referenced via imports; `GameContract` constructor fields observed through `_hydrateFromPersistenceRecord`)

Physical data directory verified:

- `server/data/ton-financial/` — contains `manifest.json`, `active/`, `archived/`, `immutable/` subdirectories
- `server/data/session-history/` — contains `ROOM_DESTROYED` audit records only

## 3. Architecture Findings

### 3.1 Persistence mechanism

**Mechanism:** File-based JSON persistence using Node.js `node:fs` synchronous APIs (`mkdirSync`, `readFileSync`, `readdirSync`, `renameSync`, `rmSync`, `unlinkSync`, `writeFileSync`).

**Class:** `TonFinancialPersistence` (`server/persistence/TonFinancialPersistence.js`).

**Key characteristics:**
- Passive persistence only — no business logic, blockchain, gameplay, or EventBus.
- Managers call this layer to survive server restart and support recovery.
- Atomic writes via temp file + `renameSync` (`_writeJsonAtomic`): writes to `${filePath}.${process.pid}.${Date.now()}.tmp`, then `renameSync(tempPath, filePath)`.
- In-memory cache: `this._records` (`Map<string, object>`) holds all loaded record envelopes.
- In-memory indexes: `this._indexes` with `byRoom`, `byGame`, `byContract` Maps.
- Schema version: `TON_FINANCIAL_SCHEMA_VERSION = 1`.
- Auto-checkpoint: writes manifest after each create/update/delete/archive operation (configurable via `autoCheckpoint`).

### 3.2 Physical storage layout

```
server/data/ton-financial/
├── manifest.json
├── active/
│   ├── game_contract/
│   │   └── <contractId>.json
│   ├── payment_session/
│   │   └── <paymentSessionId>.json
│   ├── wallet_session/
│   │   └── <walletSessionId>.json
│   ├── settlement/
│   │   └── <gameId>.json
│   ├── recovery_checkpoint/
│   │   └── <checkpointId>.json
│   ├── deployment_cost_snapshot/
│   │   └── <recordId>.json
│   ├── deployment_reimbursement/
│   │   └── <recordId>.json
│   ├── deposit_session/
│   │   └── <depositId>.json
│   └── deployment_authorization/
│       └── <authorizationId>.json
├── immutable/
│   ├── snapshot/
│   │   └── <snapshotHash>.json
│   ├── audit/
│   │   └── <auditId>.json
│   └── deposit_observation/
│       └── <observationId>.json
└── archived/
    └── archived_contract/
        └── <contractId>.json
```

Directory mapping is defined by `RECORD_STORAGE_CATEGORY` in `TonFinancialRecordTypes.js` and `CATEGORY_DIRECTORIES` in `TonFinancialPersistence.js`.

### 3.3 Record types

Defined in `TonFinancialRecordTypes.js` (`TON_FINANCIAL_RECORD_TYPES`):

| Record type | String value | Storage category | Immutable on create? |
|-------------|-------------|-----------------|---------------------|
| `GAME_CONTRACT` | `"game_contract"` | active | No |
| `PAYMENT_SESSION` | `"payment_session"` | active | No |
| `WALLET_SESSION` | `"wallet_session"` | active | No |
| `SETTLEMENT` | `"settlement"` | active | No (immutable at terminal status) |
| `RECOVERY_CHECKPOINT` | `"recovery_checkpoint"` | active | No (deletable) |
| `DEPLOYMENT_COST_SNAPSHOT` | `"deployment_cost_snapshot"` | active | No (immutable at FROZEN) |
| `DEPLOYMENT_REIMBURSEMENT` | `"deployment_reimbursement"` | active | No (immutable at terminal) |
| `DEPOSIT_SESSION` | `"deposit_session"` | active | No (immutable at terminal) |
| `DEPLOYMENT_AUTHORIZATION` | `"deployment_authorization"` | active | No (immutable at terminal) |
| `SNAPSHOT` | `"snapshot"` | immutable | Yes |
| `AUDIT` | `"audit"` | immutable | Yes |
| `ARCHIVED_CONTRACT` | `"archived_contract"` | archived | Yes |
| `DEPOSIT_OBSERVATION` | `"deposit_observation"` | immutable | Yes |

### 3.4 Record identifiers / keys

Defined in `resolveRecordId()` in `tonFinancialRecordUtils.js`:

| Record type | Record ID resolution |
|-------------|---------------------|
| `GAME_CONTRACT` | `metadata.contractId ?? payload.contractId` |
| `PAYMENT_SESSION` | `metadata.paymentSessionId ?? payload.paymentSessionId` |
| `WALLET_SESSION` | `metadata.walletSessionId ?? payload.walletSessionId ?? metadata.roomId ?? payload.roomId` |
| `SETTLEMENT` | `metadata.settlementId ?? metadata.gameId ?? payload.gameId` |
| `SNAPSHOT` | `metadata.snapshotId ?? payload.snapshotHash ?? payload.gameId` |
| `RECOVERY_CHECKPOINT` | `metadata.checkpointId ?? payload.checkpointId ?? randomUUID()` |
| `DEPOSIT_SESSION` | `metadata.depositId ?? payload.depositId ?? metadata.recordId` |
| `DEPLOYMENT_AUTHORIZATION` | `metadata.authorizationId ?? payload.authorizationId ?? metadata.recordId` |
| `DEPOSIT_OBSERVATION` | `metadata.observationId ?? payload.observationId ?? `${depositId}__${transactionHash}` ?? metadata.recordId` |

Internal key format: `${recordType}:${recordId}` (from `_recordKey()`).

### 3.5 Record envelope structure

Defined in `buildRecordEnvelope()` in `tonFinancialRecordUtils.js`:

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

The public record returned by `_publicRecord()` exposes all envelope fields plus a shallow-frozen copy of `payload`.

### 3.6 Write model

**Update-in-place** (not append-only).

- `create()` writes a new JSON file and stores the envelope in `_records`.
- `update()` reads the existing envelope, clones it with new payload/metadata, writes the file (overwriting), and updates `_records`.
- `deleteRecord()` removes the file and the in-memory entry (only for `RECOVERY_CHECKPOINT` type).
- `_purgeRecord()` removes the file and in-memory entry for specific types (`DEPOSIT_SESSION`, `DEPLOYMENT_AUTHORIZATION`) without making the type generally deletable.
- `archive()` moves a `GAME_CONTRACT` to `ARCHIVED_CONTRACT` by creating an immutable archived record and deleting the active one.

### 3.7 Startup loading

`initialize({ dataDir })`:
1. Calls `_ensureStorageLayout()` — creates all directories.
2. Calls `_loadManifest()` — reads `manifest.json` (returns `null` if not found).
3. Calls `restore()` — loads ALL records from disk:
   - Clears `_records`, `_indexes.byRoom`, `_indexes.byGame`, `_indexes.byContract`.
   - Iterates all `TON_FINANCIAL_RECORD_TYPES` values.
   - For each type, reads its directory (`_typeDirectory()`), lists `.json` files.
   - For each file: reads envelope (`_readEnvelopeFile`), validates (`validateRecordEnvelope`), stores in `_records`, indexes by room/game/contract.
   - `CorruptedRecordError` is thrown immediately; other errors are collected.
   - If errors exist and `recordCount === 0`, throws `RecoveryFailureError`.
   - Returns `{ recordCount, errors }`.

### 3.8 Active vs terminal record distinction

- `listActive(recordType)` filters records where `RECORD_STORAGE_CATEGORY[envelope.recordType] === "active"`.
- This returns records in the `active/` directory, regardless of their status field.
- Terminal records are distinguished by their `status` field and `immutable` flag:
  - `SETTLEMENT`: immutable when `status` is `SETTLEMENT_COMPLETED` or `SETTLEMENT_FAILED`.
  - `DEPLOYMENT_COST_SNAPSHOT`: immutable when `status` is `FROZEN`.
  - `DEPLOYMENT_REIMBURSEMENT`: immutable when `status` is `CONFIRMED`, `CANCELLED`, or `FAILED_TERMINAL`.
  - `DEPOSIT_SESSION`: immutable when `status` is `RELEASED`, `REIMBURSED`, or `REFUNDED`.
  - `DEPLOYMENT_AUTHORIZATION`: immutable when `status` is `CONSUMED` or `REVOKED`.
- `IMMUTABLE_ON_CREATE_TYPES` (`SNAPSHOT`, `AUDIT`, `ARCHIVED_CONTRACT`, `DEPOSIT_OBSERVATION`) are immutable immediately on create.
- The `immutable` flag on the envelope prevents further updates via `update()`.

## 4. GAME_CONTRACT Records

### 4.1 Payload fields (from `GameContractManager._persistContract`)

| Field | Source | Description |
|-------|--------|-------------|
| `contractId` | `contract.contractId` | Contract identifier (`contract_${randomUUID()}`) |
| `gameId` | `contract.gameId` | Game identifier |
| `roomId` | `contract.roomId` | Room identifier |
| `status` | `contract.status` | `GAME_CONTRACT_STATUS` enum value |
| `contractAddress` | `contract.contractAddress` | On-chain GameEscrow address (null until deployed) |
| `deploymentStatus` | `contract.deploymentStatus` | Deployment lifecycle status |
| `deployedAt` | `contract.deployedAt` | Deployment timestamp |
| `deploymentTxId` | `contract.deploymentTxId` | Deployment transaction hash |
| `deployError` | `contract.deployError` | Deployment failure reason |
| `paymentsCompletedAt` | `contract.paymentsCompletedAt` | Payments completion timestamp |
| `tonNetwork` | `contract.tonNetwork` | TON network identifier |
| `snapshotHash` | `contract.snapshotHash` | SHA-256 hash of the game contract snapshot |
| `version` | `contract.version` | Contract version number |
| `gameStartedAt` | `contract.gameStartedAt` | Game start timestamp |
| `archivedAt` | `contract.archivedAt` | Archive timestamp |
| `failureReason` | `contract.failureReason` | Contract failure reason |
| `snapshot` | `contract.snapshot` | Full game contract snapshot object (see 4.2) |

### 4.2 Envelope metadata fields

| Field | Source |
|-------|--------|
| `status` | `contract.status` |
| `roomId` | `contract.roomId` |
| `gameId` | `contract.gameId` |
| `contractId` | `contract.contractId` |
| `tonNetwork` | `contract.tonNetwork` |
| `correlationId` | `contract.correlationId` |
| `createdAt` | `contract.createdAt` |
| `updatedAt` | `contract.updatedAt ?? Date.now()` |
| `version` | `contract.version` |

### 4.3 Snapshot object contents

The `snapshot` field is built by `buildGameContractSnapshot()` (imported from `../payment/buildGameContractSnapshot.js`). Based on the `createContractRequest` method, the snapshot is built from:
- `gameId`, `roomId`
- `playerIds` (from `room.players`)
- `playerManager` (player wallet/identity data)
- `sessionWalletStore`
- `configuration` (from `ConfigurationEngine.getConfiguration(gameId)`)
- `paymentRules`
- `oracleWallet` (platform config)
- `escrowMode`
- `network`
- `adapterIdentity`
- `contractAddress` (null at creation time)

The snapshot contains player wallet addresses, required gram amounts, oracle wallet, escrow mode, and a snapshot hash. It does NOT contain the full game configuration (wheel layout, sectors, colors, icons, timers, trace seed, start angles).

### 4.4 Fields NOT present in GAME_CONTRACT records

The following gameplay-relevant information is NOT present in persisted `GAME_CONTRACT` records:

- Full immutable game configuration (wheel layout, sectors, colors, icons, timers, trace seed, start angles)
- Game state (current phase: PRE_GAME_READY, READY, SELF_TEST, SPEED, BRAKE, RESULT)
- Physics state (wheel angle, triangle angle, angular velocity, acceleration, simulation state)
- Game clock state (current phase, timing, pause/resume, frozen timers)
- Input authority state (player press counts, command queues, accepted commands)
- Winner result (winning sector, winning player object, final angles, resolvedAt)
- Room state (maxPlayers, room status, player slots)
- Player identity data (nickname, icon, age, color, sectorCount, sectorArrangement, baseStake)
- Player runtime state (connectionState, playerState, ping, connectedAt, lastSeen)

### 4.5 Hydration from persistence

`_hydrateFromPersistenceRecord(record)` reconstructs a `GameContract` from the persisted record by reading payload fields and falling back to envelope metadata fields where payload is absent.

## 5. PAYMENT_SESSION Records

### 5.1 Payload fields (from `PaymentSession.toPayload()`)

| Field | Source | Description |
|-------|--------|-------------|
| `paymentSessionId` | `this.paymentSessionId` | Payment session identifier |
| `roomId` | `this.roomId` | Room identifier |
| `gameId` | `this.gameId` | Game identifier (may be null) |
| `contractId` | `this.contractId` | Contract identifier (may be null) |
| `network` | `this.network` | TON network identifier |
| `players` | `participants.map(p => p.playerId)` | Array of player ID strings |
| `walletSessions` | `this.walletSessions` | Array of wallet session objects |
| `requiredPayments` | `this.requiredPayments` | Array of required payment objects |
| `receivedPayments` | `this.receivedPayments` | Array of received payment objects |
| `participants` | `participants.map(p => p.toSnapshot())` | Array of participant snapshots (see 5.2) |
| `paymentDeadline` | `this.paymentDeadline` | Payment deadline timestamp |
| `status` | `this.status` | `PAYMENT_SESSION_STATUS` enum value |
| `createdAt` | `this.createdAt` | Creation timestamp |
| `updatedAt` | `this.updatedAt` | Last update timestamp |
| `expiresAt` | `this.expiresAt` | Expiry timestamp |
| `completedAt` | `this.completedAt` | Completion timestamp (may be null) |
| `correlationId` | `this.correlationId` | Correlation identifier |
| `version` | `this.version` | Version number |
| `recoveryMetadata` | `this.recoveryMetadata` | Recovery metadata object (may be null) |

### 5.2 Participant snapshot fields (from `PaymentParticipant.toSnapshot()`)

| Field | Description |
|-------|-------------|
| `playerId` | Player identifier |
| `requiredGram` | Required gram amount |
| `requiredAmount` | Alias for `requiredGram` |
| `status` | `PAYMENT_PARTICIPANT_STATUS` enum value |
| `wallet` | Player wallet address |
| `walletAddress` | Alias for `wallet` |
| `walletSessionId` | Wallet session identifier |
| `paymentReference` | Payment reference |
| `contractAddress` | Contract address |
| `txHash` | Transaction hash |
| `transactionHash` | Alias for `txHash` |
| `paidAmount` | Paid amount |
| `confirmationStatus` | `PAYMENT_CONFIRMATION_STATUS` enum value |
| `confirmedAt` | Confirmation timestamp |
| `playerIndex` | Player seat index (for GameEscrow paidMask mapping) |
| `refunded` | Whether player was refunded |
| `refundTxHash` | Refund transaction hash |

### 5.3 Envelope metadata fields

| Field | Source |
|-------|--------|
| `paymentSessionId` | `session.paymentSessionId` |
| `roomId` | `session.roomId` |
| `gameId` | `session.gameId` |
| `contractId` | `session.contractId` |
| `tonNetwork` | `session.network` |
| `correlationId` | `session.correlationId` |
| `status` | `session.status` |

### 5.4 Fields NOT present in PAYMENT_SESSION records

The following gameplay-relevant information is NOT present in persisted `PAYMENT_SESSION` records:

- Full immutable game configuration (wheel layout, sectors, colors, icons, timers, trace seed, start angles)
- Game state (current phase)
- Physics state
- Game clock state
- Input authority state
- Winner result
- Room state (maxPlayers, room status)
- Player identity data (nickname, icon, age, color, sectorCount, sectorArrangement, baseStake)
- Player runtime state (connectionState, playerState, ping, connectedAt, lastSeen)
- Game lifecycle status (GAME_STATUS)

### 5.5 Hydration from persistence

`PaymentSession.fromRecord(record)` reconstructs a `PaymentSession` from the persisted record by reading payload fields and falling back to envelope metadata fields where payload is absent. Participants are reconstructed via `PaymentParticipant` constructor from participant snapshot objects.

## 6. SETTLEMENT Records

### 6.1 Payload fields (from `SettlementSession.toPayload()`)

| Field | Source | Description |
|-------|--------|-------------|
| `settlementSessionId` | `this.settlementSessionId` | Settlement session identifier |
| `contractId` | `this.contractId` | Contract identifier |
| `gameId` | `this.gameId` | Game identifier |
| `roomId` | `this.roomId` | Room identifier |
| `winnerId` | `this.winnerId` | Winner player identifier |
| `winnerWallet` | `this.winnerWallet` | Winner wallet address |
| `prizeAmount` | `this.prizeAmount` | Prize amount |
| `winnerAmount` | `this.prizeAmount` | Alias for `prizeAmount` |
| `organizerAmount` | `this.organizerAmount` | Organizer fee amount |
| `totalPot` | `this.totalPot` | Total pot amount |
| `network` | `this.network` | TON network identifier |
| `status` | `this.status` | `SETTLEMENT_SESSION_STATUS` enum value |
| `settlementTransactionHash` | `this.settlementTransactionHash` | Settlement transaction hash |
| `settlementTxHash` | `this.settlementTransactionHash` | Alias |
| `createdAt` | `this.createdAt` | Creation timestamp |
| `updatedAt` | `this.updatedAt` | Last update timestamp |
| `completedAt` | `this.completedAt` | Completion timestamp |
| `correlationId` | `this.correlationId` | Correlation identifier |
| `version` | `this.version` | Version number |
| `ownerWallet` | `this.ownerWallet` | Owner wallet address |
| `traceSeed` | `this.traceSeed` | Configuration trace seed |
| `startedAt` | `this.startedAt` | Settlement start timestamp |
| `failedAt` | `this.failedAt` | Failure timestamp |
| `reason` | `this.reason` | Failure reason |
| `settlementDeadline` | `this.settlementDeadline` | Settlement deadline timestamp |
| `recoveryMetadata` | `this.recoveryMetadata` | Recovery metadata object |
| `request` | `this.request` | Settlement request object (for GameEscrow payout watch re-registration) |

### 6.2 Hydration from persistence

`SettlementSession.fromRecord(record)` reconstructs a `SettlementSession` from the persisted record by reading payload fields and falling back to envelope metadata fields where payload is absent.

## 7. Financial Recovery (TonFinancialRecovery)

### 7.1 What TonFinancialRecovery restores

`TonFinancialRecovery.recover()` orchestrates a mandatory recovery pipeline on server startup. It restores the following in-memory structures:

| What | How | In-memory structure |
|------|-----|---------------------|
| Wallet sessions | `WalletManager.restoreSessions()` or `SessionWalletStore.restore()` | Wallet session in-memory maps |
| Game contracts | `GameContractManager.restoreContracts()` | `_contractsByRoom`, `_contractsById`, `_roomByGameId` Maps |
| Payment sessions | `PaymentSessionManager.restorePaymentSessions()` | `_sessionsByRoom` Map |
| Deposit sessions | `DepositSessionCoordinator.restoreActiveSessions()` | Deposit session in-memory maps |
| Deployment authorizations | `DeploymentAuthorizationCoordinator.restoreActiveAuthorizations()` | Authorization in-memory maps |
| Settlement sessions | `ContractSettlementManager.restoreSettlementSessions()` | `_byGameId` Map |
| Blockchain checkpoint | `BlockchainMonitor.restoreCheckpoint()` | Blockchain monitor in-memory state |
| Blockchain watches | `_reregisterBlockchainWatches()` | Contract/payment/settlement/refund watches |
| Settlement resume | `ContractSettlementManager.resumeRestoredSettlements()` | On-chain settlement state probe |

### 7.2 Which persisted records it reads

| Phase | Records read | Method |
|-------|-------------|--------|
| WALLETS | `WALLET_SESSION` (active) | `WalletManager.restoreSessions()` -> `listActive(WALLET_SESSION)` |
| CONTRACTS | `GAME_CONTRACT` (active) | `GameContractManager.restoreContracts()` -> `listActive("game_contract")` |
| PAYMENTS | `PAYMENT_SESSION` (active) | `PaymentSessionManager.restorePaymentSessions()` -> `listActive(PAYMENT_SESSION)` |
| DEPOSITS | `DEPOSIT_SESSION` (active) | `DepositSessionCoordinator.restoreActiveSessions()` |
| AUTHORIZATIONS | `DEPLOYMENT_AUTHORIZATION` (active) | `DeploymentAuthorizationCoordinator.restoreActiveAuthorizations()` |
| SETTLEMENTS | `SETTLEMENT` (active) | `ContractSettlementManager.restoreSettlementSessions()` -> `listActive(SETTLEMENT)` |
| BLOCKCHAIN | `RECOVERY_CHECKPOINT` (active) | `_loadBlockchainCheckpoint()` -> `listActive(RECOVERY_CHECKPOINT)` |

### 7.3 Which records it considers active

All records in the `active/` storage category are considered active. The `listActive()` method filters by `RECORD_STORAGE_CATEGORY[envelope.recordType] === "active"`. Terminal records (e.g., `SETTLEMENT_COMPLETED`, `SETTLEMENT_FAILED`) are still in the `active/` directory and are loaded, but individual restore methods may skip terminal records:

- `restoreContracts()`: loads all active `GAME_CONTRACT` records (does not skip terminal ones).
- `restorePaymentSessions()`: skips terminal sessions unless they are `CANCELLED` (R7.69C).
- `restoreSettlementSessions()`: skips terminal settlement sessions.

### 7.4 What in-memory structures it reconstructs

TonFinancialRecovery reconstructs financial in-memory structures only:

- `GameContractManager._contractsByRoom`, `_contractsById`, `_roomByGameId`
- `PaymentSessionManager._sessionsByRoom`
- `ContractSettlementManager._byGameId`
- `WalletManager` / `SessionWalletStore` in-memory maps
- `BlockchainMonitor` checkpoint and watches
- `DepositSessionCoordinator` in-memory maps
- `DeploymentAuthorizationCoordinator` in-memory maps

### 7.5 Whether it reconstructs gameplay runtime objects

| Item | Reconstructed? |
|------|---------------|
| Gameplay runtime objects | NO |
| RoomManager state | NO |
| GameManager state | NO |
| PlayerManager state | NO |
| ConfigurationEngine state | NO |
| GameStateEngine state | NO |
| PhysicsEngine state | NO |
| GameClockEngine state | NO |
| InputAuthority state | NO |
| WinnerEngine state | NO |

TonFinancialRecovery reconstructs financial in-memory structures only. It does NOT reconstruct any gameplay runtime objects, rooms, games, players, configurations, game states, physics, clocks, inputs, or winner results.

## 8. PaymentSessionManager Recovery

### 8.1 What persisted PAYMENT_SESSION data is sufficient to rehydrate

The persisted `PAYMENT_SESSION` record contains sufficient data to rehydrate the `PaymentSession` in-memory object:
- `paymentSessionId`, `roomId`, `gameId`, `contractId`, `network`
- `participants` (with `playerId`, `requiredGram`, `status`, `wallet`, `walletSessionId`, `paymentReference`, `contractAddress`, `txHash`, `paidAmount`, `confirmationStatus`, `confirmedAt`, `playerIndex`, `refunded`, `refundTxHash`)
- `paymentDeadline`, `status`, `createdAt`, `updatedAt`, `expiresAt`, `completedAt`
- `correlationId`, `version`, `recoveryMetadata`
- `walletSessions`, `requiredPayments`, `receivedPayments`

`PaymentSession.fromRecord(record)` fully reconstructs the `PaymentSession` object from these fields.

### 8.2 What information is missing for gameplay runtime reconstruction

The persisted `PAYMENT_SESSION` record does NOT contain:
- Room state (maxPlayers, room status, player slots)
- Game lifecycle status (GAME_STATUS)
- Player identity data (nickname, icon, age, color, sectorCount, sectorArrangement, baseStake)
- Player runtime state (connectionState, playerState, ping, connectedAt, lastSeen)
- Immutable game configuration (wheel layout, sectors, colors, icons, timers, trace seed, start angles)
- Game state (current phase)
- Physics state
- Game clock state
- Input authority state
- Winner result

The `participants` array contains `playerId` values but NOT the full `PlayerIdentity` data. The `gameId` is present but there is no corresponding `Game` object in `GameManager`. The `roomId` is present but there is no corresponding `Room` object in `RoomManager`.

### 8.3 Whether restorePaymentSessions() changes persistence during reconciliation

**Directly: No.** `restorePaymentSessions()` performs only a read: `listActive(PAYMENT_SESSION)`.

**Indirectly: Yes, conditionally.** The restore completion path (`_finishPaymentRestore` -> `syncFromGameEscrow` -> `_persistSession(session, "update")`) performs conditional disk writes when on-chain GameEscrow reconciliation produces state changes (participants confirmed or demoted). This is by design and gated on `changed === true`.

### 8.4 Whether GameEscrow remains authoritative

**Yes.** GameEscrow (TON blockchain) is the authoritative source of payment/refund truth. The backend cache (restored payment sessions) is synchronized to the chain, never the reverse. `syncFromGameEscrow` reads the on-chain `paidMask` and reconciles the cached session to match. The recovery pipeline re-registers blockchain watches for unpaid seats and refund observations.

### 8.5 Whether restored payment state can identify the corresponding game/room/player entities

**Partially.** The restored `PAYMENT_SESSION` record contains:
- `roomId` — can identify the room, but `RoomManager` has no corresponding room after restart.
- `gameId` — can identify the game, but `GameManager` has no corresponding game after restart.
- `participants[].playerId` — can identify players, but `PlayerManager` has no corresponding identities after restart.
- `contractId` — can identify the contract, and `GameContractManager.restoreContracts()` does restore the corresponding contract.

The financial records reference `roomId`/`gameId`/`playerId` values, but the runtime managers (`RoomManager`, `GameManager`, `PlayerManager`) have empty in-memory maps after restart and no reconstruction methods to attach objects using these IDs.

## 9. Cross-Domain Recovery Boundary

### 9.1 Factual boundary

| Runtime object | Information exists in financial records? | Existing recovery mechanism consumes it? |
|---------------|----------------------------------------|---------------------------------------|
| Room | PARTIAL — `roomId` exists in `GAME_CONTRACT`, `PAYMENT_SESSION`, `SETTLEMENT` records | NO — `RoomManager` has no `attachExistingRoom()` method |
| Game | PARTIAL — `gameId` exists in `GAME_CONTRACT`, `PAYMENT_SESSION`, `SETTLEMENT` records | NO — `GameManager` has no `attachExistingGame()` method |
| Player runtime | PARTIAL — `playerId` exists in `PAYMENT_SESSION.participants`, `SETTLEMENT.winnerId` | NO — `PlayerManager` has no restore/attach method |
| Configuration | PARTIAL — `snapshotHash`, `traceSeed` (in SETTLEMENT), snapshot object (in GAME_CONTRACT) exist | NO — `ConfigurationEngine` has no restore/attach method |
| GameState | NO — no game state phase in any financial record | NO |
| Physics | NO — no physics state in any financial record | NO |
| GameClock | NO — no clock state in any financial record | NO |
| InputAuthority | NO — no input state in any financial record | NO |
| Winner result | PARTIAL — `winnerId`, `winnerWallet`, `prizeAmount` exist in `SETTLEMENT` record | NO — `WinnerEngine` has no restore/attach method |

### 9.2 Key observations

- Financial records contain `roomId`, `gameId`, `playerId` identifiers that cross-reference runtime objects, but the runtime managers cannot attach objects using these IDs.
- The `GAME_CONTRACT` snapshot contains player wallet addresses and required gram amounts, but NOT the full game configuration (wheel layout, sectors, colors, icons, timers, trace seed, start angles).
- The `SETTLEMENT` record contains `winnerId`, `winnerWallet`, `prizeAmount`, `traceSeed`, and `ownerWallet`, but NOT the full winner result (winning sector, winning player object, final angles, resolvedAt).
- No existing recovery mechanism consumes financial records to reconstruct gameplay runtime objects.
- The `TonFinancialRecovery` validation phase checks for orphan players (`payment_session_orphan_player`), missing rooms (`contract_missing_room`), and missing contracts, but these are consistency warnings/errors — they do not trigger reconstruction.

## 10. Authoritative Sources

| Persisted field/state | Authoritative source |
|----------------------|---------------------|
| `GAME_CONTRACT` record | Durable financial persistence (`TonFinancialPersistence`) |
| `GAME_CONTRACT.contractAddress` | GameEscrow / TON blockchain (set after deploy) |
| `GAME_CONTRACT.snapshot` | Derived/computed at creation time from live room/player/configuration state |
| `GAME_CONTRACT.snapshotHash` | Derived/computed (SHA-256 of snapshot) |
| `PAYMENT_SESSION` record | Durable financial persistence |
| `PAYMENT_SESSION.participants[].status` | GameEscrow / TON blockchain (reconciled via `syncFromGameEscrow`) |
| `PAYMENT_SESSION.participants[].paidAmount` | GameEscrow / TON blockchain |
| `SETTLEMENT` record | Durable financial persistence |
| `SETTLEMENT.settlementTransactionHash` | GameEscrow / TON blockchain |
| `SETTLEMENT.winnerId` | In-memory backend state (from `WinnerEngine`, persisted to financial persistence) |
| `SNAPSHOT` record | Durable financial persistence (immutable on create) |
| `RECOVERY_CHECKPOINT` record | Durable financial persistence (deletable) |
| `WALLET_SESSION` record | Durable financial persistence |
| `DEPOSIT_SESSION` record | Durable financial persistence |
| `DEPLOYMENT_AUTHORIZATION` record | Durable financial persistence |
| `DEPOSIT_OBSERVATION` record | Durable financial persistence (immutable on create) |
| Game configuration | In-memory backend state (`ConfigurationEngine._configurations`) — NOT persisted |
| Game state | In-memory backend state (`GameStateEngine._states`) — NOT persisted |
| Physics state | In-memory backend state (`PhysicsEngine._simulations`) — NOT persisted |
| Game clock state | In-memory backend state (`GameClockEngine._clocks`) — NOT persisted |
| Input authority state | In-memory backend state (`InputAuthority._registries`) — NOT persisted |
| Winner result | In-memory backend state (`WinnerEngine._results`) — NOT persisted |
| Room state | In-memory backend state (`RoomManager._rooms`) — NOT persisted |
| Game lifecycle | In-memory backend state (`GameManager._games`) — NOT persisted |
| Player identity | In-memory backend state (`PlayerManager._identities`) — NOT persisted |
| Player runtime | In-memory backend state (`PlayerManager._runtimes`) — NOT persisted |
| Payment rules | Configuration/catalog (`gameCatalog.getPaymentRules()`) — immutable config data |
| Catalog timers | Configuration/catalog (`gameCatalog.getTimers()`) — immutable config data |

## 11. Recovery Lifecycle

The actual startup sequence supported by the source code:

```text
SERVER RESTART
    |
    v
TonFinancialPersistence.initialize({ dataDir })
    -> _ensureStorageLayout() — creates directories
    -> _loadManifest() — reads manifest.json
    -> restore() — loads ALL records from disk into _records Map + indexes
    |
    v
TonFinancialRecovery.recover({ trigger: "server_restart", reason: "application_startup" })
    |
    v
    Phase 1: WALLETS
    -> WalletManager.restoreSessions() or SessionWalletStore.restore()
    -> reads WALLET_SESSION records from listActive()
    -> reconstructs wallet session in-memory maps
    |
    v
    Phase 2: CONTRACTS
    -> GameContractManager.restoreContracts()
    -> reads GAME_CONTRACT records from listActive("game_contract")
    -> hydrates via _hydrateFromPersistenceRecord(record)
    -> indexes in _contractsByRoom, _contractsById, _roomByGameId
    -> identifies incompleteDeployments and unfinishedTransitions
    |
    v
    Phase 3: PAYMENTS
    -> PaymentSessionManager.restorePaymentSessions()
    -> reads PAYMENT_SESSION records from listActive(PAYMENT_SESSION)
    -> hydrates via PaymentSession.fromRecord(record)
    -> marks non-in-progress, non-cancelled sessions as RECOVERED
    -> restores seat indices (playerIndex) for GameEscrow paidMask mapping
    -> indexes in _sessionsByRoom
    -> re-arms expiry timers for active payment deadlines
    -> syncs paid seats from GameEscrow chain (syncFromGameEscrow)
    -> re-registers blockchain watches for unpaid seats
    -> emits PAYMENT_SESSION_RECOVERED events
    |
    v
    Deposit sessions restore
    -> DepositSessionCoordinator.restoreActiveSessions()
    |
    v
    Deposit monitor watches restore
    -> DepositActivationVerificationCoordinator.syncFromActiveSessions()
    or DepositMonitor.restoreActiveWatches()
    |
    v
    Deployment authorizations restore
    -> DeploymentAuthorizationCoordinator.restoreActiveAuthorizations()
    |
    v
    Phase 4: SETTLEMENTS
    -> ContractSettlementManager.restoreSettlementSessions()
    -> reads SETTLEMENT records from listActive(SETTLEMENT)
    -> hydrates via SettlementSession.fromRecord(record)
    -> skips terminal sessions
    -> marks non-in-progress sessions as RECOVERED
    -> indexes in _byGameId
    -> re-arms settlement expiry timers
    -> re-registers settlement transaction watches
    -> re-registers GameEscrow payout watches
    -> emits SETTLEMENT_RECOVERED events
    |
    v
    Phase 5: BLOCKCHAIN
    -> _loadBlockchainCheckpoint() — reads RECOVERY_CHECKPOINT records
    -> BlockchainMonitor.restoreCheckpoint(checkpoint)
    -> _reregisterBlockchainWatches():
        - contract watches for non-terminal contracts
        - payment watches for in-progress/cancelled/fully-paid sessions
        - settlement watches for SETTLEMENT_PENDING sessions
        - refund watches for CANCELLED sessions (R7.69C)
    |
    v
    Settlement resume
    -> ContractSettlementManager.resumeRestoredSettlements()
    -> probes on-chain settlement state
    |
    v
    VALIDATION
    -> _validateWalletSessions() — checks orphan players, missing rooms
    -> _validatePaymentSessions() — checks orphan players, missing contracts
    -> _validateContracts() — checks missing game IDs, missing rooms
    -> _validateSettlements() — checks payment completion, missing contracts
    -> _validateBlockchainWatches() — checks orphan contracts, terminal contracts
    -> consistency errors cause recovery failure
    |
    v
    FINANCIAL RECOVERY COMPLETE
    |
    v
    Gameplay runtime reconstruction
    -> NOT IMPLEMENTED
    -> No rooms restored
    -> No games restored
    -> No players restored
    -> No configuration restored
    -> No game state restored
    -> No physics restored
    -> No clock restored
    -> No input authority restored
    -> No winner restored
    |
    v
SERVER RUNNING (financial state restored, gameplay state empty)
```

## 12. Recovery Capability Classification

### 12.1 Financial recovery layer classification

**PARTIALLY_RECONSTRUCTABLE**

The financial recovery layer (`TonFinancialRecovery`) successfully restores financial in-memory structures from durable persistence:
- Wallet sessions: fully restored.
- Game contracts: fully restored (including snapshot and snapshot hash).
- Payment sessions: fully restored (including participants, seat indices, payment deadlines).
- Settlement sessions: fully restored (including winner info, settlement transaction hash, request).
- Deposit sessions: fully restored.
- Deployment authorizations: fully restored.
- Blockchain checkpoint and watches: fully restored.
- Settlement resume: attempted (probes on-chain state).

However, it is classified as PARTIALLY_RECONSTRUCTABLE (not FULLY_RECONSTRUCTABLE) because:
- The validation phase reports consistency errors when financial records reference `roomId`/`gameId`/`playerId` values that no longer exist in the runtime managers (orphan players, missing rooms, missing contracts).
- The financial system is restored but is in an inconsistent state with the gameplay runtime (which is empty).
- No gameplay runtime reconstruction is performed.

### 12.2 Financial persistence as source for gameplay-runtime reconstruction

**PARTIALLY_SUFFICIENT**

The financial persistence layer contains:
- `roomId`, `gameId`, `playerId` identifiers that can serve as anchors for reconstruction.
- `GAME_CONTRACT.snapshot` with player wallet addresses, required gram amounts, oracle wallet, escrow mode.
- `GAME_CONTRACT.snapshotHash` for integrity verification.
- `PAYMENT_SESSION.participants` with player IDs, wallets, required gram amounts, seat indices, payment status.
- `SETTLEMENT.winnerId`, `winnerWallet`, `prizeAmount`, `traceSeed`, `ownerWallet`.
- `SETTLEMENT.request` with contract address, wallets, amounts for payout watch re-registration.

However, it is classified as PARTIALLY_SUFFICIENT (not SUFFICIENT) because:
- No full immutable game configuration is persisted (wheel layout, sectors, colors, icons, timers, trace seed, start angles are NOT in any financial record).
- No game state (current phase) is persisted.
- No physics state (wheel angle, velocity, acceleration) is persisted.
- No game clock state (current phase, timing) is persisted.
- No input authority state (press counts, command queues) is persisted.
- No full winner result (winning sector, winning player object, final angles) is persisted.
- No room state (maxPlayers, room status) is persisted.
- No player identity data (nickname, icon, age, color, sectorCount, sectorArrangement, baseStake) is persisted.
- No player runtime state (connectionState, playerState, ping) is persisted.
- No existing recovery mechanism consumes financial records to reconstruct gameplay runtime objects.

The financial persistence contains enough information to identify which games/rooms/players existed and their financial state, but NOT enough to reconstruct the full gameplay runtime (configuration, game state, physics, clock, input, winner).

## 13. Critical Constraints

This report does NOT assume:
- Financial records equal gameplay snapshots. (They do not — financial records contain financial state only.)
- `GAME_CONTRACT` records contain full gameplay state. (They do not — they contain contract lifecycle state and a snapshot of player wallets/amounts, not game configuration or physics.)
- `PAYMENT_SESSION` records contain physics state. (They do not — they contain payment participant state only.)
- Blockchain state contains complete server runtime state. (It does not — blockchain contains escrow/payment facts only.)
- Configuration metadata is equivalent to the complete committed configuration. (It is not — `GAME_CONTRACT.snapshot` contains player wallets and amounts but not wheel layout, sectors, colors, icons, timers, trace seed, or start angles.)
- Deterministic computation means state is currently recoverable. (It does not — `WinnerEngine.resolveResult` is deterministic, but `ConfigurationEngine` and `PhysicsEngine` states are not persisted and cannot be reconstructed after restart.)

## 14. Scope Discipline

This report:
- Did NOT implement anything.
- Did NOT modify source code.
- Did NOT propose APIs.
- Did NOT propose schema changes.
- Did NOT propose persistence changes.
- Did NOT propose RecoveryEngine changes.
- Did NOT run application tests.

## 15. Risks

### Critical

- **Financial-gameplay state inconsistency after restart**: `TonFinancialRecovery` restores financial state (contracts, payment sessions, settlements) from durable persistence, but gameplay runtime state (rooms, games, players, configuration, game state, physics, clock, input, winner) is NOT restored. Financial records reference `roomId`/`gameId`/`playerId` values that do not exist in the runtime managers. This creates a state where the financial system believes payments are active but there is no gameplay to connect them to.

- **No gameplay runtime reconstruction mechanism**: `attachExistingRoom()`, `attachExistingGame()`, player identity restoration, PaymentSession rehydration, GameContract reconciliation, and configuration reconstruction are all NOT IMPLEMENTED. There is no code path to reconstruct gameplay runtime objects from restored financial records.

- **Validation consistency errors are expected after restart**: The `TonFinancialRecovery` validation phase checks for orphan players (`payment_session_orphan_player`), missing rooms (`contract_missing_room`), and missing contracts. After a server restart with no gameplay reconstruction, these checks will report consistency errors because the runtime managers are empty.

### High

- **Financial persistence contains partial configuration data**: The `GAME_CONTRACT.snapshot` contains player wallets and required gram amounts but NOT the full game configuration (wheel layout, sectors, colors, icons, timers, trace seed, start angles). Any future reconstruction that needs to rebuild `ConfigurationEngine` state cannot use the snapshot alone.

- **SETTLEMENT record contains partial winner data**: The `SETTLEMENT` record contains `winnerId`, `winnerWallet`, `prizeAmount`, and `traceSeed` but NOT the full winner result (winning sector, winning player object, final angles, resolvedAt). Any future reconstruction that needs to restore `WinnerEngine` state cannot use the settlement record alone.

- **PaymentSession rehydration gap**: Restored payment sessions reference `roomId`/`gameId`/`playerId` values that do not exist in the runtime managers. The financial system believes payments are active, but there is no room, game, or player to connect them to.

### Medium

- **restorePaymentSessions conditional writes**: The restore flow can trigger conditional disk writes through `syncFromGameEscrow` -> `_persistSession(session, "update")` when on-chain reconciliation produces state changes. This is by design but means restore is not purely read-only.

- **Terminal records remain in active directory**: Terminal settlement records (`SETTLEMENT_COMPLETED`, `SETTLEMENT_FAILED`) remain in the `active/` directory and are loaded by `listActive()`. Individual restore methods skip terminal records, but they still consume memory in `_records` and are validated during the validation phase.

### Low

- **Auto-checkpoint on every write**: `autoCheckpoint` is enabled by default, causing a manifest write after every create/update/delete/archive operation. This is correct for durability but increases I/O.

## 16. Recommendations

This section is included to satisfy the `.clinerules` report format. Per task constraints, this report makes **no implementation recommendations** and designs **no new APIs**. The following are factual observations only, not implementation proposals:

- The financial persistence layer is well-structured and provides durable storage for financial records with atomic writes, integrity validation, and immutable-on-create records.
- The financial recovery pipeline is well-orchestrated with strict phase ordering, fail-closed validation, and comprehensive watch re-registration.
- The gap between financial recovery and gameplay runtime reconstruction is the core R17.9T.6 problem. Financial records contain `roomId`/`gameId`/`playerId` identifiers and partial configuration/winner data, but the runtime managers have no attach/restore methods and the full game configuration is not persisted.
- Any future gameplay runtime reconstruction (R17.9T.6) would need to address: (a) the missing attach/restore methods in runtime managers; (b) the missing full game configuration in financial records; (c) the coupled-bootstrap gap (GameManager bootstraps all gameplay engines per game); (d) the ID-preservation gap (createRoom/createGame always generate new IDs).
- These observations are inventory only; no changes are recommended or designed in this report.

## 17. Changes Made

No files modified. No source code, configuration, or test files were changed. This report is the only artifact created:

- `AI_CONTEXT/CLINE_REPORTS/2026-08-22_financial_persistence_recovery_mapping.md`

## Limitations

- `server/gameplay/PaymentSessionManager.js` is 2861 lines. The `_persistSession` method (line 2667) and `restorePaymentSessions` (line 702, per prior report) were read. The full file was not re-read in this session; the prior `restorePaymentSessions_analysis` report was relied upon for the restore flow details.
- `server/gameplay/GameContractManager.js` is 2450 lines. Lines 1-2000 were read in full. The `restoreContracts` (line 1024), `_persistContract` (line 1775), and `_hydrateFromPersistenceRecord` (line 1909) methods were fully analyzed. Lines 2001-2450 were not read but were confirmed via search to contain only internal helper methods.
- `server/payment/ContractSettlementManager.js` is 2862 lines. The `restoreSettlementSessions` (line 432) and `_persistSession` (line 2610) methods were read. The full file was not read.
- `server/models/GameContract.js` was not directly read; the `GameContract` constructor fields were observed through `_hydrateFromPersistenceRecord` in `GameContractManager.js`.
- `buildGameContractSnapshot()` (`server/payment/buildGameContractSnapshot.js`) was not directly read; the snapshot contents were inferred from the `createContractRequest` method's call to `buildGameContractSnapshot()` with documented parameters.
- No application tests were run.
- `RecoveryEngine`, `RoomManager`, `GameManager`, `PlayerManager`, the six runtime engines, and client reconnect were explicitly out of scope per task constraints and were not analyzed in this report. Prior reports were relied upon for those domains.