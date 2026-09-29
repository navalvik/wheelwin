# SetupSessionLifecycle Restart/Expiry Analysis — Re-Arming After Server Restart

Date: 2026-09-27

Task: Analyze ONLY the current SetupSessionLifecycle restart/expiry behavior and
determine the smallest safe architecture change so a Setup Session with paid
funds cannot lose its expiry handling after a server restart. Scope strictly
limited to `server/gameplay/SetupSessionLifecycle.js`, the code that
creates/stores/restores/destroys SetupSession instances, and the existing
server startup/recovery path. ANALYSIS ONLY — no source changes, no
refactoring, no PaymentSessionManager changes, no refund-logic changes, no
GameEscrow / DepositContract / DepositPackage changes.

---

## 1. Scope

- Setup Timer creation, storage, arming, firing, and teardown
  (`SetupSessionLifecycle`, `SetupSession` model).
- The existing startup/recovery chain that runs on process boot
  (`app.js` `start()` ordering, `TonFinancialRecovery`,
  `RecoveryOrchestrator`, `RecoveryCheckpointManager`,
  `RecoveryDataPersistence`).
- Persisted data sufficiency for reconstructing the timer.
- NOT in scope: refund orchestration internals, Room Wallet settlement,
  smart-contract payment behavior, gameplay engine recovery internals,
  reconnect/socket binding.

## 2. Files Inspected

- `server/gameplay/SetupSessionLifecycle.js` — full (registry 30–109,
  `initialize` 300–340, `isGameplayOwnershipReleased` 345–356,
  `createForRoom` 380–437, `archiveForPayment` 511–691, `abortForRoom`
  696–736, `_tryComplete` 778–807, `_scheduleExpiry`/`_rescheduleExpiry`/
  `_onExpiry`/`_clearExpiry` 846–1000, storage helpers 154–298).
- `server/models/SetupSession.js` — full (constructor 13–54, state machine
  56–259, no `fromRecord`).
- `server/models/SetupSessionStatus.js` (status set).
- `server/app.js` — startup anchors: `new SetupSessionLifecycle` 870,
  `.initialize()` 879, `setEscrowUnwindBridgeDeps` 1554,
  `_recoveryCheckpointManager.initialize()` 1813, `recoverAll()` 1866,
  SocketGateway ~1949–1951, `new RoomLobbyBridge` 1953 / `.initialize()` 1972,
  `SessionHistoryArchiveManager.getInstance()` 2159 / `.initialize()` 2161.
- `server/recovery/RecoveryOrchestrator.js` — full public pipeline
  (contract header 1–30, recoverable states 51–65, `recoverAll` 249–298,
  candidate pipeline 304–778, connectivity-gated clock arming 710–765,
  813–1008).
- `server/managers/RoomManager.js` — `createRoom` → `createForRoom` atomic
  call (188), `destroyRoom` (445–536, `abortForRoom` at 510),
  `attachRoom` (608, D1 API).
- `server/recovery/TonFinancialRecovery.js` — `recoverPayments()` 530–554 →
  `PaymentSessionManager.restorePaymentSessions()`.
- `server/persistence/RecoveryDataPersistence.js` contract (via prior audit
  reports and `RecoveryOrchestrator` usage): required record fields.
- `server/history/SessionHistoryArchiveManager.js` (restore-vs-archive
  boundary only).
- Prior context: `AI_CONTEXT/WHEELWIN_MASTER_CONTEXT.md`,
  `ARCHITECTURE_RULES.md`, `CURRENT_STATE.md`, `AI_WORKING_RULES.md`;
  reports `2026-08-23_r17.9T.6-startup_recovery_integration_implementation.md`,
  `2026-08-23_r17.9T.6-recovery_checkpoint_writing_implementation.md`,
  `2026-08-22_recovery_runtime_managers_mapping.md`,
  `2026-08-22_snapshot_recovery_checkpoint_audit.md`,
  `2026-09-27_xsdd_live_setup_expiry_refund_forensic.md`.
- `server/tests/startupRecoveryIntegration.r179t6.test.js` (source-ordering
  contract, section A), `server/tests/restoreRoomWalletRefund.test.js`,
  `server/tests/setupSession.paymentExpiry.r770c23.test.js`,
  `server/tests/setupTimer.r770c19.test.js`.

