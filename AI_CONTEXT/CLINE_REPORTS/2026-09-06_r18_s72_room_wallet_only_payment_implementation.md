# WheelWin — Room Wallet-Only Player Payment Implementation

Date: 2026-09-06

Task: Implement the approved Room Wallet-only player payment and settlement architecture. Game Escrow is no longer the player-payment destination or settlement vault for `GAME_ESCROW_MODE=game`. No Railway, Vercel, wallet, chain, deploy, or push.


## 1. Scope

Rewire Page4 destination, payment payload, Room Wallet intake authority, game-start gates, and settlement so one 3-player game is:

```text
Player → Room Wallet (requiredGram + own gas)
→ Incoming Observer → PaymentSession / ledger
→ server game → Room Wallet → Winner + Owner + server gas
→ Residual Sweep (unchanged policy) → Residues Wallet
```

Old Game Escrow residue (~0.081 GRAM) was not recovered. Sweep was not executed.


## 2. Files Inspected / Changed

**Changed:** `server/app.js`; `server/payment/roomWallet/roomWalletConfig.js`; `server/models/PaymentSession.js`; `server/gameplay/PaymentSessionManager.js`; `server/gameplay/GameStartAuthorization.js`; `server/gameplay/GameContractManager.js`; `server/payment/ContractSettlementManager.js`; `client/src/pages/Page4Payment.jsx`; `client/src/payment/buildEntryPaymentTransaction.js`; `client/src/payment/buildTonConnectPaymentTransaction.js`; `client/src/game/session/page4PaymentPhase.js`; `client/src/game/session/index.js`; tests listed in §8; this report.

**Inspected, not modified:** `RoomWalletIncomingObserver.js` (traffic control preserved); `RoomWalletFinancialPolicy.js` (sweep constants unchanged); `RoomWalletSettlementAdapter.js`; `TonGameContractAdapter.js` (legacy only).


## 3. Architecture Findings

### Payment destination before / after

| | Before | After (`escrowMode=game`) |
| --- | --- | --- |
| Page4 dest | `paymentRequest.contractAddress ?? gameContract.contractAddress` (Game Escrow) | `resolvePlayerPaymentDestination` = `paymentSession.roomWalletAddress` or participant dest. **No Game Escrow fallback.** |
| Amount | `requiredGram` | unchanged |
| Payload | `GAME_ESCROW_STAKE_OPCODE` + playerIndex | plain TON transfer (`plainTransfer: true`), no STAKE body |
| Missing dest | could fall back to escrow | fail closed: no send, `payment.stakeUnavailable` |

**CODE-DERIVED FACT.** `buildEntryPaymentTransaction` with `gameEscrowOnly: true` ignores `gameEscrowAddress`.

### Player payment transaction model

**Before (observed Production s69):** three STAKE of 1.000 GRAM to Game Escrow; Oracle DEPLOY/INIT/OPEN/SETTLE; escrow paid winner/owner.

**After (intended, CODE-DERIVED FACT):**

```text
Player 1 → Room Wallet: 1.000 GRAM (+ own fee)
Player 2 → Room Wallet: 1.000 GRAM (+ own fee)
Player 3 → Room Wallet: 1.000 GRAM (+ own fee)
Room Wallet → Winner
Room Wallet → Owner (minus 0.01 retain)
Room Wallet pays settlement gas
```

### Room Wallet intake

**CODE-DERIVED FACT.** Observer traffic control unchanged (in-flight, 8-wallet slice, concurrency 1, two retries, 400 ms, 8 s timeout). No new TonCenter loop.

`GAME_ESCROW_MODE=game` now sets `isRoomWalletOnlyFinancialPath` so PaymentSessionManager:

- resolves dest via `resolveIntendedRoomWalletAddress` / `roomNumber`;
- publishes `session.roomWalletAddress`;
- does not register Game Escrow blockchain watches;
- ignores `GAME_ESCROW_STAKE_CONFIRMED`;
- refuses `issueDeployedPaymentRequests` overwrite with escrow address.

Authoritative credit remains observer → `PAYMENT_TRANSACTION_CONFIRMED` (already implemented). Duplicate / wrong sender / wrong amount already rejected (**TEST RESULT** in `roomWalletIncomingObserver.test.js`).

