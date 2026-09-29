# PaymentSessionManager Refund Reconciliation Provenance (Stage 2)

Date: 2026-09-29

Task: Stage 2 of the Room Wallet refund reconciliation fix — make
PaymentSessionManager explicitly record (and durably persist) the provenance of
refunds adopted from the destination player's own inbound wallet history
(`REFUND_RECONCILED_FROM_PLAYER_WALLET` / `PLAYER_WALLET_INBOUND`), for
observability and forensic recovery. Observability/persistence only; no
lifecycle, decision, adapter or blockchain-behavior change.

---

## 1. Scope

- `PaymentSessionManager._requestRoomWalletPartialPaymentRefund()` — additive
  provenance recording inside the existing successful-refund loop.
- One new private helper `_recordPlayerWalletRefundReconciliation()` —
  idempotent, non-authoritative metadata append + one concise info log.
- One new focused offline regression test file.

Explicitly out of scope and untouched: decision logic, `REFUND_PENDING`
transitions, refund target construction, `allConfirmedParticipantsRefunded()`,
`_finalizePartialPaymentUnwind()`, `restorePaymentSessions()` control flow,
`RoomWalletSettlementAdapter`, `RoomWalletAdapter`, blockchain API behavior,
Page4/Page5, wallet assignment, Testnet/Mainnet selection, payout logic, Room
Wallet settlement behavior, GameEscrow/DepositContract/DepositPackage (legacy
residue — not restored), Railway/Vercel deployment (none performed).

## 2. Files Inspected

- `AI_CONTEXT/WHEELWIN_MASTER_CONTEXT.md`, `ARCHITECTURE_RULES.md`,
  `CURRENT_STATE.md`, `AI_WORKING_RULES.md` (pre-analysis, per project rules).
- `AI_CONTEXT/CLINE_REPORTS/2026-09-29_room_wallet_refund_player_wallet_reconciliation.md`
  (Stage 1 report; Stage 2 continues its deferred item exactly).
- `server/gameplay/PaymentSessionManager.js` (full refund path, `_persistSession`,
  `_finalizePartialPaymentUnwind`, `_log`, imports)
- `server/models/PaymentSession.js` (`PaymentParticipant` fields, `toSnapshot()`,
  `toPayload()`, `fromRecord()`, `markRefundPending()`)
- `server/gameplay/PaymentSessionStates.js` (transition table)
- `server/gameplay/partialPaymentEscrowUnwind.js` (`buildPartialPaymentRefundTargets`,
  `allConfirmedParticipantsRefunded`)
- `server/payment/roomWallet/RoomWalletSettlementAdapter.js` (refund result shape)
- `server/persistence/TonFinancialPersistence.js` (read API used by tests)
- `server/tests/restoreRoomWalletRefund.test.js`, `creatorLeftRoomWalletRefund.test.js`
  (harness conventions), `roomWalletSettlementAdapter.test.js` (Stage 1 tests)

## 3. Architecture Findings

- `PaymentSession.toPayload()` / `toSnapshot()` already serialize
  `recoveryMetadata` verbatim, so anything recorded there is durably persisted
  (`TonFinancialPersistence` payment-session record) and emitted with
  `PAYMENT_SESSION_UPDATED` — zero model changes were required.
- The refund success loop previously consumed only `refund.ok` and
  `refund.txHash`; Stage 1's new result shape
  (`code: "REFUND_RECONCILED_FROM_PLAYER_WALLET"`,
  `reconciliation: "PLAYER_WALLET_INBOUND"`, `txHash`, `playerId`,
  `playerIndex`, `wallet`) was already fully compatible and is now also
  preserved as provenance.
- State machine constraint relevant to tests: `REFUND_PENDING → CANCELLED`
  only; `CANCELLED` has no outgoing transitions, so repeated-invocation tests
  must keep at least one participant unrefunded to stay in `REFUND_PENDING`.

## 4. Lifecycle Flow (after Stage 2)