## 3. Current Behavior

### Q1 — Where is the SetupSession timer created?

Exactly one method arms it: `SetupSessionLifecycle._scheduleExpiry(session)`
(lines 846–858):

```js
const delay = Math.max(0, session.expiresAt - Date.now());
const timerId = setTimeout(() => { this._onExpiry(session.roomId); }, delay);
this._expiryTimers.set(session.roomId, timerId);
```

Armed from exactly two call sites:

- `createForRoom(room)` — line 429, immediately after `session.activate()`
  and `_sessionSet`. `createForRoom` is atomic with
  `RoomManager.createRoom` (`RoomManager.js:188` — the room is deleted if
  setup-session creation fails).
- `_rescheduleExpiry(session)` — line 879 (`_clearExpiry` then
  `_scheduleExpiry`), called from `archiveForPayment` (line 672, R7.70C23 —
  PAYMENT keeps honoring the original wall-clock `expiresAt`).

Firing: `_onExpiry(roomId)` (883–988). Re-arming never extends `expiresAt`;
`_rescheduleExpiry` refuses to arm after gameplay ownership transfer
(869–875).

### Q2 — What in-memory state is required for that timer to fire (and do its full job)?

1. **`_expiryTimers` entry** — the `setTimeout` handle (process-local).
2. **`_sessions.get(roomId)`** — a live `SetupSession` object whose
   `state ∈ { ACTIVE, COMPLETED, ARCHIVED }`; otherwise `_onExpiry` returns
   silently (904–908 session miss, 912–918 state guard).
3. **Ownership not released** — `isGameplayOwnershipReleased(roomId)`
   (345–356) must be false: `_gameplayReleased` Set must not contain the
   roomId AND `_gameManager.hasInitializedGameplay(roomId)` must be false;
   otherwise `_onExpiry` returns silently (888–896).
4. **`_paymentSessionManager` late-bound** via `setEscrowUnwindBridgeDeps`
   (101–109; production: `app.js:1554`) — required for the R17.8O.4
   REFUND_PENDING room-destroy deferral check (960–970).
5. **`roomManager.getRoom(roomId)` present** — required only for the destroy
   step (974–986).
6. For the emitted event to have effect: the synchronous EventBus
   subscribers must exist at fire time (`RoomLobbyBridge` subscription,
   `SessionHistoryArchiveManager` flag/hint subscription — both registered
   during `app.js` startup).

### Q3 — What happens to that state when the Node.js process restarts?

Everything in Q2(1)–(3) is process-local and unrecoverable:

- Node timers do not survive process death; `_expiryTimers` is empty after
  boot.
- `_sessions` (Map) and `_gameplayReleased` (Set) start empty.
- Graceful shutdown: `SERVER_SHUTDOWN` → `_reset()` (330–336) clears both
  maps by design. Crash: silent loss.
- **No reconstruction exists for payment-stage rooms**: the only gameplay
  restore source is `RECOVERY_DATA` via `RecoveryOrchestrator.recoverAll()`
  (`app.js:1866`), whose record contract requires
  `gameId + gameState + configuration + clock` fields and is produced by
  `RecoveryCheckpointManager` only from post-`GAME_INITIALIZED`
  `GAME_STATE_CHANGED` phases (PRE_GAME_READY / READY / RESULT; SELF_TEST /
  SPEED / BRAKE deliberately not checkpointed). A room sitting in the
  PAYMENT stage (setup ARCHIVED, game never initialized) has **no**
  RECOVERY_DATA record → `RoomManager.attachRoom` never runs for it → the
  room, the setup session, and the timer are all absent after boot.
- Only financial records are restored (`TonFinancialRecovery.recover()` →
  `PaymentSessionManager.restorePaymentSessions()`), which restores the
  PaymentSession into `_sessionsByRoom` (current tree restores refundable
  FULLY_PAID sessions; `restoreRoomWalletRefund.test.js`) but nothing
  setup-related.

### Q4 — Is there currently any code that reconstructs/re-arms SetupSession expiry timers for restored rooms?

**No.** Verified:

