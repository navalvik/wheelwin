# Active Room Wallet Only Polling

Date: 2026-09-30

Task: Change Room Wallet incoming payment observation so the server polls ONLY
Room Wallets assigned to currently active (in-progress) Payment Sessions,
instead of scanning the entire 64-wallet catalog continuously; remove the
duplicate per-room BlockchainMonitor TonCenter polling in Room-Wallet-only
financial mode.

Mainnet baseline commit: 872562d85b08ba534e9f47f089c093a06ad678c7
Branch: payment/room-wallet-integration

## 1. Scope

- RoomWalletIncomingObserver polling-target selection and idle behaviour.
- Duplicate TonCenter polling caused by the legacy
  BlockchainMonitor.watchPayment() / _ensurePoll() / _pollRoom() path when
  PaymentSessionManager operates in Room-Wallet-only intake mode.
- Observability of observer cycles (activeSessions / walletsPolled / catalog).
- No changes to settlement, refunds, validation, catalogs, or deployment
  variables.

## 2. Files Inspected

- server/payment/roomWallet/RoomWalletIncomingObserver.js
- server/payment/roomWallet/RoomWalletRegistry.js
- server/payment/roomWallet/RoomWalletRuntimeResolver.js
- server/payment/roomWallet/RoomWalletService.js
- server/payment/roomWallet/roomWalletConfig.js
- server/payment/BlockchainMonitor.js
- server/gameplay/PaymentSessionManager.js
- server/gameplay/PaymentSessionStates.js
- server/models/PaymentSession.js
- server/app.js (composition root)
- server/socket/RoomLobbyBridge.js (submitPlayerConfirmation caller)
- server/tests/roomWalletIncomingObserver.test.js
- server/tests/roomWalletOnlyPlayerPayment.r18s72.test.js
- server/tests/paymentSession.manager.test.js
- server/tests/restoreRoomWalletRefund.test.js
- server/payment/roomWallet/ROOM_WALLET_RUNTIME.md
- AI_CONTEXT/WHEELWIN_MASTER_CONTEXT.md
- AI_CONTEXT/ARCHITECTURE_RULES.md
- AI_CONTEXT/CURRENT_STATE.md
- AI_CONTEXT/AI_WORKING_RULES.md
- AI_CONTEXT/CLINE_REPORTS/2026-09-28_room_wallet_observer_old_tx_attribution_analysis.md
- AI_CONTEXT/CLINE_REPORTS/2026-09-29_mainnet_room_wallet_readiness_decoupling.md

## 3. Architecture Findings

### 3.1 Root cause of unnecessary catalog-wide polling (exact)

`RoomWalletIncomingObserver.poll()` built its polling set with:

```js
const addresses = listConfiguredRoomWalletAddresses(this._registry);
```

`listConfiguredRoomWalletAddresses()` returns the FULL registered catalog
(64 Room Wallets on Mainnet). `_nextWalletSlice()` then rotated through that
catalog with `walletsPerCycle = 8` at the global 2000 ms interval (driven by
`BlockchainMonitor._pollGlobal()`), so an idle Mainnet server continuously
issued TonCenter `getTransactions` calls for catalog wallets that were NOT
assigned to any active Payment Session. This produced the observed
`wallets=8 | catalog=64` cycle logs with zero active games and wasted most of
the TonCenter RPS budget on wallets that could not receive attributable
payments.

### 3.2 Duplicate polling root cause (exact)

In Room-Wallet-only mode the observer is the authoritative Room Wallet
poller. However `PaymentSessionManager.submitPlayerConfirmation()` — the
Page4 flow entry called from RoomLobbyBridge — called
`this._registerPlayerWatch(session, participant)` WITHOUT the
Room-Wallet-only guard. `_registerPlayerWatch()` defaults
`contractAddress = session.roomWalletAddress` and calls
`BlockchainMonitor.watchPayment(...)`, whose auto-start path
(`_ensurePoll(roomId)`) creates a per-room `setInterval` timer that polls the
SAME Room Wallet address via `_pollRoom(roomId)` →
`getTransactions(roomWalletAddress)`. The other two watch-registration sites
(`_activatePaymentRequests` and `_finishPaymentSessionRestore`) were already
guarded with `!this._roomWalletPaymentIntakeEnabled`, so the unguarded
`submitPlayerConfirmation` site was the remaining duplicate poller.

