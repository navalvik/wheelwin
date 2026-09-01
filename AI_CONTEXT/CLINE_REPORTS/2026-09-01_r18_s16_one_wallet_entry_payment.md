# R18-S16 — One Wallet Confirmation Player Entry

Date: 2026-09-01

Classification:

```text
ONE-WALLET-PAYMENT FLOW = IMPLEMENTED
```

No TESTNET game. Frozen DepositContract / GameEscrow ABI and bytecode were not changed.
`74da66c` and `67ef8fa` were not modified.

---

## 1. Old payment flow

```text
Creator:  Deposit deploy → FundSeat → GameEscrow STAKE   (3 confirmations)
Player 2/3: FundSeat → GameEscrow STAKE                 (2 confirmations)
```

GameEscrow existed only after DEPOSIT_FULL → DeploymentAuthorization VALID → server deploy → INIT_GAME → OPEN_PAYMENTS.

---

## 2. New payment flow

```text
PAYMENT_CONNECTION_READY
    → Deposit package published (AWAITING_FUNDS)
    → Entry DeploymentAuthorization VALID
    → server deploys GameEscrow + INIT_GAME + OPEN_PAYMENTS
    → creator: ONE sendTransaction (deploy + FundSeat + STAKE)
    → players 2/3 wait for deposit activation, then ONE sendTransaction (FundSeat + STAKE)
    → on-chain FundSeat + STAKE verification
    → game start only after Deposit FULL AND all STAKE
```

---

## 3. Exact protocol change

GameEscrow is authorized and deployed when the Deposit package exists, not when Deposit is FULL.

`PAYMENTS_OPEN` still gates STAKE. `READY` still gates SETTLE. SETTLE remains oracle-only.

Game start now also requires Deposit FULL (or a later deposit-complete state).

---

## 4. Exact contract changes

None. ABI, opcodes, economics, and artifacts unchanged.

Sandbox proof: GameEscrow can be OPEN before any FundSeat; creator empty-deploy then FundSeat then STAKE succeeds; duplicate FundSeat/STAKE and premature SETTLE fail.

TON message order for creator is encoded as:

```text
messages[0] = empty StateInit deploy (A)
messages[1] = FundSeat (D)
messages[2] = GameEscrow STAKE (C)
```

---

## 5. Exact server changes

- `DeploymentAuthorization.fromEntryReady` — valid from AWAITING_FUNDS / PARTIALLY_FUNDED / DEPOSIT_FULL when `depositAddress` exists.
- `EntryDeploymentAuthorizationAutomation` — `DEPOSIT_PACKAGE_PUBLISHED` → VALID authorization (idempotent).
- Existing GCM path: `DEPLOY_AUTHORIZATION_VALID` → `createContractRequest` → `consumeValidForDeploy`.
- Legacy DEPOSIT_FULL authorization remains; duplicate create is ignored.
- `GameStartAuthorization` requires deposit FULL when a deposit coordinator is wired.

---

## 6. Exact frontend changes

One Page4 button. One `tonConnectUI.sendTransaction()`.

`buildEntryPaymentTransaction` concatenates existing server-authoritative builders. It does not invent amounts, seats, addresses, or StateInit.

---

## 7. Creator ONE-payment message structure

```text
[0] DepositContract + StateInit    amount = package.deployValueNanotons
[1] FundSeat opcode + seatIndex    amount = myExpectedAmountNanotons
[2] STAKE opcode + playerIndex     amount = requiredGram (authoritative)
```

Total = A + D + C (plus additional-sector stake already inside C / D from existing formulas).

---

## 8. Player 2/3 ONE-payment message structure

```text
[0] FundSeat opcode + seatIndex    amount = myExpectedAmountNanotons
[1] STAKE opcode + playerIndex     amount = requiredGram (authoritative)
```

Total = D + C.

---

## 9. Security invariants preserved

- Client cannot invent amount, seat, player index, addresses, or StateInit.
- STAKE still requires `PAYMENTS_OPEN`, exact wallet, exact amount, unused seat.
- SETTLE still requires `READY` and oracle.
- Non-oracle SETTLE rejected.
- Game start blocked until Deposit FULL and all STAKE confirmed on-chain.
- Wallet `sendTransaction` success is not payment complete (`PAYMENT_CONFIRM_INTENT` only).

---

## 10. Financial formulas preserved

```text
A = deposit deploy attach
B = creation fee per seat
C = authoritative game stake (includes additional sector via existing calculateRequiredGram / stake map)
D = C + B = FundSeat expected amount
```

No new sector-pricing formula.

---

## 11. Idempotency

- Entry authorization: one VALID record per room/game; duplicate package events reuse it.
- On-chain: duplicate FundSeat / STAKE rejected by existing contract guards.
- Client omits already-completed components on retry.
- RPC failure after broadcast does not mark paid; confirmation is still on-chain observation.

---

## 12. Tests and results

All passed:

| Suite | Result |
|-------|--------|
| `client/src/payment/buildEntryPaymentTransaction.test.js` | 7/7 |
| `client/src/game/session/page4PaymentPhase.test.js` | 15/15 |
| `client/src/i18n/language.i18n.test.js` | 5/5 |
| `server/tests/entryDeploymentAuthorization.r18s16.test.js` | 3/3 |
| `server/tests/gameStartAuthorization.test.js` | including deposit FULL gate |
| `server/tests/deploymentAuthorization.r179l5a.test.js` | 10/10 |
| `server/tests/gameContract.deployAuthorizationHandoff.r18s15.test.js` | pass |
| `server/tests/gameContract.legacyDeployTriggerIsolation.r179l18.test.js` | pass |
| `server/tests/depositFull.deploymentAuthorizationAutomation.r179l6.test.js` | 6/6 |
| `contracts/tests/OneWalletEntry.spec.ts` | 9/9 |

---

## 13. Files changed

- `server/deposit/deploymentAuthorizationValidation.js`
- `server/deposit/DeploymentAuthorization.js`
- `server/deposit/DeploymentAuthorizationCoordinator.js`
- `server/deposit/EntryDeploymentAuthorizationAutomation.js` (new)
- `server/app.js`
- `server/gameplay/GameContractManager.js`
- `server/gameplay/GameStartAuthorization.js`
- `client/src/payment/buildEntryPaymentTransaction.js` (new)
- `client/src/game/session/page4PaymentPhase.js`
- `client/src/game/session/index.js`
- `client/src/pages/Page4Payment.jsx`
- `client/src/i18n/translations.js`
- `client/src/i18n/language.i18n.test.js`
- tests listed above
- `AI_CONTEXT/CURRENT_STATE.md`

---

## 14. Git commit hash

Not committed in this task.

---

## Final classification

```text
ONE-WALLET-PAYMENT FLOW = IMPLEMENTED
```
