# Room Wallet Sequential Settlement Seqno Fix

Date: 2026-09-30

Task: Fix the Room Wallet settlement sequencing and partial-settlement recovery bug
(production game `game_8b040e1c-1007-463f-bde7-8056c6dd3124`, room `iHud`,
Room Wallet number 1). Winner Bob was paid 4.27 GRAM; the Owner did not receive
0.22 GRAM because two independent outbound transfers were broadcast with the
same Room Wallet seqno (31), and every recovery attempt then failed with
INSUFFICIENT_ROOM_WALLET_BALANCE.

## 1. Scope

- Room Wallet outbound transfer transport (`RoomWalletAdapter`).
- Room Wallet settlement orchestration (`RoomWalletSettlementAdapter.settleContract`).
- Partial-settlement recovery funding gate (winner-confirmed / owner-missing state).
- Existing confirmation infrastructure reuse (`confirmPayoutOnChain`,
  `inspectRoomWalletHistory` from `roomWalletTerminalRecoveryChain.js`).
- Existing settlement retry loop (`ContractSettlementManager._deferRoomWalletRetry`).
- Related automated tests, plus a new deterministic regression suite.

## 2. Files Inspected

- `server/payment/roomWallet/RoomWalletAdapter.js`
- `server/payment/roomWallet/RoomWalletSettlementAdapter.js`
- `server/payment/roomWallet/roomWalletTerminalRecoveryChain.js`
- `server/payment/roomWallet/RoomWalletFinancialPolicy.js`
- `server/payment/roomWallet/RoomWalletService.js`
- `server/payment/roomWallet/roomWalletConfig.js`
- `server/payment/roomWallet/RoomWalletTerminalSettlementRecovery.js`
- `server/payment/RoomWalletSettlementRouter.js`
- `server/payment/ContractSettlementManager.js`
- `server/services/TonService.js` (getSeqno / broadcastTransaction / getTransactions)
- `server/payment/ton/TonCenterTransport.js`
- `server/models/TonWalletAddress.js`
- Existing tests: `roomWalletSettlementAdapter.test.js`,
  `roomWalletSettlement.r18s75.test.js`, `roomWalletSettlement.r18s80.uhquHandoff.test.js`,
  `roomWalletSettlement.r18s83.retryable.test.js`, `roomWalletSettlement.r18s86.historicalReentry.test.js`,
  `roomWalletTerminalSettlementRecovery.r18s82.test.js`, `roomWalletResidualSweep.test.js`,
  `roomWalletAdapter.signingBuffer.r18s85.test.js`,
  `roomWalletService.test.js`, `tests/helpers/dummyRoomWallet.js`, `scripts/run-tests.js`

## 3. Architecture Findings and Exact Root Cause (confirmed)

### 3.1 Root cause of the duplicate-seqno broadcast

`RoomWalletSettlementAdapter.settleContract()` sent the winner transfer and then,
immediately, the owner transfer. Each `RoomWalletAdapter.sendTransfer()` read the
on-chain seqno (`getSeqno` get-method read) right before signing. TON accepts the
winner external message (seqno 31) but the chain state does not reflect it for
seconds, so the owner's `getSeqno` still returned 31. Both independent external
messages were signed and broadcast with seqno 31 (matches the verified Railway
log evidence: Bob `amountNano=4270000000 seqno=31` at 14:19:05.974Z and Owner
`amountNano=220000000 seqno=31` at 14:19:06.550Z). Wallet v4 ignores a repeated
seqno, so the owner transfer never landed.

### 3.2 Root cause of the failed recovery

On retry, `settleContract()` re-inspected chain history: `winnerPayout` was found,
`ownerPayout` was null, so `needOwner = true`. However the funding gate used the
full `preflight()` requirement — `winnerAmount + ownerPayout + 2 x gasReserve` —
even though the winner payout had already been paid. The Room Wallet balance
(≈ 0.72 GRAM after paying winner 4.27 + gas) can never satisfy the full
requirement (≈ 4.73 GRAM), so every retry returned
`INSUFFICIENT_ROOM_WALLET_BALANCE` forever. Settlement stayed retryable and the
Owner was never paid.