## 4. Lifecycle Flow

Room-Wallet-only financial mode after this change:

```
PaymentSessionManager (authoritative active sessions)
    ↓  _listInProgressSessions()
RoomWalletIncomingObserver._resolveActivePollingTargets()
    ↓  persisted session.roomWalletAddress
    ↓  (fallback: authoritative roomNumber → RoomWalletRegistry)
ONLY active assigned Room Wallet address(es), deduplicated
    ↓  walletsPerCycle fair-rotation slice (max), concurrency 1
TonCenter getTransactions
    ↓
PAYMENT_TRANSACTION_DETECTED / PAYMENT_TRANSACTION_CONFIRMED
    ↓
PaymentSessionManager (authoritative confirmation consumer)
```

- Session created / in progress → wallet enters the polling set automatically
  (derived fresh on every cycle; no separate source of truth).
- Participant payments confirmed → polling continues until the session leaves
  the in-progress state.
- Session terminal (FULLY_PAID / PAYMENT_TIMEOUT / PAYMENT_FAILED / CANCELLED)
  or recovered into a non-progress state → wallet leaves the polling set on
  the next cycle.
- Zero in-progress sessions → `poll()` returns
  `{ skipped: true, skipReason: "no_active_payment_sessions" }` with ZERO
  `getTransactions` calls; the catalog is not scanned.
- Server restart → `restorePaymentSessions()` rehydrates active sessions with
  their persisted `roomWalletAddress`; polling resumes only for those wallets.
- A new game receives a different room wallet through the existing
  roomNumber assignment; wallets are never inherited between games.

## 5. Ownership Boundaries

- PaymentSessionManager remains the single authoritative source of active
  Payment Sessions (`listSessionRoomIds()`, `getSession()`, `isInProgress()`,
  `isAcceptingPayments()`). No new source of truth for active rooms was
  introduced.
- RoomWalletIncomingObserver remains a read-only observer; it derives its
  polling set each cycle from PaymentSessionManager and never mutates session
  state.
- RoomWalletRegistry remains the identity/settlement catalog (roomNumber →
  address) and the legacy-recovery fallback for sessions without a persisted
  `roomWalletAddress`.
- BlockchainMonitor retains the legacy `watchPayment()` API and `_watches`
  data structure untouched for non-RoomWallet (legacy diagnostic/rollback)
  paths; only the Room-Wallet-only duplicate registration was prevented.
- Settlement/refund ownership (RoomWalletSettlementRouter,
  RoomWalletSettlementAdapter, refund/payout chains, residual sweep, Owner
  Wallet, Residues Wallet) was not modified.
- Wallet derivation still never uses the public 4-character `roomId`
  (`resolveAuthoritativeRoomNumber()` → explicit roomNumber or
  RoomManager resolution only).

## 6. Risks

- Critical: none.
- High: none.
- Medium: none.
- Low:
  - If a deployment runs with an EMPTY/missing Room Wallet catalog while
    restored sessions carry a persisted `roomWalletAddress`, the observer now
    polls that persisted address; transactions are still rejected
    fail-closed (`wrong_destination`) by the catalog check inside
    `processTransaction()`. Behaviour is safe; only read RPC is spent.
  - The idle log line is emitted once per idle period (transition-based), so
    dashboards must rely on the result fields (`activeSessions`,
    `walletsPolled`) for per-cycle confirmation.

## 7. Recommendations

- Keep `ROOM_WALLET_OBSERVER_WALLETS_PER_CYCLE` unchanged; it now acts purely
  as a max/fair-rotation cap over the active wallet set (still relevant if
  more than 8 games run simultaneously).
- Consider a future (separate) task: emit an EventBus heartbeat event from
  the observer idle state for console panels, if operators need it.
- Do not reintroduce catalog-wide polling for "discovery"; incoming payment
  discovery must always be scoped by active Payment Sessions.

## 8. Changes Made

Files changed:

