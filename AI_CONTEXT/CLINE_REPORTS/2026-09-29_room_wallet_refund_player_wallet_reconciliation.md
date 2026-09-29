# Room Wallet Refund Reconciliation from Player Wallet History (Stage 1)

Date: 2026-09-29

Task: Stage 1 of the Room Wallet refund reconciliation fix. The server may fail to observe a
refund that actually reached the player's wallet. When the existing Room Wallet outbound-history
lookup finds no matching refund, the destination player's own inbound wallet history is now
inspected (read-only) and a strictly-matching inbound transaction is adopted as an already
completed refund — without broadcasting a second refund.

---

## 1. Scope

- `RoomWalletSettlementAdapter.refundPayments` / `_findExistingRefund` — refund idempotency
  detection extended with a player-wallet inbound fallback.
- `RoomWalletAdapter` — one new read-only method `getAddressTransactions(address, query)`.
- Focused offline regression tests.

Explicitly out of scope and untouched: PaymentSessionManager lifecycle/state transitions,
REFUND_PENDING behavior, setup timer, room destruction, payout logic, Page4/Page5, GameManager,
wallet registry/assignment, Testnet/Mainnet selection, GameEscrow/DepositContract/DepositPackage
(legacy residue — not restored), Railway/Vercel configuration, refund lifecycle state machine.

---

## 2. Files Inspected

- `AI_CONTEXT/WHEELWIN_MASTER_CONTEXT.md`, `ARCHITECTURE_RULES.md`, `CURRENT_STATE.md`,
  `AI_WORKING_RULES.md` (pre-analysis, per project rules).
- `AI_CONTEXT/CLINE_REPORTS/2026-09-28_refund_cutoff_utime_unit_verification.md`
  (prior `cutoffUtime` ms→s contract, `resolveCutoffUtime` semantics, baseline test results).
- `AI_CONTEXT/CLINE_REPORTS/2026-09-28_payment_session_closing_window_stale_tx_guard.md`
  (partial-payment refund unwind context; `refundPayments` call site).
- `server/payment/roomWallet/RoomWalletAdapter.js`
- `server/payment/roomWallet/RoomWalletSettlementAdapter.js`
- `server/payment/roomWallet/roomWalletTerminalRecoveryChain.js` (`extractInbound`,
  `extractOutboundTransfers`, `isLaterThanCutoff`, `confirmPayoutOnChain`)
- `server/models/TonWalletAddress.js` (`tonWalletAccountsEqual` — fail-closed equality)
- `server/services/TonService.js` (`getTransactions(address, query, options)`)
- `server/gameplay/PaymentSessionManager.js` (`_requestRoomWalletPartialPaymentRefund`
  — try/catch around `refundPayments`, consumes only `refund.ok` / `refund.txHash`)
- `server/tests/roomWalletSettlementAdapter.test.js` (existing refund tests + fixture)
- `server/tests/roomWalletAdapter.signingBuffer.r18s85.test.js` (adapter harness conventions)

---

## 3. Architecture Findings

- `RoomWalletAdapter` already exposes read-only passthroughs (`getBalance`, `getWalletAddress`,
  `getTransactions(roomNumber, query)`, `getSeqno`) that delegate to `tonService` and return
  `[]`/`null` when the underlying method is unavailable. Signing/broadcasting is isolated in
  `sendTransfer` via `_resolve()`.
- `RoomWalletSettlementAdapter._findExistingRefund` scanned ONLY the Room Wallet's own history
  (`getTransactions(roomNumber, { limit: 40, archival: true })` + `extractOutboundTransfers`)
  matching: success, not bounced, exact `amountNano`, destination equal (`tonWalletAccountsEqual`),
  `utime` after the ms→s-normalized cutoff. No match → fresh `sendTransfer` broadcast.
- `extractInbound(tx)` already existed in `roomWalletTerminalRecoveryChain.js` returning
  `{ hash, lt, utime, source, amountNano, bounced, success }` — no changes were required in that
  module for this stage.
- `PaymentSessionManager._requestRoomWalletPartialPaymentRefund` calls `refundPayments` inside a
  try/catch (fail-closed → `ROOM_WALLET_REFUND_ERROR`, retryable) and consumes only
  `result.ok` and `refund.txHash` — the new result code is fully compatible.

---

## 4. Lifecycle Flow