### 3.3 Architecture notes

- The confirmation primitive already existed: `confirmPayoutOnChain`
  (`roomWalletTerminalRecoveryChain.js`) polls the authoritative transaction
  history and matches hash/destination/amount. The refund path already used it.
  The fix reuses it — no second polling system was introduced.
- The authoritative seqno read (`getSeqno`) already existed on `TonService` and is
  the same primitive used for signing. A wallet seqno only advances when its
  external message is accepted, so waiting for `seqno > N` is positive, bounded,
  on-chain evidence — not a timing assumption and not a locally incremented counter.

## 4. Lifecycle Flow (new settlement sequence)

1. `inspectSettlement()` — unchanged (`CHAIN_INSPECT_UNKNOWN`, `WALLET_REUSED`,
   duplicate-evidence `DUPLICATE_PAYOUT`, `SETTLEMENT_ADOPTED` paths unchanged).
2. Funding gate:
   - `needWinner` → full `preflight()` (unchanged requirement);
   - winner already on chain, owner missing → NEW `preflightRemainingOwner()`
     (owner payout + one gas reserve only).
3. If `needWinner`: send winner → NEW positive on-chain confirmation via the
   existing `confirmPayoutOnChain`. If not confirmed within the bounded window →
   retryable `WINNER_PAYOUT_UNCONFIRMED` (owner payout is never attempted).
4. If `needOwner`: send owner (a fresh authoritative seqno is read at this point —
   the chain has already accepted the winner message) → NEW positive on-chain
   confirmation. If not confirmed → retryable `OWNER_PAYOUT_UNCONFIRMED`
   (retry adopts the payout instead of duplicating it).
5. After-send inspect — unchanged (`WALLET_REUSED`, `DUPLICATE_PAYOUT`,
   `SETTLEMENT_BROADCAST`, `UNCERTAIN_BROADCAST`).
6. `ContractSettlementManager` sees `winnerConfirmed && ownerConfirmed` →
   `SETTLEMENT_COMPLETED`. Only then is settlement terminal.

## 5. Ownership Boundaries

- No ownership moved. `RoomWalletAdapter` remains the only signing/broadcast
  boundary. `RoomWalletSettlementAdapter` remains the only settlement orchestrator.
  `confirmPayoutOnChain` remains the only confirmation primitive.
- `ContractSettlementManager` is untouched; its retry loop and
  `_isRoomWalletSafetyFailure` classification treat the two new codes as retryable.
- Operator terminal recovery (`RoomWalletTerminalSettlementRecovery`) is unchanged
  and remains fail-closed (the automated retry path is what recovers partial state).
- No parallel settlement mechanism was created.

## 6. Changes Made (exact files and functions)

### 6.1 `server/payment/roomWallet/RoomWalletAdapter.js`

- `constructor()` — new injectable options: `seqnoConfirmTimeoutMs` (default
  90 000 ms), `seqnoConfirmPollMs` (default 2 000 ms), `now`, `sleep`; new
  per-address state `_outboundQueues` and `_pendingOutboundSeqno`.
- NEW `_enqueueOutbound(addressKey, task)` — serializes all `sendTransfer` calls
  per wallet address so concurrent callers cannot interleave seqno reads.
- NEW `_awaitOutboundSequenceSafety(identity)` — before a new send, waits for the
  authoritative chain seqno to advance past the previously broadcast seqno
  (positive on-chain evidence). Fail-closed: `SEQNO_CONFIRMATION_TIMEOUT` when the
  chain does not advance in the bounded window; `SEQNO_CONFIRMATION_UNAVAILABLE`
  when `getSeqno` is unavailable while a broadcast is pending.
- `sendTransfer()` → validation and identity resolution unchanged, then delegates
  to NEW `_sendTransferLocked()` (gate → balance check → sign → broadcast →
  record pending seqno). The seqno is read only after the previous outbound
  message from the same wallet is confirmed. Balance check, signing
  (`SendMode.PAY_GAS_SEPARATELY`), identity-drift guard, StateInit handling and
  result shapes are unchanged. A broadcast that throws is not recorded as pending;
  the settlement layer re-inspects history before retry and the duplicate-payout
  evidence scan stays fail-closed for uncertain broadcasts.

