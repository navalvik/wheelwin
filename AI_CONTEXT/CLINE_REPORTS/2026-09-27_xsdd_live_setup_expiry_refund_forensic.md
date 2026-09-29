# XSDd Live ROOM_DESTROYED Forensic Analysis — Setup Expiry Never Dispatched; Funds Not Refunded

Date: 2026-09-27

Task: Focused forensic analysis (ANALYSIS ONLY) of the real Testnet room **XSDd**
failure using the uploaded ROOM_DESTROYED archive facts and the current codebase
(`payment/room-wallet-integration`, HEAD `01a9a9f`). Trace only the incident path
(SetupSession expiry → event → `RoomLobbyBridge._handleSetupSessionExpired` →
`PaymentSessionManager.failSession("setup_expired")` → FULLY_PAID refund branch),
find the FIRST divergence from the passing focused tests, and classify the Page5
failure vs the refund failure. No source files, tests, or lifecycle code were
modified. No fix implemented.

---

## 1. Scope

- The exact production execution path of setup-expiry handling and its refund
  decision, on the current tree AND on the pre-fix baseline that was deployed
  when room XSDd lived (git: incident predates `4b9db36` / `01a9a9f`).
- The evidence value of the session-history classification fields recorded in
  the archive (`lifecycleResult`, `failureOwner`, `finalStage`, `reason`).
- Comparison of `server/tests/setupExpiryRoomWalletRefund.test.js` and
  `server/tests/creatorLeftRoomWalletRefund.test.js` assumptions against the
  real production lifecycle.
- NOT in scope: settlement, winner flow, Page6, smart contracts, deployment
  procedures.

## 2. Files Inspected

Context (required reading, per `.clinerules`):

- `AI_CONTEXT/WHEELWIN_MASTER_CONTEXT.md`, `ARCHITECTURE_RULES.md`,
  `CURRENT_STATE.md`, `AI_WORKING_RULES.md`.
- `AI_CONTEXT/CLINE_REPORTS/2026-09-26_xsd_page5_start_authorization_setup_expiry_refund_fix.md`
  (original XSDd incident analysis and fix),
  `AI_CONTEXT/CLINE_REPORTS/2026-09-27_creator_left_room_wallet_refund_fix.md`,
  `AI_CONTEXT/CLINE_REPORTS/2026-09-27_payment_session_restore_room_wallet_refund_gap.md`.

Source (current tree, verbatim; line numbers refer to HEAD `01a9a9f`):

- `server/gameplay/SetupSessionLifecycle.js` — registry/constructor (30–109),
  `initialize()` (300–340), `isGameplayOwnershipReleased` (345–356),
  `createForRoom` + `_scheduleExpiry` (380–437, 846–858), `archiveForPayment`
  + `_rescheduleExpiry` (511–691, 860–881), `abortForRoom` (696–736),
  `_tryComplete` (778–807), `_onExpiry` (883–988), `_clearExpiry` (990–1000).
- `server/socket/RoomLobbyBridge.js` — SETUP_SESSION_EXPIRED subscription
  (~762), `_handleSetupSessionExpired` (3478–3567), creator-left branch
  (3718–3738), `_handlePaymentSessionFailed` (~6835), `_closeRoom` (4151+).
- `server/gameplay/PaymentSessionManager.js` — ROOM_DESTROYED subscription
  (248–263), `getSession` (308–312), `restorePaymentSessions` (716–869),
  `_requestRoomWalletPartialPaymentRefund` (1961–2074), `failSession`
  (2076–2290), `destroySession` (2292–2325), `_onExpiry` (2983–2997),
  `_reset` (3013–3027).
- `server/history/SessionHistoryArchiveManager.js` —
  `resolveLifecycleResult` (81–189), `resolveFailureOwner` (191–232),
  `resolveFinalStage` (234–274), SETUP_SESSION_EXPIRED subscription
  (378–386), ROOM_DESTROYED subscription (718–720), `finalizeIfPending`
  (868–887), `_setTerminalHint` (1334–1352), `_finalize` (1448–1620; fallback
  `pending.reason = pending.reason ?? "room_destroyed"` at line 1469).
