# GameEscrow Deployment TonCenter HTTP 429 Seqno Retry Fix

Date: 2026-09-05

Task: Targeted implementation fix so the live GameEscrow deployment seqno RPC uses the existing centralized TON retry mechanism. A real Production three-player session failed with TonCenter HTTP 429 before any deployment transaction was broadcast.


## Primary verdict

**PASS**

`legacyTonServiceShim.getSeqno()` no longer calls `tonClient.runMethod` without retry. The seqno RPC now goes through the existing `executeWithRetry()` / `isInfrastructureFailure()` helpers and `DEFAULT_TON_RETRY_POLICY`. A transient TonCenter HTTP 429 is retried up to three attempts. Persistent 429 still fails with the original provider error (`status=429`, message `TonCenter HTTP 429`). No Residual Sweep, wallet, reimbursement, or room-lifecycle changes were made. No Production game was launched.


## 1. Scope

Fixed only the GameEscrow deployment-preparation seqno RPC on the legacy TonService shim path used by Production `TonGameContractAdapter`.

In scope:

- Confirm the Production failure (`roomId=yQ7t`, `gameId=game_fd106b16-833c-4cde-a380-88d18b24e9aa`).
- Inspect the live call chain and the existing TonService retry infrastructure.
- Route `legacyTonServiceShim.getSeqno()` through `executeWithRetry()` + `isInfrastructureFailure()`.
- Preserve TupleReader `readNumber()` parsing, return type, deployment flow, per-deployer mutex, signing, and broadcast.
- Add focused seqno 429 retry tests and keep existing deployment tests green.
- Create one Git commit. Do not launch a Production game.

Out of scope:

- Residual Sweep policy, Residues Wallet identity, wallet funding, reimbursement architecture.
- TonService redesign, a second retry framework, room-lifecycle redesign.
- Retrying a successful blockchain broadcast.
- Artificial game events, fake settlements, or manual financial transactions.


## 2. Files Inspected

- `server/payment/ton/gameContract/legacyTonServiceShim.js`
- `server/payment/TonGameContractAdapter.js`
- `server/app.js`
- `server/services/TonService.js`
- `server/services/ton/TonServiceRetry.js`
- `server/payment/ton/TonCenterTransport.js`
- `server/diagnostics/DeployPipelineForensics.js`
- `server/tests/legacyTonServiceShim.test.js`
- `server/tests/tonGameContractAdapter.test.js`
- `server/tests/tonGameEscrowDeploy.test.js`
- `server/tests/deployerSeqnoConfirmation.test.js`
- `server/tests/tonService.test.js`
- `server/payment/roomWallet/RoomWalletFinancialPolicy.js` (read-only confirmation that financial constants were not touched)

Files changed:

- `server/payment/ton/gameContract/legacyTonServiceShim.js`
- `server/tests/legacyTonServiceShim.test.js`
- `AI_CONTEXT/CLINE_REPORTS/2026-09-05_r18_s48_gameescrow_toncenter_429_deploy_retry.md`


## 3. Architecture Findings

### 3.1 Confirmed Production failure

Real Production session:

| Field | Value |
| --- | --- |
| roomId | `yQ7t` |
| gameId | `game_fd106b16-833c-4cde-a380-88d18b24e9aa` |
| Provider | TonCenter |
| HTTP status | 429 |
| Provider body | `{"ok":false,"result":"Ratelimit exceed","code":429}` |
| Debug | `deployStarted=true`, `currentStage=FAILED`, `errorName=Error`, `errorMessage="TonCenter HTTP 429"`, `tonCenterStatus=429` |
| Resulting states | `DEPLOY_FAILED` → `PAYMENT_FAILED` → `ROOM_DESTROYED` |
| Blockchain tx | `deploymentTxId=null`, `transactionHash=null` |

This was a provider rate-limit failure during GameEscrow deployment preparation. No deployment transaction was created. It was not a smart-contract failure.

### 3.2 Exact failure path

Production `server/app.js` constructs the live adapter **without** passing `tonService`:

```javascript
new TonGameContractAdapter({
    logger: this._logger,
    tonConfig: this._tonConfig,
    transport: this._services.tonService.getTransport(),
    tonClient: this._services.tonService.getClient()
});
```

`TonGameContractAdapter._service()` therefore falls back to `createLegacyTonServiceShim({ transport, tonClient, tonConfig })`.

Confirmed path:

```
TonGameContractAdapter._broadcastDeploy
  → _sendOracleMessage
    → this._service().getSeqno(deployerAddress)
      → legacyTonServiceShim.getSeqno
        → tonClient.runMethod(Address.parse(walletAddress), "seqno", [])
          → TonCenter HTTP 429
```

The failure happened before `broadcastTransaction`. Signing and BOC send were never reached.

### 3.3 Code-level root cause