### 6.2 `server/payment/roomWallet/RoomWalletSettlementAdapter.js`

- `ROOM_WALLET_SETTLEMENT_RETRYABLE_CODES` — added
  `WINNER_PAYOUT_UNCONFIRMED`, `OWNER_PAYOUT_UNCONFIRMED` (additive).
- `constructor()` — new injectable options: `confirmPayout` (default
  `confirmPayoutOnChain`), `confirmTimeoutMs` (default 90 000 ms),
  `confirmPollMs` (default 2 000 ms).
- `settleContract()`:
  - funding gate is now partial-aware: full `preflight()` only when `needWinner`;
    otherwise NEW `preflightRemainingOwner()`;
  - winner send block: NEW `_confirmTransferAfterBroadcast()` call; unconfirmed →
    retryable `WINNER_PAYOUT_UNCONFIRMED` with `partial: true` (owner not sent);
  - owner send block: NEW `_confirmTransferAfterBroadcast()` call; unconfirmed →
    retryable `OWNER_PAYOUT_UNCONFIRMED` with `partial: true`;
  - success returns (`SETTLEMENT_BROADCAST`, both chain-inspected and legacy
    no-observation variants) now include `winnerConfirmation` / `ownerConfirmation`
    evidence (additive fields; existing fields unchanged).
- NEW `preflightRemainingOwner({ request, roomNumber, ownerPlan, winnerAmountNano })`
  — owner-only funding requirement (`ownerPayout + gasReserve`) via the existing
  `canFundTransfer` adapter primitive; fails closed to the stricter full
  `preflight()` when `canFundTransfer` is unavailable. Frozen payload includes
  `remainingOnly: true`, `winnerPayoutAlreadyOnChain: true`,
  `excludedWinnerAmountNano`, `requiredNano`, `shortfallNano`.
- NEW `_confirmTransferAfterBroadcast({ roomNumber, history, txHash, destination,
  amountNano })` — reuses `confirmPayoutOnChain` over the existing inspect
  transport (`createInspectTransport`). When the transport cannot observe
  transactions at all, returns `observed: false` and the legacy no-observation
  behavior is preserved (this keeps environments without transaction history
  working exactly as before).
- After-send `DUPLICATE_PAYOUT` return now also includes
  `winnerPayoutCount` / `ownerPayoutCount` (evidence parity with the initial
  history duplicate return; fail-closed behavior unchanged).

### 6.3 New test file

- `server/tests/roomWalletSettlement.seqnoSequencing.test.js` — 13 deterministic
  tests (see section 7). Includes a simulated TON chain implementing the exact
  `tonService` surface (`getBalance` / `getSeqno` / `getTransactions` /
  `broadcastTransaction`) and the full real stack
  (`RoomWalletAdapter` + `RoomWalletSettlementAdapter` + `confirmPayoutOnChain`)
  with a virtual clock. No live network. Dummy test identities only.

## 7. Tests Added or Changed

New tests (all in `roomWalletSettlement.seqnoSequencing.test.js`):

1. PRODUCTION EVIDENCE: owner payout must not reuse winner seqno 31 and waits for
   winner confirmation — winner 4270000000 nano on seqno 31, owner 220000000 nano
   on seqno 32; owner broadcast strictly after winner mined and confirmed; both
   payouts confirmed; amounts/retention asserted unchanged.
2. PRODUCTION EVIDENCE: concurrent transfers cannot interleave the same seqno —
   two simultaneous `sendTransfer` calls produce seqnos [31, 32].
3. RECOVERY: winner already confirmed, owner missing — ONLY the owner payout is
   sent, with fresh seqno 32; winner not resent.
4. RECOVERY: preflight requires only owner payout + reserve, never the winner
   amount — `remainingOnly`, `requiredNano = 230000000`, `shortfallNano = 1`,
   nothing broadcast.