### Settlement

**CODE-DERIVED FACT.** `composeRoomWalletSettlementRouter` enables Room Wallet adapter when `gameEscrowMode=game` **or** `ROOM_WALLET_SETTLEMENT_MODE=ROOM_WALLET`, fail-closed without `ROOM_WALLETS_JSON` / tonService.

`ContractSettlementManager._isRoomWalletSettlementActive()`:

- skips `contract_not_deployed` / `PAYMENTS_COMPLETE` gates;
- after adapter `ok`, confirms from Room Wallet tx hashes (not Game Escrow payout watches);
- ignores Game Escrow settlement verified/rejected handlers.

Winner/owner amounts still come from existing settlement math; adapter still uses `RoomWalletSettlementAdapter.settleContract`.

### Game Escrow financial path disabled

- `GameContractManager.skipBlockchainDeploy` when Room Wallet finance: no `_beginDeploy` / INIT_GAME / OPEN_PAYMENTS / Oracle attach.
- Snapshot GameContract can still be created (non-financial) via existing authorization automation; **spend path is skipped**.
- STAKE confirmation is not payment authority.

### Oracle / Deploy

Happy-path Oracle messages for new `game` mode games are not started (`_beginDeploy` returns immediately). Adapter code remains for `v4` / disabled router. Secrets not logged.

### Legacy Deposit / FundSeat

`gameEscrowOnly` still forces `includeDeploy/includeFund=false`. `escrowMode=game` still skips Deposit orchestrator session creation. **CODE-DERIVED FACT:** cannot fall back to Deposit because dest builder never uses Deposit components on this path.

### Residual Sweep

Unchanged: 0.50 / 0.49 / 0.01 / 0.006 / 0.004 / `PAY_GAS_SEPARATELY`. Still Room Wallet only. Not executed this task.


## 4. Lifecycle Flow

```text
Page2 → players equal
Page4 PAY (one message) → Room Wallet
RoomWalletIncomingObserver (existing poll)
PaymentSession CONFIRMED × N + ledger
GameStartAuthorization (ledger; not PAYMENTS_COMPLETE)
server gameplay / winner
RoomWalletSettlementAdapter → winner + owner
SETTLEMENT_CONFIRMED → existing Sweep worker (if enabled and threshold)
```


## 5. Ownership Boundaries

After Page2 the server owns verification, start, winner, and settlement. Client only sends `requiredGram` to the server-published Room Wallet address. Client does not pick winner/owner payout destinations.


## 6. Risks

- **High:** Production `GAME_ESCROW_MODE=game` now requires configured Room Wallets at settlement compose time (fail closed). Intake create fails if Room Wallet address cannot be resolved.
- **Medium:** `GameEscrowDeploymentAuthorizationAutomation` still mints VALID deploy authorization (non-spend). Safe while `skipBlockchainDeploy` is true; leftover for later cleanup.
- **Medium:** `v4` still contains STAKE/FundSeat/Deposit builders (**LEGACY BLOCKED** from game mode).
- **Low:** Historical ~0.081 GRAM Game Escrow dust remains stranded (**ON-CHAIN FACT** from s69; not moved).

**INFERENCE:** First Production game after deploy must have Room Wallet registry and reserve as already provisioned.


## 7. Recommendations

Do not enable a second dest. Do not recover old escrow dust in this line of work. Later: stop minting Game Escrow deploy authorizations when `skipBlockchainDeploy` is on; delete unused escrow financial code after idle.


## 8. Changes Made

### Functions / classes