- `SetupSessionLifecycle` has no restore/re-arm/hydrate method; the only
  creation site is `createForRoom`, which is bound to live room creation
  (`RoomManager.createRoom` never runs for restored rooms — it always
  generates a NEW roomId; there is no `attachExistingRoom` for payment-stage
  rooms).
- `SetupSession` has no `fromRecord`/`fromSnapshot` static (unlike
  `PaymentSession`, `SettlementSession`, `DepositSession`, `WalletSession`).
- `RecoveryOrchestrator` / `RecoveryCheckpointManager` /
  `RecoveryDataPersistence` never touch setup sessions (no `setupSession`
  field in the RECOVERY_DATA contract).
- `RecoveryOrchestrator` itself is explicit that reconstructed clocks are
  armed "only eligible, validated, non-expired, last" (lines 18, 710–765) —
  that machinery is GameClockEngine-scoped only.

## 4. Evidence From The Code (exact restart gap)

Startup ordering in `server/app.js` `start()` (main tree, verified lines):

```
app.js:870   this._setupSessionLifecycle = new SetupSessionLifecycle({...})
app.js:879   this._setupSessionLifecycle.initialize()
app.js:881   roomManager.attachSetupSessionLifecycle(...)
app.js:1554  this._setupSessionLifecycle.setEscrowUnwindBridgeDeps({ paymentSessionManager })
...          financial recovery: TonFinancialRecovery.recover() →
             PaymentSessionManager.restorePaymentSessions()   (rooms NOT restored)
app.js:1813  this._recoveryCheckpointManager.initialize()
app.js:~1830 new RecoveryOrchestrator({...})
app.js:1866  const recoveryOutcome = recoveryOrchestrator.recoverAll();   // sync, gameplay attach
app.js:~1949 this._socketGateway = new SocketGateway({...}); connectEventBus(...)
app.js:1953  this._roomLobbyBridge = new RoomLobbyBridge({...})
app.js:1972  this._roomLobbyBridge.initialize()
app.js:2159  this._sessionHistoryArchive = SessionHistoryArchiveManager.getInstance()
app.js:2161  this._sessionHistoryArchive.initialize({...})
...          await this._listen()   ← client connections accepted only now
```

The ordering contract is asserted by
`server/tests/startupRecoveryIntegration.r179t6.test.js` (section A):
`RecoveryCheckpointManager.initialize()` < `new RecoveryOrchestrator({` <
`.recoverAll()` < `new SocketGateway({` < `_listen()`.

**Exact restart gap:** for every room that died inside the PAYMENT stage
(setup `ARCHIVED`, funds possibly already received), after a restart there is
no `_sessions` entry, no `_expiryTimers` entry, and no Room object.
`_onExpiry` can therefore never run; `SETUP_SESSION_EXPIRED` can never be
emitted; the Setup Session's wall-clock authority (the only pre-init
teardown authority) is silently gone for the lifetime of the process. The
recovered runtime retains only the durable PaymentSession record. This is
the mechanism proven forensically for room XSDd
(`2026-09-27_xsdd_live_setup_expiry_refund_forensic.md`, facts F3/F4).

**Honest funds-safety note (current tree):** the current
`PaymentSessionManager.restorePaymentSessions()` re-requests Room Wallet
refunds at boot for persisted sessions with unrefunded paid funds when the
room is gone / deadline passed / REFUND_PENDING (Gate 2, lines 818–845) —
and a payment-stage room is ALWAYS "gone" after restart today. So the
funds-safety net for the exact XSDd shape already exists in the current
tree. The gap closed by this analysis is the **expiry-handling authority**
itself (timer, event, classification, and future room restoration), which
must not depend on that accident of ordering.

## 5. Where re-arming would belong (Q5)

The exact insertion point is the `app.js` startup block **immediately after
`recoveryOrchestrator.recoverAll()` (line 1866) and strictly before
SocketGateway construction / `_listen()`** — the same slot the startup
recovery integration already established for "financial state first,
gameplay second, sockets last". Rationale, item by item:

- **After financial recovery** ( TonFinancialRecovery block ends before
  1813): `PaymentSessionManager._sessionsByRoom` is already populated, so a
  fired expiry can see REFUND_PENDING and correctly defer room destroy
  (960–970).
