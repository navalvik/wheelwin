# R18-S16 — Page4 TESTNET Deposit Deployment Diagnostic Preparation

Date: 2026-09-01

Task: Make the next real Telegram Page4 Deposit deployment session diagnostically complete so wallet confirm, broadcast, chain observation, and activation can be distinguished. Do not run TESTNET in this task.

Classification: **LOGGING ONLY. PAGE4 DEPLOY PATH PRESERVED. AUTHORITATIVE PACKAGE UNCHANGED. REAL TESTNET NOT RUN.**

---

## 1. Scope

Inspect existing Page4 / Deposit logging. Add only the smallest diagnostic lines needed to classify the next live wallet result into:

```text
PACKAGE_VALUE_FAILURE
PAGE4_GATING_FAILURE
TRANSACTION_BUILD_FAILURE
TONCONNECT_SEND_FAILURE
WALLET_REJECTION
BROADCAST_FAILURE
CHAIN_OBSERVATION_FAILURE
DEPLOYMENT_FAILURE
ACTIVATION_FAILURE
```

Did not redesign Page4, DepositContract, GameEscrow, recovery maps, Telegram, RoomManager, Railway, or financial constants.

---

## 2. Files Inspected

- `client/src/pages/Page4Payment.jsx` (`handleConfirmInTelegramWallet`)
- `client/src/game/session/page4PaymentPhase.js` (`canDeployDeposit`)
- `client/src/game/session/authoritativeSessionModel.js` (`DEPOSIT_PACKAGE_PUBLISHED`)
- `client/src/game/session/clientDepositRestoreDiagnostics.js`
- `client/src/payment/buildDepositDeploymentTransaction.js`
- `client/src/payment/page4DepositActivationHandoff.test.js`
- `server/deposit/DepositOrchestrator.js` (`deployValueNanotons = "10000000"`)
- `server/deposit/projectDepositForPlayer.js`
- `server/deposit/DepositActivationVerificationCoordinator.js`
- `server/deposit/RealTonDepositBlockchainSource.js` (`getContractState` lastLt/lastHash)
- `server/deposit/DepositMonitor.js`
- `server/logging/GameDiagnosticLogManager.js`
- `server/config/rooms.js`

---

## 3. Architecture Findings

The authoritative package already publishes `deployValueNanotons = 10000000`. Page4 still builds the deploy request only from that package field (no client fallback).

Before this task, the **GameEscrow STAKE** path logged `TonConnect sendTransaction`, but the **Deposit deploy** path called `sendTransaction` with almost no structured stage logs. Wallet success was silent; failure was a single `console.error`. Server activation queried account state (`UNINIT` / `ACTIVE`) but did not emit a structured `CHAIN_OBSERVED` / `DEPOSIT_ACTIVE` INFO line.

TonConnect `sendTransaction` success is **USER_CONFIRMED** at the wallet API. It is not proven broadcast and not proven on-chain. The API may return `{ boc }` but does not reliably expose a blockchain tx hash at this layer. This task does not invent one.

---

## 4. Lifecycle Flow

```text
DEPOSIT_PACKAGE_PUBLISHED
        ↓
Page4 DEPOSIT_PACKAGE_RECEIVED (existing client restore log, includes deployValueNanotons when present)
        ↓
canDeployDeposit()  →  GATE log
        ↓
buildDepositDeploymentTransaction()  →  BUILD log (amount vs packageDeployValueNanotons)
        ↓
TonConnectUI.sendTransaction()  →  SEND log
        ↓
wallet API returns or throws  →  WALLET_RESULT USER_CONFIRMED | WALLET_REJECTION | TONCONNECT_SEND_FAILURE
        ↓  (not observable as a separate client event)
broadcast / indexer
        ↓
activation poll getContractState  →  CHAIN_OBSERVED accountState=uninit|active lastLt lastHash
        ↓
getters + artifact match  →  DEPOSIT_ACTIVE
        ↓
FundSeat watch (existing monitor; not run in this task)
```

---

## 5. Ownership Boundaries

