# Room Wallet Residual Sweep Implementation

Date: 2026-09-04

Task: Implement the Room Wallet Sweep / Residues Wallet software mechanism using the corrected 0.50 / 0.49 / 0.01 / 0.006 / 0.004 Gram model. Software only. Feature default OFF. No Residues Wallet creation, funding, intake enablement, or blockchain sends.


## 1. Scope

Implemented a production sweep path that was previously policy/plan-only (see `2026-09-04_r18_s34_room_wallet_sweep_pre_implementation_inspection.md`). Stale s33 amounts (0.40 / 0.10 / 0.06 / 0.04) were not used.

Did not create or fund a Residues Wallet, fund or deploy Room Wallets, enable payment intake, enable the sweep flag in Production, change `ROOM_WALLETS_JSON` / RoomWalletRegistry identities, or send a real blockchain transaction.


## 2. Files Inspected

Primary reference: `AI_CONTEXT/CLINE_REPORTS/2026-09-04_r18_s34_room_wallet_sweep_pre_implementation_inspection.md`.

Also inspected: Room Wallet policy/plan/adapter/settlement/config, reimbursement worker/persistence, `TonFinancialPersistence`, `BlockchainMonitor.watchTransaction`, `ContractSettlementManager` settlement confirmation, `environmentSchema`, `app.js` composition.


## 3. Architecture Findings

### Implemented financial model

| Concept | Gram | Nanograms | Role |
|---------|------|-----------|------|
| Sweep threshold | 0.50 | `500_000_000n` | Eligibility trigger |
| Recipient transfer | **0.49** | `490_000_000n` | Exact Residues destination value |
| Retained floor | 0.01 | `10_000_000n` | Source envelope after the 0.49 transfer |
| Source-paid fee budget | 0.006 | `6_000_000n` | Network fee paid by the Room Wallet |
| Safety margin | 0.004 | `4_000_000n` | Remainder of the 0.01 envelope after the fee budget |

**0.01 Gram = 0.006 Gram gas + 0.004 Gram safety margin.**

At 0.50 Gram:

- destination receives **exactly 0.49 Gram**;
- source retains **0.01 Gram** before the network fee lands;
- the source then pays ~0.006 Gram from that envelope;
- ~0.004 Gram remains as safety margin.

The implementation does **not**:

- deduct 0.006 from the 0.49 recipient value;
- require `0.49 + 0.01 + 0.006`;
- treat 0.006 and 0.004 as extra stacked deductions on top of the 0.01 floor.

`buildResidualSweep` remaining after transfer at 0.50 is **0.01 Gram**, not 0.004 Gram.

### Policy changes

`ROOM_WALLET_POLICY` keeps `residualTriggerNano` / `residualSweepNano`. New named fields:

- `residualRetainedFloorNano`
- `residualSweepGasNano`
- `residualSafetyMarginNano`

`ownerRetainedNano` and `initialRoomReserveNano` are not reused as the sweep floor/gas/margin.

Module load asserts `floor === gas + margin`.

### Adapter

Optional per-call `sourceReserveNano` on `sendTransfer` / `canFundTransfer`. Settlement still uses the constructor default (`initialRoomReserveNano` = 0.01). Sweep passes `sourceReserveNano = residualRetainedFloorNano` (0.01), **not** 0.006. Shared settlement gas reserve was not lowered.


## 4. Lifecycle Flow

```
SETTLEMENT_CONFIRMED (includes roomNumber when the settlement request has it)
  → RoomWalletResidualSweepWorker (no-op if flag OFF)
  → resolve roomNumber (never Number(roomId))
  → RoomWalletRegistry.require(roomNumber)
  → resolve TON_RESIDUES_EXPECTED_ADDRESS
  → getBalance (re-check; do not reuse settlement-time balance)
  → buildResidualSweep
  → persist PENDING residual_sweep record
  → sendTransfer amount=0.49, sourceReserve=0.01
  → persist txHash (PROCESSING) or AWAITING_TRANSACTION_HASH
  → BlockchainMonitor.watchTransaction(kind=RESIDUAL_SWEEP) on the source Room Wallet
  → CONFIRMED → completed RESIDUAL_SWEEP financial event
```

Broadcast is not confirmation. `completedFinancialEvent` is true only after confirmation.

Restart: records with txHash are re-watched, never rebroadcast. PROCESSING without hash becomes AWAITING_TRANSACTION_HASH without a second send.