```
_requestRoomWalletPartialPaymentRefund(session, reason)
  ├─ buildPartialPaymentRefundTargets + pendingRefunds filter (unchanged)
  ├─ recoveryMetadata = { ...metadata, unwindReason, refundRequestedAt } (unchanged)
  ├─ markRefundPending() if not already REFUND_PENDING (unchanged)
  ├─ _persistSession + PAYMENT_SESSION_UPDATED (unchanged, first persist)
  ├─ refundPayments(...) via settlement adapter (unchanged)
  ├─ per successful refund result:
  │    participant.refunded = true                    (unchanged)
  │    participant.refundTxHash = refund.txHash ?? null (unchanged)
  │    IF refund.reconciliation === "PLAYER_WALLET_INBOUND":
  │        _recordPlayerWalletRefundReconciliation(session, {...})   [NEW]
  │          ├─ dedupe by playerId + transactionHash (idempotent)
  │          ├─ append entry to recoveryMetadata.refundReconciliations
  │          └─ info log ROOM_WALLET_REFUND_RECONCILED (only on new entry)
  ├─ _persistSession + PAYMENT_SESSION_UPDATED (single existing call —
  │    covers the metadata change; NO second persistence call added)
  └─ if allConfirmedParticipantsRefunded → _finalizePartialPaymentUnwind (unchanged)
```

## 5. Ownership Boundaries

- `PaymentSessionManager` remains the sole owner of PaymentSession in-memory
  state and its persistence/emission. The new metadata is recorded by the
  manager, from adapter result data, into the manager-owned
  `session.recoveryMetadata` object.
- `RoomWalletSettlementAdapter` remains the sole owner of refund decision and
  blockchain broadcast; it was not modified. The manager only mirrors the
  adapter's reconciliation marker as observability.
- The metadata is explicitly NON-authoritative: it never feeds decisions, never
  changes `participant.refunded` / `participant.refundTxHash` semantics, and
  never carries financial amounts (no duplication of payment/refund amounts,
  no second copy of `refundTxHash` as a financial-authority field, no raw
  transaction objects, no blockchain payloads).

## 6. Exact Metadata Structure Added

For each successful refund result with
`refund.reconciliation === "PLAYER_WALLET_INBOUND"`, additively inside the
existing `session.recoveryMetadata` object:

```
recoveryMetadata.refundReconciliations = [
  ...existing entries,
  {
    playerId,                                   // from refund result (fallback participant)
    playerIndex,                                // normalized Number, from result (fallback participant)
    wallet,                                     // from refund result (fallback participant)
    reconciliation: "PLAYER_WALLET_INBOUND",
    transactionHash,                            // refund.txHash ?? null
    reconciledAt                                // Date.now() at record time
  }
]
```

Entry key set is exactly: `playerId, playerIndex, wallet, reconciliation,
transactionHash, reconciledAt` (asserted in test A). No amounts, no timestamps
beyond `reconciledAt`, no raw payloads.

## 7. Idempotency Behavior

`_recordPlayerWalletRefundReconciliation()` treats an entry as a duplicate when
an existing entry has the same `playerId` AND the same `transactionHash`
(string-compared, null-safe). Duplicates are skipped without rewriting the
existing entry (`reconciledAt` of the first write wins) and without logging.
Two layers protect repeated recovery:
1. The existing `pendingRefunds` filter (`participant.refunded !== true`)
   usually prevents reprocessing entirely (`ALREADY_REFUNDED` path unchanged).
2. When the same successful reconciliation result is genuinely re-delivered
   (mid-unwind re-request), the metadata-level dedupe keeps exactly one entry.

## 8. Info Log (only when a reconciliation is recorded)

```
ROOM_WALLET_REFUND_RECONCILED | roomId=<roomId> | playerId=<playerId> | playerWallet=<wallet> | txHash=<txHash> | method=PLAYER_WALLET_INBOUND
```

One concise line via `this._logger?.info?.(...)`; no polling, no repeated logs
(dedupe path logs nothing).

## 9. Tests Executed and Exact Results

New file `server/tests/paymentSessionRefundReconciliationMetadata.test.js`
(harness = `restoreRoomWalletRefund.test.js` conventions: fake settlement
adapter + real managers + real `TonFinancialPersistence` over a temp dataDir;
fully offline, no live network, no broadcast):

- **A. PLAYER_WALLET_INBOUND refund records reconciliation provenance metadata** — PASS
  (adapter result with `reconciliation: "PLAYER_WALLET_INBOUND"`,
  `txHash: "player-inbound-refund"`; participant `refunded=true`,
  `refundTxHash="player-inbound-refund"` unchanged; exactly one metadata entry
  with the exact 6-key set; no `/amount/i` keys in recoveryMetadata; exactly
  one matching info log; metadata durably present in the persisted
  payment-session record; session still finalizes to `CANCELLED` with one
  `PAYMENT_SESSION_FAILED` — existing behavior unchanged)
