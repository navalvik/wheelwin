# R18-S16 — Deployment Reimbursement FAILED_RETRY and Olga Recovery

Date: 2026-09-01

Task: Investigate two residual issues from the latest completed TESTNET game. Do not reopen DepositContract economics, Page4, Telegram, RoomManager, anti-bot, or financial constants. Do not run another TESTNET game. Change production code only if evidence proves a defect that cannot succeed without a fix.

Network: TESTNET only.

---

## 1. Executive Summary

The only completed GAME_COMPLETED forensic archive in this workspace is room `csU9` / `game_fa881639-dc5c-42c1-90b9-5205f5475c5a`. That session completed Deposit → FundSeat × 3 → GameEscrow STAKE × 3 → Page5 → gameplay → SETTLE. Winner in settlement, recovery_data, and the diagnostic UI is **Olga**, not Lena.

**PART A — reimbursement.** `FAILED_RETRY` is not a GameEscrow get-method failure and not a SETTLE failure. The worker attempted a Reimbursement Wallet → Deploy Wallet transfer of the frozen deploy cost. Before broadcast it called `TonService.getSeqno()` → `runGetMethod(reimbursementWallet, "seqno", [])`. `@ton/ton` TonClient threw `Unable to execute get method. Got exit_code: -13`. `txHash` remained null. Live TESTNET `getAddressInformation` for that reimbursement wallet returned `state=uninitialized`, empty code/data, and a ~2 TON balance. Official TVM exit 13 is out-of-gas and is displayed as **-14**, not -13. `-13` here is the get-method failure on an account with no code. `ReimbursementWalletAdapter` did not attach Wallet V4 StateInit on first send (unlike `executeDepositTestnetDeploy`). Retries cannot succeed until that first-send path includes `init`. Smallest fix applied. Player stakes / winner SETTLE were already complete and were not the failing operation.

**PART B — Olga recovery.** Olga was **not** websocket-disconnected in this session. The diagnostic `FAILED / INCOMPLETE` / `session closed during recovery` block is tagged to **Lena** (`player_18aabfbd-...`, socket `G0AfFc5Htsj7wvpMAAAa`). Olga stayed CONNECTED, opened Page5, participated, and the result header is `YOU WIN`. Attempt #2 is log-close accounting when `GAME_DESTROYED` closed a leftover diagnostic `activeRecovery`. That is not a player-state restore failure and did not close the game.

Classifications:

```text
PART A  CONFIRMED BUG
        NO PLAYER-FACING FINANCIAL RISK

PART B  EXPECTED RACE / HARMLESS
        NO PLAYER STATE LOSS OBSERVED
```

---

## 1a. Scope (clinerules)

Analyzed only:

- `deployment_reimbursement` status `FAILED_RETRY` and `exit_code: -13`
- the recovery sequence attributed to Olga in the same TESTNET session

Out of scope: DepositContract economics, Page4 redesign, Telegram auth, Room ID protection, RoomManager, anti-bot, financial-constant changes, another live game.

---

## 2. Source TESTNET Session

Workspace forensic extract:

```text
ROOM     = csU9
GAME     = game_fa881639-dc5c-42c1-90b9-5205f5475c5a
NETWORK  = testnet
OUTCOME  = GAME_COMPLETED / SETTLEMENT_COMPLETED
```

Players:

```text
Olga  player_6138332d-39fb-4048-8c74-50cc56dbf6ad  seat 0  winner
Lena  player_18aabfbd-ec71-437d-a4e0-12b3e5f01dc1
Bob   player_0cba1a67-9494-4dda-9733-42211b66373f
```

Escrow: `EQDw0ScwoZQNAsufwhIlAzhYoPLYfDGrXxONzelImmwCopTV`  
Deploy tx: `ImqIYI7DqAJRZUxgXDGZdbbIirxRd21LVjD6dCc+iiY=`  
SETTLE tx: `6dbP2IXITp4H8ThgMXMDcemGr0waFtV0EpBdm7F6cGo=`  
Prize: winnerAmount 2.85 / organizerAmount 0.15 / totalPot 3

Reimbursement record:

