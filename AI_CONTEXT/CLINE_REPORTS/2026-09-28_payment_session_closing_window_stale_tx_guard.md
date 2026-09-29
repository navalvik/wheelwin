# PaymentSession Closing Window and Stale-Transaction Guard (Testnet Room Wallet)

Date: 2026-09-28

Task: Implement ONE focused change to the Testnet Room Wallet payment lifecycle — enforce the
correct lifetime of a PaymentSession while Page4 waits for all three player payments:
(PAYMENT CLOSING) stop Room-Wallet payment acceptance a few seconds before the hard timer
expiration; (OLD TRANSACTIONS) reject blockchain transactions whose on-chain creation time
precedes the session acceptance window or that are discovered after the session stopped
accepting payments; (INCOMPLETE PAYMENT) on hard expiry keep using the EXISTING
refund/recovery path for exactly the already-accepted payments.

No redesign of the payment architecture. No Page4 changes. No settlement changes. No
GameEscrow / smart-contract changes. No Mainnet behavior change. No git commit (not requested).

---

## 1. Scope

- Payment-acceptance lifetime of `PaymentSession` (Room-Wallet intake path only).
- `RoomWalletIncomingObserver` attribution guards (acceptance window + stale-tx).
- Existing expiry → `failSession("payment_timeout")` → partial-payment Room Wallet refund
  unwind (reused unchanged, proven by tests).
- Unit-conversion detail: TON `utime` (Unix seconds) vs PaymentSession timestamps (ms).

Out of scope (untouched): settlement, GameEscrow, DepositContract, Page4 UI, recovery
engines, room-wallet allocation, Mainnet/GameEscrow confirmation path
(`_validateIncomingPayment` / `_processConfirmedPayment` deadline logic unchanged).

---

## 2. Files Inspected

- `AI_CONTEXT/WHEELWIN_MASTER_CONTEXT.md`, `ARCHITECTURE_RULES.md`, `CURRENT_STATE.md`,
  `AI_WORKING_RULES.md` (pre-analysis, per project rules).
- `AI_CONTEXT/CLINE_REPORTS/2026-09-28_room_wallet_observer_old_tx_attribution_analysis.md`
  (prior diagnostic — its section 7 insertion point is exactly what was implemented).
- `server/gameplay/PaymentSessionManager.js` (full lifecycle: create, activate, confirm,
  `_scheduleExpiry`/`_onExpiry`, `failSession`, `_requestRoomWalletPartialPaymentRefund`,
  `_finalizePartialPaymentUnwind`, restore).
- `server/gameplay/PaymentSessionStates.js`, `server/models/PaymentSession.js`,
  `server/gameplay/partialPaymentEscrowUnwind.js`.
- `server/payment/roomWallet/RoomWalletIncomingObserver.js` (full).
- `server/payment/BlockchainMonitor.js` (`parseDepositCandidate` — confirmed `raw: tx`).
- `server/payment/roomWallet/RoomWalletSettlementAdapter.js` (`refundPayments` — recipient
  is `target.wallet`, the authoritative participant record).
- Tests: `roomWalletIncomingObserver.test.js`, `roomWalletGameReadiness.test.js`,
  `setupExpiryRoomWalletRefund.test.js`, `creatorLeftRoomWalletRefund.test.js`,
  `roomNumberWalletMapping.test.js`, `paymentSession.manager.test.js`.
- `server/app.js` observer wiring (manager passed to observer; `setRoomWalletFinance`).

---

## 3. Architecture Findings

- `PaymentSessionManager` owns the session lifecycle: `_scheduleExpiry` arms a timer at the
  hard `paymentDeadline`; `_onExpiry` → `failSession(roomId, "payment_timeout")` →
  `markTimedOut()` (PAYMENT_TIMEOUT) and, when some-but-not-all seats are confirmed
  (`sessionNeedsEscrowUnwind`), the EXISTING `_requestRoomWalletPartialPaymentRefund` →
  `RoomWalletSettlementAdapter.refundPayments` unwind refunds exactly the accepted players,
  with recipients taken from `participant.wallet` (`buildPartialPaymentRefundTargets`).