5. SEQNO HOLD: second transfer refused while first unconfirmed
   (`SEQNO_CONFIRMATION_TIMEOUT`), then released after confirmation (seqno 32).
6. SEQNO HOLD: fails closed when the chain seqno read is unavailable
   (`SEQNO_CONFIRMATION_UNAVAILABLE`).
7. settlement sequence: winner confirmed before owner payout submitted
   (event order send:winner → confirm:winner → send:owner → confirm:owner).
8. winner payout not confirmed: retryable `WINNER_PAYOUT_UNCONFIRMED`, owner
   payout never attempted.
9. owner payout not confirmed: retryable `OWNER_PAYOUT_UNCONFIRMED` partial state.
10. owner payout failure after a confirmed winner keeps
    `OWNER_PAYOUT_FAILED_AFTER_WINNER` partial retryable state.
11. winner already on chain: only owner payout sent and only owner payout confirmed.
12. duplicate owner payout evidence after recovery fails closed
    (`DUPLICATE_PAYOUT`, `retryable: false`).
13. adapter boundaries validate the injected confirmation primitives.

No existing test was weakened. No fail-closed or duplicate-protection assertion
was removed.

## 8. Exact Test Commands Executed

All commands were executed from `g:\WheelWin\server` (Windows, Node v24.19.0):

```
node tests/roomWalletSettlement.seqnoSequencing.test.js
node scripts/run-tests.js                         (full alphabetical suite)
node tests/auditEngine.test.js                    (isolation, pristine + current)
node tests/roomNumberWalletMapping.test.js        (isolation, pristine + current)
node tests/roomWalletGameReadiness.test.js        (pristine)
node tests/settlementRecoveryResume.r94.test.js   (pristine)
node tests/winnerRetry.settlementHandoff.r92.test.js (pristine)
node tests/gameplayPaymentSettlement.integration.test.js (pristine)
node tests/roomWalletSettlement.r18s80.uhquHandoff.test.js   (current)
node tests/roomWalletSettlement.r18s83.retryable.test.js     (current)
node tests/roomWalletService.test.js              (isolation)
<sequential runner over the 37 payment/settlement-related test files>
   (a temporary uncommitted runner script was used to continue past the
    pre-existing auditEngine failure and to retry transient Windows
    process-spawn failures 0xC0000142; the script was removed after use)
```

Pristine-tree comparison method: the two modified implementation files were
temporarily `git stash`-ed (no commits made), the failing tests were executed
against git HEAD, then the fix was restored with `git stash pop`. This separated
pre-existing failures from regressions without committing anything.

## 9. Exact Pass/Fail Results

### 9.1 New regression suite (run twice: after implementation, and again after the
final stash cycle to verify the delivered file state)

```
node tests/roomWalletSettlement.seqnoSequencing.test.js
tests 13 | pass 13 | fail 0 | exit code 0
```

### 9.2 Payment/settlement-related suite (37 files) — 24 PASS / 13 FAIL

PASS (24): roomWalletAdapter.addressTransactions, roomWalletAdapter.signingBuffer.r18s85,
roomWalletActiveWalletPolling, roomWalletAppComposition, roomWalletFinancialPolicy,
roomWalletIncomingObserver, roomWalletOnlyPlayerPayment.r18s72,
roomWalletPaymentClosingLifecycle, roomWalletResidualSweep, roomWalletRuntimeResolver,
roomWalletService, roomWalletSettlement.r18s75, roomWalletSettlement.r18s86.historicalReentry,
roomWalletSettlement.seqnoSequencing (new), roomWalletSettlementPlan,
roomWalletSettlementRouter, roomWalletTerminalSettlementRecovery.r18s82,
roomWalletTestnetFilePathConfig, creatorLeftRoomWalletRefund, setupExpiryRoomWalletRefund,
restoreRoomWalletRefund, residuesWalletReuse, sessionWalletStore,
mainnetRoomWalletReadinessDecoupling.

FAIL (13) — every one verified to fail identically on the pristine tree (git HEAD)
with the same assertion, so NONE of them is caused by this fix:

