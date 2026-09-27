# Creator-Left-Before-GAME_INITIALIZED Room Wallet Refund Fix

Date: 2026-09-27

Task: Fix the creator-leaves-before-GAME_INITIALIZED refund gap identified in
the 2026-09-26 XSDd report (§9, "Medium — creator-left decision point").
Scope strictly limited to the creator-left decision condition and the existing
`PaymentSessionManager.failSession` Room Wallet refund machinery.

---

## 1. Scope

- `server/socket/RoomLobbyBridge.js` — `_removePlayerFromLobby` creator-left
  decision branch (~line 3723 on the pre-fix baseline).
- `server/gameplay/PaymentSessionManager.js` — `failSession` FULLY_PAID
  terminal-abort exception (reason gate).
- New focused test + this report. Nothing else.

## 2. Files Inspected

- `AI_CONTEXT/WHEELWIN_MASTER_CONTEXT.md`, `ARCHITECTURE_RULES.md`,
  `CURRENT_STATE.md`, `AI_WORKING_RULES.md`.
- `AI_CONTEXT/CLINE_REPORTS/2026-09-26_xsd_page5_start_authorization_setup_expiry_refund_fix.md`
  (source of the known issue and the recommended follow-up).
- `server/socket/RoomLobbyBridge.js` (`_removePlayerFromLobby` creator-left
  branch, `_handleSetupSessionExpired`, `_handlePaymentSessionFailed`,
  `_startedRooms` lifecycle, `_isActiveGameplayProtected`).
- `server/gameplay/PaymentSessionManager.js` (`failSession`,
  `_requestRoomWalletPartialPaymentRefund`, `_finalizePartialPaymentUnwind`,
  `_maybeCompleteSession`).
- `server/gameplay/partialPaymentEscrowUnwind.js`
  (`sessionNeedsEscrowUnwind`, `sessionHasUnrefundedPaidFunds`).
- `server/gameplay/PaymentSessionStates.js` (FULLY_PAID → REFUND_PENDING
  transition, terminal status set).
- `server/tests/setupExpiryRoomWalletRefund.test.js` (harness pattern),
  `server/tests/partialPaymentEscrowUnwind.test.js`,
  `server/tests/socketDisconnect.roomWalletDiagnostics.test.js`,
  `server/tests/gameStartAuthorization.test.js`.

## 3. Architecture Findings (root cause)

The creator-left branch still used the escrow-era decision:

```js
if (paymentSession && sessionNeedsEscrowUnwind(paymentSession)) {
    this._paymentSessionManager.failSession(roomId, "creator_left");
    return;
}
void this._closeRoom(roomId, "creator_left");
```

`sessionNeedsEscrowUnwind` returns `false` when `allConfirmed()` is true, so a
3/3 FULLY_PAID session skipped `failSession` and the room closed via
`_closeRoom` without refunding already-paid Room Wallet funds.

Compounding defect: even if `failSession` were called for a FULLY_PAID
(terminal) session, its terminal-session abort
(`session.isTerminal() && !refundableFullyPaidSetupExpiry`) blocked the refund,
because the exception was reason-gated to `"setup_expired"` only. Therefore the
fix required exactly two coupled conditions:

1. Bridge decision → `sessionHasUnrefundedPaidFunds(paymentSession)` (the
   current Room Wallet paid-funds semantics, same helper the fixed
   setup-expiry path uses).
2. `failSession` FULLY_PAID terminal-abort exception extended to
   `reason === "creator_left"` (variable renamed to
   `refundableFullyPaidBeforeGameInit`). The `setup_expired` evaluation is
   bit-for-bit unchanged — the condition was widened by reason, not altered.

## 4. Files Changed

- `server/socket/RoomLobbyBridge.js` — creator-left branch decision swap
  (+ comment); removed the now-unused `sessionNeedsEscrowUnwind` bridge import.
- `server/gameplay/PaymentSessionManager.js` — `failSession` reason gate
  extended with `creator_left`; comment updated.
- `server/tests/creatorLeftRoomWalletRefund.test.js` — new focused test.
- `AI_CONTEXT/CLINE_REPORTS/2026-09-27_creator_left_room_wallet_refund_fix.md`
  (this report).

`sessionNeedsEscrowUnwind` was NOT deleted globally — it remains exported and
used by `PaymentSessionManager` legacy/non-intake paths (restore path ~line 807
and the legacy escrow-unwind gates in `failSession`).