1. `server/payment/roomWallet/RoomWalletIncomingObserver.js`
   - `poll()` no longer scans the catalog. It derives the polling set from
     `_resolveActivePollingTargets()` (in-progress sessions only). With zero
     active sessions it returns
     `{ skipped: true, skipReason: "no_active_payment_sessions",
     activeSessions: 0, walletsPolled: 0 }` and performs zero
     `getTransactions` calls (transition-logged once per idle period).
   - New `_resolveActivePollingTargets()`: for each in-progress session,
     prefer canonical `session.roomWalletAddress`, else
     `resolveIntendedRoomWalletAddress()` via authoritative `roomNumber` →
     registry; deduplicated; frozen result. `walletsPerCycle` retained as the
     max/fair-rotation cap; concurrency guard and all traffic-control
     settings unchanged.
   - New `_registryCatalogSize()` diagnostic helper.
   - Observability: cycle started/complete and idle logs now report
     `activeSessions=N | walletsPolled=N | catalog=64`; poll results expose
     `activeSessions` and `walletsPolled`.
   - Updated the traffic-control doc comment to describe active-set
     rotation. No validation, attribution, persistence, or event logic was
     changed.
2. `server/gameplay/PaymentSessionManager.js`
   - `submitPlayerConfirmation()` now registers the legacy
     BlockchainMonitor watch only when
     `!this._roomWalletPaymentIntakeEnabled` (same guard pattern already used
     at `_activatePaymentRequests` and `_finishPaymentSessionRestore`). In
     Room-Wallet-only mode no second per-room TonCenter poller is created for
     the active Room Wallet; `PAYMENT_SUBMITTED` → `BLOCKCHAIN_PENDING`
     transitions, persistence, and event emission are unchanged.
3. `server/tests/roomWalletActiveWalletPolling.test.js` (new)
   - Focused tests A–J proving the required behaviours (see tests section).

Not changed (verified): wallet catalogs / resolver env variables
(ROOM_WALLETS_MAINNET_JSON, ROOM_WALLETS_TESTNET_JSON, ROOM_WALLETS_JSON),
TonCenter credentials, Railway variables, Vercel configuration, Page4/Page5
UI, R2 configuration, settlement/refund business rules, residual sweep
policy, Owner/Residues wallet behaviour, GameEscrow/DepositContract code
(not restored or enabled).

## 9. Tests Executed and Results

Runner: `node <testfile>` per file (repo convention,
`server/scripts/run-tests.js`). All tests are mocked-TON, no funds touched.
Baseline was captured on commit 872562d (working tree before changes) and
compared after the change.

New focused tests — `server/tests/roomWalletActiveWalletPolling.test.js`
(11 tests, ALL PASS):

- A  no active sessions → 0 `getTransactions` calls, result
  `skipReason="no_active_payment_sessions"`, `activeSessions=0`,
  `walletsPolled=0`; repeated idle cycles stay at zero RPC.
- B  one active session → exactly its assigned Room Wallet polled
  (`activeSessions=1 | walletsPolled=1`); no unrelated catalog wallet across
  cycles (registry of 64 wallets).
- C  two active sessions → exactly the two assigned Room Wallets
  (`activeSessions=2 | walletsPolled=2`).
- D  full 64-wallet catalog with zero active sessions → zero catalog-wide
  polling over repeated cycles.
- E  legacy recovered session (`session.roomWalletAddress` stripped, valid
  authoritative `roomNumber`) → polling resolves exactly that room's wallet.
- F  terminal session (all participants confirmed → FULLY_PAID) → not polled;
  `activeSessions=0`.
- G  restart/recovery: two stacks over one persistence dataDir;
  `restorePaymentSessions()` restores the in-progress session with its
  persisted `roomWalletAddress` and polling resumes for exactly that wallet;
  no BlockchainMonitor watch is re-created (restore path already guarded).
- H  Room-Wallet-only mode: `createPaymentSession` + `submitPlayerConfirmation`
  never call `blockchainMonitor.watchPayment` → no second per-room TonCenter
  polling timer for the active Room Wallet (watchPayment is the only entry
  point that creates `BlockchainMonitor._ensurePoll` timers).
- H2 legacy non-RoomWallet path (intake disabled) still registers payment
  watches on `submitPlayerConfirmation` → legacy diagnostic/rollback
  behaviour preserved.
- I  payment confirmation via poll: `PAYMENT_TRANSACTION_DETECTED` and
  `PAYMENT_TRANSACTION_CONFIRMED` still reach PaymentSessionManager;
  participant becomes `PAYMENT_CONFIRMED` with correct txHash (Page4
  completion semantics unchanged).
