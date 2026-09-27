# SetupSessionLifecycle Restart/Expiry Re-Arm — Implementation Report

Date: 2026-09-27

Task: Implement ONLY the minimal SetupSession restart/expiry persistence fix
defined in
`AI_CONTEXT/CLINE_REPORTS/2026-09-27_setup_session_restart_rearm_analysis.md`:
a durable `SETUP_SESSION` financial record, persistence hooks in the existing
lifecycle choke points, `restorePersistedSessions()` reusing the existing
`_scheduleExpiry()`, and exactly one startup call in `app.js` after
`recoveryOrchestrator.recoverAll()`. No recovery redesign, no PAYMENT-stage
room restoration, no refund logic changes.

---

## 1. Scope

Implemented exactly the 3 authorized areas:

1. `server/persistence/TonFinancialRecordTypes.js` — additive
   `SETUP_SESSION` record type.
2. `server/gameplay/SetupSessionLifecycle.js` — optional fail-open persistence
   dep, 4 write points, `restorePersistedSessions()`.
3. `server/app.js` — import, late-binding, one restore call after
   `recoverAll()`.

Plus one new focused test file. Nothing else.

Note on the task's stated path: the record-types module lives at
`server/persistence/TonFinancialRecordTypes.js` (canonical location used by
`TonFinancialRecovery`, `RecoveryOrchestrator`, `RecoveryCheckpointManager`).
There is no `server/payment/ton/TonFinancialRecordTypes.js`. The analysis
report §8.1 identifies the persistence location; the actual file was used.

---

## 2. Files Inspected

- `server/gameplay/SetupSessionLifecycle.js` (full, before editing)
- `server/models/SetupSession.js`, `server/models/SetupSessionStatus.js`
- `server/persistence/TonFinancialRecordTypes.js`
- `server/persistence/TonFinancialPersistence.js` (generic API: create/update/
  load/listActive/deleteRecord, `_categoryForType`, `_typeDirectory`,
  `_writeJsonAtomic`, `restore()`)
- `server/persistence/tonFinancialRecordUtils.js` (`resolveRecordId` default →
  `metadata.recordId`; `buildRecordEnvelope`; `cloneEnvelopeForUpdate`)
- `server/app.js` (constructor site ~870, `_financialPersistence` ~1196,
  `recoverAll()` block ~1839–1918, SocketGateway ~1939)
- `server/managers/GameManager.js` (`hasInitializedGameplay` 529)
- `server/scripts/run-tests.js`, existing suites under `server/tests/`
- Prior reports listed in the analysis report (context reading per rules).

---

## 3. Architecture Findings (implementation shape)

### Record type (`TonFinancialRecordTypes.js`, additive only)

- `SETUP_SESSION: "setup_session"` in `TON_FINANCIAL_RECORD_TYPES`.
- `SETUP_SESSION_TERMINAL_STATUSES = ["EXPIRED", "ABORTED"]` — mirrors the
  SetupSession model's terminal states (deadline elapsed / room teardown).
- `RECORD_STORAGE_CATEGORY[SETUP_SESSION] = "active"`.
- No other record type touched. No `tonFinancialRecordUtils.js` change was
  needed: `resolveRecordId()`'s default case accepts `metadata.recordId`, and
  the lifecycle passes `recordId: roomId` explicitly (roomId-keyed, 1:1 with
  the in-memory registry, same convention as `WALLET_SESSION`).

### Lifecycle (`SetupSessionLifecycle.js`, additive only)

- `this._setupSessionPersistence = null` in the constructor; optional
  late-bound dep via `setSetupSessionPersistence({ persistence })` —
  same fail-open late-binding style as `setEscrowUnwindBridgeDeps`.
- Fail-open write helpers: `_persistSessionCreate` (create, falling back to
  update when a stale record exists for a reused roomId from a previous
  process), `_persistSessionUpdate` (full authoritative payload each write),
  `_persistSessionTerminalize`, `_persistTerminalizeRecordPayload`,
  `_setupSessionRecordPayload`, `_persistLogFailure`. Every call is wrapped;
  with no dep bound the behavior is bit-for-bit unchanged.
- Payload: `{ roomId, setupSessionId, startedAt, expiresAt, state, roomFull }`
  — everything required to reconstruct, including the ORIGINAL expiresAt.
- Write points: `createForRoom` (after `_scheduleExpiry`), `_tryComplete`
  (after `session.complete()`), `archiveForPayment` (after
  `_rescheduleExpiry`), `_sessionDelete` (the single deletion choke point;
  reason `"setup_expired"` → EXPIRED, any other reason → ABORTED).