- **After `recoverAll()` (1866)**: `GameManager.attachGame` has run for all
  recovered gameplay candidates, so `hasInitializedGameplay(roomId)` is
  truthful for every restored game — the ownership-released guard (Q7,
  GAME_INITIALIZED case) works without touching GameManager.
- **Before SocketGateway/`_listen()`**: no client can connect or create a
  room while restore is deciding; the existing source-ordering test
  continues to pass (an insertion between `.recoverAll()` and
  `new SocketGateway({` preserves its assertion).
- If a future variant deliberately wants already-elapsed deadlines to emit
  `SETUP_SESSION_EXPIRED` at boot (for honest archive classification), the
  call must instead be placed after `RoomLobbyBridge.initialize()` (1972)
  and `SessionHistoryArchiveManager.initialize()` (2161), still before
  `_listen()`. The recommended minimal variant does not need this (see Q7).

`SetupSessionLifecycle` is constructed and initialized long before this
point (870/879), so the target object exists; the call is a plain public
method invocation, no new lifecycle or event is required.

## 6. Does a persisted SetupSession record already contain enough information? (Q6)

**No — no SetupSession persistence exists today.** Verified:

- `SetupSession` (model) has no `toPayload`/`fromRecord`; nothing in
  `server/persistence/` or `server/recovery/` stores setup-session fields.
- Durable sources that DO exist and what they contain:
  - `PAYMENT_SESSION` records (TonFinancialPersistence active set):
    `roomId`, `roomNumber`, `gameId`, `status`, participants
    (`paidAmount`/`refunded`), `roomWalletAddress`, `recoveryMetadata`,
    `paymentDeadline` — **no setup `startedAt`/`expiresAt`/`state`/
    `roomFull`**. `paymentDeadline` is the PaymentSessionManager deadline, a
    different timer; deriving the setup deadline from it (or from boot time +
    configured duration) would EXTEND the original authoritative deadline —
    the exact thing `RecoveryOrchestrator` refuses to do for recovered game
    clocks ("the original authoritative deadline is never extended",
    lines 714–717). Rejected on principle.
  - `RECOVERY_DATA`: gameplay contract only (requires
    `gameId/gameState/configuration/clock`); never written pre-init.
  - `RECOVERY_CHECKPOINT`: production writers = NONE; deletable monitor
    state; not a durable authority.
  - `session-history` JSONs: destroy-time archives, not restore sources.
- **However, the model is already reconstruct-ready**: the `SetupSession`
  constructor (SetupSession.js:13–22) accepts
  `{ roomId, startedAt, expiresAt, setupSessionId, state,
  verificationState, paymentPrepState, roomFull }` — exactly the minimal
  record needed. The gap is purely the missing durable record, not a model
  change.

Conclusion: the smallest faithful re-arm requires a small **additive**
persistence record. Reconstructing without one cannot preserve the
authoritative deadline and is therefore not "safe".

## 7. Could re-arming accidentally fire for…? (Q7)

- **An already completed setup (state COMPLETED):** firing is *by design*
  pre-init — `_onExpiry` explicitly honors COMPLETED (R7.70C23 comment,
  910–918; `_tryComplete` keeps the wall clock alive at 786–787) because
  prep pages still count down and the deadline still terminates the room.
  The only forbidden case is firing **after** gameplay took ownership —
  guarded by `isGameplayOwnershipReleased(roomId)` (888–896). After a
  restart this guard is truthful because the restore call is placed after
  `recoverAll()` (attachGame done → `hasInitializedGameplay` accurate).
- **A destroyed room:** three independent layers: (a) the persistence write
  is terminalized whenever the lifecycle deletes the session
  (`_sessionDelete` covers both `abortForRoom` and `_onExpiry` callers), so
  a destroyed room's record is skipped at restore; (b) at fire time
  `_onExpiry` destroys only when `roomManager.getRoom(roomId)` is present
  (974); (c) a late ROOM_DESTROYED still reaches
  `_handleRoomDestroyed → abortForRoom`. A restore-time fire with no room
  degrades to a harmless emit + registry delete.