- J  two simultaneous rooms isolated by roomWalletAddress: Room A payment
  confirms Room A only; a Room A sender paying Room B's wallet is rejected
  `wrong_destination`.

Regression suites (baseline vs post-change):

| Test file | Baseline | Post-change |
|---|---|---|
| roomWalletIncomingObserver.test.js | pass 27 / fail 0 | pass 27 / fail 0 |
| roomWalletOnlyPlayerPayment.r18s72.test.js | pass | pass (6/0) |
| roomWalletPaymentClosingLifecycle.test.js | pass | pass (2/0) |
| blockchainMonitor.test.js | pass | pass (log identical) |
| blockchainMonitor.productionStart.r18s15.test.js | pass | pass (2/0) |
| restoreRoomWalletRefund.test.js | pass | pass (timestamps only) |
| paymentPhaseRecovery.r178b.test.js | pass | pass (log identical) |
| entryPaymentLifecycle.test.js | pass | pass (log identical) |
| paymentSessionRefundReconciliationMetadata.test.js | pass | pass |
| creatorLeftRoomWalletRefund.test.js | pass | pass |
| residuesWalletReuse.test.js | pass | pass (15/0) |
| mainnetRoomWalletReadinessDecoupling.test.js | pass | pass |
| financialPersistence.wiring.r810.test.js | FAIL (pre-existing) | FAIL (identical failure: PAYMENT_VALIDATION_ERROR status DEPLOYING at test line 490) |
| paymentSession.manager.test.js | FAIL (pre-existing) | FAIL (same: legacy lobby flow 0 !== 1 at line 396) |
| paymentSessionRoomNetwork.test.js | FAIL (pre-existing, 3 tests) | FAIL (same 3 tests: 180/208/242) |
| tonFinancialRecovery.test.js | FAIL (pre-existing) | FAIL (same: 0 !== 1 at line 495) |

All pre-existing failures reproduce identically before and after the change
(verified by normalized log diff: only UUIDs/timestamps differ). No new
failures were introduced.

## 10. Verification Against the Current Mainnet Issue

Old idle behaviour: `RoomWalletIncomingObserver cycle started | wallets=8 |
catalog=64` every 2000 ms with no active games.

New idle behaviour: the observer emits one
`RoomWalletIncomingObserver idle | no active payment sessions |
activeSessions=0 | walletsPolled=0 | catalog=64` line on entering idle and
performs zero `getTransactions` calls while there are no in-progress Payment
Sessions. With N active sessions the cycle logs show
`activeSessions=N | walletsPolled=N` for exactly the N assigned wallets.
Test D proves a configured 64-wallet catalog produces zero polling when no
sessions are active.

## 11. Catalog / Deployment Confirmation

- 64-wallet catalogs unchanged: no edits to wallet JSON, catalogs,
  `RoomWalletRegistry`, `RoomWalletRuntimeResolver`, or the
  ROOM_WALLETS_MAINNET_JSON / ROOM_WALLETS_TESTNET_JSON / ROOM_WALLETS_JSON
  variables and their semantics. The catalog remains fully available for
  identity, mapping, and settlement.
- No Railway variables changed (incl. TonCenter key, observer traffic env —
  defaults preserved: maxConcurrency=1, walletsPerCycle=8, retry 2/400 ms,
  fetch timeout 8 s).
- No Vercel configuration changed. No Page4/Page5 UI changed. No R2
  configuration changed.

## 12. Remaining Limitations

- Observer logging for long idle periods is transition-based (one line when
  entering idle); per-cycle proof of idleness is in the returned result
  object rather than the log stream.
- If a legacy persisted session references a wallet that is no longer in the
  configured catalog (catalog rotation without migration), the wallet is
  still polled and its transactions are rejected fail-closed
  (`wrong_destination`); operators should keep catalogs stable across
  restarts.
- `submitPlayerConfirmation` still performs its
  `PAYMENT_SUBMITTED → BLOCKCHAIN_PENDING` persistence/emission in
  Room-Wallet-only mode; only the duplicate watch registration is skipped,
  matching the requirement to keep lifecycle semantics unchanged.