```text
id              = 7ac90f697a98ab96a41a6f799117f4af7c38461917d3b0e20a31139e4136796d
status          = FAILED_RETRY
amountTon       = 0.023878622
txHash          = null
retryCount      = 5
confirmationAttempts = 0
deployWallet    = EQB83s9XMOMseDFxyXxj4hrC0sS4FB4xhdNiUPkl_3zx3PDQ
reimbursementWallet = EQD-ylhSs7YLUJpZymRiiX2HnovASnwS9LbhK9OidoveBZJE
errorReason     = Unable to execute get method. Got exit_code: -13
```

The user brief quoted `amountTon = 0.023865396` and `winner = Lena`. Neither value appears in this archive. No later GAME_COMPLETED forensic zip was found in the workspace or Downloads. This report treats `csU9` as the only evidenced completed session.

### Files Inspected

- `_forensic_csU9/ton-financial/active/deployment_reimbursement/7ac90f697a98ab96a41a6f799117f4af7c38461917d3b0e20a31139e4136796d.json`
- `_forensic_csU9/ton-financial/active/deployment_cost_snapshot/dab2c0643e2b4491200d4b24da04ffcad6b0314c5c1dd172a84d3ee59c2cadf9.json`
- `_forensic_csU9/ton-financial/active/settlement/game_fa881639-dc5c-42c1-90b9-5205f5475c5a.json`
- `_forensic_csU9/ton-financial/active/recovery_data/game_fa881639-dc5c-42c1-90b9-5205f5475c5a.json`
- `_forensic_csU9/diagnostic-logs/2026-09-01_07-39-46_ROOM_csU9_GAME_COMPLETED.log`
- `_forensic_csU9/session-history/2026-09-01_07-45-48_ROOM_csU9_GAME_game_fa881639-dc5c-42c1-90b9-5205f5475c5a_GAME_COMPLETED.json`
- `server/payment/reimbursement/ReimbursementWalletAdapter.js`
- `server/payment/reimbursement/DeploymentReimbursementWorker.js`
- `server/payment/reimbursement/DeploymentReimbursementRepository.js`
- `server/payment/reimbursement/ReimbursementTransferService.js`
- `server/services/TonService.js`
- `server/payment/ton/executeDepositTestnetDeploy.js`
- `server/logging/GameDiagnosticLogManager.js`
- `AI_CONTEXT/CLINE_REPORTS/2026-09-01_r18_s16_recovery_attempt_reconciliation_csU9.md`
- TESTNET: `https://testnet.toncenter.com/api/v2/getAddressInformation?address=EQD-ylhSs7YLUJpZymRiiX2HnovASnwS9LbhK9OidoveBZJE`
- TON docs: `https://docs.ton.org/v3/documentation/tvm/tvm-exit-codes`

---

## 3. PART A — Deployment Reimbursement

### 3.1 Exact production path

```text
SETTLEMENT_COMPLETED
    → DeploymentReimbursementService creates record PENDING
    → DeploymentReimbursementWorker.processQueue (pollIntervalMs default 5000)
    → listPending() includes FAILED_RETRY when nextRetryAt due and txHash empty
    → claim PROCESSING
    → ReimbursementTransferService.sendReimbursement
    → ReimbursementWalletAdapter.sendTransfer
         getBalance(reimbursementWallet)     ← succeeded (otherwise error would be insufficient_balance)
         WalletContractV4.create(...)
         tonService.getSeqno(this._address)  ← FAILED HERE
         createTransfer / external / broadcastTransaction  ← NOT REACHED
    → worker markFailed({ terminal: false }) → FAILED_RETRY
```

This is a **wallet-to-wallet TON transfer** of the frozen GameEscrow **deployment cost**, not a GameEscrow getter, not SETTLE, not FundSeat.

### Architecture findings

`ReimbursementWalletAdapter` is isolated from Owner/Deployer mnemonics and from GameEscrow/SETTLE (Stage O source assertions). Send is the only broadcast path. Confirmation never ran (`confirmationAttempts = 0`); `confirmationError` is copied from the send `errorReason` by `markFailed`.

### Lifecycle flow

Failure is **before broadcast**. `payload.txHash = null`. No reimbursement BOC was accepted by the network from this path.

### Ownership boundaries

- Deployment cost snapshot: frozen, immutable, `source=chain`.
- Reimbursement send: Reimbursement Wallet adapter only.
- Player pot / SETTLE: GameEscrow, already `SETTLEMENT_COMPLETED`.