- **A room that already reached GAME_INITIALIZED:** same ownership guard as
  the first case; additionally `_releaseGameplayOwnership` cleared the
  timer in the dying process and the restore-side guard re-checks
  `hasInitializedGameplay` (populated by `attachGame` during `recoverAll()`,
  which precedes the restore call).
- **A session that has already expired:** `expiresAt ≤ Date.now()` at boot.
  Recommended minimal rule: **do not arm elapsed deadlines** — terminalize
  the persisted record and skip. Funds remain owned by the existing
  `restorePaymentSessions()` Gate-2 boot refund (room-gone conjunct). If the
  project later wants the boot-time `SETUP_SESSION_EXPIRED` emission for
  archive classification, that variant must arm only after
  `RoomLobbyBridge.initialize()` (1972) + `SessionHistoryArchiveManager.initialize()`
  (2161), still pre-`_listen()` — otherwise the synchronous event fires
  before its subscribers exist and is lost.
- Additional invariant that makes all four cases safe: a reconstructed
  session never gets NEW authority — `_onExpiry` keeps every existing guard
  (ownership, state set, room presence, REFUND_PENDING deferral) and the
  restore path reuses `_scheduleExpiry`/`_onExpiry` unchanged.

## 8. Proposed minimal fix (Q8 — design only, NOT implemented)

Three files, additive-only, no behavior change for the live (non-restart)
path:

**1. `server/persistence/TonFinancialRecordTypes.js`** — add one record type
`SETUP_SESSION` (+ its terminal status) to the additive record-type table.
No existing record, schema, checksum, or storage behavior changes; the
generic `TonFinancialPersistence` envelope API is reused as-is.

**2. `server/gameplay/SetupSessionLifecycle.js`** — additive only:

- New optional late-bound dep, mirroring the existing
  `setEscrowUnwindBridgeDeps` pattern (101–109):
  `setSetupSessionPersistence({ persistence })`. All persistence calls are
  fail-open (log + continue); the lifecycle must never block or throw on
  persistence errors — the runtime behavior of the live path stays
  bit-for-bit identical when the dep is absent.
- Three tiny write points (create/update/terminalize):
  - `createForRoom` after `_scheduleExpiry` (line ~430): create record
    `{ roomId, setupSessionId, startedAt, expiresAt, state: ACTIVE,
    roomFull: false }`;
  - `_tryComplete` after `session.complete()` (~788) and `archiveForPayment`
    after `session.archive()` + `_rescheduleExpiry` (~672): update record
    (`state`, `roomFull`);
  - `_sessionDelete` (238–273, the single choke point already used by both
    `_onExpiry` and `abortForRoom`): mark the record terminal/deleted.
  This automatically terminalizes records for destroyed rooms (via
  `RoomManager.destroyRoom → abortForRoom`), expired sessions, and
  GAME_INITIALIZED histories only when the session is actually deleted —
  matching what restore is allowed to resurrect.
- One new public restore method (name illustrative):
  `restorePersistedSessions({ records })`, invoked once at boot:
  for each record — skip if `_sessions.has(roomId)`; skip if
  `isGameplayOwnershipReleased(roomId)`; skip if
  `state ∉ { ACTIVE, COMPLETED, ARCHIVED }`; skip + terminalize if
  `expiresAt <= Date.now()`; otherwise reconstruct
  `new SetupSession({ roomId, startedAt, expiresAt, setupSessionId, state,
  roomFull })` (constructor already supports this verbatim), `_sessionSet`,
  then the EXISTING `_scheduleExpiry(session)` — unchanged. No new timer
  code, no new event, no changed guards.

**3. `server/app.js`** — ONE insertion block right after
`recoveryOrchestrator.recoverAll()` (after line 1866, before SocketGateway):
list `SETUP_SESSION` records through the generic persistence list API and
call `this._setupSessionLifecycle.restorePersistedSessions({ records })`.
Failure policy: log-and-continue (candidate-isolated, matching the existing
per-candidate startup-recovery policy) — funds safety remains owned by
`PaymentSessionManager.restorePaymentSessions()`, which has already run at
this point.

**What this does and does not close:**

