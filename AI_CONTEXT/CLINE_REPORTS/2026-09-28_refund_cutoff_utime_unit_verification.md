# Refund `cutoffUtime` Unit Verification (Testnet Room Wallet Refund Path)

Date: 2026-09-28

Task: Make ONE small corrective change to the existing Testnet Room Wallet refund path so the
`cutoffUtime` unit mismatch (WheelWin milliseconds vs TON `utime` seconds) is corrected with an
explicit `Math.floor(cutoffTimestampMs / 1000)` conversion, or — per the task's own fallback
clause — verify the complete path unchanged if the conversion already exists correctly.

**Outcome: NO production code change was required. The conversion already exists, exactly once,
at the adapter boundary. The complete path was verified and is now pinned by focused tests.**
The 5-second PAYMENT_CLOSING window was NOT changed. No git commit created.

---

## 1. Scope

- The `cutoffUtime` value produced by the existing partial-payment refund path
  (`PaymentSessionManager._requestRoomWalletPartialPaymentRefund`) and consumed by
  `RoomWalletSettlementAdapter.refundPayments` / `_findExistingRefund`.
- Unit semantics only. No refund mechanism, timeout, lifecycle, settlement, Page4/Page5,
  Mainnet, GameEscrow, wallet-allocation, or observer-guard changes.

---

## 2. Files Inspected

- `server/gameplay/PaymentSessionManager.js` — `_requestRoomWalletPartialPaymentRefund`
  (:2035–2140): `refundRequestedAt` derivation, `recoveryMetadata` persistence,
  `refundPayments({ ..., cutoffUtime: refundRequestedAt, confirmationTimeoutMs: 60_000 })`.
- `server/payment/roomWallet/RoomWalletSettlementAdapter.js` — `refundPayments`
  (:121–264), `_findExistingRefund` (:266–298), `resolveCutoffUtime` (:648–658).
- `server/payment/RoomWalletSettlementRouter.js` — `refundPayments` (:61–73) pure delegation.
- `server/payment/roomWallet/roomWalletTerminalRecoveryChain.js` — `extractTxUtime`
  (:52–55), `extractOutboundTransfers` (:75–103), `confirmPayoutOnChain` (:212–257).
- `server/tests/roomWalletSettlementAdapter.test.js` — existing refund tests (:460–537),
  `createAdapter` fixture (:7–59).
- `server/tests/roomWalletPaymentClosingLifecycle.test.js` — existing E/F/G refund tests.
- Prior context: `AI_CONTEXT/CLINE_REPORTS/2026-09-27_stage1-1_financial_test_triage_refund_recovery.md`
  (already documented `resolveCutoffUtime` ms→s normalization, lines 648–658).

---

## 3. Findings — the complete `cutoffUtime` path is already unit-correct

1. **Producer (ms, correct):** `PaymentSessionManager._requestRoomWalletPartialPaymentRefund`
   derives `refundRequestedAt = Number(session.recoveryMetadata?.refundRequestedAt ?? Date.now())`
   — a WheelWin **millisecond** lifecycle timestamp — persists it in
   `session.recoveryMetadata.refundRequestedAt` (survives restarts so recovery re-entry reuses
   the same cutoff), and passes it to the adapter as `cutoffUtime`. Internal WheelWin
   timestamps therefore remain milliseconds, as required.
2. **Router:** `RoomWalletSettlementRouter.refundPayments(request)` is a pure delegation to the
   active adapter — no unit transformation, no loss.
3. **Consumer (seconds, correct):** `RoomWalletSettlementAdapter._findExistingRefund` calls
   `resolveCutoffUtime({ cutoffUtime })` which normalizes **exactly once**:

   ```js
   return value > 1_000_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
   ```

   A millisecond cutoff (≈1.79e12 > 1e12) becomes
   `cutoffUtimeSeconds = Math.floor(cutoffTimestampMs / 1000)`. The subsequent comparison
   `transfer.utime > cutoff` uses `extractTxUtime(tx)` (`Number(tx.utime ?? tx.now ?? 0)`) —
   **TON utime seconds** — so the adapter's blockchain comparison stays in seconds, as required.
4. **Adoption semantics (verified, unchanged):** an outbound Room Wallet transfer with
   `utime > cutoff` (a refund broadcast after the refund request) is adopted
   (`REFUND_ADOPTED`, no second send — prevents double refunds); a transfer with
   `utime <= cutoff` (pre-request history) is NOT adopted and a fresh refund is broadcast.
5. **Unrelated consumers checked, no mismatch:** `inspectSettlement` also routes through
   `resolveCutoffUtime`; its `cutoffUtime` input (`reconstructed.lastInboundUtime`) is already
   seconds (extracted from tx `utime`) and passes through unchanged. This is settlement
   recovery, out of scope, untouched.