### 3.2 Contract/address involved

Queried address:

```text
EQD-ylhSs7YLUJpZymRiiX2HnovASnwS9LbhK9OidoveBZJE
```

That is `payload.reimbursementWallet`, not the GameEscrow (`EQDw0Scw...`) and not the deploy wallet (`EQB83s9X...`).

Intended destination of the unpaid transfer: deploy wallet `EQB83s9XMOMseDFxyXxj4hrC0sS4FB4xhdNiUPkl_3zx3PDQ`.

### 3.3 Get method

```text
TonService.getSeqno(walletAddress)
    → runGetMethod(walletAddress, "seqno", [])
    → TonClient.runMethod(Address, "seqno", [])
```

Method name `seqno` is the Wallet V4 getter. It is the correct ABI **once the wallet contract is active**. It cannot run on an account with empty code.

### 3.4 Exact exit code

```text
Unable to execute get method. Got exit_code: -13
```

Stored as `payload.errorReason` and `payload.confirmationError`.

Official TON TVM table:

| Code | Meaning |
|------|---------|
| 13 | Out of gas (compute phase) |
| -14 | Same as 13, bitwise NOT so it cannot be faked |

`-13` is **not** the documented out-of-gas display code.

### 3.5 Root cause

Live TESTNET account state for the reimbursement wallet (this investigation, read-only `getAddressInformation`):

```text
state    = uninitialized
code     = ""
data     = ""
balance  = 1999999999   (~1.999999999 TON)
```

An uninitialized account has no contract code. `runGetMethod("seqno")` therefore cannot execute. TonClient surfaces that as `exit_code: -13`.

This is **not**:

- a wrong GameEscrow ABI
- a GameEscrow invalid state
- a provider timeout / HTTP 500 (the message is the get-method wrapper)
- a post-broadcast confirmation mismatch

This **is**:

- missing/incorrect get-method invocation **against an uninit wallet** (the method name is right; the account has no code)
- plus a send-path defect: `external({ to, body })` without `init: wallet.init`

The Deposit testnet deployer already handles this:

```text
getSeqno catch → seqno = 0
external({ init: seqno === 0 ? wallet.init : undefined, body })
```

The reimbursement adapter did not.

### 3.6 Retry behavior

`FAILED_RETRY` **does** mean automatic retry.

Mechanism:

1. Worker timer: `setInterval(processQueue, pollIntervalMs)` default **5000 ms**, only if `DEPLOYMENT_REIMBURSEMENT_ENABLED`.
2. `listPending()` returns `PENDING` always, and `FAILED_RETRY` when `nextRetryAt` is null or `<= Date.now()`.
3. Records with a `txHash` are never re-sent.
4. `markFailed({ terminal: false })` increments `retryCount` and sets `nextRetryAt = now + 60000`.
5. Send failures in the worker always use `terminal: false`. There is **no max-retry promotion to FAILED_TERMINAL** on this send path.

Archive state: `retryCount = 5`, `txHash = null`, still `FAILED_RETRY`. Retries will keep calling the same `getSeqno` until the adapter can send with StateInit (after this fix) or the wallet is initialized by some other outbound.

### 3.7 Financial impact

| Bucket | Effect of this failure |
|--------|------------------------|
| Player stakes / GameEscrow pot | Unaffected. SETTLE already completed. |
| Winner payout | Unaffected. `winnerAmount = 2.85`, SETTLE tx present. |
| Organizer SETTLE fee | Unaffected. `organizerAmount = 0.15` already in the settlement record. |
| Deploy-wallet reimbursement (~0.023878622 TON) | **Not paid.** Amount remains in the uninitialized reimbursement wallet (balance ~2 TON). Retryable after StateInit send. |
| Double-pay risk from this failure | None. No broadcast, `txHash` null, worker will not resend once a hash exists. |

Classification of player-facing risk: **NO PLAYER-FACING FINANCIAL RISK**.

Operator/deploy-wallet reimbursement is incomplete until a successful first send. That is operational, not a player-pot defect.

### 3.8 Classification

```text
CONFIRMED BUG
NO PLAYER-FACING FINANCIAL RISK
```

Risks (clinerules):