Centralized retry already existed:

- `server/services/TonService.js` `_executeRpc()` wraps RPC with `executeWithRetry()`.
- `server/services/ton/TonServiceRetry.js` already classifies HTTP 429 as retryable (`status === 429`, `"http 429"`, `"status code 429"`, `"too many requests"`).
- Default policy:

```
maxAttempts: 3
initialDelayMs: 250
maxDelayMs: 2000
multiplier: 2
timeoutMs: 10000
```

The live GameEscrow deployment path did not use TonService. It used the legacy shim, whose `getSeqno()` called `tonClient.runMethod` directly and therefore bypassed retry.

Direct delegation to `TonService.getSeqno()` was not used: TonService parses seqno from an array/tuple stack (`stack[0]`), while the shim and adapter depend on `@ton/ton` TupleReader `readNumber()` semantics (R7.50). Routing the existing `runMethod` + `readNumber()` call through `executeWithRetry()` is the smallest equivalent that preserves parsing and return type.

### 3.4 Retry behavior implemented

`legacyTonServiceShim.getSeqno()` now:

1. Parses the wallet address once (`Address.parse`).
2. Calls `executeWithRetry()` with `shouldRetry: isInfrastructureFailure` and `DEFAULT_TON_RETRY_POLICY` (optional `retryPolicy` overlay for tests only).
3. Inside each attempt: `tonClient.runMethod(address, "seqno", [])` then `result.stack.readNumber()`.
4. Retries only infrastructure failures, including HTTP 429.
5. Stops after `maxAttempts` (3). Does not retry indefinitely.
6. On exhausted retries, rethrows the original error, preserving `message`, `status` (429), and `responseBody` when present.
7. Does not wrap or retry `broadcastTransaction`. A successful seqno read proceeds to the existing sign/broadcast path unchanged.

Backoff for the production default policy:

- attempt 1 fails 429 → wait 250 ms
- attempt 2 fails 429 → wait 500 ms (capped by `maxDelayMs=2000`)
- attempt 3 fails 429 → propagate original error

A later successful attempt returns the numeric seqno and deployment continues.

### 3.5 Error propagation after retries are exhausted

No adapter, GameContractManager, or room-lifecycle change was required. After retries fail, `_sendOracleMessage` still throws, `pushTonDeployDebugStage("FAILED")` still records `errorMessage` and `tonCenterStatus` from `error.status`, and deploy still returns failure without inventing a transaction hash.

A transient 429 that recovers inside `getSeqno()` never reaches that failure path, which is the intended recovery.

Unchanged:

- per-deployer async mutex (`_withDeployerSendLock`)
- Wallet V4 signing
- BOC broadcast
- seqno-advancement confirmation after a real send


## 4. Lifecycle Flow

Deployment preparation after this fix:

1. Adapter enters `_broadcastDeploy` / `_sendOracleMessage`.
2. Deployer wallet is created from the existing mnemonic configuration.
3. Per-deployer send lock is acquired.
4. `getSeqno(deployerAddress)` is called on the legacy shim (Production wiring).
5. If TonCenter returns HTTP 429, the centralized retry policy retries the read-only seqno RPC.
6. If seqno succeeds, the existing transfer is signed and broadcast. Broadcast is not retried by this change.
7. If seqno still fails after three attempts, the original TonCenter 429 is thrown, deploy is marked failed, and no fake `deploymentTxId` / `transactionHash` is created.

Room states `DEPLOY_FAILED` / `PAYMENT_FAILED` / `ROOM_DESTROYED` remain the existing failure outcomes when retries cannot recover. No new room state was added.


## 5. Ownership Boundaries

| Concern | Owner | This change |
| --- | --- | --- |
| Live GameEscrow deploy seqno RPC | `legacyTonServiceShim.getSeqno` | Retry wrapper only |
| Retry classification / policy | `TonServiceRetry.js` | Reused, not redesigned |
| Deploy orchestration, mutex, signing, broadcast | `TonGameContractAdapter` | Unchanged |
| Room / payment lifecycle | `GameContractManager` / payment engines | Unchanged |
| Residual Sweep | `RoomWalletFinancialPolicy` / sweep worker | Unchanged |
| Residues / reimbursement wallets | existing reimbursement/residues config | Unchanged |
| TonService public API | `TonService.js` | Unchanged |

Production flags were not modified:

- `ROOM_WALLET_RESIDUAL_SWEEP_ENABLED=true` (left as previously enabled)
- `DEPLOYMENT_REIMBURSEMENT_ENABLED=false`
- `REIMBURSEMENT_ENABLED=false`

Financial constants were not modified:

- Residual Sweep threshold 0.50 Gram
- Residual Sweep amount 0.49 Gram
- Source reserve envelope 0.01 Gram
- Planned gas budget 0.006 Gram
- Storm/safety margin 0.004 Gram
- Transfer mode `SendMode.PAY_GAS_SEPARATELY`
- Residues Wallet remains the existing former Reimbursement Wallet