- `server/forensic/ForensicArchiveService.js` (60–345),
  `server/forensic/forensicArchiveNaming.js`, `server/diagnostics/RoomDestroyForensics.js`,
  `server/managers/RoomManager.js` `destroyRoom` (445–536),
  `server/events/EventBus.js` (74–135), `server/gameplay/financialEvidenceGuards.js`,
  `server/app.js` (wiring at 1554), `server/console/projectionBuilders/buildRoomDetail.js`.
- Local durable evidence: `server/data/session-history/` —
  `2026-08-28_19-06-53_ROOM_Smsp_GAME_..._SETUP_EXPIRED.json` and
  `2026-08-28_19-52-11_ROOM_wMCC_..._SETUP_EXPIRED.json`
  (SETUP_EXPIRED / TIMEOUT / `reason: setup_expired` / finalStage PAYMENT),
  plus `index.json` records carrying the ROOM_DESTROYED/UNKNOWN fallback
  signature.
- Tests: `server/tests/setupExpiryRoomWalletRefund.test.js` (full),
  `server/tests/creatorLeftRoomWalletRefund.test.js` (harness),
  `server/tests/restoreRoomWalletRefund.test.js` (present on this branch).
- Pre-fix baseline mirror: `.kilo/worktrees/powerful-trunk/` (same modules
  with pre-R18.XSDd logic: `_handleSetupSessionExpired` gated on
  `sessionNeedsEscrowUnwind`; `_closeRoom` already passes
  `reason ?? "room_destroyed"` into the forensic service).
- Git: `git log --oneline -20` — HEAD `01a9a9f`, fix commits `4b9db36`
  (XSDd game-start + setup-expiry refunds) and `01a9a9f` (creator-left),
  baseline `f79177a` (origin/main).

## 3. Incident Facts From The Archive

Given archive facts (room XSDd):

- PaymentSession: `status: FULLY_PAID`; all 3 participants
  `PAYMENT_CONFIRMED`; all 3 `refunded=false`; `recoveryMetadata=null`;
  `roomWalletAddress` present; `paymentSessionId=pay_89a2d92d-...`;
  `roomId=XSDd`.
- SetupSession: `state: ARCHIVED`; `expiresAt=1790449986354` (≈
  2026-09-26T19:13:06Z); `roomId=XSDd`; `roomFull=true`.
- Room archive: `lifecycleResult: ROOM_DESTROYED`; `finalStage: PAYMENT`;
  `reason: room_destroyed`; `failureOwner: UNKNOWN`.
- The three incoming Room Wallet payments are confirmed and recorded as
  ACCEPTED.

Derived facts (code-evidenced):

- **F1.** `expiresAt` is in the past at destruction — the authoritative Setup
  Timer wall clock elapsed while the room sat in the PAYMENT stage.
- **F2.** `recoveryMetadata=null` is decisive: **`failSession(...)` never
  reached `_requestRoomWalletPartialPaymentRefund`**. That function writes
  `recoveryMetadata = { unwindReason, refundRequestedAt }` and calls
  `session.markRefundPending()` **synchronously before its first `await`**
  (`PaymentSessionManager.js:1986–2001`). Any started refund flow would have
  left `REFUND_PENDING` + `recoveryMetadata` in the durable record. Also:
  `status: FULLY_PAID` (not `CANCELLED`) — the unwind never finalized.
- **F3.** The classification triple (`ROOM_DESTROYED` / `UNKNOWN` /
  `reason: room_destroyed`) is the **no-terminal-hint fallback** of
  `SessionHistoryArchiveManager._finalize` (line 1469) and the
  `resolveFailureOwner` default (lines 225–228). Under the current — and
  pre-fix — pipeline, ANY real setup expiry would instead produce
  `SETUP_EXPIRED` / `TIMEOUT` / `reason: "setup_expired"`, because:
  - `_onExpiry` emits `SETUP_SESSION_EXPIRED` **before** any destroy
    (`SetupSessionLifecycle.js:943` vs 984) and `EventBus.emit` dispatches
    **synchronously** (`EventBus.js:117`);
  - the archive manager flags `setupExpired=true` and hints `setup_expired`
    on that event (`SessionHistoryArchiveManager.js:378–386`);
  - `resolveLifecycleResult` returns `SETUP_EXPIRED` when
    `reason.includes("setup_expired") || flags.setupExpired` (line 107) —
    the flag alone suffices, regardless of any later close reason.
  Durable counter-example from this repository:
  `2026-08-28_..._ROOM_Smsp_..._SETUP_EXPIRED.json` —
  `lifecycleResult: SETUP_EXPIRED`, `failureOwner: TIMEOUT`,
  `reason: setup_expired`, `finalStage: PAYMENT`, `durationMs: 300009`
  (room wMCC identical). The expiry→archive pipeline demonstrably worked on
  deployed builds before XSDd.