| Test file | Failing assertion (current) | Pristine verification |
| --- | --- | --- |
| roomNumberWalletMapping.test.js | PaymentValidationError "Room Wallet address is required for player payment" (payment-intake domain) | fails identically on pristine |
| roomWalletGameReadiness.test.js | "C. legacy mode still requires Deposit FULL..." expected OPEN_PAGE5 | fails identically on pristine |
| roomWalletRegistryRegisterIdentity.r18s89.test.js | 6 registry-identity assertion failures | pristine run exit=1, same assertion class |
| roomWalletSecretHardening.test.js | expects /cannot mix network values/, gets "TON_NETWORK must be explicitly set..." (runtime resolver validation order) | pristine run exit=1, same message mismatch |
| roomWalletSettlement.r18s80.uhquHandoff.test.js | pass 0 / fail 2 ("adapter must receive the CSM request" 0 !== 1; transient-throw retryability) | pristine pass 0 / fail 2 — identical |
| roomWalletSettlement.r18s83.retryable.test.js | pass 2 / fail 8 (READY vs SETTLEMENT_FAILED expectations) | pristine pass 2 / fail 8 — identical |
| roomWalletSettlementAdapter.test.js | pass 24 / fail 1 ("partial room-wallet refunds..." refund-2 vs refund-1) | pristine pass 24 / fail 1 — identical |
| contractSettlement.manager.test.js | "settlement started" false | pristine fails with same assertion |
| settlementBroadcastRecovery.r96.test.js | TEST A resumed 0 !== 1; READY→SETTLEMENT_TIMEOUT transition | pristine fails with same assertions |
| settlementProbeSafety.r104.test.js | TEST C exactly one settle 0 !== 1; READY→SETTLEMENT_TIMEOUT | pristine fails with same assertions |
| settlementRecoveryResume.r94.test.js | TEST A resumed once 0 !== 1 (line 316) | pristine fails identically (line 316) |
| winnerRetry.settlementHandoff.r92.test.js | TEST C session in progress after handoff | pristine fails identically |
| gameplayPaymentSettlement.integration.test.js | "game should reach RESULT" | pristine fails identically |

Note: `auditEngine.test.js` (outside the 37-file payment set, aborts the full
alphabetical runner) also fails identically on the pristine tree
("valid completed game should pass audit").

Conclusion: 0 regressions introduced by this fix. All pre-existing failures are in
unrelated domains (gameplay audit, payment intake, legacy GameEscrow readiness,
runtime-resolver env validation) or in ContractSettlementManager harness/resume
behaviors that this sprint did not touch.

## 10. Tests That Could Not Be Executed and Why

- The full alphabetical runner (`node scripts/run-tests.js`) aborts at the first
  failing file (`auditEngine.test.js`), which already fails at git HEAD before
  reaching the payment tests. The payment/settlement set was therefore executed
  with a temporary sequential runner that continues past failures; the runner was
  an uncommitted scratch file and was deleted after use.
- Three files (`settlementRecoveryResume.r94`, `winnerRetry.settlementHandoff.r92`,
  `gameplayPaymentSettlement.integration`) hit transient Windows process-spawn
  failures (0xC0000142) during one pristine batch run; they were re-executed
  individually on the pristine tree and produced real, identical failure
  signatures (documented above). No test was left unexecuted.
- Live Testnet/Mainnet broadcast tests were intentionally NOT executed:
  this task forbids deployment and any real transfer.

## 11. Confirmations

1. Payout amounts and Owner-retention policy were NOT changed. Winner receives the
   authoritative winner amount (4270000000 nano in the regression test); Owner
   gross share is calculated normally (230000000 nano); exactly
   `ROOM_WALLET_POLICY.ownerRetainedNano` = 10000000 nano (0.01 GRAM) stays in the
   Room Wallet; Owner receives `buildOwnerPayout().ownerPayoutNano` = 220000000
   nano. Gas is paid by the source Room Wallet; no gas is deducted from the winner
   or the Owner payout. `RoomWalletFinancialPolicy.js` is untouched.
