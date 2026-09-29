# PaymentSessionManager Restore Path — Room Wallet Refund Re-Request Gap (Analysis Only)

Date: 2026-09-27

Task: Analyze ONLY the server-restart recovery gap for a Room Wallet refund:
does the `PaymentSessionManager` restore path re-request a refund for a
FULLY_PAID session that entered the pre-GAME_INITIALIZED refund flow before
the restart but did not finish it? No source code modified.

Verdict up front: **RISK CONFIRMED — and it is two barriers, not one.**
A persisted FULLY_PAID (3/3 confirmed) session is skipped by the restore
terminal filter before the refund condition is even evaluated; and if it were
evaluated, the escrow-era `sessionNeedsEscrowUnwind()` still returns `false`
for an all-confirmed session. The same second barrier strands a persisted
REFUND_PENDING mid-unwind session (refund broadcast, crash before finalize).

---

## 1. Scope

- `server/gameplay/PaymentSessionManager.js` — `restorePaymentSessions()`,
  `_finishPaymentSessionRestore()`, `failSession()`,
  `_requestRoomWalletPartialPaymentRefund()`, `_finalizePartialPaymentUnwind()`,
  `_persistSession()`.
- `server/gameplay/partialPaymentEscrowUnwind.js` — decision helpers.
- `server/gameplay/PaymentSessionStates.js` — lifecycle transitions/terminal set.
- `server/models/PaymentSession.js` — `fromRecord()` / `toPayload()` /
  participant persistence (`refunded`, `paidAmount`, `recoveryMetadata`).
- `server/payment/roomWallet/RoomWalletSettlementAdapter.js` — `refundPayments()`
  idempotency (`_findExistingRefund`).
- `server/recovery/TonFinancialRecovery.js` — `recoverPayments()` restore entry.
- Smallest relevant restore tests (see §7).

## 2. Files Inspected

- `AI_CONTEXT/WHEELWIN_MASTER_CONTEXT.md`, `ARCHITECTURE_RULES.md`,
  `CURRENT_STATE.md`, `AI_WORKING_RULES.md`.
- `AI_CONTEXT/CLINE_REPORTS/2026-09-27_creator_left_room_wallet_refund_fix.md`
  (source of the known-remaining-risk statement under analysis).
- Source files listed in §1, read verbatim (line numbers below refer to the
  current working tree on `payment/room-wallet-integration`).
- Tests: `server/tests/paymentSession.manager.test.js`,
  `server/tests/financialPersistence.wiring.r810.test.js`,
  `server/tests/creatorLeftRoomWalletRefund.test.js`,
  `server/tests/setupExpiryRoomWalletRefund.test.js`,
  `server/tests/partialPaymentEscrowUnwind.test.js`.

## 3. Architecture Findings

### 3.1 Exact restore path

`TonFinancialRecovery.recoverPayments()` (line 554) →
`PaymentSessionManager.restorePaymentSessions()` (line 716) →
`listActive(PAYMENT_SESSION)` records → `PaymentSession.fromRecord(record)` →
per-record gates → `_finishPaymentSessionRestore()` (watches / chain sync).

### 3.2 Exact current conditions (two gates)

Gate 1 — terminal skip, `restorePaymentSessions()` lines 755–762:

```js
// R7.69C — restore CANCELLED sessions for refund sync / watch recovery.
const isCancelled = session.status === PAYMENT_SESSION_STATUS.CANCELLED;

if (session.isTerminal() && !isCancelled) {

    continue;
}
```

`isTerminal()` is true for FULLY_PAID (`TERMINAL_PAYMENT_SESSION_STATUSES`,
`PaymentSessionStates.js` lines 67–72). A persisted FULLY_PAID session never
re-enters `_sessionsByRoom`: not re-indexed, not visible to `getSession()`,
and the refund condition below is never reached for it.