- **F4.** The archive still contains a full `ARCHIVED` SetupSession snapshot.
  `_onExpiry` **deletes** the setup session (line 957) BEFORE destroying the
  room (line 984); `RoomManager.destroyRoom` additionally calls
  `abortForRoom` BEFORE emitting `ROOM_DESTROYED` (`RoomManager.js:510`), and
  `abortForRoom` deletes the registry entry unconditionally (line 732). A
  destroy driven by `_onExpiry` therefore cannot leave a live `ARCHIVED`
  snapshot for the archive to capture. **Independent second proof that the
  expiry path never executed for XSDd.**
- **F5.** The `ROOM_DESTROYED` token in the archive filename is generic
  (`forensicArchiveNaming.js` maps unrecognized lifecycle results to
  `ROOM_DESTROYED`); it does NOT identify the destroyer. The discriminative
  fields are the four JSON classification fields covered by F3.

## 4. Architecture Findings (ownership of the traced path)

1. **SetupSessionLifecycle** owns the Setup Timer: armed once at
   `createForRoom` (line 429), re-armed at `archiveForPayment` (line 672,
   R7.70C23 — PAYMENT still honors the wall-clock `expiresAt`), fired by a
   plain in-memory `setTimeout`. Registry (`_sessions`) and timers
   (`_expiryTimers`) are **memory-only**; `SERVER_SHUTDOWN` → `_reset()`
   clears both (330–336). **There is no restore path**: `SetupSession` has no
   `fromRecord`, and nothing re-creates ARCHIVED sessions or re-arms the
   timer for rooms recovered after a restart (compare: PaymentSession,
   SettlementSession, DepositSession, WalletSession — all have `fromRecord`).
2. **RoomLobbyBridge** owns the expiry *decision*: EventBus subscription
   (~762) → `_handleSetupSessionExpired` (3478–3567): ownership guard →
   deliver to room → "room already gone" early return (3508–3526 — cleanup
   only, **no refund**) → PaymentSession lookup (3528) → decision
   `sessionHasUnrefundedPaidFunds(paymentSession) &&
   isRoomWalletPaymentIntakeEnabled()` (3533–3543) →
   `failSession(roomId, "setup_expired")` (3559) → return; otherwise
   `void this._closeRoom(roomId, "setup_expired")` (3565).
3. **PaymentSessionManager** owns the refund machinery: `failSession` (2076)
   — `refundableFullyPaidBeforeGameInit` = reason ∈ {`setup_expired`,
   `creator_left`} ∧ `FULLY_PAID` ∧ refund available ∧ unrefunded paid funds
   (2110–2116) bypasses the terminal abort; `needsRoomWalletRefund` →
   fire-and-forget `void this._requestRoomWalletPartialPaymentRefund(...)`
   (2179), which synchronously persists `recoveryMetadata` and calls
   `markRefundPending()` before its first `await` (1986–2024). The lifecycle
   defers room destroy because `_onExpiry` re-reads the session at 960–970
   and observes `REFUND_PENDING` (valid only because EventBus dispatch is
   synchronous — `EventBus.js:117`; production wiring
   `app.js:1554 setEscrowUnwindBridgeDeps({ paymentSessionManager })`
   confirmed). Finalization: `_finalizePartialPaymentUnwind` →
   `PAYMENT_SESSION_FAILED` → `RoomLobbyBridge._handlePaymentSessionFailed`
   → `_closeRoom`.
4. **Evidence ownership**: `SessionHistoryArchiveManager` finalizes exactly
   once (`_archived` guard): first via
   `ForensicArchiveService._resolveLifecycleResult → finalizeIfPending({roomId, reason})`
   (close-reason carrying; runs inside `_closeRoom` before `destroyRoom`),
   otherwise via the ROOM_DESTROYED subscriber `_finalize(envelope.payload)`
   whose payload carries **no reason** → fallback `reason: "room_destroyed"`
   + `ROOM_DESTROYED` + `UNKNOWN`.