- **B. repeated refund pass with same reconciliation result stays idempotent** — PASS
  (same successful result processed twice through the existing
  recovery/refund path: adapter invoked twice, still exactly one entry for
  playerId `p1` + txHash `player-inbound-refund`, `reconciledAt` unchanged,
  no duplicate log, session stays `REFUND_PENDING`)
- **C. REFUND_ADOPTED does not create PLAYER_WALLET_INBOUND metadata** — PASS
  (`recoveryMetadata.refundReconciliations === undefined`, no reconciliation
  log, `unwindReason` untouched, finalize behavior unchanged)

Execution: `node --test tests/paymentSessionRefundReconciliationMetadata.test.js`
→ 3/3 internal cases PASS, node test runner `pass 1 / fail 0`, exit code 0.

Regression runs (node, from `server/`):
- `tests/restoreRoomWalletRefund.test.js` — 5/5 cases PASS, exit 0.
- `tests/creatorLeftRoomWalletRefund.test.js` — A–E all "passed", exit 0.
- `tests/roomWalletPaymentClosingLifecycle.test.js` — exit 0 (cases PASS).
- `tests/setupExpiryRoomWalletRefund.test.js` — A–F all "passed".
- `tests/roomWalletSettlementAdapter.test.js` — 25 tests: **24 pass / 1 fail**;
  the single failure is the pre-existing `:464` fixture artifact
  (`refund-2` vs `refund-1`), byte-identical to the stash-verified baseline
  documented in the Stage 1 report — unrelated to this stage, Stage 1
  behavior unchanged.

No live-network tests were created or run. No blockchain transaction was sent.

## 10. Git

- Branch: `payment/room-wallet-integration`
- Commit: **4877525098b8457570a6ecc1834a5ffec734e066**
  `fix(payment): record refund reconciliation provenance`
- 2 files changed, 776 insertions(+), 0 deletions:
  - `server/gameplay/PaymentSessionManager.js` (+86, purely additive)
  - `server/tests/paymentSessionRefundReconciliationMetadata.test.js` (new)
- Pushed; local HEAD == `origin/payment/room-wallet-integration` (verified via
  fetch + rev-parse). Stage 1 commit `e5939a4` remains the direct parent.
- No deploy performed (Railway/Vercel untouched). No empty commit.

## 11. Risks

- Low: `recoveryMetadata` grows by at most one compact entry per
  player+transactionHash per session (max 3 players; idempotent).
- Low: the mirrored constant `PLAYER_WALLET_INBOUND_RECONCILIATION` in
  PaymentSessionManager duplicates the adapter's private constant string. The
  adapter intentionally was not modified (per stage constraints); if the
  adapter ever renames the marker, the manager's condition would simply stop
  matching (fail-safe: metadata just not recorded; no behavior change).
- Low: `reconciledAt` uses `Date.now()` at record time — observability only,
  never used for cutoff/decision logic (cutoff remains
  `recoveryMetadata.refundRequestedAt`, unchanged).

## 12. Recommendations

Do not implement automatically:
- Consider exporting the reconciliation marker constant from
  `RoomWalletSettlementAdapter` in a later stage so the manager can import it
  instead of mirroring the string.
- Consider surfacing `recoveryMetadata.refundReconciliations` in operator
  forensic tooling in a later stage.

## 13. Changes Made

- `server/gameplay/PaymentSessionManager.js`:
  - module constant `PLAYER_WALLET_INBOUND_RECONCILIATION`
  - private helper `_recordPlayerWalletRefundReconciliation()` (idempotent
    append + single info log)
  - additive provenance recording in the successful-refund loop of
    `_requestRoomWalletPartialPaymentRefund()` (existing behavior preserved)
- `server/tests/paymentSessionRefundReconciliationMetadata.test.js` (new):
  cases A/B/C described in section 9.

Unresolved issues:
- Pre-existing (documented in Stage 1, out of scope):
  `roomWalletSettlementAdapter.test.js:464` fixture artifact (1 failure);
  `roomWalletSettlementRouter.test.js` baseline drift (2 failures) — untouched.
