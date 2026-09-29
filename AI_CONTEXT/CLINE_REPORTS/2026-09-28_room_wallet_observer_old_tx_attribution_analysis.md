# Room Wallet Incoming Observer — Old Transaction / New PaymentSession Attribution Analysis

Date: 2026-09-28

Task: Diagnostic-only investigation. Determine whether `RoomWalletIncomingObserver` can accept an
OLD blockchain transaction from a previous game as the payment for a NEW PaymentSession.
No fix was requested or implemented. No source code, tests, or configuration were modified.
No git commit was created.

---

## 1. Scope

Analysis focused on `server/payment/roomWallet/RoomWalletIncomingObserver.js` and the minimum
directly related code needed to trace timestamps:

- shared transaction parser `parseDepositCandidate` / `isFailedTonTransaction` in
  `server/payment/BlockchainMonitor.js`;
- `PaymentSession` model time fields in `server/models/PaymentSession.js`;
- session enumeration via `PaymentSessionManager.listSessionRoomIds()` / `getSession()`.

Questions investigated:

1. Where the Observer obtains the blockchain transaction timestamp/time; which exact field is
   used; whether it is blockchain transaction time, logical time (LT), observer processing time,
   or something else.
2. Where the Observer decides that a transaction belongs to an active PaymentSession.
3. Exact code path: blockchain transaction → transaction parsing → sender/destination matching →
   active PaymentSession lookup → `PAYMENT_TRANSACTION_DETECTED` / `PAYMENT_TRANSACTION_CONFIRMED`.
4. Whether the Observer verifies that the blockchain transaction was created AFTER the
   PaymentSession started.
5. Whether any comparison equivalent to `transaction timestamp >= paymentSession.createdAt` exists.
6. Smallest possible code location where such validation could later be added.

---

## 2. Files Inspected

- `server/payment/roomWallet/RoomWalletIncomingObserver.js` — 1241 lines, read in full.
- `server/payment/BlockchainMonitor.js` — lines 200–340 (`isFailedTonTransaction` tail,
  `parseDepositCandidate` full body).
- `server/models/PaymentSession.js` — lines 125–235 plus `toPayload`/`toSnapshot` sections.
- `server/gameplay/PaymentSessionManager.js` — targeted inspection only:
  `listSessionRoomIds()` (:314), `paymentDeadline` activation (:2517–2536).
- Context documents read before analysis (per project rules):
  `AI_CONTEXT/WHEELWIN_MASTER_CONTEXT.md`, `AI_CONTEXT/ARCHITECTURE_RULES.md`,
  `AI_CONTEXT/CURRENT_STATE.md`, `AI_CONTEXT/AI_WORKING_RULES.md`.

Method note: a `Select-String` scan of the entire Observer file for
`utime|createdAt|timestamp|Date.now|_now()|lt` confirmed the timestamp-related facts below.

---

## 3. Architecture Findings

### 3.1 Q1 — Transaction time source: the Observer uses NO blockchain time

**Finding: the Observer does not read any blockchain transaction timestamp at all.**

- Parsing happens via `parseDepositCandidate(tx)` — `server/payment/BlockchainMonitor.js:220–307`.
  It extracts exactly: `sender`, `destination`, `comment`, `amountGram`, `txHash`
  (`transaction_id?.hash ?? tx.txHash ?? tx.hash`), **`lt: tx.transaction_id?.lt ?? tx.lt`**
  (BlockchainMonitor.js:303), and `raw: tx` (the untouched TonCenter transaction object).
- The TonCenter transaction object contained in `raw` DOES carry `utime` / `now`
  (blockchain/validator time, unix seconds) — but nothing in the Observer reads it.
- `lt` is **logical time**: a per-account monotonically increasing sequence number. It is carried
  through event payloads (Observer :603, :626, :663) and persisted (:926) but is **never used for
  any temporal decision** and is not comparable to wall-clock time.
- Every timestamp the Observer itself produces is **observer processing time**
  (`this._now()`, constructor default `() => Date.now()` at :260):
  - `_paymentPayload()` :870 — `timestamp: this._now()` → included in
    `PAYMENT_TRANSACTION_DETECTED` / `PAYMENT_TRANSACTION_CONFIRMED` payloads
    (processing time, NOT blockchain time);
  - `_emit()` :1203 and `_audit()` :1216 — same.
- Scan evidence: zero occurrences of `utime` and zero occurrences of `createdAt` in the entire
  Observer file.

### 3.2 Q2 — Attribution decision point

**`_attribute(destination, sender)` — Observer lines 697–783.**

