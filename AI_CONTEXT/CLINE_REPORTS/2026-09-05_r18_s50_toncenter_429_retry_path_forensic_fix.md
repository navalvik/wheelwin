# Forensic Verification of the Real TonCenter 429 Retry Path

Date: 2026-09-05

Task: Prove why Production GameEscrow deploy still failed with TonCenter HTTP 429 after commit `41f0638`, then apply the smallest fix that retries the actual failing read RPC. Do not launch a game. Do not change Residual Sweep or wallets.


## Primary verdict

**PASS**

Production uses the **legacy shim**, not `TonService.getSeqno()`. The new archive (`stage=["START","FAILED"]`, `seqno=null`) matches a throw in **deployer balance preflight** `getAccount` → `TonCenterTransport`, which had **no retry**, not a failure of `executeWithRetry` on seqno.

`@ton/ton` **16.3.0** `HttpApi.doCall` throws `Received error: {"ok":false,"result":"Ratelimit exceed","code":429}` when HTTP 200 and `ok:false`. That shape was **not** classified as retryable by `isInfrastructureFailure()`. Axios HTTP 429 (`Request failed with status code 429`) already was.

Fix: classify the real HttpApi 429 body as infrastructure failure, and wrap shim `getAccount` in the existing `executeWithRetry()` (same policy as seqno). `sendBoc` is unchanged. One commit. No Production game.


## 1. Scope

Forensic proof of the live `_service()` object, `@ton/ton` 16.3.0 exception contract, retry classification, and whether retries ran. Then a targeted fix on the proven read-RPC gap only.


## 2. Files Inspected

- `server/app.js` (live `TonGameContractAdapter` construction)
- `server/payment/TonGameContractAdapter.js` (`_service`, `_broadcastDeploy`, `_sendOracleMessage`, deploy catch)
- `server/payment/ton/checkDeployerBalancePreflight.js`
- `server/payment/ton/gameContract/legacyTonServiceShim.js`
- `server/payment/ton/TonCenterTransport.js`
- `server/services/TonService.js` (`_createClients`, `_executeRpc`, `getBalance`)
- `server/services/ton/TonServiceRetry.js`
- `server/diagnostics/DeployPipelineForensics.js`
- `server/config/ton.js`
- `server/package.json` / `server/package-lock.json`
- `server/node_modules/@ton/ton/package.json` (16.3.0)
- `server/node_modules/@ton/ton/dist/client/api/HttpApi.js` (`doCall`)
- `server/node_modules/@ton/ton/dist/client/TonClient.js`
- `server/payment/BlockchainMonitor.js` / Room Wallet adapters (monitor 429 competition)
- Tests: `legacyTonServiceShim.test.js`, `deployerBalancePreflight.test.js`, `deployerSeqnoConfirmation.test.js`, adapter/deploy/TonService suites


## 3. Architecture Findings

### Proven facts

#### Production failure

| Field | Value |
|-------|--------|
| SHA deployed | `41f0638da14c505dd58b125974931885998b6f35` |
| roomId | `gGyz` |
| gameId | `game_598cd80a-3c81-4a51-adef-9f7063cdaeaa` |
| Provider body | `{"ok":false,"result":"Ratelimit exceed","code":429}` |
| Archive | `tonDeployDebug.stage = ["START", "FAILED"]`, `seqno=null`, `transactionHash=null`, `broadcastResult=null` |

No blockchain broadcast occurred.

#### Exact runtime path (live construction)

`app.js` live adapter **does not pass `tonService`**:

```javascript
new TonGameContractAdapter({
    logger, tonConfig,
    transport: this._services.tonService.getTransport(),
    tonClient: this._services.tonService.getClient()
});
```

`_service()` therefore returns `createLegacyTonServiceShim(...)`. The shim has **no `getBalance`**.

`_broadcastDeploy` awaits `checkDeployerBalancePreflight({ tonService: this._service() })` **before** any `WALLET_CREATE_*` / `SEQNO_READ` stage.

Preflight:

```
typeof getBalance === "function"  →  getBalance()   // TonService only
else getAccount()                 →  transport.getAddressInformation()  // Production shim
```

**Production uses path B (legacy shim), not TonService `_executeRpc`.**

The first RPC of a live deploy is **preflight `getAccount`**, not seqno.

`beginTonDeployDebug` sets `stage=["START"]`. Preflight stages are pushed **after** the await returns. If `getAccount` **throws**, the outer `deployContract` catch pushes `FAILED`. Resulting archive: `["START","FAILED"]`, `seqno=null`. That is the gGyz archive.

Commit `41f0638` only wrapped **shim `getSeqno`**. Preflight never reached seqno.

#### Actual `@ton/ton` version

Resolved lockfile and `npm ls`: **`@ton/ton@16.3.0`**. Railway image is built from `/server` with this lockfile. Axios is a dependency of `@ton/ton` (`^1.15.0`).

#### Actual exception shapes

**A. TonCenterTransport (preflight `getAccount`, monitor `getTransactions`)**

HTTP status not OK → `Error("TonCenter HTTP 429")` with `error.status=429`, `responseBody`, `endpoint`, `method`.

`isInfrastructureFailure` already true (`status === 429` and message `http 429`). **Retry did not run** because `getAccount` did not call `executeWithRetry`.

**B. `@ton/ton` 16.3.0 `HttpApi.doCall` (seqno `runMethod`, TonService `getBalance`)**

- Axios default: HTTP 429 throws `AxiosError` `"Request failed with status code 429"` (`response.status=429`). Classifier **already true**.
- HTTP 200 and `data.ok === false`: `throw Error("Received error: " + JSON.stringify(res.data))`  
  Example: `Received error: {"ok":false,"result":"Ratelimit exceed","code":429}`  
  No `status` / `response.status`. Classifier **was false** (`41f0638`).