- `restorePersistedSessions({ records })` guards, per record: malformed →
  skip; `_sessions.has(roomId)` → skip (idempotent, live wins);
  `isGameplayOwnershipReleased(roomId)` → skip (R8.6 / GAME_INITIALIZED
  guard, truthful because `recoverAll()` ran first); terminal status
  (EXPIRED/ABORTED via `SETUP_SESSION_TERMINAL_STATUSES`) → skip; expired
  deadline → terminalize the record and skip (never armed, no synthetic
  boot-time expiry, no refund invention); otherwise reconstruct with the
  original `startedAt`/`expiresAt`/`state`/`roomFull`, `_sessionSet`, then
  the EXISTING `_scheduleExpiry(session)` — the single timer mechanism.

### Startup (`app.js`)

- Import of `TON_FINANCIAL_RECORD_TYPES`.
- `setSetupSessionPersistence({ persistence: this._financialPersistence })`
  immediately after `_financialPersistence.initialize()` (late-bound because
  the lifecycle is constructed before the persistence exists).
- Exactly one `restorePersistedSessions()` call, after the `recoverAll()`
  outcome handling and `startupLine("RecoveryOrchestrator")`, before
  SocketGateway construction / `_listen()`. Fail-open try/catch with a
  `SETUP_SESSION_RESTORE_COMPLETE` summary log.

---

## 4. Lifecycle Flow

1. `createForRoom` → session ACTIVE → record created (status ACTIVE).
2. `ROOM_FULL` → `_tryComplete` → COMPLETED → record updated.
3. `archiveForPayment` → ARCHIVED → `_rescheduleExpiry` (same deadline) →
   record updated.
4. Room destroyed → `abortForRoom` → `_sessionDelete("abort_for_room")` →
   record ABORTED. Expiry → `_onExpiry` → existing guards → EXPIRED event →
   `_sessionDelete("setup_expired")` → record EXPIRED.
5. Server restart → `recoverAll()` (games attached → ownership guard
   truthful) → `listActive(SETUP_SESSION)` → `restorePersistedSessions()`:
   valid non-elapsed records are reconstructed and re-armed by the existing
   `_scheduleExpiry` with the ORIGINAL expiresAt; elapsed ones are
   terminalized (EXPIRED) and never armed; terminal ones are skipped.
6. Re-armed expiry fires into a roomless context when the room was not
   restored (pre-init): `_onExpiry` keeps every existing guard (room presence
   check before destroy, escrow-unwind deferral via PSM), so funds safety
   remains owned by PaymentSessionManager boot recovery.

---

## 5. Ownership Boundaries

- `SetupSessionLifecycle` remains the sole owner of Setup Session state and
  the single expiry scheduling mechanism (`_scheduleExpiry`); persistence is
  a passive record of its authoritative state — no new authority granted.
- `PaymentSessionManager` remains the sole owner of funds/refunds: no refund
  was added, skipped, invented, or altered; the room-gone refund behavior of
  its boot restore path is untouched and was explicitly NOT re-implemented.
- `RoomManager` was not taught anything new; restore never creates rooms.
- `RecoveryOrchestrator`, `RecoveryDataPersistence`, `TonFinancialRecovery`,
  `RoomLobbyBridge`, `SessionHistoryArchiveManager`, client Page4/Page5 —
  untouched.
- The GAME_INITIALIZED ownership release (R8.6) stays authoritative: a
  restored session for a room with initialized gameplay is skipped at
  restore AND its timer would be cleared by the existing GAME_INITIALIZED
  handler if gameplay initializes after restore.

---

## 6. Risks

- Critical: none identified.
- High: none introduced. The restore path grants no new authority; every
  `_onExpiry` guard is preserved (verified by tests E1/E2/G).
- Medium — clock skew (inherited, R5 of the analysis): if the host clock
  jumps backwards across a restart, the re-armed timer fires later than the
  original epoch. The deadline value itself is preserved.
- Medium — graceful-shutdown records: `_sessionClear` (bulk `_reset`) does
  not terminalize records (per approved scope: terminalization lives only at
  `_sessionDelete`). A restorable record left by a graceful shutdown without
  room destroys will re-arm on the next boot and fire into a roomless
  context — harmless by design (no room destroy, no funds action).
- Low — stale ACTIVE records for rooms whose game reached GAME_INITIALIZED
  without a terminalized record: they self-heal (ownership guard or
  elapsed-deadline terminalization on a later boot).
- Low — persistence I/O failures are fail-open (logged, never blocking);
  worst case is a lost re-arm, never a wrong refund.

---

## 7. Recommendations

- Do not extend this mechanism to restore PAYMENT-stage rooms; funds remain
  in the PaymentSessionManager domain.
- If boot-time SETUP_SESSION_EXPIRED emissions are ever wanted for elapsed
  records, that requires arming after `RoomLobbyBridge.initialize()` — a
  separate, explicitly-approved change (analysis §8/§10).
- Optional future hardening: terminalize records during `_sessionClear`
  (`_reset`) if graceful-shutdown semantics should differ from crash
  semantics. Not implemented (outside approved scope).

