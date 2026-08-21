# PaymentSessionManager.restorePaymentSessions() — Read-Only Analysis

Date: 2026-08-22

Task: Locate `restorePaymentSessions()` in `server/gameplay/PaymentSessionManager.js`, report its starting line number, main purpose, and whether it writes to disk. No modifications, no tests, no source changes.

## 1. Scope

Read-only inspection of a single function: `PaymentSessionManager.prototype.restorePaymentSessions()`.

The goal was to answer three specific questions:

1. The line number where the function starts.
2. The function's main purpose.
3. Whether it writes to disk.

No code was modified. No tests were executed. This document is the only artifact produced.

## 2. Files Inspected

- `server/gameplay/PaymentSessionManager.js` (2861 lines total; relevant range 702-909, plus 915-1122 for the `syncFromGameEscrow` continuation invoked by the restore path).

## 3. Architecture Findings

### 3.1 Function location

`restorePaymentSessions()` is defined as an instance method on the `PaymentSessionManager` class.

- **Starting line: 702** (`restorePaymentSessions() {`).
- Function body spans lines 702-813.
- It delegates completion work to `_finishPaymentSessionRestore({ restored, recovered, rewatched, pendingSync })` at line 806 (defined at lines 819-909).

### 3.2 Main purpose

`restorePaymentSessions()` rehydrates in-memory payment sessions from the financial persistence layer on server startup / recovery. Concretely it:

1. Asserts the manager is initialized (`this._assertInitialized()`).
2. If `this._financialPersistence` is absent, returns a frozen zero-summary `{ restored: 0, recovered: 0, rewatched: 0, syncedFromChain: 0 }`.
3. Reads active persisted payment-session records via `this._financialPersistence.listActive(TON_FINANCIAL_RECORD_TYPES.PAYMENT_SESSION)` (line 717).
4. For each record:
   - Reconstructs a `PaymentSession` via `PaymentSession.fromRecord(record)` (line 733).
   - Skips rooms that already have an in-memory session (line 735).
   - Honors R7.69C: restores CANCELLED sessions for refund sync / watch recovery (line 742).
   - Skips terminal sessions unless they are CANCELLED (line 744).
   - Marks non-in-progress, non-cancelled sessions as `PAYMENT_SESSION_STATUS.RECOVERED` (line 756).
   - Restores seat indices (`participant.playerIndex`) for GameEscrow `paidMask` mapping (R7.69B, lines 767-775).
   - Indexes the session in-memory via `this._indexSession(session)` (line 777).
   - Re-arms the expiry timer if `paymentDeadline` is still in the future (line 785).
   - Pushes the session to `pendingSync` (line 789).
   - Emits `EVENT_TYPES.PAYMENT_SESSION_RECOVERED` (line 791).
5. Returns `this._finishPaymentSessionRestore({ restored, recovered, rewatched, pendingSync })`, which:
   - Calls `this.syncFromGameEscrow(roomId)` for each pending session (line 890) to align participants with the on-chain GameEscrow `paidMask` (GameEscrow is authoritative; backend cache never overrides chain).
   - Re-registers blockchain watches for unpaid seats via `this._registerBlockchainWatches(session, contractAddress)` (line 851).
   - Returns a frozen summary `{ restored, recovered, rewatched, syncedFromChain }`.

**Summary of purpose:** Rehydrate in-memory payment sessions from persistence on startup/recovery, reconcile them with on-chain GameEscrow state, re-establish blockchain watches for unpaid seats, and re-arm expiry timers — returning a restore summary.

### 3.3 Whether it writes to disk

**Directly: No.** The `restorePaymentSessions()` function body (lines 702-813) does not call any persistence write method. Its only persistence interaction is a **read**: `this._financialPersistence.listActive(...)` (line 717). It does not call `_persistSession` directly.

**Indirectly: Yes, conditionally.** The restore completion path that `restorePaymentSessions()` triggers can write to disk:

- `restorePaymentSessions()` → `_finishPaymentSessionRestore()` (line 806)
- `_finishPaymentSessionRestore()` → `this.syncFromGameEscrow(session.roomId)` (line 890)
- `syncFromGameEscrow()` calls `this._persistSession(session, "update")` at **line 1095**, but **only when `changed === true`** — i.e., when reconciling the cached session against the on-chain GameEscrow `paidMask` actually mutates participant state (participants confirmed or demoted).

Therefore:
- The function itself performs no disk writes.
- The restore flow it initiates performs conditional disk writes through `syncFromGameEscrow` → `_persistSession(session, "update")`, only when on-chain reconciliation produces state changes.

## 4. Lifecycle Flow

```
restorePaymentSessions()                      [line 702]
  └─ _assertInitialized()
  └─ (guard) no _financialPersistence → return zero summary
  └─ _financialPersistence.listActive(PAYMENT_SESSION)   [READ]
  └─ for each record:
       ├─ PaymentSession.fromRecord(record)
       ├─ skip if room already has session
       ├─ skip terminal (unless CANCELLED)
       ├─ mark RECOVERED where applicable
       ├─ restore seat indices (R7.69B)
       ├─ _indexSession(session)              [in-memory]
       ├─ _scheduleExpiry(session)             [in-memory timer]
       ├─ _emitDomain(PAYMENT_SESSION_RECOVERED)
       └─ pendingSync.push(session)
  └─ return _finishPaymentSessionRestore({...})          [line 806]
       ├─ for each pending session:
       │    └─ syncFromGameEscrow(roomId)     [line 890]
       │         ├─ readGameEscrowPaymentState (chain READ)
       │         ├─ confirm/demote participants
       │         └─ if changed: _persistSession(session, "update")  [WRITE, line 1095]
       └─ _registerBlockchainWatches(session, contractAddress)  [line 851]
       └─ return { restored, recovered, rewatched, syncedFromChain }
```

## 5. Ownership Boundaries

- `PaymentSessionManager` owns payment-session orchestration only. It never communicates with TON directly; on-chain reads go through `BlockchainMonitor` (`readGameEscrowPaymentState`, `readGameEscrowCancelState`).
- Persistence ownership is delegated to the injected `_financialPersistence` dependency (`listActive` for reads, `_persistSession` wrapping writes). `PaymentSessionManager` does not implement disk I/O itself.
- GameEscrow is the authoritative source of payment/refund truth; the backend cache (sessions restored here) is synchronized to the chain, never the reverse.
- This analysis did not alter any ownership boundaries.

## 6. Risks

- **Low** — This is a read-only analysis; no code was changed.
- **Low** — Restore-time conditional writes (`syncFromGameEscrow` → `_persistSession`) are by design and gated on `changed === true`; they reconcile cache to chain. No action required for this task.
- **Low** — Restored sessions marked `RECOVERED` and re-armed expiry timers depend on persisted `paymentDeadline` correctness; out of scope for this read-only inspection.

## 7. Recommendations

Recommendations only; not implemented.

- Consider documenting the indirect write path (`restorePaymentSessions` → `_finishPaymentSessionRestore` → `syncFromGameEscrow` → `_persistSession`) in an inline comment near line 806 so future readers understand that restore can trigger conditional persistence writes.
- No other action required; the function behaves as designed for a server-authoritative recovery flow.

## 8. Changes Made

No files modified. No source code, configuration, or test files were changed. This report is the only artifact created.