## 5. Behavior After Fix (creator leaves before GAME_INITIALIZED)

- **0/3 paid** — no player funds received → `sessionHasUnrefundedPaidFunds`
  is false → existing close behavior (`_closeRoom("creator_left")`); no
  refund attempt, no PAYMENT_SESSION_FAILED. Verified also for the no-session
  case.
- **1/3 paid** — `failSession(roomId, "creator_left")` → existing Room Wallet
  refund machinery (`_requestRoomWalletPartialPaymentRefund` →
  `RoomWalletSettlementAdapter.refundPayments`) refunds the single confirmed
  player; session REFUND_PENDING → CANCELLED; room closes only after the
  unwind finalizes via the existing `PAYMENT_SESSION_FAILED` flow.
- **2/3 paid** — same path; both confirmed players refunded.
- **3/3 FULLY_PAID** — previously closed WITHOUT refund (the gap). Now the
  terminal FULLY_PAID session is treated as refundable when Room Wallet
  intake is enabled and unrefunded paid funds exist; all three payments are
  refunded and the close is deferred until the unwind completes. This reuses
  the EXISTING machinery — no new refund implementation.
- Legacy (non-intake) 1–2 paid behavior unchanged — still routes to the
  legacy `GameContractManager` escrow unwind inside `failSession`.
- Normal winner settlement and normal room close untouched.

**After-GAME_INITIALIZED protection (requirement 4):** the creator-left
branch is reached only when `!gameStarted` (setup session not completed), and
the existing active-gameplay guard (`_isActiveGameplayProtected` → soft leave,
R13.1B) remains authoritative upstream. Refund after GAME_INITIALIZED is
impossible through this path; focused test case E verifies no refund, no
close, and that the FULLY_PAID session keeps its settlement ownership.

## 6. Tests Executed and Result

`node server/tests/creatorLeftRoomWalletRefund.test.js` — **PASS** (exit 0):

- A. 0/3 paid → normal `_closeRoom`, no refund. PASS
- B. 1/3 paid → single Room Wallet refund (p1), room closes after refund. PASS
- C. 2/3 paid → both confirmed players refunded. PASS
- D. 3/3 FULLY_PAID → all three refunded, close deferred while
  REFUND_PENDING, then CANCELLED + close. PASS
- E. creator leaves after GAME_INITIALIZED → no refund, no room destroy,
  session stays FULLY_PAID, gameplay ownership remains released. PASS

Regression check (run back-to-back, all exit 0): `setupExpiryRoomWalletRefund`,
`partialPaymentEscrowUnwind`, `socketDisconnect.roomWalletDiagnostics`,
`gameStartAuthorization`. One earlier false batch "FAIL" was an artifact of
accidentally concurrent verification runs (proven by clean re-runs), not a
code issue.

## 7. Explicit Non-Changes (confirmations)

- Page5 start-authorization code NOT changed: `GameStartAuthorization.js`
  untouched; its focused suite passes.
- General payment architecture NOT changed: no new refund implementation, no
  parallel systems; only the existing `failSession` →
  `_requestRoomWalletPartialPaymentRefund` → `RoomWalletSettlementAdapter`
  machinery is reused.
- No GameEscrow / DepositContract / DepositPackage payment method restored or
  introduced; legacy GameEscrow evidence and `GameContractManager` untouched.
- Setup-expiry refund logic from the previous task NOT changed (the extended
  reason gate is additive and evaluates identically for `setup_expired`).
- `sessionNeedsEscrowUnwind` NOT deleted globally (still used by
  `PaymentSessionManager` legacy/restore paths).

## 8. Risks

- Low — a FULLY_PAID session in non-intake mode (not reachable in practice:
  FULLY_PAID is only produced by the Room Wallet intake confirm path) would
  abort in `failSession` without closing the room; funds remain safely in the
  Room Wallet for the existing recovery machinery.
- Low — if a refund broadcast fails, the session stays REFUND_PENDING and the
  room stays open for recovery/retry — identical residual behavior to the
  fixed setup-expiry flow (pre-existing machinery, out of scope).

## 9. Changes Made

- `server/socket/RoomLobbyBridge.js` — creator-left decision condition.
- `server/gameplay/PaymentSessionManager.js` — `creator_left` accepted by the
  FULLY_PAID pre-init refund gate in `failSession`.
- `server/tests/creatorLeftRoomWalletRefund.test.js` — new focused suite
  (cases A–E).
- This report. Git commit on `payment/room-wallet-integration` after
  validation.