## 5. Ownership Boundaries

| Concern | Owner |
|---------|--------|
| Policy amounts | `RoomWalletFinancialPolicy` |
| Destination config | `TON_RESIDUES_EXPECTED_ADDRESS` (public pin) |
| Enable send | `ROOM_WALLET_RESIDUAL_SWEEP_ENABLED` (default off) |
| Identities | existing `RoomWalletRegistry` / `ROOM_WALLETS_JSON` (unchanged) |
| Durable SoR | `residual_sweep` via `TonFinancialPersistence` |
| Chain send | `RoomWalletAdapter.sendTransfer` |
| Confirmation | `BlockchainMonitor.watchTransaction` |
| Trigger | `SETTLEMENT_CONFIRMED` (not IncomingObserver) |


## 6. Risks

### Critical

- None while the feature flag is OFF and Residues address is unset. No sweep send can occur after this deployment.

### High

- Enabling the flag without a valid Residues address still does not send (fail-closed). Enabling the flag **and** setting a real destination would send when a room is eligible after confirmed settlement.

### Medium

- `SETTLEMENT_CONFIRMED` from a non-Room-Wallet (GameEscrow) path also reaches the worker when the flag is on. Eligibility re-checks live chain balance, so an empty Room Wallet is not swept. Still not a 64-wallet poll.

### Low

- `settlementProbeSafety.r104.test.js` and `gameplayPaymentSettlement.integration.test.js` fail on this branch independently of this change (previously documented). Isolated revert of the SETTLEMENT_CONFIRMED `roomNumber` extra still failed r104.


## 7. Recommendations

Recommendations only for later operational work (not done here):

1. Create the Residues Wallet offline.
2. Set `TON_RESIDUES_EXPECTED_ADDRESS` after owner authorization.
3. Enable `ROOM_WALLET_RESIDUAL_SWEEP_ENABLED` only after destination validation and Room Wallet funding/deploy policy are decided.
4. Keep `ROOM_WALLET_PAYMENT_INTAKE_MODE` as a separate activation.


## 8. Changes Made

Implementation and tests listed in §9. One new report (this file). No Railway, no secrets, no `ROOM_WALLETS_JSON` edits.


## 9. Implementation summary

### Exact files changed

Production:

- `server/payment/roomWallet/RoomWalletFinancialPolicy.js`
- `server/payment/roomWallet/RoomWalletSettlementPlan.js`
- `server/payment/roomWallet/roomWalletConfig.js`
- `server/payment/roomWallet/RoomWalletAdapter.js`
- `server/payment/roomWallet/residualSweepStates.js` (new)
- `server/payment/roomWallet/RoomWalletResidualSweepRepository.js` (new)
- `server/payment/roomWallet/RoomWalletResidualSweepWorker.js` (new)
- `server/payment/roomWallet/ROOM_WALLET_RUNTIME.md`
- `server/persistence/TonFinancialRecordTypes.js`
- `server/persistence/tonFinancialRecordUtils.js`
- `server/persistence/TonFinancialPersistence.js`
- `server/config/schemas/environmentSchema.js`
- `server/config/validators/validateEnvironment.js`
- `server/events/EventTypes.js`
- `server/events/EventSources.js`
- `server/payment/BlockchainMonitor.js`
- `server/payment/ContractSettlementManager.js` (`roomNumber` on SETTLEMENT_CONFIRMED extra only)
- `server/app.js`

Tests:

- `server/tests/roomWalletFinancialPolicy.test.js`
- `server/tests/roomWalletSettlementPlan.test.js`
- `server/tests/roomWalletAppComposition.test.js`
- `server/tests/roomWalletResidualSweep.test.js` (new)

### Residues destination configuration

- Env: `TON_RESIDUES_EXPECTED_ADDRESS` (optional public address).
- Validated with `canonicalizeTonWalletAddress`.
- Missing → `RESIDUES_DESTINATION_MISSING`; invalid → `RESIDUES_DESTINATION_INVALID`; no broadcast; process starts.
- Not a secret. No mnemonic.

### Sweep feature flag

- `ROOM_WALLET_RESIDUAL_SWEEP_ENABLED`
- Default OFF (unset / not `true`/`1`/`yes`).
- Independent of `ROOM_WALLET_PAYMENT_INTAKE_MODE` and `ROOM_WALLET_SETTLEMENT_MODE`.
- Worker `initialize()` is inert when off: no timer, no subscriptions, no sends.