- **High (operator, before fix):** infinite FAILED_RETRY; deploy wallet never reimbursed; reimbursement TON sits on an uninit account.
- **Low (after fix):** first send broadcasts StateInit + transfer; subsequent seqno>0 omits init. Not proven on Railway until the worker runs against this record.
- **Low:** catch-all on `getSeqno` treats any RPC throw as seqno 0. Same pattern as `executeDepositTestnetDeploy`. Wrong seqno on an already-active wallet is rejected on-chain rather than silently double-spending.

---

## 4. PART B — Olga Recovery

### 4.1 Disconnect evidence

Olga (`player_6138332d-...`) has **no** `[RECOVERY] disconnect`, **no** `soft disconnect`, and **no** `connection DISCONNECTED` in the csU9 diagnostic log.

The only soft disconnects are Lena:

```text
07:42:43  transport close  Lena  socket G0AfFc5Htsj7wvpMAAAa
07:44:13  transport close  Lena  socket G0AfFc5Htsj7wvpMAAAa
```

### 4.2 Reconnect evidence

Lena reconnected twice on the **same** socket id `G0AfFc5Htsj7wvpMAAAa` (`bound=true`).

Olga at 07:44:56: `connection CONNECTED`, `NAV_OPEN_PAGE5`, `NAVIGATION_PAGE5`, socket `p6ApiawNmSp-1H7oAAAe`. That is gameplay navigation, not a disconnect/reconnect pair.

### 4.3 Ownership mapping

| Time | Player | Socket | Notes |
|------|--------|--------|-------|
| join | Olga | (creator) | player_6138332d |
| 07:42:43–07:44:39 | Lena | G0AfFc5Htsj7wvpMAAAa | same-id protected reconnect |
| 07:44:56+ | Olga | p6ApiawNmSp-1H7oAAAe | Page5 client diag, stayed CONNECTED |
| 07:45:20 | Lena | G0AfFc5Htsj7wvpMAAAa | RECOVERY_STARTED then recovery completed (player) |

No evidence that Olga's socket was rebound or stolen. Multi-player maps `_socketToPlayer` / `_playerToSocket` / `_recoveryOwnershipBySocket` / `_recoveryOwnershipByPlayer` were not rewritten in this task; prior isolation tests remain the proof of those maps.

### 4.4 Restore attempt

Diagnostic RECOVERY FAILURE Attempt #2:

```text
Player ID:  player_18aabfbd-ec71-437d-a4e0-12b3e5f01dc1   (Lena)
Socket ID:  G0AfFc5Htsj7wvpMAAAa
Failure:    session closed during recovery
Last step:  SESSION_RECOVERY_REQUEST
```

That is **not Olga**.

`GameDiagnosticLogManager._closeSession` (reason `GAME_DESTROYED`) calls `_failRecoveryAttempt` if `activeRecovery` is still open, default reason `"session closed during recovery"`.

At 07:45:20 Lena already had `RECOVERY_STARTED` and `recovery completed (player)` / PLAYER_RECOVERED, then another `SESSION_RECOVERY_REQUEST` with `bound=true`. Attempt #1 SUCCESS is that gameplay recovery. Attempt #2 FAILED is leftover diagnostic accounting at destroy ~32 seconds later.

`[R18-S16 Recovery] deposit projection restored` is **not copied** into the room diagnostic file (established in the csU9 recovery reconciliation report). Therefore `restoreDepositProjectionForSocket()` is **not proven from this log** for anyone; it is also **not required for Olga**, who never disconnected.

### 4.5 Projection

Olga reached Page5 with a live payment-stage UI (`NAV_OPEN_PAGE5`, later `YOU WIN` / Page6). Deposit → FundSeat → STAKE for all three players completed. A valid deposit projection for Olga as an active funded player is evidenced by the completed financial lifecycle, not by a reconnect restore log line.

`projectDepositForPlayer()` as a recovery-time call for Olga: **not evidenced** (no Olga restore path).

### 4.6 Session-close interaction

```text
07:45:48  Olga YOU WIN / Page6
07:45:48  Bob YOU LOST / Page6
07:45:52  GAME_DESTROYED  → diagnostic log closing
```

Session closed because the completed game was destroyed, **after** settlement UI. Recovery did not trigger closure. Closure marked leftover diagnostic recovery FAILED.

### 4.7 Final Olga state