| Layer | Owner | This task |
|---|---|---|
| Package value | `DepositOrchestrator.freezeDepositPackage` | unchanged |
| Page4 gate / send | `Page4Payment.jsx` | logging only |
| Tx construction | `buildDepositDeploymentTransaction` | unchanged |
| Chain account state | `DepositActivationVerificationCoordinator` | logging only |
| Recovery maps | `RoomLobbyBridge` | unchanged |

---

## 6. Risks

### Medium — BROADCAST_SUCCESS still not a first-class client event

Wallet confirm ≠ broadcast. If funds return after USER_CONFIRMED, classify from missing `CHAIN_OBSERVED accountState=active` / missing `DEPOSIT_ACTIVE`, not from a client broadcast flag.

### Low — UNINIT CHAIN_OBSERVED is first-wait only

Repeat UNINIT polls are not re-logged, to avoid flooding. The first `WAITING_FOR_PLAYER_DEPLOYMENT` line is the pre-deploy baseline.

### Low — client logs are WebView console

`[R18-S16 Page4DepositDeploy]` is `console.info` on the client. Capture Telegram WebView / browser console. Server room archives ingest `[R18-S16 DepositChain]` only.

---

## 7. Recommendations

1. In the next live session, capture both WebView console and Railway / room diagnostic log.
2. Do not treat USER_CONFIRMED as deployment success until `CHAIN_OBSERVED accountState=active` and `DEPOSIT_ACTIVE`.
3. Do not claim the historical 0.011 TON bounce is fixed until that live session.

---

## 8. Changes Made

Logging-only. No gate, builder, send payload, or financial change.

---

# Verification Report (task sections 1–26)

---

## 1. Executive Summary

The next Page4 TESTNET deploy can now be staged:

| Stage | Observable |
|---|---|
| Package value | existing `DEPOSIT_PACKAGE_RECEIVED` + GATE `deployValueNanotons` |
| Page4 decision | GATE `canDeploy` / `action=deploy\|fund\|blocked` |
| Builder amount | BUILD `amount` and `packageDeployValueNanotons` |
| TonConnect call | SEND before `sendTransaction` |
| Wallet API | WALLET_RESULT `USER_CONFIRMED` / `WALLET_REJECTION` / `TONCONNECT_SEND_FAILURE` |
| Chain | CHAIN_OBSERVED `accountState` + optional `lastLt` / `lastHash` |
| Activation | DEPOSIT_ACTIVE |

**AUTHORITATIVE PACKAGE:** `deployValueNanotons = 10000000`  
**PAGE4:** existing production deployment path preserved  
**REAL TESTNET:** not run by this task  

---

## 2. Existing Diagnostic Flow

Already present before this task:

- Client restore logs on `DEPOSIT_PACKAGE_PUBLISHED` (`deployValueNanotons` only when present)
- GameEscrow path: `[Page4Payment] TonConnect sendTransaction` + rejection dump
- Deposit deploy path: only `console.error` on catch
- Server: activation events `DEPOSIT_ACTIVATION_WAITING` / `VERIFIED`; account `UNINIT`/`ACTIVE` internally
- FundSeat observations carry `transactionHash` inside the monitor, not as a Page4 deploy log

---

## 3. Package Logging

**Checkpoint A**

Existing:

```text
[R18-S16 ClientDepositRestore] event=DEPOSIT_PACKAGE_RECEIVED | ... | deployValueNanotons=10000000
```

New GATE line repeats the package value actually seen at click time (omitted if null — no fallback).

Required live value: `deployValueNanotons=10000000`. Absence → `PACKAGE_VALUE_FAILURE` / `PAGE4_GATING_FAILURE`.

---

## 4. Page4 Gating Logging

**Checkpoint B**

```text
[R18-S16 Page4DepositDeploy] event=GATE | canDeploy=true|false | canFund=... | action=deploy|fund|blocked | deployValueNanotons=...
```

`canDeployDeposit() = true` is `canDeploy=true` and `action=deploy`.

---

## 5. Transaction Builder Logging

**Checkpoint C**

