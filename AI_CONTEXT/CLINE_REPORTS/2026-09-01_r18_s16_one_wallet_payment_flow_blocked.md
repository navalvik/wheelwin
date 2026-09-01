# R18-S16 — One Wallet Confirmation Payment Flow

Date: 2026-09-01

Task: Determine whether each player can enter a game with **one** TonConnect `sendTransaction` / one wallet confirmation, using frozen DepositContract + GameEscrow. Implement only if Case A is proven. Stop if Case B.

Classification:

```text
ONE-WALLET-PAYMENT FLOW = BLOCKED BY CONTRACT/PROTOCOL CONSTRAINT
```

```text
IMPOSSIBLE WITH CURRENT FROZEN CONTRACTS
```

No source files modified. No TESTNET game. No payment-flow redesign started.

---

## 1. Scope

Inspected Page4 TonConnect builders, deposit vs GameEscrow phases, DepositContract `receive` / `FundSeat`, GameEscrow `STAKE` / `OPEN_PAYMENTS`, and the server gate that deploys GameEscrow only after deposit authorization. Did not audit Railway, reimbursement, recovery, or anti-bot.

---

## 2. Files Inspected

- `client/src/pages/Page4Payment.jsx`
- `client/src/payment/buildDepositDeploymentTransaction.js`
- `client/src/payment/buildFundDepositTransaction.js`
- `client/src/payment/buildTonConnectPaymentTransaction.js`
- `client/src/game/session/page4PaymentPhase.js`
- `contracts/deposit/DepositContract.tact`
- `contracts/game_escrow/GameEscrow.tact`
- `server/gameplay/GameContractManager.js` (authorization gate)

---

## 3. Architecture Findings

### Current payment flow

Page4 is two separate wallet phases, each its own `tonConnectUI.sendTransaction` with **one** message:

1. **Deposit (before GameEscrow exists)**  
   - Creator: `buildDepositDeploymentTransaction` (StateInit, 0.01 TON).  
   - Then, after activation verified: `buildFundDepositTransaction` (FundSeat 0x46554E44, 0.011 TON).  
   - Players 2/3: FundSeat only.  
   - Gate: `canDeployDeposit` / `canFundSeat`. Creator cannot FundSeat until activation is verified.

2. **GameEscrow STAKE (after GameEscrow is deployed)**  
   - `buildTonConnectPaymentTransaction` (STAKE 0x5354414B + playerIndex).  
   - Gate: `canStakeGameEscrow` requires payment session **and** `isGameContractDeployed`.  
   - `resolvePage4PaymentPhase` will not select `GAMEESCROW_STAKE` until the GameEscrow is deployed.

Server: GameEscrow deploy / `INIT_GAME` / `OPEN_PAYMENTS` run only after deposit is full and a valid deployment authorization exists (`MissingDeploymentAuthorizationError` if missing).

---

## 4. Lifecycle Flow (why one tx cannot include STAKE)

```text
Creator deploy Deposit (0.01)
  → activation verified
  → all 3 FundSeat (0.011 each)
  → DEPOSIT_FULL (on-chain)
  → server authorization
  → server deploys GameEscrow
  → oracle INIT_GAME
  → oracle OPEN_PAYMENTS  (status → PAYMENTS_OPEN)
  → each player STAKE (configured C)
```

GameEscrow `STAKE`:

```tact
require(self.status == STATUS_PAYMENTS_OPEN, "GameEscrow: payments not open");
require(context().value == required, ...);
```

`OPEN_PAYMENTS` is oracle-only and requires `STATUS_DEPLOYED` after `INIT_GAME`. Empty GameEscrow `receive()` rejects player deposits (`use STAKE for player deposits`) unless still uninitialized/deployed/waiting — still **not** `PAYMENTS_OPEN`.

At the moment any player can send FundSeat, **GameEscrow does not exist** and is **not OPEN**. The last FundSeat that completes DEPOSIT_FULL still cannot carry STAKE: the server has not yet deployed or opened GameEscrow.

Therefore a single TonConnect transaction cannot contain:

```text
FundSeat  AND  GameEscrow STAKE
```

and cannot contain:

```text
Deposit deploy + FundSeat + GameEscrow STAKE
```

without changing the frozen STAKE guard or the Deposit-FULL-then-GameEscrow security boundary.

TonConnect **can** put multiple messages in one `sendTransaction`. That does not make STAKE valid against an address that is missing or not `PAYMENTS_OPEN`.

---

## 5. Ownership Boundaries

Unchanged. Client still must not invent amounts. Server still owns GameEscrow deploy authorization. This task did not move those boundaries (and could not while keeping them).

---

## 6. Risks

- **Critical (product)** — requested one-confirmation UX is not achievable on frozen contracts + current protocol order.
- Combining only Deposit deploy + FundSeat (no STAKE) was **not implemented**. It would at best cut creator confirms from 3 toward 2 and would not meet the stated goal. Same-account deploy-then-FundSeat in one wallet tx is also not proven here and was not attempted.

---

## 7. Recommendations

Do not modify frozen contracts in a follow-up unless a later task explicitly authorizes a new protocol. Smallest **future** options (not done now):

1. Keep two wallet steps: one deposit-layer tx, one STAKE after `PAYMENTS_OPEN` (still **two** confirmations).
2. Change protocol so GameEscrow is opened before player STAKE is required in the same user action (new security model; out of scope).
3. New contract that accepts combined entry (new economics/ABI; out of scope).

---

## 8. Changes Made

No files modified.

---

## Required answers

| Item | Result |
|------|--------|
| Why one wallet tx is not possible | GameEscrow STAKE requires `PAYMENTS_OPEN` after server deploy + oracle INIT/OPEN, which happens only after DEPOSIT_FULL. STAKE cannot share a TonConnect tx with deploy/FundSeat. |
| Creator total construction | Not implemented. Would have been A + D + C from server package/seat/stake. |
| Player 2/3 total | Not implemented. Would have been D + C. |
| Duplicate effects | Unchanged existing FundSeat/STAKE idempotency. |
| Tests | None added (Case B stop). |
| Economics | Unchanged. |
| Unrelated systems | Unchanged. `74da66c` / `67ef8fa` not modified. |

---

## Final classification

```text
ONE-WALLET-PAYMENT FLOW = BLOCKED BY CONTRACT/PROTOCOL CONSTRAINT
```
