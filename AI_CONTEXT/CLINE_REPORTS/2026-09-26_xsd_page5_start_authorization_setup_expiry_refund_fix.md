# XSDd Page5 Start-Authorization Failure, Setup-Expiry Refunds, Disconnect ReferenceError

Date: 2026-09-26

Task: Fix the Testnet room **XSDd** failure (all three players paid, PaymentSession
reached `FULLY_PAID`, game never reached Page5), fix setup-expiry refund semantics
for 1/3, 2/3 and 3/3 paid sessions, and fix the confirmed
`ReferenceError: contract is not defined` in `RoomLobbyBridge._handleSocketDisconnected()`.
Current baseline only; no old commits restored; no smart-contract payments introduced.

---

## 1. Scope

- `server/gameplay/GameStartAuthorization.js` — game-start authorization gate.
- `server/gameplay/PaymentSessionManager.js` — `failSession` refund orchestration.
- `server/gameplay/PaymentSessionStates.js` — payment session lifecycle transitions.
- `server/gameplay/partialPaymentEscrowUnwind.js` — refund decision helpers.
- `server/socket/RoomLobbyBridge.js` — setup-expiry decision + disconnect diagnostics.
- Related tests and the broader focused server suites.

## 2. Files Inspected

- `AI_CONTEXT/WHEELWIN_MASTER_CONTEXT.md`, `ARCHITECTURE_RULES.md`, `CURRENT_STATE.md`,
  `AI_WORKING_RULES.md`, `CLINE_REPORTS/CURRENT_TESTNET_PAYMENT_INTERFACE_MAP.md`,
  `CLINE_REPORTS/2026-09-20_page4_room_wallet_rebuild.md`.
- `server/gameplay/GameStartAuthorization.js` (full)
- `server/gameplay/PaymentSessionManager.js` (`failSession`, `_requestRoomWalletPartialPaymentRefund`,
  `_finalizePartialPaymentUnwind`, `_onExpiry`, restore path)
- `server/gameplay/PaymentSessionStates.js`, `server/models/PaymentSession.js`
- `server/gameplay/partialPaymentEscrowUnwind.js`, `server/gameplay/GameContractManager.js`
- `server/gameplay/SetupSessionLifecycle.js` (`_onExpiry`, `isGameplayOwnershipReleased`)
- `server/socket/RoomLobbyBridge.js` (`_handleSetupSessionExpired`, `_handleSocketDisconnected`,
  `_handlePaymentSessionFailed`, `_removePlayerFromLobby`)
- `server/events/EventBus.js`, `server/events/EventDispatcher.js`
- Tests: `gameStartAuthorization.test.js`, `setupExpiryEscrowUnwind.test.js`,
  `partialPaymentEscrowUnwind.test.js`, `setupSession.reconnect.test.js`,
  `roomWalletGameReadiness.test.js`, `paymentSession.manager.test.js`

## 3. Architecture Findings

### 3.1 Root cause of the XSDd Page5 failure

`GameStartAuthorization._checkStartConditions()` ended its success path with:

```js
return {
    ok: true,
    room,
    session,
    contract,                       // ← undeclared identifier
    gameId,
    blockchainCompletedAt: session.completedAt
        ?? contract?.paymentsCompletedAt   // ← second obsolete reference
        ?? Date.now()
};
```

`contract` is a leftover from the abandoned GameEscrow authorization path; the
current method never declares it. When XSDd reached `PAYMENT_SESSION_COMPLETED`
(all three Room Wallet payments confirmed), `_evaluate` → `_checkStartConditions`
reached the success `return` and threw `ReferenceError: contract is not defined`.
`EventDispatcher` catches subscriber exceptions (logs and continues), so other
subscribers were unaffected — but `GAME_START_AUTHORIZED` was never emitted, hence
no `GAME_INITIALIZING`, no bootstrap, no `OPEN_PAGE5`, and Page4 never handed over
to Page5. This exact failure is reproduced by the previous
`gameStartAuthorization.test.js` happy path, which failed on the current baseline
with `actual: []`.