Builder still uses `depositProjection.package.deployValueNanotons` only.

```text
event=BUILD | amount=10000000 | packageDeployValueNanotons=10000000 | hasStateInit=true
```

If `amount` ≠ package value → `TRANSACTION_BUILD_FAILURE`. Silent substitution would show here.

---

## 6. TonConnect Logging

**Checkpoint D**

```text
event=SEND | action=deploy | amount=10000000 | validUntil=...
```

Logged immediately before `tonConnectUI.sendTransaction(transactionObject)`. If GATE/BUILD exist and SEND does not, the call was not reached.

---

## 7. Wallet Result Logging

**Checkpoint E**

Success:

```text
event=WALLET_RESULT | outcome=USER_CONFIRMED | hasBoc=true|false | bocLength=... | resultType=...
```

No tx hash is invented. `hasBoc` is whatever TonConnect returns.

Failure after SEND:

```text
outcome=WALLET_REJECTION     (UserRejectsError / code 300 / "reject")
outcome=TONCONNECT_SEND_FAILURE
```

Failure before SEND:

```text
outcome=TRANSACTION_BUILD_FAILURE
```

Limitation: USER_CONFIRMED is wallet-API success, not broadcast, not chain.

---

## 8. Broadcast Logging

**Checkpoint F — limitation (documented, not invented)**

There is still **no** client or server `BROADCAST_SUCCESS` event for player-signed Deposit deploy. The backend does not submit that transaction.

Available after the fact:

- Client: `USER_CONFIRMED` + optional `boc`
- Server: `CHAIN_OBSERVED` `lastLt` / `lastHash` when TON account reports them
- FundSeat later: monitor `transactionHash` on inbound messages

If USER_CONFIRMED and chain stays `uninit` → treat as `BROADCAST_FAILURE` or `DEPLOYMENT_FAILURE` / bounce, not a generic “payment failed”.

---

## 9. Blockchain Observation Logging

**Checkpoint F/G**

First UNINIT wait:

```text
[R18-S16 DepositChain] event=CHAIN_OBSERVED | accountState=uninit | lastLt=... | lastHash=... | activationStatus=WAITING_FOR_PLAYER_DEPLOYMENT
```

When account is no longer UNINIT:

```text
event=CHAIN_OBSERVED | accountState=active | lastLt=... | lastHash=...
```

These lines are copied into the room diagnostic archive.

---

## 10. Deposit State Logging

**Checkpoint G**

After getters + artifact match:

```text
event=DEPOSIT_ACTIVE | accountState=active | activationStatus=VERIFIED | codeHash=...
```

Expected later (not executed here): FundSeat → `paidMask = 7`, `totalCredited = 33000000`, `STATUS_FULL`. Existing monitor/on-chain verification remains the source.

---

## 11. Exact Diagnostic Gaps Found

| Gap | Status after this task |
|---|---|
| Deploy `sendTransaction` not logged | **closed** (SEND) |
| Wallet success silent | **closed** (USER_CONFIRMED) |
| Wallet reject vs bridge error | **closed** (coarse classifier) |
| Builder amount vs package | **closed** (BUILD) |
| UNINIT vs ACTIVE in Railway INFO | **closed** (CHAIN_OBSERVED) |
| VERIFIED as DEPOSIT_ACTIVE line | **closed** |
| Separate BROADCAST_SUCCESS | **still open** (architecture) |
| Client boc → chain tx hash | **still open** (API limitation) |
| Page4Deploy lines in room zip | **still open** (client console only) |

---

## 12. Changes Made

- Page4 deposit confirm: GATE / BUILD / SEND / WALLET_RESULT `console.info`
- Activation coordinator: CHAIN_OBSERVED (first UNINIT; any non-UNINIT) and DEPOSIT_ACTIVE
- Room log ingest of `[R18-S16 DepositChain]`
- Focused formatter tests

No change to `canDeployDeposit`, builder math, send payload, recovery maps, or timeouts.

---

## 13. Exact Files Changed

