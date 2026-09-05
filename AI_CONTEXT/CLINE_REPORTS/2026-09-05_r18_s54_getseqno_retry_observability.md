# GameEscrow getSeqno Retry Observability

Date: 2026-09-05

Task: Add low-noise structured retry logs for Production GameEscrow `getSeqno()` so the next real game can prove attempt 1/2/3 versus a single 429. Do not change retry policy, deploy, or launch a game.


## Primary verdict

**PASS**

Retry behavior is unchanged (`maxAttempts=3`, `initialDelayMs=250`, `multiplier=2`, `maxDelayMs=2000`, `timeoutMs=10000`). `executeWithRetry()` now emits `TON_RPC_RETRY_ATTEMPT` / `TON_RPC_RETRY_FINAL` on failed attempts and final outcome only (no first-attempt success spam). Local Axios 429 tests prove three attempt lines plus a final failure. One local commit. Not pushed. Production not deployed.


## 1. Scope

Observability only on the existing retry boundary used by Production GameEscrow `getSeqno` (legacy shim) and by TonService RPC retries (`getAccount`, `getBalance`, etc.) so concurrent 429s can be correlated by `operation=`.


## 2. Files Inspected

- `server/app.js` (adapter wiring: `transport` + `tonClient`, no `tonService`)
- `server/payment/TonGameContractAdapter.js` (`_service().getSeqno`)
- `server/payment/ton/gameContract/legacyTonServiceShim.js`
- `server/services/ton/TonServiceRetry.js`
- `server/services/TonService.js` (`_executeRpc`)
- `server/diagnostics/DeployPipelineForensics.js` (`getTonDeployDebug` correlation)
- `server/tests/legacyTonServiceShim.test.js`


## 3. Architecture Findings

Production path unchanged:

`_broadcastDeploy` → `_sendOracleMessage` → `_withDeployerSendLock` → `legacyTonServiceShim.getSeqno` → `executeWithRetry` → `TonClient.runMethod`.

Logging is inside `executeWithRetry`. Classification, delays, timeouts, and throw-last-error behavior are the same.


## 4. Lifecycle Flow

Failed attempt → `TON_RPC_RETRY_ATTEMPT` (with `willRetry` / `delayMs` when another attempt will run) → sleep if retrying → next attempt. After last failure or after a later success, `TON_RPC_RETRY_FINAL`. Successful first attempt: no new log.


## 5. Ownership Boundaries

Retry math stays in `TonServiceRetry`. Deploy correlation reuses in-memory `getTonDeployDebug()` (`roomId`, `gameId`, `operation`). No new persisted ID.


## 6. Risks

- **Low:** Additional stdout lines on retry/failure only.
- **Low:** `getTransactions` on the shim still has no `executeWithRetry` (pre-existing); monitor 429s there remain uncounted by this logger.


## 7. Recommendations

Push and deploy in a separate task. On the next real game, grep Railway for `[TON_RPC_RETRY_ATTEMPT]` / `operation=getSeqno`.


## 8. Changes Made

See Code changes below.


## Investigation basis

- SHA before this commit: `5ff73f464858cf7b6ec8f76889695cd2620930a7`
- Latest failing game: `game_52d95bb4-6e79-4c99-8621-133c0e4c8c5c` / room `7dhz`
- Stage: after `WALLET_CREATED`, `getSeqno` Axios 429, no broadcast
- Archive could not count attempts; this task is observability-only (no second retry layer)


## Code changes

| File | Change |
| --- | --- |
| `server/services/ton/TonServiceRetry.js` | `formatTonRpcRetryLog`, emit on attempt/final; optional `operationName` / `onRetryObservability`; policy numbers untouched |
| `server/payment/ton/gameContract/legacyTonServiceShim.js` | Pass `operationName` `getSeqno` / `getAccount` |
| `server/services/TonService.js` | Pass `_executeRpc` `operation` as `operationName` |
| `server/tests/legacyTonServiceShim.test.js` | Axios 429 attempt/final tests |

Retry policy constants were not edited.


## Tests

| Test | Result |
| --- | --- |
| getSeqno Axios 429 logs attempts 1-3 then FINAL failure | PASS |
| getSeqno Axios 429 then success logs FINAL success | PASS |
| getSeqno non-retryable error logs one attempt and FINAL | PASS |
| Existing shim 429 retry counts / classification | PASS |
| `tonService.test.js` | PASS |
| `deployerBalancePreflight.test.js` | PASS |
| `deployerSeqnoConfirmation.test.js` | PASS |

No live TonCenter. No blockchain. No Production credentials.


## Logging fields

Stdout lines (Railway-visible), same family as `[R7.51 TON DEPLOY]`:

`[TON_RPC_RETRY_ATTEMPT] operation=getSeqno | attempt=1|2|3 | maxAttempts=3 | retryable=true|false | willRetry=true|false | status=429 | errorName=AxiosError | errorMessage=… | delayMs=250 | roomId=… | gameId=… | deployOperation=DEPLOY`

`[TON_RPC_RETRY_FINAL] operation=getSeqno | attempt=3 | maxAttempts=3 | success=false|true | retryable=… | willRetry=false | status=… | errorName=… | errorMessage=… | roomId=… | gameId=… | deployOperation=…`

- `roomId` / `gameId` / `deployOperation` filled from `getTonDeployDebug()` when a deploy snapshot exists.
- Message truncated to 160 characters. No request bodies, headers, API keys, mnemonics.
- First-attempt success is not logged.
- Concurrent TonService retries use the same lines with `operation=getAccount` / `getBalance` / `getTransactions` / `probe:getMasterchainInfo`.


## Production safety

- Production was **not** deployed.
- No Git push.
- No Railway Variable changes.
- No blockchain transaction.
- No wallet operation.
- Residual Sweep 0.50 / 0.49 / 0.01 / 0.006 / 0.004 Gram, `SendMode.PAY_GAS_SEPARATELY`, Residues Wallet identity, reimbursement disabled: **unchanged**.


## Git

See following section after commit.


## Final verdict

**PASS**
