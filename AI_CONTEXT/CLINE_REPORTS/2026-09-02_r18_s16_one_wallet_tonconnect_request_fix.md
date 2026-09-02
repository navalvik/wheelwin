# R18-S16 — One-Wallet TonConnect Request Extra-Property Fix

Date: 2026-09-02

Task: Surgical Page4 fix for TESTNET room `EtNx` / `game_49d023d3-21d1-4925-9712-c4c1e07e1604` (creator Olga).

Classification:

```text
ONE-WALLET-TONCONNECT-REQUEST-FIX = IMPLEMENTED
```

No TESTNET game. No financial transactions. Contracts unchanged.
`74da66cce2ae2d224379bf83061122b474527656` and `67ef8fa` were not modified.

---

## 1. Scope

Remove the application-only field `totalNanotons` from the object passed to `tonConnectUI.sendTransaction()` so TonConnect SDK validation no longer fails with `Request contains extra properties`.

---

## 2. Files Inspected

- `client/src/payment/buildEntryPaymentTransaction.js`
- `client/src/pages/Page4Payment.jsx`
- `client/src/game/session/page4PaymentPhase.js`
- `client/src/game/session/page4PaymentPhase.test.js`
- `client/src/payment/buildEntryPaymentTransaction.test.js`

---

## 3. Architecture Findings

Exact root cause:

`buildEntryPaymentTransaction()` returns `{ validUntil, messages, totalNanotons }`.
`totalNanotons` is a UI/diagnostics helper. Page4 passed that entire object into `tonConnectUI.sendTransaction()`. TonConnect rejects unknown request properties.

The builder, message construction, amounts, StateInit, payloads, playerIndex, seatIndex, and addresses are correct. Displayed `PAY 1.021 TON` is correct.

Player #2 / #3 payment-button gating after failed creator deploy remains expected: Deposit stayed `UNINIT` / `WAITING_FOR_PLAYER_DEPLOYMENT`.

---

## 4. Lifecycle Flow

Unchanged:

```text
Creator: ONE sendTransaction [Deploy + FundSeat + STAKE]
Player 2/3: ONE sendTransaction [FundSeat + STAKE] after Deposit activation verified
```

Page4 now:

1. Builds the transaction (still includes `totalNanotons`).
2. Destructures `{ totalNanotons, ...tonConnectTransaction }`.
3. Passes only `{ validUntil, messages }` to `sendTransaction`.
4. Continues using `totalNanotons` for BUILD/SEND/WALLET_RESULT logs.

---

## 5. Ownership Boundaries

- Builder still owns assembling authoritative component messages plus the helper total.
- Page4 still owns TonConnect handoff.
- Server authorization, Deposit activation, and Player #2/#3 gating were not touched.

---

## 6. Risks

- Critical: none remaining for this defect after the strip.
- High: none.
- Medium: none for this change.
- Low: other future helper fields on the builder return would also need stripping; currently only `totalNanotons` exists.

---

## 7. Recommendations

Recommendations only. No further work in this task.

Do not pass builder helper fields into TonConnect. Keep Player #2/#3 buttons gated on Deposit activation.

---

## 8. Changes Made

### Exact files changed

- `client/src/pages/Page4Payment.jsx`
- `client/src/payment/buildEntryPaymentTransaction.test.js`
- `client/src/game/session/page4PaymentPhase.test.js`
- `AI_CONTEXT/CLINE_REPORTS/2026-09-02_r18_s16_one_wallet_tonconnect_request_fix.md`

### Exact fix

```javascript
const { totalNanotons, ...tonConnectTransaction } = transactionObject;
await tonConnectUI.sendTransaction(tonConnectTransaction);
```

`totalNanotons` remains on the builder return and is used for Page4 logs. It is excluded from the TonConnect request.

Creator message structure unchanged:

```text
messages[0] = DepositContract deployment
messages[1] = FundSeat
messages[2] = GameEscrow STAKE
```

Player #2/#3 gating unchanged: `canFundSeat()`, `canSubmitEntryPayment()`, `isDepositActivationVerified()` were not modified.

Contracts not changed (DepositContract, GameEscrow, ABI, bytecode, opcodes, economics).

Financial formulas not changed (`0.01` deploy, `0.001` creation fee, FundSeat = stake + fee, authoritative game stake). Displayed creator total remains `1.021 TON` from those components.

Commits `74da66cce2ae2d224379bf83061122b474527656` and `67ef8fa` were not modified.

---

## 9. Tests

```text
node --test client/src/payment/buildEntryPaymentTransaction.test.js
  8/8 PASS  (includes new strip + 1.021 TON creator fixture)

node --test client/src/game/session/page4PaymentPhase.test.js
  15/15 PASS  (existing gating tests preserved; sendTransaction now asserted to receive tonConnectTransaction)
```

Regression asserts:

```text
sentTransaction.totalNanotons === undefined
sentTransaction.validUntil === builtTransaction.validUntil
sentTransaction.messages === builtTransaction.messages
creator messages.length === 3
nanotonsToTonDisplay(totalNanotons) === "1.021"
```