- `client/src/pages/Page4Payment.jsx`
- `client/src/payment/page4DepositDeployDiagnostics.js` (new)
- `client/src/payment/page4DepositDeployDiagnostics.test.js` (new)
- `server/deposit/DepositActivationVerificationCoordinator.js`
- `server/diagnostics/depositChainDiagnostics.js` (new)
- `server/logging/GameDiagnosticLogManager.js`
- `server/tests/depositChainDiagnostics.test.js` (new)
- `server/tests/gameDiagnosticLogManager.test.js`
- This report

---

## 14. Focused Tests

```text
cd server
node --test tests/r18DepositProjection.test.js tests/depositChainDiagnostics.test.js tests/gameDiagnosticLogManager.test.js tests/depositActivationVerification.r179l22.test.js tests/depositActivationOrdering.r18s15.test.js

cd client
node --test src/payment/page4DepositDeployDiagnostics.test.js src/payment/page4DepositActivationHandoff.test.js src/payment/buildDepositDeploymentTransaction.test.js src/game/session/page4PaymentPhase.test.js
```

---

## 15. Test Results

Server focused: **pass 38, fail 0** (includes activation security suite + projection `deployValueNanotons=10000000` + DepositChain ingest).

Client focused: **pass 43, fail 0** (includes `canDeployDeposit` from authoritative `10000000`, builder amount `10000000`, handoff, new diagnostic tests).

---

## 16. Financial Constants Verification

Unchanged:

```text
deployValueNanotons = 10000000
TON_DEPOSIT_CREATION_FEE_PER_SEAT_NANO = 1000000
player stake = 10000000
FundSeat = 11000000
DEFAULT_PAYMENT_SESSION_DURATION_MS = 480000
DEFAULT_SETUP_DURATION_MS = 480000
```

No `deployValueNanotons ?? 10000000` client fallback.

---

## 17. Recovery Protection Verification

Did not modify `_socketToPlayer`, `_playerToSocket`, `_recoveryOwnershipBySocket`, `_recoveryOwnershipByPlayer`, `restoreDepositProjectionForSocket()`, or `projectDepositForPlayer()`.

---

## 18. Anti-Bot Verification

Did not modify Telegram authorization, Room ID authorization, RoomManager, room-creation quota, or anti-bot protection.

---

## 19. Railway Verification

```text
Railway changes = none
```

New lines use existing LoggerService / `console.info`. No new env vars.

---

## 20. Git Status

Intended files only (plus this report). Unrelated forensic extracts and older reports not staged.

---

## 21. Commit Hash

```text
0460602 chore(deposit): improve Page4 deployment diagnostics
```

---

## 22. Push Result

---

## 23. FACT

- Authoritative package remains `deployValueNanotons = 10000000`.
- Page4 still deploys only from that package field.
- Deposit `sendTransaction` is now preceded by SEND and followed by WALLET_RESULT.
- Server now logs first UNINIT observation and ACTIVE / VERIFIED as distinct events.
- Focused package / Page4 / builder / activation tests passed.
- Real TESTNET was not run.

---

## 24. INFERENCE

- If the next live wallet shows `0.01 TON` and USER_CONFIRMED, the previous `deployValueNanotons = null` gate is no longer the blocker.
- If USER_CONFIRMED then chain stays UNINIT, the failure is after the wallet API (broadcast / bounce / deploy), not Page4 gating.

---

## 25. NOT PROVEN

- Live wallet now sends `0.01 TON` successfully
- Broadcast success
- DepositContract becomes ACTIVE on TESTNET
- FundSeat / `paidMask = 7`
- Page5 reached
- Page4 adaptation complete
- Production readiness
- Historical 0.011 TON return is fixed

---

## 26. Final Verdict

```text
AUTHORITATIVE PACKAGE:
deployValueNanotons = 10000000

PAGE4:
existing production deployment path preserved

REAL TESTNET:
not run by this task

NEXT LIVE TEST:
must determine whether the wallet transaction now reaches
TonConnect sendTransaction and whether the resulting transaction
is broadcast and observed on-chain.
```

Do not claim the live wallet problem is fixed until a real TESTNET session proves it.