- Closes: loss of the Setup Session's wall-clock authority and
  `SETUP_SESSION_EXPIRED` semantics across restart for any session whose
  deadline is still in the future; honest re-arming tied to the original
  `expiresAt`; correct archive classification (`SETUP_EXPIRED`/`TIMEOUT`)
  when the timer eventually fires; REFUND_PENDING deferral interplay works
  because financial recovery has already run before the restore call.
- Does NOT close (explicitly out of scope, unchanged): payment-stage room
  reconstruction itself (Room/players are still not restored pre-init —
  that remains the R17.9T.6 attach family); the boot-time refund of paid
  funds stays owned by the existing `restorePaymentSessions()` path; no
  refund logic, decision logic, or bridge logic is touched.

**Deliberately rejected smaller variants:**

- Re-derive `expiresAt` from the PAYMENT_SESSION record or from
  `boot + configuredDuration` — extends the authoritative deadline
  (forbidden by the recovery principle in `RecoveryOrchestrator` 714–717)
  and can silently resurrect a deadline that had already elapsed.
- Reuse `RECOVERY_DATA` for pre-init rooms — requires relaxing the gameplay
  recovery contract (gameId/gameState/configuration/clock) and drags engine
  attach semantics into the payment stage; far larger blast radius than a
  dedicated additive record.
- Piggyback the snapshot onto the PaymentSession payload — requires
  changing `PaymentSessionManager` (explicitly out of scope) and couples
  two domains' persistence.

**Suggested focused test (new file, e.g.
`server/tests/setupSessionRestartRearm.test.js`):** build a lifecycle with
persistence; create → archive → simulate a crash by constructing a SECOND
lifecycle over the same data directory; assert (a) future-deadline record is
re-armed and `_onExpiry` fires exactly once at the original deadline,
(b) elapsed-deadline record is skipped + terminalized, (c)
ownership-released / GAME_INITIALIZED record is skipped, (d) terminalized
(destroyed-room) record is skipped, (e) the REFUND_PENDING deferral still
prevents room destroy when a payment session is present.

## 9. Modules that must NOT be changed (Q9)

- `server/gameplay/PaymentSessionManager.js` — restore path, `failSession`,
  `_requestRoomWalletPartialPaymentRefund`, `_finalizePartialPaymentUnwind`
  (explicitly out of scope; refund logic frozen).
- `server/socket/RoomLobbyBridge.js` — `_handleSetupSessionExpired`,
  `_removePlayerFromLobby`, `_closeRoom` (decision logic frozen).
- `server/payment/RoomWalletSettlementAdapter.js`,
  `RoomWalletSettlementRouter.js`, `BlockchainMonitor.js` — settlement and
  observation untouched.
- GameEscrow / DepositContract / DepositPackage / DepositSession* modules
  and `GameContractManager` legacy paths — untouched, not restored, not
  consulted.
- `server/recovery/RecoveryOrchestrator.js`,
  `RecoveryCheckpointManager.js`, `RecoveryDataPersistence.js`,
  `TonFinancialRecovery.js` — gameplay recovery contract and financial
  recovery stay exactly as they are.
- `server/managers/RoomManager.js`, `GameManager.js`, `PlayerManager.js` —
  D1–D3 attach APIs and lifecycles unchanged; no payment-stage attach added.
- `server/models/SetupSession.js` — constructor already sufficient; no model
  change required.
- `server/history/SessionHistoryArchiveManager.js`,
  `server/socket/lobbyProtocol.js`, `server/events/*` — no new events, no
  classification changes.
- `server/gameplay/GameStartAuthorization.js`,
  `server/gameplay/financialEvidenceGuards.js` — untouched.

## 10. Risks / Edge Cases

- **R1 (Low) — restored ARCHIVED/COMPLETED sessions are not frozen.**
  `SetupSession.archive()`/`expire()` normally freeze the model
  (`_immutable`), but a reconstructed instance starts mutable; the state
  machine methods are guarded by state checks (`archive()` re-enters as a
  no-op for ARCHIVED; `complete()` would re-set COMPLETED harmlessly) and
  `_onExpiry` only calls `expire()` for ACTIVE sessions (922–937 — ARCHIVED
  uses the frozen-snapshot branch). Acceptable; optionally call the private
  freeze via a tiny additive `markRestoredImmutable()` later. No restore
  path currently mutates state.
