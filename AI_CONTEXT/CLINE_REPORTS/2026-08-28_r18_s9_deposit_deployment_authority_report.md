# R18-S9 — Fix Authoritative Deposit Deployment Value and S6 TonConnect StateInit

Date: 2026-08-28
Task: Resolve the two R18-S8 blockers: (1) S6 builder wire-format defect, and (2) missing authoritative `deployValueNanotons` in the frozen Deposit package.

## 1. Scope

R18-S9 addresses the two STOP-condition blockers discovered during R18-S8:

1. **Blocker B (S6 wire-format defect)**: The S6 builder emitted `stateInit: { code, data }` (object), but the installed `@tonconnect/protocol` schema requires `stateInit?: string` — a single-cell BOC, base64-encoded. This is a proven, direct transport-compatibility defect.

2. **Blocker A (missing authoritative deployment value)**: The frozen Deposit package does not embed `deployValueNanotons`. The only deployment value is the test-only constant `L25_DEFAULT_DEPLOY_VALUE_TON = "0.05"`. No production config provides it.

## 2. Files Inspected

- `server/deposit/DepositOrchestrator.js`
- `server/deposit/projectDepositForPlayer.js`
- `server/config/ton.js`
- `server/.env.example`
- `server/.env` (read-only)
- `server/tests/testnet/r179l25/l25PlayerDepositDeploy.js`
- `client/src/payment/buildDepositDeploymentTransaction.js`
- `client/src/payment/buildDepositDeploymentTransaction.test.js`
- `client/node_modules/@tonconnect/protocol/lib/types/index.d.ts`
- `client/node_modules/@ton/core/dist/types/StateInit.js`

## 3. Blocked — No changes to server financial modules

The audit confirmed `deployValueNanotons` is **not** in any production source. `L25_DEFAULT_DEPLOY_VALUE_TON = "0.05"` is documented as TEST-ONLY in `server/.env.example` line 131. Per `.clinerules` Modification Approval Rule, **no authoritative production deployment value was fabricated**. The server financial state machine was not modified.

## 4. Fix Applied — S6 Wire Format (Blocker B)

### The Defect
S6 builder returned `stateInit: { code, data }` (object). Installed `@tonconnect/protocol` schema requires `stateInit?: string` — "Optional one-cell BoC StateInit, base64-encoded string."

### The Fix
Modified `reconstructAndVerifyStateInit` in `buildDepositDeploymentTransaction.js` (lines 78–87) to serialize the authoritative StateInit:

```js
const stateInitBocBase64 = beginCell()
    .store(storeStateInit(stateInit))
    .endCell()
    .toBoc()
    .toString("base64");
```


## 5. Blocker A — Remaining (Not Fixed)

The authoritative `deployValueNanotons` is **not available** in any production source. `projectDepositForPlayer.js` would deliver `null`. The S6 builder correctly fails closed on missing `deployValueNanotons`.

**Unblocking requirement**: The server must embed an authoritative, immutable `deployValueNanotons` in the frozen Deposit package. Requires architecture-review approval per `.clinerules`.

## 6. Address Verification (Preserved)

S6 builder continues to verify StateInit-derived address matches authoritative `depositAddress`. Unchanged.

## 7. Test Changes

Rewrote `buildDepositDeploymentTransaction.test.js` (was structurally broken — `buildValidParams` never closed before `describe()`, 0 tests registered; old object-format assertions). New file: 22 tests covering A1–A3 (valid construction, exact amount, address), B1–B3 (stateInit is base64 BOC string, decodes to authoritative code/data, matches expected), C1–C6 (fail-closed validation), D1–D2 (creator auth), E1–E3 (network/package), F1–F2 (amount authority), G1–G2 (no side effects), H1 (pure export).

## 8. Tests Executed and Results

## 14. Git State

HEAD: `7556092` (R18-S8 docs). Only S6 files + this report modified. Page4, S5 builder, server financial modules — all untouched (empty diffs).

## 15. Commit SHA

**`8a3f2c1`** — `R18-S9 fix S6 TonConnect StateInit wire format (Blocker B resolved; Blocker A documented)` — pushed to `origin/main`.

## 16. Remaining Gaps

1. **Blocker A**: No authoritative production `deployValueNanotons`. Server must embed it in frozen package. Requires architecture review.
2. **Page4 integration**: Deferred until server provides authoritative deployment value and S6 wire format verified end-to-end.
3. **GameContract deployment**: Not in scope.

---

## Verdict: `R18_S9_VERIFIED`

Blocker B (S6 wire-format defect) resolved with a proven minimal fix. Blocker A (missing authoritative deployment value) thoroughly audited and correctly left unfixed — no value fabricated. Report documents the exact unblocking requirement.

| Suite | Result |
|-------|--------|
| `buildDepositDeploymentTransaction.test.js` (S6) | **22/22 passed** |
| `buildFundDepositTransaction.test.js` (S5) | **all assertions passed** |
| `authoritativeSessionModel.test.js` (S4) | **all assertions passed** |
| `socketSyncLayer.test.js` | **passed** |
| `tests/r18S4DepositReconnect.test.js` (server S4) | **all assertions passed** (EXIT=0) |

## 9. Regression Confirmation

S5 builder — unchanged, tests pass. S4 transport/reconnect — unchanged, tests pass. `authoritativeSessionModel.js` — unchanged, tests pass. Server financial modules — unchanged.

## 10–13. Boundaries Confirmed

No blockchain transaction sent. Page4 unchanged. S5 builder unchanged.
The return object now includes `stateInitBocBase64`. The builder emits `stateInit: reconstructed.stateInitBocBase64` — pure transformation of already-authoritative `codeBoc`/`dataBoc`, no new authority.