- `_listInProgressSessions()` :785–803 → iterates
  `paymentSessionManager.listSessionRoomIds()` and keeps sessions where
  `session.isInProgress() === true`.
- Match rule per participant:
  - canonical-equal wallets: `tonWalletAccountsEqual(wallet, sender)` :722;
  - participant not already `PAYMENT_CONFIRMED` :726;
  - session's intended room-wallet address (`session.roomWalletAddress`, else registry fallback
    via `resolveIntendedRoomWalletAddress` :208 / :711–717) equals tx `destination` :734.
- Disambiguation:
  - exactly 1 match → attributed :744;
  - more than 1 → `AMBIGUOUS_ATTRIBUTION` :748;
  - deadline-expired → `EXPIRED_PAYMENT_CONTEXT` :760;
  - sender known but wrong destination → `WRONG_DESTINATION` :770;
  - no match → `UNKNOWN_SENDER` :780.

### 3.3 Q4 / Q5 — No `tx.timestamp >= paymentSession.createdAt` protection exists

**Finding: there is NO such check and NO equivalent.**

- The ONLY temporal comparison in the entire Observer is in `_attribute` line 735:

  ```js
  if (session.paymentDeadline && now > session.paymentDeadline) {
      expiredMatches.push(match);
  }
  ```

  where `now = this._now()` (observer wall-clock, :702). This is an **upper bound** only — it
  rejects activity *after* the session deadline. It compares **observer processing time vs.
  session deadline**, uses no blockchain time, and does **not** bound the transaction's on-chain
  creation time from below by the session start.
- `PaymentSession` DOES have `createdAt` (`server/models/PaymentSession.js` :138/:164; persisted
  in `toPayload` :488; preserved on rehydration in `fromRecord` :224) and `deposit.raw.utime` is
  available in memory at attribution time — the two values are simply never compared.
- The only transaction-identity guard is the dedup key
  `destination + txHash` (`buildRoomWalletIncomingObservationId` :165–174, checked at :536 and
  after persistence at :636). It prevents re-processing the *same* transaction, but says nothing
  about *when* the transaction was created relative to the session.

### 3.4 Verdict — can an OLD tx be accepted by a NEW PaymentSession?

**Yes, theoretically.** Attribution is purely:
`(sender wallet == participant.wallet) && (destination == room wallet) && session.isInProgress() && amount matches`.
The realistic failure window:

1. A tx to the Room Wallet is sent during/before a *previous* game (aborted session, player
   pre-funding, leftover transfer) and never receives a persisted observation record — because
   the observer was down, got 429-blocked, the path was `_rejectTransient`
   (:967 — `UNKNOWN_SENDER`, `MALFORMED_TRANSACTION`, `MISSING_TRANSACTION_HASH`,
   `MISSING_DESTINATION`, `MISSING_SENDER`, unparseable `FAILED_TRANSACTION`), or persistence was
   unavailable.
2. The same wallet is bound to the same player in a **new** session (normal — wallets are
   persistent bindings), destination is the same Room Wallet address (deterministic per room
   number), and the old tx is still within the TonCenter page window (limit 32, `archival: true`).
3. The next poll fetches the old tx → `_attribute` matches it to the **new** session →
   `PAYMENT_TRANSACTION_DETECTED` + `PAYMENT_TRANSACTION_CONFIRMED` → the player is credited
   without paying again. Because required amounts are deterministic (equal stakes), the
   `amountsMatch` check (:574) does not protect against this.
4. Mitigation that partially exists: a tx once terminal-rejected via `_rejectTerminal` (:972)
   is persisted as `REJECTED` and subsequently returns `DUPLICATE_TRANSACTION` forever. Only
   transactions that were never terminal-persisted are at risk.

---

## 4. Lifecycle Flow (Q3 — exact code path from blockchain to events)