## 6. Risks

### Critical

None identified for this change. The seqno RPC is read-only and occurs before broadcast.

### High

Persistent TonCenter 429 still fails deployment after three attempts. This is correct: the fix recovers transient rate limits, not a sustained provider outage. A later game can still `DEPLOY_FAILED` if TonCenter remains rate-limited for the full retry window (~750 ms plus attempt runtime).

### Medium

- `broadcastTransaction` and shim `runGetMethod` still have no retry. This incident failed at seqno before broadcast. A 429 during `sendBoc` remains a separate path.
- Production adapter still does not receive the `TonService` instance, so other shim RPCs remain outside `_executeRpc`. That is intentional for this smallest fix.
- Each seqno attempt still has a 10 s timeout from `DEFAULT_TON_RETRY_POLICY`. That matches TonService and does not create an infinite loop.

### Low

- Tests overlay short delays (`initialDelayMs: 1`) onto the same policy object. Production continues to use the default 250/2000/2 policy.
- TupleReader parsing is unchanged; empty-stack still throws and is not classified as infrastructure failure, so it is not retried.


## 7. Recommendations

1. Deploy this commit to Production through the existing Railway git-source workflow. Do not launch a financial game solely to prove the retry.
2. After the next real three-player Production game, inspect deploy debug for `SEQNO_READ` versus `FAILED` / `tonCenterStatus=429`. A recovered 429 will not appear as a terminal deploy failure if retries succeeded.
3. If TonCenter 429 later appears on `sendBoc` or other shim RPCs, apply the same `executeWithRetry` wrapper to those read/write boundaries as a separate change. Do not expand this commit.
4. Keep Residual Sweep, Residues Wallet, and reimbursement flags unchanged.


## 8. Changes Made

### 8.1 `legacyTonServiceShim.getSeqno`

Imported `DEFAULT_TON_RETRY_POLICY`, `executeWithRetry`, and `isInfrastructureFailure` from `server/services/ton/TonServiceRetry.js`.

Wrapped the existing `tonClient.runMethod` + `result.stack.readNumber()` seqno operation in `executeWithRetry`. Public `getSeqno()` still returns a number. Optional `retryPolicy` argument overlays the default policy for tests; Production adapter construction does not pass it.

`broadcastTransaction`, `getAccount`, `getTransactions`, and `runGetMethod` were not changed.

### 8.2 Tests

Extended `server/tests/legacyTonServiceShim.test.js`:

| Case | Result |
| --- | --- |
| Seqno fails once with HTTP 429 then succeeds | PASS (2 `runMethod` calls, seqno `11`) |
| Seqno fails twice with HTTP 429 then succeeds | PASS (3 `runMethod` calls, seqno `22`) |
| HTTP 429 on every attempt stops at configured retry limit | PASS (3 calls, original `status=429` preserved) |
| Non-retryable error is not retried | PASS (`BOC was not accepted`, 1 call) |
| Successful TupleReader parsing still returns numeric seqno | PASS (`1` and `7`; empty stack still throws) |
| `TonGameContractAdapter` production wiring (transport + tonClient, no `tonService`) remains compatible and retries 429 | PASS |
| Existing R7.50 array-index regression | PASS |

Existing suites executed:

| Suite | Result |
| --- | --- |
| `server/tests/legacyTonServiceShim.test.js` | PASS |
| `server/tests/tonGameContractAdapter.test.js` | PASS |
| `server/tests/tonGameEscrowDeploy.test.js` | PASS |
| `server/tests/deployerSeqnoConfirmation.test.js` | PASS |
| `server/tests/tonService.test.js` | PASS |

### 8.3 Git

Exactly one commit, message:

```
fix: retry TonCenter 429 during escrow deployment
```

Commit hash: **PENDING_COMMIT_HASH**

Command used (PowerShell):

```powershell
git add -- server/payment/ton/gameContract/legacyTonServiceShim.js server/tests/legacyTonServiceShim.test.js AI_CONTEXT/CLINE_REPORTS/2026-09-05_r18_s48_gameescrow_toncenter_429_deploy_retry.md
git commit -m @"
fix: retry TonCenter 429 during escrow deployment
"@
```

Not pushed. No Production game was launched. No Railway Variables were changed. No wallet, mnemonic, or funding operation was performed.

### 8.4 Remaining limitations

- A sustained TonCenter 429 still fails GameEscrow deploy after three seqno attempts.
- Shim `broadcastTransaction` / `runGetMethod` remain unretried.
- This change does not by itself redeploy Production; the existing git-source workflow must pick up the commit.
- Proof of the defect fix is the focused tests and static inspection above, not a manufactured blockchain event.