5. **Restore ownership (post-restart)**:
   `PaymentSessionManager.restorePaymentSessions()` (716–869) — the current
   tree restores refundable FULLY_PAID sessions
   (`refundableRestoredFullyPaid`, 761–770) and re-requests refunds through
   the existing machinery (818–845; reason
   `recoveryMetadata?.unwindReason ?? "room_destroyed"`); covered by
   `server/tests/restoreRoomWalletRefund.test.js`. **The pre-fix baseline did
   not**: Gate 1 skipped every terminal session (`isTerminal() → continue`)
   and Gate 2 required escrow-era `sessionNeedsEscrowUnwind` (false whenever
   all seats are confirmed) — the exact gap documented in
   `2026-09-27_payment_session_restore_room_wallet_refund_gap.md`.

## 5. Expected Production Path (the traced chain, current code)

1. **Expiry scheduling/dispatch.** `SetupSessionLifecycle._scheduleExpiry`
   (846–858) arms `setTimeout(_onExpiry(roomId), expiresAt - now)` at
   `createForRoom` (429) and re-arms it at `archiveForPayment` (672). At
   `expiresAt` the timer callback runs `_onExpiry(roomId)` (883).
2. **Guards inside `_onExpiry`.** Timer map cleanup (885); gameplay-ownership
   guard (888–896 — false here, GAME_INITIALIZED never happened); session
   lookup (898–908 — the ARCHIVED session is still registered); state guard
   (912–918 — ARCHIVED is an allowed expiry state, R7.70C23).
3. **The event.** `_emit(EVENT_TYPES.SETUP_SESSION_EXPIRED, snapshot)` (943)
   — **synchronous** dispatch (`EventBus.js:117`) to all subscribers:
   - `SessionHistoryArchiveManager` → `flags.setupExpired=true` +
     `_setTerminalHint(roomId, "setup_expired")` (378–386);
   - `RoomLobbyBridge._handleSetupSessionExpired` (3478).
4. **`RoomLobbyBridge._handleSetupSessionExpired`.** Room exists → lookup
   `paymentSession = paymentSessionManager.getSession(roomId)` (3528) → for
   XSDd: FULLY_PAID, 3 × `PAYMENT_CONFIRMED`, `refunded=false` →
   `sessionHasUnrefundedPaidFunds === true`; intake enabled →
   `willRefundPaidFunds === true` → `failSession(roomId, "setup_expired")`
   (3559) → **return** (no `_closeRoom` here).
5. **`failSession` decision** (2103–2152): session present; intake on;
   `refundableFullyPaidBeforeGameInit === true` → terminal abort bypassed;
   `markTimedOut/markFailed` skipped for FULLY_PAID (2161–2175);
   `needsRoomWalletRefund === true` →
   `void _requestRoomWalletPartialPaymentRefund(session, "setup_expired")`
   (2179) → return.
6. **Refund start (synchronous part).** 1975–2001: targets built,
   `recoveryMetadata = { unwindReason: "setup_expired", refundRequestedAt }`
   written, `markRefundPending()` → `FULLY_PAID → REFUND_PENDING`
   (legal since R18.XSDd, `PaymentSessionStates.js:48–52`), persisted,
   `PAYMENT_SESSION_UPDATED` emitted — all before the first `await`.
7. **`_onExpiry` continuation.** Line 960–970: payment session status is now
   `REFUND_PENDING` → `DEFER_ROOM_DESTROY` → **return without destroying**.
8. **Refund completion (async).** `RoomWalletSettlementAdapter.refundPayments`
   → participants `refunded=true` → `allConfirmedParticipantsRefunded` →
   `_finalizePartialPaymentUnwind` → session `CANCELLED` +
   `PAYMENT_SESSION_FAILED(reason=setup_expired)` →
   `RoomLobbyBridge._handlePaymentSessionFailed` →
   `_closeRoom(roomId, "setup_expired")` → forensic archive →
   `destroyRoom` → `ROOM_DESTROYED`.
9. **Archive outcome (expected).** Session-history record:
   `lifecycleResult: SETUP_EXPIRED`, `failureOwner: TIMEOUT`,
   `reason: setup_expired`, `finalStage: PAYMENT`; PaymentSession durable
   record: `CANCELLED`, `refunded=true` ×3, `recoveryMetadata` populated.
   (Exactly what rooms Smsp/wMCC show, minus the refund facts.)