| Step | Location |
|---|---|
| Poll cycle | `poll()` Observer:317 → `_nextWalletSlice` :1029 → `_mapPool` :1044 → `_fetchTransactionsControlled(address)` :1072 → `_fetchTransactionsOnce` :1138 (limit 32, `archival: true`) → `_fetchTransactionsRaw` :1149 (TonCenter via transport / TonService) |
| Transaction parsing | `processTransaction(tx, watchedAddress)` :418 → `isFailedTonTransaction` :425 → **`parseDepositCandidate(tx)` :457** (BlockchainMonitor.js:220–307) |
| Field validation | missing txHash/destination/sender → :476/:483/:490; `INVALID_AMOUNT` :497; destination == watched address :504; destination ∈ registry catalog :520 |
| Dedup | `buildRoomWalletIncomingObservationId(dest, txHash)` = `rwin__{dest}__{hash}` :165 → `_hasObservation()` :887 (persistence `loadAuditRecord`) → `DUPLICATE_TRANSACTION` :536 |
| **Session lookup** | **`this._attribute(destination, sender)` :548 → definition :697** |
| Amount check | `amountsMatch(participant.requiredGram, amountGram)` :574 |
| Ledger + persistence | `_recordPlayerPayment` :595/:805 → `_persistObservation(ACCEPTED)` :617/:904 |
| **Events** | **`_emit(EVENT_TYPES.PAYMENT_TRANSACTION_DETECTED, ...)` :676 and `PAYMENT_TRANSACTION_CONFIRMED` :677, emitted back-to-back**, after audit `ROOM_WALLET_PAYMENT_CONFIRMED` :666 |

Note: both lifecycle events carry `timestamp: this._now()` (observer processing time,
`_paymentPayload` :870 / `_emit` :1203), not blockchain time.

---

## 5. Ownership Boundaries

- `RoomWalletIncomingObserver` is an observation/attribution module: it discovers inbound TON
  transfers to configured Room Wallet addresses, attributes them to exactly one in-progress
  payment-session participant, and feeds the existing `PAYMENT_TRANSACTION_DETECTED` /
  `PAYMENT_TRANSACTION_CONFIRMED` lifecycle. Per its header (:1–11) it does not replace
  `PaymentSessionManager`, `BlockchainMonitor`, `DepositMonitor`, `GameEscrow`, or Room Wallet
  settlement.
- `PaymentSessionManager` owns session lifecycle/status/deadlines
  (`_activatePaymentRequests` :2517–2536 sets `paymentDeadline`/`expiresAt`;
  `listSessionRoomIds()` :314).
- The Observer owns only: observation dedup persistence (`_persistObservation` :904), ledger
  recording (`_recordPlayerPayment` :805), attribution (`_attribute` :697), and event emission
  (`_emit` :1193).

---

## 6. Risks

- **Medium — stale transaction attribution:** an OLD on-chain tx that never received a persisted
  observation record can be credited to a NEW session (see 3.4). Requires: unobserved/stale tx +
  same sender wallet bound to the same player + same Room Wallet destination + matching amount.
  Deterministic equal stakes mean the amount check provides no protection.
- **Low — transient rejections are not persisted:** `_rejectTransient` :967 writes nothing, so
  transiently-rejected txs are re-polled indefinitely until they can be attributed; combined with
  the missing lower time bound this widens the stale-tx window.
- **Low — event timestamp semantics:** `PAYMENT_TRANSACTION_DETECTED`/`CONFIRMED` payload
  `timestamp` is observer processing time (:870, :1203), not blockchain time; downstream
  consumers must not treat it as on-chain time.
- Mitigation that partially exists: terminal rejections are persisted (`_rejectTerminal` :972),
  so such txs become permanent `DUPLICATE_TRANSACTION` (:536).

---

## 7. Recommendations (recommendations only — NOT implemented)

1. **Primary insertion point:** in `processTransaction`, immediately after
   `const { session, participant } = attribution;` — **Observer line 572**. This is the single
   spot where both the raw transaction (`deposit.raw.utime ?? deposit.raw.now`, unix seconds →
   ×1000) and the attributed `session` (`session.createdAt`, ms) are in scope. A guard rejecting
   with a new reason (e.g. `STALE_TRANSACTION`) via `_rejectTerminal` requires no changes to
   `_attribute`'s signature, `PaymentSessionManager`, Page4, settlement, or recovery.
2. **Optional supporting change:** surface `utime` as an explicit field in `parseDepositCandidate`
   (BlockchainMonitor.js :297–305) instead of reading `deposit.raw` — additive and
   backward-compatible, but touches a shared parser used elsewhere; the Observer-only option is
   the smaller change.
3. **Design caveats for any future fix:** TonCenter `utime` is validator time in seconds;
   `createdAt` is server wall-clock ms; recovery rehydration preserves `createdAt`
   (`PaymentSession.fromRecord`, model :224), so the comparison survives restart; a small
   clock-skew tolerance may be advisable.

---

## 8. Changes Made

Only this report file was created:
`AI_CONTEXT/CLINE_REPORTS/2026-09-28_room_wallet_observer_old_tx_attribution_analysis.md`

- No source code modified.
- No tests modified.
- No configuration modified.
- No git commit created.
- No fix implemented — the insertion point in section 7 is a recommendation only.