---

## 8. Changes Made

### Source files changed (exactly 3)

1. `server/persistence/TonFinancialRecordTypes.js`
   (additive: record type, terminal statuses, storage category)
2. `server/gameplay/SetupSessionLifecycle.js`
   (additive: import, dep field, `setSetupSessionPersistence`, persistence
   helpers, 4 write points, `restorePersistedSessions`)
3. `server/app.js`
   (additive: import, late-bind, one restore call)

`git diff --stat` vs `01a9a9f` (branch `payment/room-wallet-integration`):

```
server/app.js                                 |  51 ++++
server/gameplay/SetupSessionLifecycle.js      | 379 ++++++++++++++++++
server/persistence/TonFinancialRecordTypes.js |  23 +-
```

Note: `server/gameplay/PaymentSessionManager.js` shows 26 modified lines in
the working tree, but those are PRE-EXISTING uncommitted modifications that
were present before this task started (verified via a stash control run:
the PaymentSessionManager diff existed before and after, unchanged; this
task made zero edits to it).

### Test files created (exactly 1)

- `server/tests/setupSessionRestartRearm.test.js` (new) — covers A–G below
  using the REAL `TonFinancialPersistence` (tmpdir, `autoCheckpoint: false`)
  for end-to-end record-type proof (envelope validation, storage category,
  disk round-trip).

No existing test files were modified.

### Tests executed and results

Runner: plain Node (project convention; suites also runnable via
`npm test` → `node scripts/run-tests.js`). Working tree:
`payment/room-wallet-integration` @ 01a9a9f + this change.

Focused suite — `node tests/setupSessionRestartRearm.test.js`
(run twice, including once after a stash/pop round-trip):

- A create → persist → restart → restore → re-armed timer fires exactly
  once at the ORIGINAL deadline; record terminalized after firing: OK
- B restore keeps the ORIGINAL expiresAt (no recalculation/extension):
  OK
- C already-expired persisted record NOT re-armed; terminalized EXPIRED;
  no synthetic boot expiry: OK
- D terminalized (ABORTED / EXPIRED) records never restored: OK
- E1 GAME_INITIALIZED ownership guard skips restore; no unsafe expiry;
  recovered game room not destroyed: OK
- E2 GAME_INITIALIZED after restore clears the re-armed timer (existing
  R8.6 handler): OK
- F restore idempotent (second call no-op), exactly one timer, single
  expiry emission: OK
- G live create/expiry unchanged with no persistence dep bound: OK
- Final line: `setupSessionRestartRearm.test.js: all assertions passed`

Existing relevant suites:

| Suite | Result |
|---|---|
| `setupSession.lifecycle.test.js` | PASS |
| `setupSession.paymentExpiry.r770c23.test.js` | PASS |
| `setupSession.reconnect.test.js` | PASS |
| `setupTimer.r770c19.test.js` | PASS |
| `setupExpiryRoomWalletRefund.test.js` | PASS (`...test.js passed`) |
| `creatorLeftRoomWalletRefund.test.js` | PASS (`...test.js passed`) |
| `restoreRoomWalletRefund.test.js` | PASS (sub-tests A–E all PASS) |
| `startupRecoveryIntegration.r179t6.test.js` | PASS (A–L all OK, incl. `A. source ordering OK` — the app.js startup-ordering contract) |
| `tonFinancialPersistence.test.js` | PASS (`tonFinancialPersistence tests passed`) |
| `page5LifecycleOwnership.r86.test.js` | FAILS at TEST B — PRE-EXISTING, see below |

`page5LifecycleOwnership.r86.test.js` is an extra regression probe (not in
the task's required list). Its TEST B
(`GameContract survives ROOM_DESTROYED after GAME_INITIALIZED`) fails at
test line 421. Control evidence: with all three implementation files
stashed (original code), the run fails at the identical assertion — the
failure is independent of this change and consistent with the working
tree's pre-existing uncommitted `PaymentSessionManager.js` modifications.

Process-exit note: several existing suites print their final `passed` line
but keep the node process alive on a lingering handle (pre-existing suite
trait; e.g. `setupExpiryRoomWalletRefund.test.js` printed
`...test.js passed` ~1s after start). Assertion completeness was verified
from captured output.

### Explicit boundary confirmation

- `PaymentSessionManager.js` was NOT modified by this task.
- Payment/refund logic was NOT modified: no refund path added, skipped,
  invented, or altered; no GameEscrow / DepositContract / DepositPackage /
  GameContractManager / settlement file touched.
- `RecoveryOrchestrator`, `TonFinancialRecovery`, `RecoveryDataPersistence`,
  `RoomLobbyBridge`, `SessionHistoryArchiveManager`, client Page4/Page5 —
  untouched.
- No commit or push performed (not requested).