`_executeRpc` order (unchanged): `executeWithRetry` **then** `_normalizeRpcError`. Normalization cannot help if classification fails on the original throw.

#### Retry attempts on gGyz

Preflight `getAccount` had **one** attempt (no wrapper). That matches “FAILED immediately after START”. Seqno retry (3 × 250/500 ms) never started.

#### Root cause

1. Live deploy preflight uses shim `getAccount` → TonCenterTransport with no retry.
2. `@ton/ton` HttpApi 200/`ok:false` 429 string was not treated as infrastructure failure, so even seqno retry would skip that shape.

Contributing pressure (code-supported, not a redesign): one `TonService` owns **two** HTTP stacks to the same TonCenter endpoint — `TonClient` (axios: `getBalance`, `runMethod`) and `TonCenterTransport` (fetch: `getAccount`, `getTransactions`, `sendBoc`). Room Wallet monitor `getBalance`/`getTransactions` share those clients and can consume the same rate-limit budget as deploy. Monitor was not disabled.

#### Production TON config (no secrets)

From live `/health` after `41f0638` and `server/config/ton.js`:

- network **testnet**
- endpoint configured (`TON_ENDPOINT` or testnet profile; TonCenter JSON-RPC)
- `apiKeyConfigured=true` (`TON_API_KEY` passed into both `TonCenterTransport` `X-API-Key` and `new TonClient({ apiKey })`)
- Provider still returned 429 with a key present

Railway Variables were not read or written in this task.

### Fix

Retry policy **unchanged**: `maxAttempts: 3`, `initialDelayMs: 250`, `maxDelayMs: 2000`, `multiplier: 2`, `timeoutMs: 10000`.

| File | Change | Why |
|------|--------|-----|
| `server/services/ton/TonServiceRetry.js` | Classify `ratelimit exceed` and `Received error:` + `429` | Real HttpApi 16.3.0 body |
| `server/payment/ton/gameContract/legacyTonServiceShim.js` | `getAccount` uses same `executeWithRetry` / `isInfrastructureFailure` as seqno | Proven preflight throw |
| tests | Real exception shapes; preflight 429 → success / exhaust; `_service()` has no `getBalance` | Prove classification and attempts |

Not changed: `sendBoc` / `broadcastTransaction`, room lifecycle, TonService architecture, monitor, Residual Sweep, retry counts.

`broadcastTransaction` remains a separate send path (TonService already retries sendBoc via `_executeRpc`; shim sendBoc is still unretried — intentional).


## 4. Lifecycle Flow

After the fix, live deploy:

```
beginTonDeployDebug START
  → checkDeployerBalancePreflight
      → shim.getAccount
          → executeWithRetry (max 3) + isInfrastructureFailure
              → TonCenterTransport.getAddressInformation
  → PREFLIGHT_PASSED
  → _sendOracleMessage
      → WALLET_CREATED
      → shim.getSeqno
          → executeWithRetry + isInfrastructureFailure
              → TonClient.runMethod("seqno")
                  (Axios 429 or HttpApi "Received error: ...429")
  → sign / sendBoc (not blindly retried by this change)
```

If all three preflight attempts fail, archive remains `["START","FAILED"]` with original `status=429`, without a fake tx hash.


## 5. Ownership Boundaries

| Concern | Owner |
|---------|--------|
| Live GameEscrow deploy RPC | `TonGameContractAdapter` + legacy shim |
| Retry policy / classification | `TonServiceRetry.js` |
| TonCenter HTTP (fetch) | `TonCenterTransport` |
| TonCenter HTTP (axios) | `@ton/ton` TonClient HttpApi |
| Monitor balances / txs | `TonService` (already `_executeRpc`) |
| Residual Sweep / Residues | unchanged |


## 6. Risks

### Critical

None for this change. Only read RPCs are retried.

### High

Persistent TonCenter 429 for ~750 ms still fails deploy after three attempts. Policy was not increased.

### Medium

Monitor 429s continue and can compete with deploy. Not “fixed” by disabling monitoring.

### Low

Classifier `received error:` + `429` is string-based, matching HttpApi 16.3.0. Unrelated messages containing both tokens would also retry.


## 7. Recommendations

1. Deploy this commit through the existing Railway git-source workflow. Do not launch a game in this task.
2. Next validation: one real three-player Production session on the new SHA.
3. Keep Residual Sweep and reimbursement flags unchanged.


## 8. Changes Made

Source/tests listed above. No financial policy files changed.

### Verification

| Suite | Result |
|-------|--------|
| `legacyTonServiceShim.test.js` (HttpApi 429 classify; seqno 429→success / exhaust; getAccount 429→success / exhaust; `_service()` is shim without `getBalance`) | PASS |
| `deployerBalancePreflight.test.js` (shim preflight 429→success; exhaust 3 attempts) | PASS |
| `tonGameContractAdapter.test.js` | PASS |
| `tonGameEscrowDeploy.test.js` | PASS |
| `deployerSeqnoConfirmation.test.js` | PASS |
| `tonService.test.js` | PASS |

### Production (this task)

- Production code/variables: **not changed**
- Another game launched: **NO**
- Commit: see git log after this change-set (`fix: classify TonClient 429 as retryable`)

### Financial safety

Unchanged:

- Residual Sweep threshold 0.50 Gram, amount 0.49 Gram, reserve 0.01 Gram, gas 0.006 Gram, margin 0.004 Gram
- `SendMode.PAY_GAS_SEPARATELY`
- Residues Wallet identity
- Reimbursement disabled (`DEPLOYMENT_REIMBURSEMENT_ENABLED` / `REIMBURSEMENT_ENABLED` not written)