```
PaymentSessionManager._requestRoomWalletPartialPaymentRefund
    └─ refundPayments({ roomNumber, refunds, cutoffUtime (ms), confirmationTimeoutMs })
         └─ per refund target:
              _findExistingRefund
                1) Room Wallet outbound history scan (UNCHANGED)
                     getTransactions(roomNumber, { limit: 40, archival: true })
                     extractOutboundTransfers → success ∧ !bounced ∧ amountNano equal
                     ∧ destination == player wallet ∧ utime > cutoff
                     → match returned as-is (REFUND_ADOPTED)
                2) ONLY if no outbound match AND getAddressTransactions is available:
                     roomWalletAddress = getWalletAddress(roomNumber)   (fail-closed: null → skip)
                     getAddressTransactions(playerWallet, { limit: 40, archival: true })
                     extractInbound(tx) → accepted ONLY when ALL hold:
                        success === true
                        bounced !== true
                        amountNano === expected amountNano (bigint equality)
                        source equals authoritative Room Wallet (tonWalletAccountsEqual)
                        utime > cutoff (when a cutoff exists)
                     → { ...inbound, reconciliation: "PLAYER_WALLET_INBOUND" }
              existing ? adopt (no broadcast) : sendTransfer → confirmPayoutOnChain
```

---

## 5. Ownership Boundaries

- `RoomWalletAdapter` keeps owning TON transport; `getAddressTransactions` is a read-only
  passthrough of the same class of methods it already had. It never resolves signing material
  and never broadcasts.
- `RoomWalletSettlementAdapter` keeps owning refund idempotency detection; the new fallback is
  inside the existing `_findExistingRefund`, not a parallel path.
- `roomWalletTerminalRecoveryChain.js` remains the owner of raw-transaction extraction
  (`extractInbound` reused, not duplicated).
- No responsibility moved; no lifecycle/state-machine change; no new refund mechanism.

---

## 6. Risks

- Critical-class protection kept: an inbound transaction is accepted only when success, not
  bounced, exact nano amount, sourced from the authoritative Room Wallet, and after the cutoff.
  `tonWalletAccountsEqual` is fail-closed (unparseable/missing → false). Missing/zero `utime`
  cannot pass a positive cutoff.
- The fallback scans ONLY the destination player's own wallet — no arbitrary blockchain search.
- If the player-wallet lookup throws, the error propagates exactly like an existing
  `getTransactions` failure → PaymentSessionManager treats the refund attempt as retryable
  (fail-closed: no silent double-broadcast, no lost refund).
- New result code `REFUND_RECONCILED_FROM_PLAYER_WALLET` is additive; the manager only checks
  `ok`/`txHash`, so no consumer change was needed.
- Low: `_findExistingRefund` early-returns `null` when `getTransactions` is unavailable
  (pre-existing behavior preserved); in production `RoomWalletAdapter` always provides it, so
  the fallback is reachable whenever the outbound scan completes without a match.

---

## 7. Recommendations

1. `roomWalletSettlementRouter.test.js` — 2 pre-existing failures at stash-verified baseline
   ("uses legacy adapter by default" expects `legacy` while this branch's active architecture is
   `room-wallet`). The test file should be updated to the branch's architecture decision
   separately (out of Stage 1 scope).
2. `roomWalletSettlementAdapter.test.js:464` — pre-existing fixture artifact (fixture's
   `sendTransfer` wrapper double-counts the shared `calls` array → `refund-2` vs `refund-1`).
   Documented in the 2026-09-28 cutoff report; repair separately.
3. Stage 2 (future): consider reconciling the PaymentSession refund state machine with the new
   result code explicitly (observability/telemetry), without changing lifecycle logic.

---

## 8. Changes Made

Production code:
- `server/payment/roomWallet/RoomWalletAdapter.js`
  - NEW `getAddressTransactions(address, query = {})` — delegates to
    `tonService.getTransactions(address, query)` unchanged, returns `[]` when unavailable,
    read-only (no wallet resolution, no signing, no broadcast).
    `getTransactions(roomNumber, ...)` behavior unchanged.