- **R2 (Low) — duplicate restore.** Guarded by `_sessions.has(roomId)`
  (`createForRoom` also fails closed on duplicates, 407–415); restore runs
  once per boot, and `_reset()` still clears memory on SERVER_SHUTDOWN.
- **R3 (Low) — persistence write latency in the live path.** Writes are
  fire-and-forget with logging; the lifecycle's synchronous guarantees
  (`createForRoom` atomicity, timer arming) never wait on persistence.
- **R4 (Medium, pre-existing, unchanged by this fix)** — a payment-stage
  room after restart has no Room object, so a re-armed expiry fires into a
  roomless context: the bridge's "room already gone" branch runs, no
  `failSession`, no room destroy. Funds are handled by the PSM restore
  path (Gate 2, room-gone). This is precisely why the fix must NOT be
  counted as the funds-safety mechanism — it restores *authority and
  semantics*, while refund safety remains in the payment domain.
- **R5 (Low) — clock skew.** If the host clock jumps backwards across a
  restart, `expiresAt - Date.now()` grows and the timer arms longer than
  originally intended. The deadline value itself is preserved; only the
  firing epoch moves. Same exposure exists for `GameClockEngine` arming.
- **R6 (Low) — stale records after long downtime.** Elapsed deadlines are
  skipped + terminalized, so a server returning after hours cannot
  resurrect old timers; room numbers were released at destroy time in the
  previous process.
- **R7 (Medium, design constraint)** — the persistence dep must be
  strictly optional and fail-open: if the additive record type is ever
  disabled/misconfigured, the live lifecycle must behave exactly as today
  (tests A–F of `setupExpiryRoomWalletRefund.test.js` and
  `creatorLeftRoomWalletRefund.test.js` must pass unchanged with no
  persistence dep bound).
- **R8 (Low)** — `setupTimer.r770c19.test.js` asserts a second
  `createForRoom` returns null ("no reset"); the restore method is a
  separate public API and must not route through `createForRoom`, keeping
  that invariant intact.

## 11. Answers Recap (Q1–Q9)

1. Timer created in `_scheduleExpiry` (846–858); armed at `createForRoom`
   (429) and `_rescheduleExpiry` (879, from `archiveForPayment` 672).
2. `_expiryTimers` entry + live `_sessions` entry with state
   ACTIVE/COMPLETED/ARCHIVED + ownership not released (+ PSM dep for
   deferral, + room for destroy).
3. All of it is process-local; gone on restart/crash; `_reset()` clears on
   graceful shutdown; payment-stage rooms are not reconstructed at all.
4. No — no reconstruction/re-arm code exists anywhere.
5. `app.js` startup, immediately after `recoveryOrchestrator.recoverAll()`
   (line 1866), before SocketGateway/`_listen()` (after financial recovery
   so PSM state is present; after gameplay attach so
   `hasInitializedGameplay` is accurate).
6. No — nothing persists `startedAt/expiresAt/state/roomFull`; the
   `SetupSession` constructor already accepts exactly those fields, so only
   an additive record is missing.
7. Safe with guards: COMPLETED fires by design pre-init (ownership guard
   blocks post-init); destroyed rooms are terminalized + room-presence
   guarded at fire time; GAME_INITIALIZED blocked by the ownership guard
   (accurate post-`recoverAll()`); already-expired records must NOT be
   armed (skip + terminalize; PSM restore owns their funds).
8. Additive `SETUP_SESSION` record type + create/update/terminalize writes
   in the lifecycle's existing choke points + one `restorePersistedSessions`
   method reusing `_scheduleExpiry` + one call site in `app.js` after
   `recoverAll()`. Three files, additive only.
9. See §9 — PaymentSessionManager, RoomLobbyBridge, settlement adapters,
   GameEscrow/Deposit*, recovery orchestrator/persistence, managers, model,
   archive manager, events.

## 12. NO SOURCE CHANGES MADE

- No source files modified. No tests modified. Nothing deleted.
  Nothing refactored. Nothing committed or pushed.
- This report is the only file created:
  `AI_CONTEXT/CLINE_REPORTS/2026-09-27_setup_session_restart_rearm_analysis.md`.