### 3.2 Second confirmed defect — undeclared `needsEscrowUnwind` in `failSession()`

`PaymentSessionManager.failSession()` contained `if (needsEscrowUnwind) {` at the
legacy escrow branch, but the variable was never declared (the declaration was lost
when the Room Wallet refund branch was inserted). Every `failSession` call that did
not route into the Room Wallet refund branch (zero-paid sessions, non-intake mode)
threw `ReferenceError: needsEscrowUnwind is not defined` — confirmed by
`partialPaymentEscrowUnwind.test.js` failing on the current baseline.

### 3.3 Third confirmed defect — disconnect handler

`RoomLobbyBridge._handleSocketDisconnected()` built its diagnostic `console.log`
object with `DeployState: contract ? {...} : null`, where `contract` was never
declared. Because the diagnostic block runs before the unknown-socket guard,
**every** socket disconnect threw `ReferenceError: contract is not defined`.

### 3.4 Fourth defect — setup-expiry refund decision used escrow-era semantics

`_handleSetupSessionExpired()` gated `failSession("setup_expired")` on
`sessionNeedsEscrowUnwind(paymentSession)`. That helper (escrow-era semantics)
returns `false` whenever `session.allConfirmed()` is true, so a **FULLY_PAID**
session was treated as "nothing to unwind" and the room was closed directly,
leaving all three confirmed Room Wallet payments unrecovered. Additionally,
`failSession` aborted on any terminal status, and the lifecycle state machine
allowed `FULLY_PAID → CANCELLED` only, so the existing Room Wallet refund
machinery (`_requestRoomWalletPartialPaymentRefund`, which uses
`markRefundPending()` → `REFUND_PENDING` → `CANCELLED`) could not process a
fully paid session at all.

## 4. Files Changed (implementation)

| File | Change |
|---|---|
| `server/gameplay/GameStartAuthorization.js` | `_checkStartConditions()` success return: removed the obsolete `contract` field and `contract?.paymentsCompletedAt` fallback; success now carries `blockchainCompletedAt: session.completedAt ?? Date.now()`. One stale comment updated. |
| `server/gameplay/partialPaymentEscrowUnwind.js` | Added `sessionHasUnrefundedPaidFunds(session)` — authoritative Room Wallet paid-funds check (true when any participant is `PAYMENT_CONFIRMED` or has `paidAmount > 0` and is not yet refunded). No existing function modified. |
| `server/gameplay/PaymentSessionStates.js` | Additive only: `FULLY_PAID` now also allows `REFUND_PENDING` (alongside the existing `FULLY_PAID → CANCELLED`). Terminal/in-progress sets and all other transitions unchanged. |
| `server/gameplay/PaymentSessionManager.js` | `failSession()` only: (1) `refundableFullyPaidSetupExpiry` — strictly `reason === "setup_expired"` AND status `FULLY_PAID` AND Room Wallet refund available AND unrefunded paid funds — bypasses the terminal abort; (2) `markTimedOut`/`markFailed` skipped for `FULLY_PAID` (no legal transition); (3) `needsRoomWalletRefund` extended with the fully-paid setup-expiry case (partial-paid gate unchanged); (4) **declared the previously undeclared `needsEscrowUnwind`** — legacy escrow branch now restricted to non-intake mode with a `requestPartialPaymentEscrowUnwind` capability check; (5) new helper import. |
| `server/socket/RoomLobbyBridge.js` | `_handleSetupSessionExpired()`: decision now `sessionHasUnrefundedPaidFunds(paymentSession) && isRoomWalletPaymentIntakeEnabled()` instead of `sessionNeedsEscrowUnwind` (which treats `FULLY_PAID` as "no unwind"); diagnostic log updated. `_handleSocketDisconnected()`: removed the undeclared `contract` diagnostic; the disconnect log now reports `RoomWallet: paymentSession?.roomWalletAddress` next to the PaymentSession id/status. |
| `server/tests/gameStartAuthorization.test.js` | Rewritten for the current Room-Wallet-only GSA: harness matches the current constructor (no `depositSessionCoordinator` / `gameEscrowMode` / `gameContractManager` stub), Room Wallet ledger registry default; cases A–E below. |
| `server/tests/setupExpiryRoomWalletRefund.test.js` | New; replaces the escrow-era `setupExpiryEscrowUnwind.test.js` (stale: asserted the pre-R18-S72 bridge behavior and could not pass on the current architecture). Room Wallet intake stack with a stubbed settlement adapter (same interface the production router exposes). Cases A–F below. |