- `RoomWalletIncomingObserver` accepted payments until the hard deadline only
  (`session.paymentDeadline && now > session.paymentDeadline` → EXPIRED_PAYMENT_CONTEXT)
  and never compared blockchain time with session lifetime (no `utime` use anywhere).
- `parseDepositCandidate` already returns `raw: tx`; TonCenter transactions carry
  `utime` (Unix seconds). `session.createdAt` is the acceptance start and survives
  persistence/rehydration (`PaymentSession.fromRecord`).

---

## 4. Lifecycle Flow (after this change)

```
createPaymentSession
  paymentDeadline = createdAt + durationMs (unchanged, 8 min default)
  _scheduleExpiry → _onExpiry → failSession("payment_timeout")   (hard timer, unchanged)
        │
        ▼  while in progress AND now <= deadline - 5 s (PAYMENT_CLOSING window)
RoomWalletIncomingObserver accepts inbound Room Wallet transfers
  - manager predicate: isAcceptingPayments(roomId)             (NEW)
  - tx.utime (s→ms) must be >= session.createdAt - 5 s skew    (NEW guard)
        │ accepted → existing records: participant.txHash / paidAmount,
        │ receivedPayments, ROOM_WALLET_INCOMING_OBSERVATION audit, player-payment ledger
        │ → PAYMENT_TRANSACTION_DETECTED → PAYMENT_TRANSACTION_CONFIRMED
        │   → confirmBlockchainPayment
        │
        ├─ 3 confirmed → _maybeCompleteSession → FULLY_PAID
        │                 → PAYMENT_SESSION_COMPLETED → Page5 (unchanged)
        │
        └─ closing window (deadline-5s) / REFUND_PENDING / terminal →
             EXPIRED_PAYMENT_CONTEXT (attributed) or transient UNKNOWN_SENDER (terminal)
             no credit, no revival
        │
        ▼ hard deadline
failSession("payment_timeout") → PAYMENT_TIMEOUT
  → existing _requestRoomWalletPartialPaymentRefund → adapter.refundPayments
     refunds ONLY participants with accepted payments, to participant.wallet
  → all refunded → _finalizePartialPaymentUnwind → CANCELLED + PAYMENT_SESSION_FAILED
```

---

## 5. Ownership Boundaries

- `PaymentSessionManager` (lifecycle owner): gained the closing-window constant
  `PAYMENT_ACCEPTANCE_CLOSING_WINDOW_MS = 5_000` and the public predicate
  `isAcceptingPayments(roomId)`. No transition, timer, or refund behavior changed.
- `RoomWalletIncomingObserver` (observation/attribution owner): consults the manager
  predicate in `_attribute` (deadline-only fallback preserved for managers without the
  predicate) and enforces the blockchain-time lower bound in `processTransaction`
  (`tonTransactionCreatedAtMs` + `ROOM_WALLET_TX_CLOCK_SKEW_TOLERANCE_MS = 5_000`,
  new rejection reason `STALE_TRANSACTION`, persisted via `_rejectTerminal`).
- No responsibility moved between modules. No second ledger. Existing events
  (PAYMENT_TRANSACTION_DETECTED/CONFIRMED, PAYMENT_SESSION_COMPLETED,
  PAYMENT_SESSION_FAILED) and the existing refund mechanism are reused unchanged.

Clock detail: TonCenter `utime`/`now` is Unix SECONDS; `session.createdAt` is ms.
`tonTransactionCreatedAtMs()` performs the explicit ×1000 conversion. Skew tolerance is
5 000 ms — smallest defensible value covering second-granularity rounding plus ordinary
validator/NTP skew, negligible against the 8-minute window (documented in code).

---

## 6. Risks

- Low — closing window cuts acceptance 5 s early: a payment sent in the final 5 s is not
  credited and will not be refunded automatically (it was never accepted). This is the
  requested trade-off; it removes the previous race where an accepted payment could be
  confirmed by the manager after PAYMENT_TIMEOUT.