Gate 2 — refund re-request condition, lines 805–823 (the condition named in
the previous report's known risk):

```js
if (
    this._roomWalletPaymentIntakeEnabled
    && sessionNeedsEscrowUnwind(session)
    && (
        session.status === PAYMENT_SESSION_STATUS.REFUND_PENDING
        || Number(session.paymentDeadline ?? 0) <= Date.now()
        || !this._roomManager?.getRoom?.(session.roomId)
    )
) {
    void this._requestRoomWalletPartialPaymentRefund(
        session,
        session.recoveryMetadata?.unwindReason ?? "room_destroyed"
    ).catch((error) => { ... });
}
```

The decision conjunct is `sessionNeedsEscrowUnwind(session)`
(`partialPaymentEscrowUnwind.js` lines 7–27): returns `false` when
`session.allConfirmed()` is true, i.e. for any 3/3-confirmed session —
regardless of `refunded` flags. This is the escrow-era semantics; the Room
Wallet-era helper `sessionHasUnrefundedPaidFunds()` (lines 39–62) exists
exactly to cover this case and is already used by the fixed setup-expiry and
creator-left live paths.

### 3.3 Ordering facts that shape the crash windows

`_requestRoomWalletPartialPaymentRefund()` (line 1939) persists BEFORE
broadcasting: it filters `participant?.refunded !== true`, writes
`recoveryMetadata.unwindReason` / `refundRequestedAt`, calls
`session.markRefundPending()` (FULLY_PAID → REFUND_PENDING transition is
legal since R18.XSDd, `PaymentSessionStates.js` lines 45–52), persists
(line 1978), and only then calls
`RoomWalletSettlementAdapter.refundPayments()` (line 2002). Therefore the
persisted status is FULLY_PAID only in the window before the first refund
request persists; once unwinding starts, the persisted status is
REFUND_PENDING. `_finalizePartialPaymentUnwind()` (line 1440) requires status
REFUND_PENDING → `markCancelled()` → persists → emits
`PAYMENT_SESSION_FAILED` (room close trigger).

## 4. Lifecycle Flow (crash windows)

1. **Window A (pre-unwind).** Crash after `failSession()` decided a refund but
   before `_requestRoomWalletPartialPaymentRefund` persists: persisted record
   is FULLY_PAID, all `refunded=false`. Restart → Gate 1 `continue` → session
   not restored, no refund re-request. **Funds stranded; session invisible.**
   (Gate 2 would also have refused: `sessionNeedsEscrowUnwind` = false.)
2. **Window B (mid-unwind).** Crash after the REFUND_PENDING persist but
   before all refunds confirm/finalize (some may already be broadcast):
   REFUND_PENDING is in-progress, so Gate 1 passes and the session is
   restored — but Gate 2 fails because `sessionNeedsEscrowUnwind()` is false
   for an all-confirmed session. **No retry for unrefunded seats, no
   adoption of in-flight refunds, no `_finalizePartialPaymentUnwind`, no
   `PAYMENT_SESSION_FAILED` → session stuck REFUND_PENDING forever.**
3. **Partially-paid sessions (1–2/3).** Restored and correctly re-requested
   today: Gate 2 passes (`confirmedCount > 0`, not all confirmed; status
   REFUND_PENDING), already-refunded seats filtered, all-refunded → finalize.
   No gap for this class.

## 5. Ownership Boundaries

- The restore path and refund orchestration are both owned by
  `PaymentSessionManager` — the fix location is inside the existing owner.
  No ownership move, no parallel recovery flow.
- `sessionNeedsEscrowUnwind` must remain for the legacy non-intake
  `failSession` escrow branch (lines 2134–2137) — not deleted, not changed.
- Client/bridge untouched: `RoomLobbyBridge`, `GameStartAuthorization`, Page5
  are out of this gap entirely; the restore path never consults them.
- Financial truth stays authoritative: persisted record + on-chain history
  (`_findExistingRefund`); nothing is invented at restore time.

## 6. Risks

- **High — Window A (persisted FULLY_PAID skipped at Gate 1):** after a
  restart, a 3/3-paid pre-GAME_INITIALIZED session is invisible and its Room
  Wallet funds are stranded with no retry path. Confirms the previous
  report's known risk, with the terminal skip as the earlier, harder barrier.
- **High — Window B (persisted REFUND_PENDING, all-confirmed, skipped at
  Gate 2):** mid-unwind crash leaves the session permanently REFUND_PENDING:
  unrefunded seats are never retried, in-flight broadcasts never adopted,
  and the unwind never finalizes (no CANCELLED, no `PAYMENT_SESSION_FAILED`).
- **Low — adapter dedup window:** `_findExistingRefund` scans the last 40
  outbound Room Wallet transfers (archival) for same wallet+amount with
  `utime > cutoff` (ms→s normalized via `resolveCutoffUtime`); if
  `getTransactions` is unavailable it degrades to re-broadcast. Pre-existing
  adapter behaviour, unchanged by the proposed fix.
- **Low — reason label:** a restored FULLY_PAID re-request logs reason
  `recoveryMetadata.unwindReason ?? "room_destroyed"`; acceptable for
  decisionTrace/audit, a dedicated reason can be added later without
  behaviour change.

## 7. Recommendations

**Smallest proposed change (implementation deferred; approval required):**
confined to `restorePaymentSessions()` in
`server/gameplay/PaymentSessionManager.js`, two conditions:

1. Gate 1 (line ~758): add an exception mirroring `isCancelled` —
   `refundableRestoredFullyPaid = this._roomWalletPaymentIntakeEnabled
   && session.status === PAYMENT_SESSION_STATUS.FULLY_PAID
   && sessionHasUnrefundedPaidFunds(session)`; skip-terminal condition
   becomes `if (session.isTerminal() && !isCancelled &&
   !refundableRestoredFullyPaid) continue;`.
2. Gate 2 (line ~807): replace `sessionNeedsEscrowUnwind(session)` with
   `sessionHasUnrefundedPaidFunds(session)` (or OR-in the variable from (1) —
   equivalent, since the helper is a strict superset for intake sessions).

Effect: partially-paid restore behaviour is bit-for-bit unchanged
(`sessionHasUnrefundedPaidFunds` agrees with `sessionNeedsEscrowUnwind` for
1–2/3 sessions); FULLY_PAID and mid-unwind REFUND_PENDING sessions newly
re-enter the existing `_requestRoomWalletPartialPaymentRefund` chain, which is
already idempotent (`refunded` filter + `REFUND_ADOPTED` on-chain dedup +
persisted `refundRequestedAt` cutoff) and finalizes to CANCELLED +
`PAYMENT_SESSION_FAILED`. The third Gate-2 conjunct (REFUND_PENDING /
deadline passed / room gone) still prevents re-requesting a refund for a
restored FULLY_PAID session whose room legitimately still exists pre-init
(live setup-expiry / creator-left paths remain authoritative there).

**Reuse answer (Q7):** yes — the entire existing machinery is reused with no
new refund engine: `restorePaymentSessions` →
`_requestRoomWalletPartialPaymentRefund` → `buildPartialPaymentRefundTargets`
→ `RoomWalletSettlementAdapter.refundPayments` → `_finalizePartialPaymentUnwind`
→ `PAYMENT_SESSION_FAILED`. No GameEscrow / DepositContract / DepositPackage
path is restored or introduced; legacy `failSession` escrow branch untouched.

**Idempotency state (Q5):** sufficient today without schema changes —
`toPayload()`/`fromRecord()` round-trip `status`, participants
(`status`, `paidAmount`, `refunded`, `refundTxHash`), `recoveryMetadata`
(`unwindReason`, `refundRequestedAt`), `roomWalletAddress`, `roomNumber`;
combined with the adapter's on-chain dedup this makes the retry safe at
per-participant, per-broadcast, and per-time-window granularity.

**Tests to add/update** (harness pattern of
`creatorLeftRoomWalletRefund.test.js` / `setupExpiryRoomWalletRefund.test.js`:
`roomWalletPaymentIntakeEnabled: true`, fake settlement adapter, real
`TonFinancialPersistence`, restart via second manager):

- New focused suite `server/tests/restoreRoomWalletRefund.test.js`:
  - A: persisted FULLY_PAID (3/3 confirmed, `refunded=false`) → restart →
    `restorePaymentSessions()` → session restored, refund re-requested with 3
    targets, status REFUND_PENDING → after adapter resolves → CANCELLED +
    `PAYMENT_SESSION_FAILED` emitted once.
  - B: persisted REFUND_PENDING mid-unwind with 1/3 `refunded=true` → only
    the 2 unrefunded seats re-requested; a REFUND_ADOPTED result (fake)
    marks the participant refunded and does not re-broadcast.
  - C: persisted REFUND_PENDING with all participants `refunded=true` → no
    broadcast, `ALREADY_REFUNDED` path → `_finalizePartialPaymentUnwind` →
    CANCELLED + `PAYMENT_SESSION_FAILED`.
  - D: persisted partial-paid (1–2/3) REFUND_PENDING → identical behaviour to
    today (regression guard for the helper swap).
  - E: non-intake mode (`roomWalletPaymentIntakeEnabled: false`) → restore
    decision untouched, no refund call (legacy semantics preserved).
- Regression run (no edits expected): `paymentSession.manager.test.js`
  (restore blocks ~715/763/998), `financialPersistence.wiring.r810.test.js`
  (TEST A ~510 and ~793), `creatorLeftRoomWalletRefund.test.js`,
  `setupExpiryRoomWalletRefund.test.js`, `partialPaymentEscrowUnwind.test.js`.

## 8. Changes Made

No files modified (analysis only). This report is the only file created.
Nothing committed or pushed.