- Remained an active player (no disconnect).
- Reached Page5.
- Participated in the completed game.
- Settlement winnerId = Olga; diagnostic `headerMessageText=YOU WIN`.

### 4.8 Financial state

Olga's stake was in the pot; she received `winnerAmount = 2.85`. Recovery_data status `TERMINAL`. No evidence of lost deposit session, lost seat, or lost wallet binding for Olga.

### 4.9 Classification

```text
EXPECTED RACE / HARMLESS
NO PLAYER STATE LOSS OBSERVED
```

The user-facing phrase "Olga recovery FAILED" is a **mis-attribution** relative to this archive: the FAILED diagnostic attempt is Lena's leftover attempt at GAME_DESTROYED.

The same diagnostic race can tag **any** player whose `activeRecovery` is still open when the room log closes. That does not by itself prove `_socketToPlayer` / restore-engine failure. Independent Bob/Lena/Olga restore isolation tests were re-run in this task and passed; they were not contradicted by csU9.

---

## 5. Code Changes

Required for PART A only.

**Failing line (before fix):** `ReimbursementWalletAdapter.sendTransfer` awaited `getSeqno` without catch and built `external({ to, body })` with no `init`.

**Why it fails:** the reimbursement wallet is uninitialized. `seqno` cannot run. Broadcast is never reached. Automatic retry repeats the same get-method.

**Fix:** same first-send pattern as `executeDepositTestnetDeploy`:

- `getSeqno` throw → `seqno = 0`
- `external({ init: seqno === 0 ? wallet.init : undefined, body })`

PART B: no recovery-code change.

---

## 6. Exact Files Changed

```text
server/payment/reimbursement/ReimbursementWalletAdapter.js
server/tests/deploymentReimbursement.stageO.test.js
AI_CONTEXT/CLINE_REPORTS/2026-09-01_r18_s16_reimbursement_and_olga_recovery_investigation.md
```

Unchanged: DepositContract, GameEscrow, STAKE, SETTLE, Page4, Telegram, RoomManager, anti-bot, `TON_DEPOSIT_CREATION_FEE_PER_SEAT_NANO`, `deployValueNanotons`, player stake, FundSeat, `_socketToPlayer`, `_playerToSocket`, `_recoveryOwnershipBySocket`, `_recoveryOwnershipByPlayer`, `restoreDepositProjectionForSocket()`, `projectDepositForPlayer()`.

---

## 7. Focused Tests

```text
server/tests/deploymentReimbursement.stageO.test.js
  - uninit getSeqno exit_code -13 still broadcasts with StateInit
  - seqno>0 does not attach StateInit
  - existing FAILED_RETRY mock-broadcast path
server/tests/deploymentReimbursement.stageS.test.js
  - FAILED_RETRY nextRetryAt / worker skip
server/tests/depositProtectedReconnect.r18s16.test.js
  - three-player independent restore
  - restore order isolation
  - financial constants assertion
```

No full repository suite. No live TESTNET game.

---

## 8. Test Results

```text
deploymentReimbursement.stageO.test.js: OK
deploymentReimbursement.stageS.test.js: OK
depositProtectedReconnect.r18s16.test.js: 8 pass, 0 fail
```

---

## 9. Financial Constants Verification

Source not modified:

```text
DEPOSIT_CONTRACT_DEPLOY_VALUE_NANOTONS = "10000000"     DepositOrchestrator.js
TON_DEPOSIT_CREATION_FEE_PER_SEAT_NANO                  still env-required; tests still 1000000
player stake / FundSeat 11000000                        not edited
```

Focused reconnect test `R18-S16: financial constants and setup timeout remain unchanged` passed.

---

## 10. Multi-player Recovery Protection Verification

No replacement of player-specific recovery with a shared "current player" state. Maps and restore functions untouched. Isolation tests passed:

```text
R18-S16: three players independently restore without identity collision
R18-S16: three-player restore isolation does not depend on restore order
```

csU9 does not contradict those tests: Olga never entered the disconnect/restore path.

---

## 11. Anti-Bot Protection Verification

No Telegram, Room ID, or anti-bot source files were edited.

---

## 12. Railway Verification

Not performed as a live Railway log pull in this task.

Read-only TESTNET chain query of the reimbursement wallet succeeded (`uninitialized`).