No other files were modified. `GameContractManager`, `ContractSettlementManager`
and all historical contract evidence were left untouched.

## 5. Lifecycle Flow (after fix)

```
FULLY_PAID Room Wallet session
  → PAYMENT_SESSION_COMPLETED
  → GameStartAuthorization._evaluate
  → _checkStartConditions: room exists · session COMPLETED/FULLY_PAID ·
    allConfirmed · participants == 3 · Room Wallet ledger complete ·
    game/bootstrap state · no recovery pending      ← no `contract` reference
  → GAME_START_AUTHORIZED → GAME_INITIALIZING → bootstrap validation
  → GAME_START_BOOTSTRAP_READY → existing OPEN_PAGE5 / GAME_INITIALIZED flow
```

```
Setup expiry BEFORE GAME_INITIALIZED (Room Wallet intake enabled):
  SETUP_SESSION_EXPIRED → RoomLobbyBridge._handleSetupSessionExpired
  → sessionHasUnrefundedPaidFunds(session) && intake enabled?
      ├─ NO  → _closeRoom("setup_expired")                       (unchanged)
      └─ YES → failSession("setup_expired")
                → FULLY_PAID-only refundable passthrough (no illegal mark*)
                → _requestRoomWalletPartialPaymentRefund (EXISTING machinery)
                → REFUND_PENDING (synchronously; lifecycle defers room destroy)
                → RoomWalletSettlementAdapter.refundPayments (existing adapter;
                  gas from Room Wallet residual funds, configured margin kept)
                → participants refunded → _finalizePartialPaymentUnwind
                → CANCELLED → PAYMENT_SESSION_FAILED → room close
  After GAME_INITIALIZED: isGameplayOwnershipReleased → handler returns early;
  no refund; winner settlement / recovery ownership untouched.
```

Idempotency: already-refunded participants are excluded (`refunded` flags +
`pendingRefunds` filter); a repeated expiry after finalize closes the room without
a second refund. Refund failure keeps the session `REFUND_PENDING` and the room
preserved for recovery (existing behavior of the refund machinery).

## 6. Ownership Boundaries Preserved

- `PaymentSession` remains the authoritative payment-completion source; the
  Room Wallet ledger/intake gate in `GameStartAuthorization` is intact and
  unconditional. No contract / blockchain state was introduced into the start
  gate; no new authorization system was invented.
- Refunds run exclusively through the existing
  `PaymentSessionManager._requestRoomWalletPartialPaymentRefund` →
  `RoomWalletSettlementAdapter.refundPayments` path. No second refund engine, no
  escrow reintroduction.
- The `PaymentSessionStates` change is additive (one extra allowed transition
  from `FULLY_PAID`). `TERMINAL_PAYMENT_SESSION_STATUSES`, `isInProgress` and all
  other transitions are unchanged; `payment_timeout` can never fire on a
  `FULLY_PAID` session (`_onExpiry` requires `isInProgress()`), and the new
  passthrough is restricted to `reason === "setup_expired"`.
- The EventDispatcher already isolates subscriber exceptions; no error-masking
  try/catch was added.

## 7. Remaining GameEscrow / DepositContract / DepositPackage References

Classified per the task's source-search requirement. None were removed in this
task beyond the two dead bare-`contract` references.