- `server/payment/roomWallet/RoomWalletSettlementAdapter.js`
  - Imports `extractInbound` from `roomWalletTerminalRecoveryChain.js`.
  - `_findExistingRefund(...)`: Room Wallet outbound scan preserved verbatim; new fallback
    queries the destination player's wallet (`getAddressTransactions(wallet,
    { limit: 40, archival: true })`), resolves the authoritative Room Wallet address via
    `getWalletAddress(roomNumber)`, and matches the inbound transaction against ALL of:
    success === true, bounced !== true, amountNano exact equality, source equal to the
    authoritative Room Wallet (`tonWalletAccountsEqual`), utime > cutoff when cutoff provided.
    Match returns `{ ...inbound, reconciliation: "PLAYER_WALLET_INBOUND" }`.
  - `refundPayments(...)`: PLAYER_WALLET_INBOUND adoption returns
    `code: "REFUND_RECONCILED_FROM_PLAYER_WALLET"`, `confirmed: true`,
    `reconciliation: "PLAYER_WALLET_INBOUND"`, `txHash` (from the adopted transaction) —
    `sendTransfer()` is NOT called. The existing Room Wallet outbound case keeps
    `REFUND_ADOPTED` unchanged (no `reconciliation` field added to it). Exactly one concise
    informational log for the new path: room, player wallet, Room Wallet address, amountNano,
    tx hash, reconciliation type. No polling or repeated logs.
- `server/payment/roomWallet/roomWalletTerminalRecoveryChain.js` — NOT modified
  (`extractInbound` already existed; included in the task's git add list as a no-op).


Tests:
- `server/tests/roomWalletSettlementAdapter.test.js`
  - Fixture extended additively: optional `getAddressTransactions` and `logger` params.
  - NEW tests (7, all deterministic/offline):
    1. Player-wallet inbound reconciliation → `REFUND_RECONCILED_FROM_PLAYER_WALLET`,
       `reconciliation: "PLAYER_WALLET_INBOUND"`, `txHash`, zero broadcasts, query asserted as
       exactly `{ address: PLAYER_WALLET, query: { limit: 40, archival: true } }`, and exactly
       one info log containing room/playerWallet/roomWallet/amountNano/txHash/reconciliation.
    2. Foreign-source inbound rejected → fresh broadcast (`REFUND_CONFIRMED`), no
       `reconciliation` field.
    3. Wrong-amount inbound rejected → fresh broadcast.
    4. Inbound before the millisecond-derived cutoff rejected → fresh broadcast.
    5. Bounced inbound rejected → fresh broadcast.
    6. Room Wallet outbound match still wins over a player-wallet match → `REFUND_ADOPTED`,
       no `reconciliation` field, no info log, zero broadcasts.
    7. Missing `getAddressTransactions` → fallback skipped without crash → fresh broadcast.
- `server/tests/roomWalletAdapter.addressTransactions.test.js` (NEW)
  - Delegation passes the exact address and query through to `tonService.getTransactions`.
  - Returns `[]` when `tonService.getTransactions` is unavailable; never broadcasts.
  - Never touches the wallet resolver / signing material.

Test results (node --test, run from `server/`; no live network):
- `roomWalletSettlementAdapter.test.js` — 25 tests: **24 pass / 1 fail**. The only failure is the
  pre-existing `:464` fixture artifact (`refund-2` vs `refund-1`), identical at
  stash-verified baseline per the 2026-09-28 report; all 7 new tests pass.
- `roomWalletAdapter.addressTransactions.test.js` — **3 pass / 0 fail**.
- `roomWalletPaymentClosingLifecycle.test.js` — **2 pass / 0 fail**.
- `setupExpiryRoomWalletRefund.test.js` — **passed** (script-style file, self-reported; no failures).
- `creatorLeftRoomWalletRefund.test.js` — **1 pass / 0 fail** (internal A–E assertions passed).
- `restoreRoomWalletRefund.test.js` — **1 pass / 0 fail** (internal A–E assertions passed).
- `roomWalletSettlementRouter.test.js` — 4 tests: **2 pass / 2 fail** — both failures
  pre-existing at stash-verified baseline (default adapter expectation `legacy` vs branch
  architecture `room-wallet`); unrelated to this change.
- Combined run (`roomWalletResidualSweep.test.js`,
  `roomWalletAdapter.signingBuffer.r18s85.test.js`,
  `roomWalletTerminalSettlementRecovery.r18s82.test.js`,
  `roomWalletSettlement.r18s86.historicalReentry.test.js`) — **42 pass / 0 fail**.
- Post-rebase re-run of the two primary files: **27 pass / 1 fail** (same pre-existing artifact).

Git:
- One commit on `payment/room-wallet-integration`:
  `fix(payment): reconcile refunds from player wallet history`
- Commit SHA (after rebase onto the two remote commits `c00aecd`, `8e1e194`):
  **e5939a45e2d766e0285d5c5a38bf4ee1abe0ff83**
- Pushed to `origin/payment/room-wallet-integration` (branch in sync with origin).
- No deploy performed (Railway/Vercel untouched).

Unresolved issues / limitations:
- The two pre-existing `roomWalletSettlementRouter.test.js` failures remain (baseline drift,
  out of Stage 1 scope).
- The pre-existing `roomWalletSettlementAdapter.test.js:464` fixture artifact remains (out of
  scope; documented twice now).
- Stage 1 only: PaymentSessionManager still marks refunded participants generically from
  `result.ok`; explicit handling of `REFUND_RECONCILED_FROM_PLAYER_WALLET` in manager
  observability is deferred to a later stage (no lifecycle change was permitted here).