After this commit is on `origin/main`, Railway may auto-deploy. Whether the existing `FAILED_RETRY` record then sends successfully is **NOT PROVEN** here. Do not treat push as confirmation of on-chain reimbursement.

---

## 13. Git Status

See section 14–15 after commit. Only the three files in section 6 are intended for this commit. Forensic extracts and unrelated dirty files stay untracked/uncommitted.

---

## 14. Commit Hash

Filled after commit.

---

## 15. Push Result

Filled after push.

---

## 16. FACT

- csU9 game completed with `SETTLEMENT_COMPLETED`; winnerId is Olga.
- Reimbursement record is `FAILED_RETRY`, `txHash=null`, `retryCount=5`, error `Unable to execute get method. Got exit_code: -13`.
- The only get-method on the send path before broadcast is `seqno` on the reimbursement wallet.
- Live TESTNET state of `EQD-ylhSs7YLUJpZymRiiX2HnovASnwS9LbhK9OidoveBZJE` is `uninitialized` with empty code and ~2 TON balance.
- Official TVM out-of-gas is 13 / display **-14**, not -13.
- Worker retries `FAILED_RETRY` automatically (`listPending` + 60s `nextRetryAt`); send failures are never marked `FAILED_TERMINAL`.
- Olga has no diagnostic disconnect. Lena has two. Diagnostic Attempt #2 FAILED names Lena's playerId and socket.
- Olga Page5 `NAV_OPEN_PAGE5` and later `YOU WIN` are in the diagnostic log.
- `ReimbursementWalletAdapter` previously omitted `wallet.init` on the external message.

---

## 17. INFERENCE

- `-13` from TonClient on `seqno` for this address is the get-method failure of an account with no code, not a GameEscrow compute-phase out-of-gas.
- Infinite retry would never pay the deploy wallet without StateInit on first send.
- User brief `winner = Lena` / `amountTon = 0.023865396` likely names a different display, rounding, or a session not present in this workspace — or swaps Olga/Lena. The archive contradicts both figures.
- Diagnostic Attempt #2 is leftover `activeRecovery` after Lena's successful PLAYER_RECOVERED, closed at GAME_DESTROYED.

---

## 18. NOT PROVEN

- That a later TESTNET session with Lena as winner and amount `0.023865396` exists outside this workspace.
- That `restoreDepositProjectionForSocket()` or `projectDepositForPlayer()` ran for Olga (no disconnect; those log lines are not in the room diagnostic file).
- That Railway has already applied this adapter fix or that the csU9 reimbursement will confirm on-chain after deploy.
- That catch-all `getSeqno` errors other than uninit `-13` cannot occur in production RPC flakes (same residual as the Deposit deployer path).
- Completeness of **all** operator financial flows: GameEscrow SETTLE completed; **deployment reimbursement did not**. Game completion ≠ reimbursement completion.

---

## 19. Final Verdict

```text
PART A  CONFIRMED BUG (reimbursement wallet uninit; seqno -13 before broadcast)
        NO PLAYER-FACING FINANCIAL RISK
        smallest fix: attach Wallet V4 StateInit when seqno is 0 / unavailable

PART B  EXPECTED RACE / HARMLESS (diagnostic close at GAME_DESTROYED)
        NO PLAYER STATE LOSS OBSERVED
        FAILED attempt is Lena, not Olga; Olga never disconnected
        no recovery-code change
```

Main player-facing flow remains the successful csU9 TESTNET game. These two residuals are independent of that success. Reimbursement of deploy cost was incomplete and retry-stuck; player pot settlement was not.

---

## Recommendations

1. After Railway deploy, inspect the same reimbursement record: expect `txHash` set and status progressing to confirmed, or a new error class if send-allow/policy blocks it.
2. Do not treat diagnostic Attempt #2 FAILED as a per-player restore engine bug without matching disconnect + restore logs for that playerId.
3. Optional later (not done here): complete leftover diagnostic attempts on PLAYER_RECOVERED so GAME_DESTROYED does not emit a false FAILED. That is observer-quality, not player-state.

---

## Changes Made

```text
ReimbursementWalletAdapter.sendTransfer: seqno catch + StateInit on seqno === 0
deploymentReimbursement.stageO.test.js: uninit -13 and active seqno regressions
this report
```