### Worker / trigger

- Trigger: `SETTLEMENT_CONFIRMED` → `enqueueFromSettlement`.
- Mapping: `payload.roomNumber` or `roomManager.resolveRoomNumber(roomId)`. Never `Number(roomId)`.
- Not wired from `RoomWalletIncomingObserver`.
- No 64-wallet balance poll. Queue poll (5s) only when the flag is on, for pending/retry/confirm recovery.

### Persistence / status lifecycle

Record type: `residual_sweep`.

Statuses: `PENDING`, `PROCESSING`, `AWAITING_TRANSACTION_HASH`, `CONFIRMED`, `FAILED_RETRY`, `FAILED_TERMINAL`.

Completed financial event fields include `roomNumber`, source address, Residues destination, amount `"490000000"`, `txHash`, status, timestamps, `idempotencyKey`. No secrets. `gameId` is null (room-level, not a game pot debit).

### Concurrency / idempotency

- In-memory per-`roomNumber` lock.
- Durable in-flight uniqueness (`DuplicateRecordError` if a non-terminal record exists for that room).
- Existing `txHash` → watch/confirm only, never second broadcast.

### Confirmation

`BlockchainMonitor.watchTransaction({ kind: "RESIDUAL_SWEEP" })` on the **source** Room Wallet. Emits `RESIDUAL_SWEEP_TRANSACTION_CONFIRMED`. Bounce/`transaction_failed` → `FAILED_TERMINAL`.

### Tests added/changed

Policy tests now lock 0.50 eligible, 0.49 sent, 0.01 remaining envelope, 0.006+0.004 composition, and ignore leftover `gasNano` so it cannot double-count.

Plan tests use `roomNumber` and reject `roomId` / `Keah`.

New worker tests cover destination fail-closed, mapping, lifecycle, concurrent/duplicate trigger, restart without rebroadcast, confirmation-only ledger completion, bounced terminal failure, and default-off composition.

### Tests executed and results

Passed:

- `roomWalletFinancialPolicy.test.js`
- `roomWalletSettlementPlan.test.js`
- `roomWalletResidualSweep.test.js`
- `roomWalletAppComposition.test.js`
- `roomWalletService.test.js`
- `roomWalletSettlementAdapter.test.js`
- `roomWalletIncomingObserver.test.js`
- `roomNumberWalletMapping.test.js`
- `roomWalletRuntimeResolver.test.js`
- `roomWalletGameReadiness.test.js`
- `roomWalletSecretHardening.test.js`
- `roomWalletSettlementRouter.test.js`
- `provisionRoomWallets.test.js`
- `contractSettlement.manager.test.js`
- `settlementBroadcastRecovery.r96.test.js`
- `settlementRecoveryResume.r94.test.js`
- `winnerRetry.settlementHandoff.r92.test.js`
- `tonFinancialPersistence.test.js`

Pre-existing failures, not caused by this change (previously reported on this branch; r104 still failed after reverting the SETTLEMENT_CONFIRMED extra):

- `settlementProbeSafety.r104.test.js` — expects `SETTLEMENT_PENDING`, observes `SETTLEMENT_PENDING_CONFIRMATION`
- `gameplayPaymentSettlement.integration.test.js` — `game should reach RESULT`

Full `npm test` was not run to completion (large suite; two known unrelated failures above).

### Git commit hash

`7c1bd3e` — `feat: implement room wallet residual sweep`

### Production safety verification

| Check | Result |
|-------|--------|
| Sweep flag default | OFF |
| Production / Railway variables | not modified |
| Blockchain transaction | none |
| Room Wallet identities / `ROOM_WALLETS_JSON` | not regenerated or edited |
| Residues Wallet created/funded | **NO** |
| Room Wallets funded/deployed | **NO** |
| Payment intake enabled | **NO** |
| Transfer value | exactly 0.49 Gram recipient; source reserve 0.01 Gram |
| 0.006 + 0.004 | compose the 0.01 floor; not stacked on 0.49 + 0.01 |

### Remaining limitations

- Residues destination is not configured (intentional).
- Sweep sends require an explicit later enable flag plus a valid address.
- First outbound V4 transfer still needs an on-chain initialized/funded Room Wallet (operational, not this task).
- No in-memory game ledger write for sweeps (durable `residual_sweep` is the system of record; gameId remains null).
- Hash recovery when broadcast returned no txHash is conservative: no automatic second send.