**Active and required (kept):**
- `GameContractManager` subscription to `PAYMENT_SESSION_COMPLETED`
  (`_handlePaymentSessionCompleted` → `markPaymentsComplete`): maintains contract
  evidence records used by current settlement/recovery/evidence code. It no
  longer participates in game start (GSA does not subscribe
  `GAME_CONTRACT_PAYMENTS_COMPLETE`), but it does not block the Room Wallet flow.

**Legacy but still used for evidence/settlement (kept intact):**
- `PaymentSessionManager`: `syncFromGameEscrow`, `_syncCancelFromGameEscrow`,
  `_applyGameEscrowConfirmed`, `_handleGameEscrowRefundConfirmed`,
  `_handleGameEscrowCancelConfirmed` — chain-evidence / escrow-era recovery
  paths, gated off in Room Wallet intake mode; not on the active player-payment
  path.
- `partialPaymentEscrowUnwind.js` helpers (`sessionNeedsEscrowUnwind`,
  `buildPartialPaymentRefundTargets`, `allConfirmedParticipantsRefunded`,
  `countConfirmedParticipants`) — used by the restore path, the legacy
  non-intake escrow branch of `failSession`, and the legacy creator-left
  decision point in `RoomLobbyBridge` (~line 3723).
- `PaymentParticipant.contractAddress` legacy field — documented as never
  populated on the Room Wallet path.
- `RoomLobbyBridge._deliverDepositPackagePublished` plumbing (~916/934/943/6981/7071)
  — legacy event delivery for an event the current client never triggers.

**Dead/obsolete in the active flow (removed by this task):**
- Bare `contract` identifier in `GameStartAuthorization._checkStartConditions()`
  (XSDd root cause) and in `RoomLobbyBridge._handleSocketDisconnected()`.
- The `sessionNeedsEscrowUnwind` decision point in `_handleSetupSessionExpired`
  (replaced by the Room Wallet paid-funds check).
- The undeclared `needsEscrowUnwind` in `failSession` — now explicitly declared
  and restricted to non-intake mode (repairs the legacy escrow branch; verified by
  the now-passing `partialPaymentEscrowUnwind.test.js`).

## 8. Tests Executed and Results

Focused suites (each executed with `node server/tests/<file>`):

| Test | Before this task | After |
|---|---|---|
| `gameStartAuthorization.test.js` | FAIL — happy path got `[]` (the XSDd `contract` ReferenceError); harness stale vs current GSA | **PASS** (A full payment → authorize; B incomplete ledger blocks; C missing registry blocks; D incomplete session blocks; E recovery blocks; audit + idempotency) |
| `partialPaymentEscrowUnwind.test.js` | FAIL — `ReferenceError: needsEscrowUnwind is not defined` at `failSession` | **PASS** (all 5 legacy escrow-unwind cases repaired by the declaration fix) |
| `setupExpiryEscrowUnwind.test.js` | FAIL (stale escrow-era harness; bridge is intake-gated since R18-S72) | Removed — superseded by `setupExpiryRoomWalletRefund.test.js` |
| `setupExpiryRoomWalletRefund.test.js` (new) | — | **PASS** — A: 2/3 paid refunds + deferred close; B: 0/3 paid plain close; C: 1/3 paid single refund; D: 3/3 FULLY_PAID all refunded + idempotent; E: refund failure → room preserved in REFUND_PENDING; F: after GAME_INITIALIZED no refund |
| `socketDisconnect.roomWalletDiagnostics.test.js` (new) | (would throw `ReferenceError: contract is not defined` on every disconnect) | **PASS** — unknown-socket and bound-player disconnect with payment state; no ReferenceError |
| `paymentSession.model.test.js` | PASS | **PASS** (state-machine addition breaks no model assertion) |
| `setupSession.lifecycle.test.js`, `setupSession.reconnect.test.js`, `setupSession.paymentExpiry.r770c23.test.js`, `socketAuthority.commit.test.js`, `sessionRebind.integration.test.js`, `identityRecovery.r131e.test.js`, `entryPaymentSession.test.js` | PASS on baseline | **PASS** (no regression) |
| `roomWalletFinancialPolicy.test.js`, `gameplayBootstrap.integration.test.js`, `secretMatrix.status.test.js` | PASS on baseline | **PASS** |
| `paymentSession.manager.test.js` | FAIL on baseline | FAIL identically — **pre-existing**, verified by stash/unstash attribution |
| `roomWalletGameReadiness.test.js`, `roomWalletOnlyPlayerPayment.r18s72.test.js`, `roomWalletSettlementAdapter.test.js`, `roomWalletSettlementRouter.test.js`, `roomWalletAppComposition.test.js`, `roomWalletIncomingObserver.test.js` | FAIL on baseline | FAIL identically — **pre-existing** (attribution verified via stash/unstash; stale legacy-mode/integration harnesses predating the Room-Wallet-only migration) |