- Low — `STALE_TRANSACTION` is fail-open on missing `raw.utime` (falls back to the
  session-state checks). TonCenter always supplies `utime`; mocks may not.
- Low — observer rejection reasons for terminal sessions remain transient
  (`UNKNOWN_SENDER`) as before; closing-window rejections are attributed
  (`EXPIRED_PAYMENT_CONTEXT`) and persisted.
- Pre-existing (not introduced here): `roomNumberWalletMapping.test.js` 3 failures and
  `paymentSession.manager.test.js` failure are harness breakage present on the branch
  before this change (verified by stash-based baseline run). Readiness test
  "C. legacy mode" also failed at baseline.

---

## 7. Recommendations

1. Consider aligning `cutoffUtime` units in `_requestRoomWalletPartialPaymentRefund`
   (ms timestamp passed where the adapter compares against `utime` seconds) — pre-existing,
   out of scope here.
2. The test harnesses that construct `PaymentSessionManager` without
   `setRoomWalletFinance` (`roomNumberWalletMapping.test.js`,
   `paymentSession.manager.test.js`) should be repaired separately to restore branch
   health.
3. Optionally surface `utime` as a first-class field of `parseDepositCandidate`
   (additive) if other modules later need on-chain time.

---

## 8. Changes Made

Modified:
- `server/gameplay/PaymentSessionManager.js`
  - `PAYMENT_ACCEPTANCE_CLOSING_WINDOW_MS = 5_000` (documented lifecycle constant).
  - `isAcceptingPayments(roomId)` — in progress + not REFUND_PENDING + outside closing window.
- `server/payment/roomWallet/RoomWalletIncomingObserver.js`
  - Rejection reason `STALE_TRANSACTION`; `ROOM_WALLET_TX_CLOCK_SKEW_TOLERANCE_MS = 5_000`;
    `tonTransactionCreatedAtMs(raw)` (utime/now seconds → ms);
    `_isSessionAcceptingPayments(session)` (manager predicate + deadline fallback);
    `_attribute` destination-match gated on acceptance;
    `processTransaction` stale-tx terminal rejection after attribution.
- `server/tests/roomWalletIncomingObserver.test.js`
  - Harness fix: `createObserverFixture` wires `manager.setRoomWalletFinance({ registry,
    roomWalletPaymentIntakeEnabled: true })` (production app.js parity — fixes 18
    pre-existing failures of this file).
  - `inboundTx` helper gained optional `utime`.
  - New tests A, B, C (closing window), C/G (expired, no revival), D (three payments →
    PAYMENT_SESSION_COMPLETED).
  - Two stale assertions (K, N) updated from `PAYMENT_REQUESTED` to
    `AWAITING_PLAYER_CONFIRMATION` (correct post-activation seat status once the harness
    reaches them).
- `server/tests/roomWalletPaymentClosingLifecycle.test.js` (NEW)
  - E/F: timer expiry with two accepted payments → existing refund path invoked once for
    exactly those two players, recipients from participant records; never-paid player has
    no refund target/state; unwind finalizes CANCELLED; session never completes.
  - G: late direct confirmation and late PAYMENT_TRANSACTION_CONFIRMED event cannot reopen
    or complete the expired session.

Test results (node --test, run from `server/`):
- `roomWalletIncomingObserver.test.js` — 27 pass / 0 fail (baseline before change: 18 fail).
- `roomWalletPaymentClosingLifecycle.test.js` — 2 pass / 0 fail (new).
- `roomWalletGameReadiness.test.js` — same as baseline (only pre-existing
  "C. legacy mode" failure).
- `setupExpiryRoomWalletRefund.test.js` — passed (refund flow intact).
- `creatorLeftRoomWalletRefund.test.js` — passed (1/3, 2/3, 3/3 refunds intact).
- `roomNumberWalletMapping.test.js` — 5 pass / 3 fail (identical to stash-verified baseline;
  pre-existing harness breakage).
- `paymentSession.manager.test.js` — 0 pass / 1 fail (identical to baseline; pre-existing).

No git commit created (not requested).