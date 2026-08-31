# R18-S16 — Wire Proven Deposit Deploy Value Into the Authoritative Package

Date: 2026-08-31

Task: Publish the proven TESTNET DepositContract StateInit attach (`deployValueNanotons = 10000000`) on the authoritative server package so existing Page4 can consume it. Do not redesign Page4. Do not change B/C/D.

Classification: **PACKAGE VALUE PUBLISHED**

---

## 1. Scope

Server-authoritative freeze of `deployValueNanotons = 10000000` in `freezeDepositPackage`, projection passthrough, focused tests. No Railway, no Page4 handler rewrite, no FundSeat/GameEscrow change, no live E2E spend.

---

## 2. Files Inspected

- `server/deposit/DepositOrchestrator.js` (`freezeDepositPackage`, `_emitPackagePublished`)
- `server/deposit/projectDepositForPlayer.js` (`projectPackage`)
- `client/src/game/session/page4PaymentPhase.js` (`canDeployDeposit`) — not modified
- `client/src/payment/buildDepositDeploymentTransaction.js` — not modified
- `client/src/pages/Page4Payment.jsx` — not modified
- Prior evidence: `2026-08-31_r18_s16_live_testnet_deposit_deploy_value_matrix.md`, `2026-08-31_r18_s16_deposit_001ton_full_fundseat_validation.md`

---

## 3. Architecture Findings

The frozen package is the server authority. `projectPackage` already forwards `deployValueNanotons` when the frozen object carries it. Page4 `canDeployDeposit` already requires that field. The missing piece was freeze omitting it.

---

## 4. Lifecycle Flow

```text
PAYMENT_CONNECTION_READY
        ↓
freezeDepositPackage (deployValueNanotons = "10000000")
        ↓
DEPOSIT_PACKAGE_PUBLISHED
        ↓
projectDepositForPlayer → Number(10000000)
        ↓
Page4 canDeployDeposit() = true
        ↓
buildDepositDeploymentTransaction amount = "10000000"
```

---

## 5. Ownership Boundaries

| Field | Owner |
|---|---|
| A `deployValueNanotons` | `freezeDepositPackage` (now populated) |
| B fee | `TON_DEPOSIT_CREATION_FEE_PER_SEAT_NANO` (unchanged) |
| C stake | `TON_DEPOSIT_STAKE_NANOTON_BY_PROFILE` (unchanged) |
| D FundSeat | binding `expectedAmount` (unchanged) |
| Page4 consume | existing `canDeployDeposit` / builder (unchanged) |

---

## 6. Risks

- **Medium** — `10000000` nanoTON equals 1:1 stake numerically. Tests assert A is not computed from B, D, or seats × fee.
- **Low** — Null-package fail-closed path remains; a missing field still hides the confirm button.

---

## 7. Recommendations

A later live Page4 TESTNET confirmation can verify the wallet prompt. Do not treat this commit as GameEscrow or Page5 proof.

---

## 8. Changes Made

- `server/deposit/DepositOrchestrator.js` — freeze `deployValueNanotons: "10000000"`
- `server/deposit/projectDepositForPlayer.js` — comment only (still no substitution)
- Tests: orchestrator, projection, Page4 handoff, Page4 phase, deploy builder
- This report

---

## 1. OBJECTIVE

**FACT.** Wire the already-proven 0.01 TON attach into the authoritative Deposit package so Page4 receives `deployValueNanotons = 10000000` from the server.

---

## 2. PREVIOUS TESTNET EVIDENCE

**FACT.**

```text
matrix:     0.01 TON → ACTIVE + VERIFIED
FundSeat:   3 × 11000000 → paidMask=7 totalCredited=33000000 status=3
reports:    2026-08-31_r18_s16_live_testnet_deposit_deploy_value_matrix.md
            2026-08-31_r18_s16_deposit_001ton_full_fundseat_validation.md
```

---

## 3. AUTHORITATIVE VALUE

**FACT.**

```text
deployValueNanotons = 10000000
equivalent           = 0.01 TON
source               = freezeDepositPackage constant
                     DEPOSIT_CONTRACT_DEPLOY_VALUE_NANOTONS = "10000000"
```

**FACT.** Not computed from seats, creation fee, stake, or FundSeat amount.

---

## 4. FINANCIAL ROLE SEPARATION

**FACT.**

```text
A = deployValueNanotons          = 10000000
B = creationFeePerSeat           = 1000000
C = expectedStake (1:1)          = 10000000
D = expectedAmount / FundSeat    = 11000000
```

**FACT.** `TON_DEPOSIT_CREATION_FEE_PER_SEAT_NANO` remains `1000000`.