## 6. Actual Path Supported By Evidence

- **The chain stopped at step 1.** F3 + F4 (two independent, code-evidenced
  proofs) show `SETUP_SESSION_EXPIRED` was never dispatched for XSDd before
  the room was destroyed: no `setupExpired` flag, no `setup_expired` hint,
  and a live `ARCHIVED` SetupSession snapshot at destroy time although
  `_onExpiry` deletes the session before destroying.
- Therefore steps 2–8 never ran for XSDd. Consistent with **F2**:
  `recoveryMetadata=null`, status still `FULLY_PAID`, `refunded=false` ×3.
- The room was destroyed by a **destroyer that sets no terminal hint and does
  not route through `_onExpiry`**: the record's fallback signature
  (`reason: room_destroyed`, `ROOM_DESTROYED`, `UNKNOWN`) is produced when
  the ROOM_DESTROYED subscriber finalizes without any prior
  `_setTerminalHint` (line 1469). The only pre-init, PAYMENT-stage destroy
  paths with that signature are the direct `RoomManager.destroyRoom` calls
  outside `_closeRoom`'s hinted flow — the empty-room branch of
  `RoomLobbyBridge._removePlayerFromLobby` (registers
  `reason: "empty_room"` destroy forensics only; 3905–3914) and
  `RoomManager.shutdown` (`reason: "server_shutdown"`; 743–749) — or a
  `_closeRoom` invocation whose forensic finalize never carried a reason on
  the deployed build. In all variants: **no refund decision exists on that
  path at all.**
- Timeline synthesis consistent with every archive fact: XSDd reached
  PAYMENT (ARCHIVED setup, `roomFull=true`, `paymentEntered` flag →
  `finalStage: PAYMENT`), all three Room Wallet payments confirmed →
  `FULLY_PAID` + `PAYMENT_SESSION_COMPLETED`; **Page5 was never reached**
  (see §9); the wall-clock Setup Timer deadline elapsed without the expiry
  dispatch; later the room was torn down by an unhinted destroy
  (empty-room-after-disconnects or shutdown); the durable PaymentSession
  record froze at `FULLY_PAID` with `recoveryMetadata=null` — funds still
  sitting in the Room Wallet, unrefunded.

## 7. First Confirmed Divergence (tests vs real production lifecycle)

**Trace step 1 — SetupSession expiry scheduling/dispatch.**

The passing tests do not exercise step 1 at all:

- `setupExpiryRoomWalletRefund.test.js` (`triggerSetupExpiry`, lines
  295–299) calls `stack.setupSessionLifecycle._onExpiry(stack.roomId)`
  **directly** — the real `setTimeout` scheduling/arming performed by
  `createForRoom`/`archiveForPayment` is bypassed, and so is everything that
  can happen to an in-memory timer and registry during the 5–10 minute
  payment window (process restart/crash-respawn being the decisive one).
- The harness **seeds** the PaymentSession straight into
  `paymentSessionManager._sessionsByRoom` (lines 311–314, 445–448) and the
  setup session via `archiveForPayment` (`seedArchivedSetup`, 278–287) — it
  presupposes both objects are alive in memory at expiry, which is precisely
  what production lost for XSDd.
- `roomLobbyBridge._closeRoom` is **stubbed** (lines 219–223), so the
  production close semantics (forensic finalize ordering, destroy context,
  record classification) are never exercised.
- Both suites run a single process: no `SERVER_SHUTDOWN`, no
  `restorePaymentSessions()`, no reconnection, no time gap.

The real production path depends on a **memory-only** timer plus registry
that have no durable representation and no restore path (§4.1). Once that
state is gone, the `SETUP_SESSION_EXPIRED` event can never fire, and — on the
deployed pre-fix baseline — no other machinery would refund either, because
`restorePaymentSessions()` Gate 1 skipped the terminal FULLY_PAID session
entirely (it was never re-indexed into `_sessionsByRoom`; even a later expiry
or creator-left would have found `getSession(roomId) === null`).