Per the task rules, the pre-existing failures were attributed (not papered over)
and left untouched; no tests were disabled and no assertions were weakened.

## 9. Remaining Risks

- **Medium — pre-existing failing suites.** `paymentSession.manager.test.js` and
  the six Room Wallet integration suites fail on the current baseline
  (attribution verified). They assert pre-R18-S72 legacy-mode behavior; repairing
  them is a separate task and was deliberately not mixed into this financial fix.
- **Medium — creator-left decision point.**
  `RoomLobbyBridge._removePlayerFromLobby` (creator-left branch, ~line 3723) still
  gates `failSession` on `sessionNeedsEscrowUnwind`, so a FULLY_PAID session on
  creator leave still closes via `_closeRoom` without refund. Out of this task's
  setup-expiry scope; recommended follow-up: reuse
  `sessionHasUnrefundedPaidFunds` there.
- **Medium — restore-path refund gap.** The `PaymentSessionManager` restore path
  (~line 806) still uses `sessionNeedsEscrowUnwind`; a server restart between
  `FULLY_PAID` and refund finalization skips the automatic refund re-request for
  fully-paid sessions (terminal records are skipped at restore). The existing
  residual-sweep machinery may recover such funds; a follow-up should extend the
  restore gate with an explicit before-`GAME_INITIALIZED` paid-funds check.
- **Low — `FULLY_PAID → REFUND_PENDING` transition.** Additive; the only code
  path that performs it is the setup-expiry refund flow (reason-gated in
  `failSession`). `payment_timeout` cannot reach a `FULLY_PAID` session
  (`_onExpiry` requires `isInProgress()`).
- **Low — diagnostic noise.** Pre-existing `console.log` / `console.trace`
  diagnostic blocks in the bridge/lifecycle remain (untouched scope).

## 10. Changes Made

- `server/gameplay/GameStartAuthorization.js` — `_checkStartConditions()` success
  return fixed (obsolete `contract` removed); one comment updated.
- `server/gameplay/partialPaymentEscrowUnwind.js` — added
  `sessionHasUnrefundedPaidFunds`.
- `server/gameplay/PaymentSessionStates.js` — additive `FULLY_PAID → REFUND_PENDING`.
- `server/gameplay/PaymentSessionManager.js` — `failSession()` refund passthrough,
  mark-skip for `FULLY_PAID`, `needsEscrowUnwind` declaration, new helper import.
- `server/socket/RoomLobbyBridge.js` — `_handleSetupSessionExpired` decision +
  log; `_handleSocketDisconnected` diagnostic fixed.
- `server/tests/gameStartAuthorization.test.js` (rewritten),
  `server/tests/setupExpiryRoomWalletRefund.test.js` (new),
  `server/tests/socketDisconnect.roomWalletDiagnostics.test.js` (new),
  `server/tests/setupExpiryEscrowUnwind.test.js` (removed, superseded).
- This report. Git commit on `payment/room-wallet-integration` after validation.