| File | Function/class | Change |
| --- | --- | --- |
| `roomWalletConfig.js` | `isRoomWalletOnlyFinancialPath`, `composeRoomWalletSettlementRouter` | game mode = Room Wallet finance/settlement |
| `PaymentSession` | `roomWalletAddress` | published dest |
| `PaymentSessionManager` | `createPaymentSession`, `setRoomWalletFinance`, watches, STAKE handler | dest + no escrow credit |
| `GameStartAuthorization` | `_checkStartConditions` | ledger for game mode; not `PAYMENTS_COMPLETE` |
| `GameContractManager` | `skipBlockchainDeploy`, `_beginDeploy`, `_scheduleCreated` | no Oracle deploy |
| `ContractSettlementManager` | `_isRoomWalletSettlementActive`, `_validateSettlement`, `_applySettlementAdapterResult` | Room Wallet settle/confirm |
| `app.js` | composition | wires flags, registry, skip deploy, settlement mode |
| `page4PaymentPhase.js` | `resolvePlayerPaymentDestination`, `canStakeGameEscrow`, `canSubmitEntryPayment` | dest gate, not escrow deploy |
| `buildEntryPaymentTransaction.js` | `gameEscrowOnly` branch | Room Wallet plain transfer |
| `buildTonConnectPaymentTransaction.js` | `plainTransfer` | no STAKE opcode |
| `Page4Payment.jsx` | entry submit | dest from session; no escrow fallback |

### Tests executed (**TEST RESULT**)

Passed (representative): `roomWalletOnlyPlayerPayment.r18s72.test.js`; `roomWalletAppComposition.test.js`; `gameStartAuthorization.test.js`; `paymentSession.manager.test.js`; `roomWalletGameReadiness.test.js`; `roomWalletIncomingObserver.test.js`; `roomWalletResidualSweep.test.js`; `gameEscrowOnlyPlayerPayment.r18s63.test.js`; `buildEntryPaymentTransaction.test.js`; `page4PaymentPhase.test.js`; `page4GameEscrowAuthoritativeState.test.js`.

Pre-existing `page4DepositActivationHandoff.test.js` was not used as a pass gate for this architecture.

### Post-change search

| Mechanism | Classification | Note |
| --- | --- | --- |
| `GAME_ESCROW_STAKE_OPCODE` | **LEGACY BLOCKED** / **TEST ONLY** | Used only when `gameEscrowOnly` is false (`v4`). New path uses `plainTransfer`. |
| `GAME_ESCROW_STAKE_CONFIRMED` | **LEGACY BLOCKED** | Ignored when intake enabled. |
| FundSeat / Deposit / 0.011 | **LEGACY BLOCKED** | `gameEscrowOnly` drops deploy/fund; DepositOrchestrator skip remains. |
| `PAYMENTS_COMPLETE` | **LEGACY BLOCKED** for new games | GSA uses ledger; CSM skips when Room Wallet settle active. Still in GCM for old path. |
| Game Escrow dest on Page4 | **REMOVED** from new path | No `gameContract.contractAddress` fallback. |
| Game Escrow settlement | **LEGACY BLOCKED** | Router `isEnabled()` uses Room Wallet adapter. |
| Oracle `_beginDeploy` | **LEGACY BLOCKED** for game mode | `skipBlockchainDeploy`. |
| Creator activation / second TonConnect | **LEGACY BLOCKED** | equality + one message preserved. |
| Observer traffic control | **ACTIVE NEW PATH** | Unchanged constants. |
| Room Wallet settle/sweep policy | **ACTIVE NEW PATH** | Sweep values unchanged. |
| Game Escrow source / opcodes module | **SAFE TO REMOVE LATER** | Non-financial snapshot still used. |
| GameEscrow deploy authorization mint | **NON-FINANCIAL** leftover | Does not spend while skip deploy is on. Could still confuse ops. |

Nothing in the new `game` flow automatically sends player funds to Game Escrow or Deposit.

### Commit / safety

Commit SHA and file list: filled after git commit in this same task.

- Nothing pushed: **CONFIRMED FACT** (no `git push`).
- Nothing deployed: **CONFIRMED FACT**.
- No blockchain transaction: **CONFIRMED FACT**.
- Railway/Vercel/secrets unmodified: **CONFIRMED FACT**.
- No `git add .`: **CONFIRMED FACT**.

### Remaining legacy

Deposit/FundSeat/STAKE builders, TonGameContractAdapter SETTLE, Game Escrow contract sources remain for `v4` and later deletion.

### Unresolved

**UNKNOWN until Production run:** first live game with this commit must prove three Room Wallet credits and Room Wallet settlement under real TonCenter load. VALID Game Escrow deploy authorizations may still appear in logs without a corresponding deploy.


## 9. Implementation plan status

The s71 plan is implemented in code for `GAME_ESCROW_MODE=game` without flipping Railway env as the sole switch.