**Conclusion: the first divergence is the lifetime of the expiry-dispatch
state (timer + setup-session registry), not the refund logic and not the
bridge decision.** The test suite cannot see it because it injects the expiry
callback and presumes the registry contents.

## 8. Root Cause

Confirmed as a two-layer root cause:

1. **Deployment layer (primary for THIS incident).** The room lived and died
   on the **pre-fix baseline** (`f79177a`); the fixes named after this very
   room (`4b9db36` "repair XSDd game-start authorization and setup-expiry
   Room Wallet refunds", `01a9a9f` creator-left) were authored AFTER
   `expiresAt ≈ 2026-09-26T19:13Z`. On that baseline:
   - Page5 was blocked by the confirmed `ReferenceError: contract is not
     defined` in `GameStartAuthorization._checkStartConditions()` (fixed in
     `4b9db36`) — the room could never reach `GAME_INITIALIZED`;
   - the restore path skipped terminal FULLY_PAID sessions (Gate 1) and used
     escrow-era `sessionNeedsEscrowUnwind` (Gate 2), so a FULLY_PAID session
     could not be restored or refunded after any state loss;
   - `_handleSetupSessionExpired` and the creator-left branch gated refunds
     on `sessionNeedsEscrowUnwind` (false for all-confirmed sessions), and
     `failSession` aborted on terminal status — so even a fired expiry event
     would have closed the room via `_closeRoom("setup_expired")` without
     refund.
2. **Architecture layer (still true on the current tree).** The
   `SETUP_SESSION_EXPIRED` dispatch chain has **no durable lifetime**: the
   Setup Timer and the setup-session registry live only in process memory
   and are wiped by `SERVER_SHUTDOWN → _reset()`; `SetupSessionLifecycle`
   has no recovery/restore/re-arm path (`SetupSession` has no `fromRecord`).
   The archive's classification fallback signature proves the dispatch never
   happened for XSDd — i.e. the process lost that in-memory state before
   `expiresAt` (restart/crash-respawn being the only code-supported
   mechanism; `_onExpiry`'s own guards cannot silently swallow an ARCHIVED
   session that is still registered). After the state loss, the room became
   teardown-only: the eventual destroyer (empty-room-after-disconnects or
   shutdown) has **no refund decision whatsoever**, so the FULLY_PAID funds
   were stranded in the Room Wallet with `recoveryMetadata=null`.

The refund machinery itself (`failSession` →
`_requestRoomWalletPartialPaymentRefund` → `RoomWalletSettlementAdapter`) is
**not** the defect: it was never reached, as F2 proves.

## 9. Why The Existing Focused Unit Test Passed Despite The Real Incident

`setupExpiryRoomWalletRefund.test.js` (cases A–F) is a faithful test of the
**decision and machinery**, and it honestly passes — but it structurally
cannot reproduce this incident:

| Test assumption | Production reality (XSDd) |
|---|---|
| `_onExpiry(roomId)` invoked by the test (295–299) | The real timer/registry state was gone; the callback never fired at all |
| Setup session present (seeded via `archiveForPayment`, 278–287) | Setup registry wiped / never restored after state loss |
| PaymentSession present in `_sessionsByRoom` (seeded, 311–314 / 445–448) | Pre-fix restore Gate 1 skipped the FULLY_PAID session → `getSession()` null for every later trigger |
| Single process, no restart, no time gap | State loss between payment completion and `expiresAt` is the core of the incident |
| `_closeRoom` stubbed (219–223) | Production close drives the archive classification and has no refund decision on unhinted paths |
| Settlement adapter stubbed with the router's interface | Not implicated — refund never started (F2) |

The same applies to `creatorLeftRoomWalletRefund.test.js` (same seeding
pattern, same single-process lifetime assumptions). Both suites validate the
post-fix decision logic (`sessionHasUnrefundedPaidFunds`,
`refundableFullyPaidBeforeGameInit`, deferred close) — which is correct —
but the incident died **upstream** of every line they exercise.

Supporting negative evidence: had the production room executed even the
**pre-fix** expiry path, the session-history record would read
`SETUP_EXPIRED`/`TIMEOUT`/`reason: setup_expired` (pipeline proven by the
2026-08-28 Smsp/wMCC records). It does not. The tests therefore cover a path
the production room never entered.

## 10. Minimal Affected Module(s)

- `server/gameplay/SetupSessionLifecycle.js` — the only module where the
  confirmed divergence lives: memory-only expiry scheduling/registry, no
  restore/re-arm after state loss (`SERVER_SHUTDOWN → _reset()`;
  `SetupSession` has no `fromRecord`). Any future fix belongs here (or in
  the recovery domain owning room restore), reusing existing owners.
- Historical owners of the pre-fix defects (already fixed on this branch,
  listed for traceability — **no further change required**):
  - `server/gameplay/GameStartAuthorization.js` (Page5 blocker;
    fixed in `4b9db36`),
  - `server/socket/RoomLobbyBridge.js`
    (`_handleSetupSessionExpired` decision; fixed in `4b9db36`),
  - `server/gameplay/PaymentSessionManager.js` (`failSession` FULLY_PAID
    passthrough in `4b9db36`; restore Gates 1/2 fixed on this branch,
    covered by `restoreRoomWalletRefund.test.js`),
  - `server/history/SessionHistoryArchiveManager.js` — evidence-only
    contributor: the `reason: room_destroyed` fallback made the archived
    record classify a lost-expiry teardown as `ROOM_DESTROYED/UNKNOWN`
    (classification ambiguity, not a funds defect).

## 11. Page5 Failure And Refund Failure — Same Defect Or Two?

**Two separate defects, with one shared precondition.**

- **Defect A — Page5 not reached** (start-authorization domain): the
  pre-fix `ReferenceError: contract is not defined` in
  `GameStartAuthorization._checkStartConditions()` swallowed
  `GAME_START_AUTHORIZED` after `PAYMENT_SESSION_COMPLETED`. Owner:
  `GameStartAuthorization.js`. Fixed in `4b9db36`; covered by
  `gameStartAuthorization.test.js`.
- **Defect B — refund never happened** (setup-lifecycle + restore domain):
  the loss of the memory-only expiry-dispatch state combined with the
  pre-fix restore Gate-1 skip and escrow-era decision semantics. Owners:
  `SetupSessionLifecycle.js` (still-open architectural gap),
  `PaymentSessionManager.restorePaymentSessions` (fixed on this branch),
  `RoomLobbyBridge` decisions (fixed in `4b9db36`/`01a9a9f`).
- Shared precondition only: the room stayed pre-`GAME_INITIALIZED` until
  teardown. Defect A alone never strands funds (a working expiry or restore
  path still refunds); Defect B alone strands funds regardless of whether
  Page5 works. They have different owners, different fixes, and different
  residual risks — they must not be conflated into one fix.

## 12. Lifecycle Flow (evidence-annotated)

```
ROOM_FULL → setup COMPLETED → PAYMENT_STAGE_READY
  → archiveForPayment: state=ARCHIVED, timer re-armed (same expiresAt)
  → 3 × Room Wallet payment ACCEPTED/confirmed
  → FULLY_PAID + PAYMENT_SESSION_COMPLETED
  → [Defect A, pre-fix] GameStartAuthorization throws → no GAME_INITIALIZED, no Page5
  ... state loss of in-memory setup timer/registry (restart/crash-respawn; no restore path) ...
  → expiresAt elapses: NO SETUP_SESSION_EXPIRED dispatch   (F3, F4 — proven)
  → PaymentSession not in memory (pre-fix restore Gate 1 skip) → nothing can refund
  → players stranded on Page4 → disconnects / shutdown
  → unhinted teardown (empty-room / shutdown destroy)      (record fallback signature)
  → ROOM_DESTROYED → record: ROOM_DESTROYED / UNKNOWN / reason room_destroyed / PAYMENT
  → durable PaymentSession frozen: FULLY_PAID, refunded=false ×3, recoveryMetadata=null
```

## 13. Ownership Boundaries (respected by this analysis)

- Room lifecycle/destroy: `RoomManager` (+ bridge teardown helpers).
- Setup Timer/expiry: `SetupSessionLifecycle` (sole owner of
  `SETUP_SESSION_EXPIRED` emission).
- Payment state/refunds: `PaymentSessionManager` (sole owner of
  `failSession` and the Room Wallet unwind chain).
- Failure classification: `SessionHistoryArchiveManager` (observe-only).
- No parallel systems were created and none are proposed; any future fix must
  reuse these owners (see Risks/Recommendations).

## 14. Hypotheses Ranking (by direct evidence)

1. **CONFIRMED (direct archive + code evidence):** the expiry dispatch never
   executed for XSDd (F3 flag/hint absence; F4 live ARCHIVED snapshot at
   destroy); the refund never started (F2 `recoveryMetadata=null`);
   destruction came from an unhinted teardown path (fallback record
   signature). The deployed build was the pre-fix baseline (git timeline).
2. **Strongly supported mechanism for the lost dispatch (indirect):** process
   restart/crash-respawn between `FULLY_PAID` and `expiresAt` — the only
   code-supported way to lose a still-registered ARCHIVED session's timer
   (`SERVER_SHUTDOWN → _reset()`; no restore path). Verification data exists
   in the uploaded archive (`durationMs`, `timeline[]`) and host logs —
   check for a duration far exceeding the 5-minute setup window, a timeline
   gap, and a restart at ~2026-09-26 19:13Z.
3. **Not supported:** "the refund logic is broken" — the refund chain was
   never entered (F2); the focused tests plus the Smsp/wMCC records show the
   decision logic and the classification pipeline behave as coded.
4. **Not supported:** `sessionNeedsEscrowUnwind` mis-decision as the executed
   cause — real on the pre-fix baseline, but any expiry-path execution would
   have left the `setup_expired` hint/flag; XSDd's record has neither.
5. **Residual unknowns (documented, no code action):** the exact deployed
   build's record plumbing for the SetupSession snapshot (F4 relies on the
   current tree's abort-before-emit ordering; the pre-fix mirror shows the
   same `_onExpiry` ordering, but the deployed snapshot source could not be
   byte-verified from this workspace).

