# R18-S16 — Creator One-Wallet Deposit Activation Verification

Date: 2026-09-02

Task: Allow Deposit activation to reach `VERIFIED` after the legitimate creator one-wallet FundSeat state (`PARTIALLY_FUNDED`, creator seat only, creditedAmount0 = configured FundSeat), so Player 2/3 Page4 can enter `ENTRY_PAYMENT`. Do not change amounts, Player 2/3 gating, contracts, TonConnect, or deploy.

Classification:

```text
IMPLEMENTED
```

---

## 1. Scope

Server Deposit activation verification only. Player 2/3 `canIncludeFundSeatInEntry` / `canSubmitEntryPayment` gates were not changed; they become satisfiable because `activationStatus` can now be `VERIFIED`.

No production deploy. No TESTNET game. No env, contract, TonConnect, BlockchainMonitor, or amount changes.

---

## 2. Files Inspected

- `server/payment/ton/readDepositGetters.js`
- `server/deposit/DepositActivationVerificationCoordinator.js`
- `server/deposit/RealTonDepositBlockchainSource.js` (`DEPOSIT_ONCHAIN_STATUS`)
- `server/deposit/DepositOrchestrator.js` / `resolveDepositOrchestrationFinancials.js`
- `server/deposit/projectDepositForPlayer.js` (creator = first bound seat)
- `client/src/game/session/page4PaymentPhase.js`
- `server/tests/depositActivationVerification.r179l22.test.js`
- `client/src/game/session/page4PaymentPhase.test.js`

---

## 3. Architecture Findings

### Root cause

Creator one-wallet TonConnect sends Deploy + FundSeat + GameEscrow STAKE together. FundSeat credits seat 0 with `expectedStake0 + creationFeePerSeat`. On-chain getters then show:

```text
status = PARTIALLY_FUNDED (2)
paidMask = 1  (creator seat bit only)
creditedAmount0 = plan FundSeat nanotons
```

Activation previously called only `assertInitialMutableState`, which requires empty `AWAITING_FUNDS` (`status === 1`, `paidMask === 0`). That reject (`INITIAL_STATE_INVALID`) left Player 2/3 in `DEPOSIT_ACTIVATION` with no pay button.

### Exact new activation condition

`assertActivableMutableState(getters, plan)` accepts **either**:

1. Existing empty initial state (`assertInitialMutableState`):

```text
status === 1          // AWAITING_FUNDS
paidMask === 0
all credited / surplus / refund / totalCredited === 0
releasedTo empty
```

2. Legitimate creator one-wallet FundSeat (`isCreatorOneWalletFundSeatMutableState`):

```text
status === 2          // PARTIALLY_FUNDED
paidMask === CREATOR_SEAT_PAID_MASK   // 1 << 0, first bound seat
creditedAmount0 === creatorFundSeatNanotonsFromPlan(plan)
                  === bindings[0].expectedStake + creationFeePerSeat
creditedAmount1 === 0
creditedAmount2 === 0
totalCredited === creditedAmount0
surplusNano === 0
refundMask === 0
releasedTo empty
```

FundSeat nanotons are derived from the same activation `plan` already used for immutable getter checks. No hardcoded `11000000` or `0.011 TON`. No player nickname or wallet identity.

Coordinator `_verifyActivation` now calls `assertActivableMutableState(getters, plan)` instead of `assertInitialMutableState(getters)` only. All other checks (artifact, address, players, financial parameters, hashes) are unchanged.

### Why this cannot accept arbitrary partial funding

Rejected unless **all** of the creator-FundSeat predicates match. Existing cases still fail `INITIAL_STATE_INVALID`:

- `PARTIALLY_FUNDED` + `paidMask=1` but `creditedAmount0=0` (Test12)
- `PARTIALLY_FUNDED` + seat-1 `paidMask=2`
- `PARTIALLY_FUNDED` + creditedAmount0 equal to stake without fee
- `FULL` / `RELEASED` / extra seat credits

Player 2/3 gate (`canIncludeFundSeatInEntry` → `canFundSeat` → `isDepositActivationVerified`) is unchanged.

---

## 4. Lifecycle Flow

```text
Creator one-wallet tx confirms
  → Deposit getters: PARTIALLY_FUNDED, paidMask=1, creditedAmount0=plan FundSeat
  → verifyActivation
       immutable checks (unchanged)
       assertActivableMutableState → VERIFIED
  → DEPOSIT_ACTIVATION_VERIFIED
  → Player 2/3 projection activationStatus=VERIFIED
  → canSubmitEntryPayment true
  → Page4 ENTRY_PAYMENT
  → pay button rendered
```

Empty deploy-only `AWAITING_FUNDS` still verifies as before.

---

## 5. Ownership Boundaries

| Concern | Owner |
| --- | --- |
| Mutable activable predicate | `readDepositGetters.js` |
| VERIFIED persist / event | `DepositActivationVerificationCoordinator.js` |
| FundSeat amount | activation plan (`expectedStake` + `creationFeePerSeat`) |
| Player 2/3 button | unchanged `page4PaymentPhase.js` |

---

## 6. Risks

- **Critical:** none if the on-chain FundSeat is not exactly plan stake+fee (still rejected).
- **High:** none for GameEscrow `1 TON` or Deposit `0.011` meanings (unchanged).
- **Medium:** DepositMonitor still must observe FundSeat for session bindings; this fix only unblocks `VERIFIED`.
- **Low:** `assertInitialMutableState` still rejects funded states; scripts that assert empty deploy-only state are unchanged.

---

## 7. Recommendations

Promote this branch after review. Then run one TESTNET session to confirm Lena/Bob reach `PAGE4_SEND_TRANSACTION_REQUEST`. Not done here.

---

## 8. Changes Made

```text
server/payment/ton/readDepositGetters.js
  creatorFundSeatNanotonsFromPlan
  isCreatorOneWalletFundSeatMutableState
  assertActivableMutableState

server/deposit/DepositActivationVerificationCoordinator.js
  verifyActivation uses assertActivableMutableState(getters, plan)

server/tests/depositActivableMutableState.r18s16.test.js          (new)
server/tests/depositActivationVerification.r179l22.test.js        (3 tests)
client/src/game/session/page4PaymentPhase.test.js                 (shouldShowEntryAction)
```

Tests:

```text
depositActivableMutableState.r18s16.test.js           6/6 PASS
depositActivationVerification.r179l22.test.js         includes new R18-S16 cases; suite 43/43 with ordering tests
depositActivationOrdering.r18s15.test.js              PASS
page4PaymentPhase.test.js                             15/15 PASS
depositTestnetDeploy.r179l14.test.js                  PASS
depositTestnetDeploy.r179l14b.test.js                 PASS
```

Git:

```text
Branch:
cursor/verify-creator-one-wallet-deposit-activation

Commit:
1d44c4f5b7ba9116418db0c307088d691c37e60b
fix: verify creator one-wallet deposit activation

Push:
NO

Production deployed:
NO

TESTNET game performed:
NO
```