Adding another ms→s conversion (e.g. in the manager call site) would be a **redundant second
conversion** and would push the cutoff ~33 000 years into the past, breaking idempotent
adoption. Per the task's fallback clause, the path was left unchanged. This supersedes
Recommendation #1 of `2026-09-28_payment_session_closing_window_stale_tx_guard.md`, which
wrongly suspected a unit mismatch from a partial read.

---

## 4. Lifecycle Flow (verified, unchanged)

```
_requestRoomWalletPartialPaymentRefund(session, reason)
  refundRequestedAt = recoveryMetadata.refundRequestedAt ?? Date.now()   [MILLISECONDS]
  recoveryMetadata.refundRequestedAt = refundRequestedAt                 [persisted ms]
  adapter.refundPayments({ ..., cutoffUtime: refundRequestedAt })        [ms on the wire]
      │
      ▼  RoomWalletSettlementAdapter._findExistingRefund
  cutoff = resolveCutoffUtime({ cutoffUtime })   [ms → SECONDS exactly once: floor(ms/1000)]
  for each outbound transfer:  transfer.utime > cutoff ?          [TON utime SECONDS]
      ├─ yes → REFUND_ADOPTED (idempotent, no re-broadcast)
      └─ no  → sendTransfer → confirmPayoutOnChain → REFUND_CONFIRMED
```

---

## 5. Ownership Boundaries

- `PaymentSessionManager` keeps owning the ms lifecycle timestamp (`recoveryMetadata`).
- `RoomWalletSettlementAdapter` keeps owning the seconds-based blockchain comparison.
- No responsibility moved; no new refund mechanism; no adapter comparison unit changed.

---

## 6. Risks

- None introduced — zero production changes in this task.
- Pre-existing (documented, not touched): `roomWalletSettlementAdapter.test.js` test
  "partial room-wallet refunds return exactly the paid amount and confirm on chain" (:460)
  fails at branch HEAD too (stash-verified baseline, 15 pass / 1 fail) — its fixture
  double-counts `calls` because `createAdapter`'s built-in `sendTransfer` wrapper pushes the
  call into the shared array before delegating to the test override ("refund-2" after one
  broadcast). A fixture artifact, unrelated to cutoff units.

---

## 7. Recommendations

1. Separately repair the :460 fixture (assert on a dedicated counter instead of the shared
   `calls` array) — out of scope here.
2. Keep the ms→s normalization inside `resolveCutoffUtime` as the single conversion point;
   do not add conversions at call sites.

---

## 8. Changes Made

Production code: **none** (conversion already correct — verified, no redundant conversion).

Tests:
- `server/tests/roomWalletSettlementAdapter.test.js`
  - NEW: "refund cutoff derived from a millisecond timestamp is compared in TON utime
    seconds — transfer after the cutoff is adopted without re-broadcast" (fixed cutoff
    `1_700_000_000_500 ms → 1_700_000_000 s`; history transfer `utime = cutoffSeconds + 60`
    → `REFUND_ADOPTED`, zero broadcasts). Proves A + C.
  - NEW: "transfer with utime before the millisecond-derived cutoff is not adopted — a fresh
    refund is broadcast" (history transfer `utime = cutoffSeconds - 60` → exactly one fresh
    broadcast to the authoritative wallet, `REFUND_CONFIRMED`). Proves B.
- `server/tests/roomWalletPaymentClosingLifecycle.test.js`
  - E/F test extended: asserts the adapter request carries
    `cutoffUtime === session.recoveryMetadata.refundRequestedAt` (the PaymentSession
    millisecond timestamp, ms scale) — proves A at the manager→adapter boundary. The
    existing E/F assertions (refund targets exactly the accepted players' authoritative
    wallets; never-paid player excluded) prove D.

Test results (node --test, run from `server/`):
- `roomWalletSettlementAdapter.test.js` — 17 pass / 1 fail; the only failure is the
  pre-existing :460 fixture artifact (identical at stash-verified baseline). Both new
  cutoff-unit tests pass.
- `roomWalletPaymentClosingLifecycle.test.js` — 2 pass / 0 fail (A + D/E/F/G).
- `setupExpiryRoomWalletRefund.test.js` — passed (real manager→adapter refund path intact).
- `creatorLeftRoomWalletRefund.test.js` — 1 pass / 0 fail (1/3, 2/3, 3/3 refunds intact).

**The 5-second PAYMENT_CLOSING window was not changed.** No PaymentSession lifecycle,
observer stale-transaction guard, Page4/Page5, settlement, Mainnet, GameEscrow, or
wallet-allocation changes. No git commit created.