## 15. Risks

- **High — residual architectural gap (current tree):** Setup Timer/expiry
  remains memory-only with no restore. The funds-safety net for a
  restart-after-FULLY_PAID is now the restore path (refund re-request,
  `restoreRoomWalletRefund.test.js`) — but note its third Gate-2 conjunct:
  a restored FULLY_PAID session whose room still exists AND whose
  `paymentDeadline` is still in the future is NOT refunded immediately; it
  waits for deadline/creator-left/next boot. Funds stay recoverable, but the
  room can linger until player action. A restored partial-paid room has NO
  setup wall-clock anymore at all (timer never re-armed).
- **Medium — classification ambiguity:** any unhinted teardown is recorded
  as `ROOM_DESTROYED/UNKNOWN/room_destroyed`, which hid the true mechanism
  of this incident and will hide the next one (the empty-room and shutdown
  destroyers set `RoomDestroyForensics` context but no session-history
  terminal hint).
- **Low — deployment verification:** if the fixes `4b9db36`/`01a9a9f` are not
  yet on the Testnet host, the same Page5 + no-refund failure recurs for
  every full-payment room regardless of code correctness in this branch.

## 16. Recommendations (analysis only — not implemented)

1. Verify the restart hypothesis against the uploaded archive's `durationMs`
   and `timeline[]` plus host process logs (~2026-09-26 19:13Z).
2. Confirm the Testnet host runs ≥ `01a9a9f` before any new Testnet round.
3. If setup-expiry semantics must survive restarts, the minimal controlled
   change is in `SetupSessionLifecycle` (restore/re-arm from the durable
   room-recovery record, or delegate pre-init teardown authority to the
   already-restoring `PaymentSessionManager` path) — requires an
   architecture review per `.clinerules` before implementation.
4. Optional hardening (separate task): let the ROOM_DESTROYED finalize in
   `SessionHistoryArchiveManager` prefer `consumeRoomDestroyContext(roomId)`
   so `empty_room`/`server_shutdown` destroys are classified honestly
   instead of falling back to `room_destroyed/UNKNOWN`.
5. Add a regression test that models the incident: FULLY_PAID +
   `SERVER_SHUTDOWN` + fresh boot + `restorePaymentSessions()` + players
   gone → refunds re-requested and room closed (extends
   `restoreRoomWalletRefund.test.js`).

## 17. Changes Made

- Created this report only:
  `AI_CONTEXT/CLINE_REPORTS/2026-09-27_xsdd_live_setup_expiry_refund_forensic.md`.
- **No source files modified. No tests modified. Nothing deleted. Nothing
  refactored. Nothing committed or pushed.**