2. Smart-contract player-payment logic was NOT reintroduced. No smart contract,
   no GameEscrow settlement path, and no legacy adapter was added or re-enabled.
   `isRoomWalletOnlyFinancialPath()` and the Room-Wallet-only architecture are
   unchanged. The fix only sequences and confirms existing plain TON transfers.
3. No Room Wallet secrets, private keys, mnemonics, or credentials were added to
   the repository. Tests use `tests/helpers/dummyRoomWallet.js`-derived dummy
   identities (deterministic seeds, not production keys). No Railway Variables,
   Vercel configuration, production wallet catalogs, or network configuration were
   modified. Nothing was deployed.
4. Git discipline: per task instructions, NO commits and NO pushes were made.
   The only workspace changes are the two modified implementation files, the new
   test file, and this report.

## 12. Statement on the Original Production Failure Pattern

The pattern "winner payout + owner payout submitted as two independent external
transactions with the same Room Wallet seqno" is now structurally prevented at two
levels: (a) `RoomWalletAdapter` serializes all outbound sends per wallet address
and refuses to sign a new transfer until the authoritative chain seqno has
advanced past the previous broadcast (fail-closed instead of reusing the seqno);
(b) `RoomWalletSettlementAdapter.settleContract()` confirms the winner payout
on-chain with the existing `confirmPayoutOnChain` primitive before the owner
payout is submitted, and confirms the owner payout before settlement completes.
Partial recovery (winner confirmed / owner missing) now sends only the missing
owner payout, requires only the owner payout plus the source-wallet gas reserve,
and uses a fresh authoritative seqno. The regression suite reproduces the exact
production amounts and initial seqno 31 and proves the second transaction uses
seqno 32 only after positive confirmation.

## Risks

- Low: `RoomWalletAdapter` now waits (bounded, default 90 s) for seqno advance
  between consecutive sends from one wallet, including refund flows; this makes
  multi-refund sequences slower but removes the same-seqno failure class.
- Low: if a broadcast is accepted by the transport but never lands on-chain, the
  next send fails closed with `SEQNO_CONFIRMATION_TIMEOUT` (retryable) instead of
  reusing the seqno; recovery relies on the existing history re-inspection and
  duplicate-evidence scan, unchanged.
- Low: environments whose transport cannot read transactions keep the legacy
  no-observation behavior (`observed: false` fallback) — unchanged from before
  this fix; the adapter-level seqno gate still protects them.

## Recommendations

1. Investigate the pre-existing failures documented in section 9 in a separate
   sprint (payment-intake registry wiring and ContractSettlementManager harness
   behaviors are the largest groups).
2. Consider observability: emit a metric/log line when the seqno safety hold
   engages (the adapter already logs a warning).
3. Consider surfacing `preflightRemainingOwner` evidence in operator tooling for
   partial settlements (the frozen payload already exposes the remaining
   requirement).

## Changes Made

- `server/payment/roomWallet/RoomWalletAdapter.js` (modified)
- `server/payment/roomWallet/RoomWalletSettlementAdapter.js` (modified)
- `server/tests/roomWalletSettlement.seqnoSequencing.test.js` (new)
- `AI_CONTEXT/CLINE_REPORTS/2026-09-30_room_wallet_sequential_settlement_seqno_fix.md` (new, this report)

## FINAL VERDICT

The production failure pattern "winner payout + owner payout submitted as separate
transactions with the same Room Wallet seqno" IS PREVENTED by the implemented code
and tests. Two independent outbound transfers from one Room Wallet can no longer
use the same seqno: the adapter gate makes reuse fail-closed
(`SEQNO_CONFIRMATION_TIMEOUT` / `SEQNO_CONFIRMATION_UNAVAILABLE`), and settlement
itself now waits for positive on-chain confirmation of the winner payout before
submitting the owner payout, and confirms the owner payout before
`SETTLEMENT_COMPLETED`. This is proven by the deterministic regression suite
(13/13 passing), including the exact production-evidence test (winner
4270000000 nano on seqno 31, owner 220000000 nano on seqno 32, owner submitted
only after the winner transaction was positively observed on-chain).