**FACT.** FundSeat amount remains `11000000` for the tested 1:1 profile.

---

## 5. AUTHORITATIVE PACKAGE PATH

**FACT.**

```text
DepositOrchestrator.handlePaymentConnectionReady
        ↓
freezeDepositPackage()
        ↓
recordDepositPackage()
        ↓
_emitPackagePublished()  EVENT_TYPES.DEPOSIT_PACKAGE_PUBLISHED
        ↓
RoomLobbyBridge → projectDepositForPlayer → client deposit.package
```

---

## 6. SOURCE CHANGES

**FACT.**

| File | Change |
|---|---|
| `server/deposit/DepositOrchestrator.js` | populate `deployValueNanotons` |
| `server/deposit/projectDepositForPlayer.js` | comment only |
| focused tests listed in §10 | extend coverage |
| Page4 production handlers | **none** |

---

## 7. PACKAGE BEFORE

**FACT.** `freezeDepositPackage` omitted `deployValueNanotons`. Projection therefore delivered `null`. `canDeployDeposit()` was false.

---

## 8. PACKAGE AFTER

**FACT.** Frozen / published package includes:

```text
deployValueNanotons = "10000000"
creationFeePerSeat  = "1000000"   (unchanged)
bindings.expectedStake   = 10000000
bindings.expectedAmount  = 11000000
depositId / depositAddress / stateInit unchanged
```

---

## 9. CLIENT VALUE FLOW

**FACT.** No Page4 fallback (`?? 10000000` not added). Existing path:

```text
package.deployValueNanotons = 10000000
        ↓
canDeployDeposit() = true
        ↓
buildDepositDeploymentTransaction amount = "10000000"
```

**NOT PROVEN.** Live Telegram Mini App / TonConnect wallet prompt on production Page4 (no E2E this task).

---

## 10. FOCUSED TESTS

**FACT.** Passed:

```text
server/tests/depositOrchestrator.r179l23.test.js
  including R18-S16 freeze publishes 10000000 independent of B/C/D

server/tests/r18DepositProjection.test.js
  including projection forwards 10000000 without substituting B/C/D

client page4DepositActivationHandoff.test.js
client page4PaymentPhase.test.js
client buildDepositDeploymentTransaction.test.js
```

Coverage:

1. frozen package `deployValueNanotons = 10000000`
2. published event payload same
3. client receives the field
4. `canDeployDeposit() = true`
5. builder amount `"10000000"`
6. B/C/D unchanged and not substituted into A

---

## 11. FINANCIAL INVARIANT RESULTS

**FACT (orchestrator freeze test, 1:1 fixture env).**

```text
deployValueNanotons     = 10000000
creationFeePerSeat      = 1000000
expectedStake0/1/2      = 10000000
expectedAmount0/1/2     = 11000000
A ≠ B
A ≠ D
A ≠ 3 × B
```

---

## 12. PAGE4 IMPACT

**FACT.** No production Page4 UI/handler change. With the populated package, existing `canDeployDeposit` selects `DEPOSIT_DEPLOY` and shows the existing confirm button.

**INFERENCE.** tSPj-class sessions will proceed to the wallet prompt once they receive a package frozen after this change. Old in-flight packages frozen without the field remain fail-closed.

---

## 13. ANTI-BOT IMPACT

**FACT.** Telegram authorization, Room ID protection, RoomManager, and lobby anti-bot were not modified.

---

## 14. RAILWAY CHANGES

**FACT.**

```text
NO RAILWAY CHANGE
```

The attach is a source constant in `freezeDepositPackage`, not a new env variable. Fee and stake-map Railway keys were not modified.

---

## 15. GIT COMMIT

See §15/16 after commit.

---

## 16. GIT PUSH

See after push.

---

## 17. FACT / INFERENCE / NOT PROVEN

| Claim | Class |
|---|---|
| freeze now sets `deployValueNanotons = 10000000` | FACT |
| published EventBus payload carries the same field | FACT |
| projection Number() forwards it; does not substitute D | FACT |
| Page4 handlers unchanged | FACT |
| B remains 1000000; D remains 11000000 in 1:1 freeze | FACT |
| Live Page4 TonConnect send on production | NOT PROVEN |
| GameEscrow / Page5 | NOT PROVEN |
| 0.01 TON is a MAINNET attach | NOT PROVEN |

---

## 18. FINAL VERDICT

```text
deployValueNanotons = 10000000
TON_DEPOSIT_CREATION_FEE_PER_SEAT_NANO remains 1000000
FundSeat amount remains 11000000 for the tested 1:1 profile
NO RAILWAY CHANGE
Page4 production code unchanged — consumes server-authoritative field
```
