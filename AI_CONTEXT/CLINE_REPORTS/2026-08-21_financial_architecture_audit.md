# Financial Architecture Audit

Date: 2026-08-21

Task: Read-only financial architecture audit covering the TON financial integration, GameEscrow contract lifecycle, payment session management, settlement orchestration, deposit flow, financial persistence, financial recovery, and blockchain monitoring. No source code changes were allowed.

## 1. Scope

This audit inspected the WheelWin financial architecture to document the current implementation of TON financial integration, payment session lifecycle, GameEscrow contract lifecycle, settlement orchestration, deposit flow, financial persistence, financial recovery, and blockchain monitoring.

Analyzed areas:

- Payment session lifecycle (`PaymentSessionManager`, `PaymentSessionStates`).
- GameEscrow contract lifecycle (`GameContractManager`).
- Settlement orchestration (`ContractSettlementManager`, `SettlementSession`, `SettlementSessionStates`).
- Blockchain monitoring (`BlockchainMonitor`).
- Financial persistence (`TonFinancialPersistence`).
- Financial recovery (`TonFinancialRecovery`, `TonFinancialRecoveryStates`).
- Partial payment escrow unwind (`partialPaymentEscrowUnwind`).
- Financial evidence guards (`financialEvidenceGuards`).
- TON smart contracts (`GameEscrow.tact`, `DepositContract.tact`).
- v4/legacy payment path (`PaymentEngine`, `PaymentActivation`, `EntryPaymentLifecycle`).
- Composition root wiring (`server/app.js`).

This was not a behavioral test pass and did not execute application test suites. The audit was structural and architectural only.

## 2. Files Inspected

Context and architecture documentation:

- `AI_CONTEXT/WHEELWIN_MASTER_CONTEXT.md`
- `AI_CONTEXT/ARCHITECTURE_RULES.md`
- `AI_CONTEXT/CURRENT_STATE.md`
- `AI_CONTEXT/AI_WORKING_RULES.md`
- `AI_CONTEXT/CLINE_REPORTS/2026-08-21_initial_project_audit.md`

Payment session lifecycle:

- `server/gameplay/PaymentSessionManager.js` (2861 lines)
- `server/gameplay/PaymentSessionStates.js` (96 lines)
- `server/gameplay/PaymentSessionManagerErrors.js`
- `server/gameplay/PaymentActivation.js` (157 lines)
- `server/gameplay/EntryPaymentLifecycle.js` (212 lines)
- `server/gameplay/partialPaymentEscrowUnwind.js` (99 lines)
- `server/gameplay/financialEvidenceGuards.js` (85 lines)

GameEscrow contract lifecycle:

- `server/gameplay/GameContractManager.js` (2450 lines)
- `server/gameplay/GameContractManagerErrors.js`

Settlement orchestration:

- `server/payment/ContractSettlementManager.js` (2862 lines)
- `server/payment/ContractSettlementManagerErrors.js`
- `server/payment/SettlementSession.js`
- `server/payment/SettlementSessionStates.js` (94 lines)

Blockchain monitoring:

- `server/payment/BlockchainMonitor.js` (3068 lines)
- `server/payment/BlockchainMonitorErrors.js`
- `server/payment/TonGameContractAdapter.js`
- `server/payment/GameContractDeployAdapter.js`

Financial persistence:

- `server/persistence/TonFinancialPersistence.js` (1488 lines)
- `server/persistence/TonFinancialPersistenceErrors.js`
- `server/persistence/TonFinancialRecordTypes.js`
- `server/persistence/tonFinancialRecordUtils.js`

Financial recovery:

- `server/recovery/TonFinancialRecovery.js` (1739 lines)
- `server/recovery/TonFinancialRecoveryErrors.js`
- `server/recovery/TonFinancialRecoveryStates.js` (27 lines)

Deposit flow:

- `server/deposit/DepositOrchestrator.js`
- `server/deposit/DepositSession.js`
- `server/deposit/DepositSessionStates.js`
- `server/deposit/DepositMonitor.js`
- `server/deposit/DeploymentAuthorization.js`
- `server/deposit/DeploymentAuthorizationCoordinator.js`
- `server/deposit/DeploymentAuthorizationStates.js`

TON smart contracts:

- `contracts/game_escrow/GameEscrow.tact` (389 lines)
- `contracts/deposit/DepositContract.tact` (429 lines)
- `contracts/wrappers/GameEscrow.ts`
- `contracts/wrappers/DepositContract.ts`

v4/legacy payment path:

- `server/engines/PaymentEngine.js` (480 lines)
- `server/engines/payment/PrizeCalculator.js`
- `server/engines/payment/resolveGameFinancialRules.js`
- `server/engines/payment/paymentFreeze.js`
- `server/engines/payment/PaymentValidationError.js`

Composition root:

- `server/app.js` (financial module wiring inspected via search)

## 3. Architecture Findings

### Two payment paths

The codebase contains two distinct payment paths:

1. **v4/legacy path** (simulation/stub):
   - `EntryPaymentLifecycle` → `TelegramWalletAdapter` (stub).
   - `PaymentActivation` → `PaymentEngine` → `TelegramWalletAdapter`.
   - In-memory storage (`Map`); not durable.
   - `EntryPaymentLifecycle` explicitly documents that it "Does not call Telegram Wallet API or the TON blockchain."
   - `PaymentEngine` demonstration is noted as "Retired after C3.8+/C4.x" in `app.js`.
   - This path appears to be a legacy/simulation layer that predates the GameEscrow architecture.

2. **GameEscrow path** (production):
   - `PaymentSessionManager` → `GameContractManager` → `ContractSettlementManager` → `BlockchainMonitor`.
   - Durable persistence via `TonFinancialPersistence`.
   - On-chain TON transactions via `GameEscrow.tact` smart contract.
   - Full recovery support via `TonFinancialRecovery`.
   - This is the current production financial architecture.

### Payment session lifecycle

`PaymentSessionManager` owns the payment session lifecycle. Key characteristics:

- Creates payment sessions after `PAYMENT_CONNECTION_READY`.
- Transitions: `CREATED` → `WAITING_FOR_PAYMENTS` → `PARTIALLY_PAID` → `FULLY_PAID`.
- Terminal states: `FULLY_PAID`, `PAYMENT_TIMEOUT`, `PAYMENT_FAILED`, `CANCELLED`.
- Escrow unwind state: `REFUND_PENDING` → `CANCELLED`.
- Recovery state: `RECOVERED` can transition back to active states.
- `FULLY_PAID` can transition to `CANCELLED` (emergency cancel on-chain after READY / before SETTLE).
- Validates incoming payments: amount, wallet, contract address, network.
- Duplicate payment detection via `_confirmedTxHashes` set.
- Payment deadline expiry via `_scheduleExpiry` / `_onExpiry`.
- Never communicates with TON directly — reads go through `BlockchainMonitor` (+ `TonGameContractAdapter`).

### GameEscrow contract lifecycle

`GameContractManager` owns the GameEscrow contract lifecycle. Key characteristics:

- Creates contract domain records with immutable snapshots.
- Snapshot hash is computed via `hashGameContractSnapshot` and verified on-chain during settlement.
- Contract status transitions: `NOT_CREATED` → `CREATING` → `CREATED` → `AWAITING_PAYMENTS` → `READY_FOR_BLOCKCHAIN` → `DEPLOYING` → `DEPLOYED` → `AWAITING_PLAYER_PAYMENTS` → `PAYMENTS_COMPLETE` → `SETTLEMENT_PREPARING` → `SETTLEMENT_SUBMITTED` → `SETTLEMENT_PENDING` → `SETTLEMENT_CONFIRMED` → `SETTLEMENT_COMPLETED` → `ARCHIVED`.
- Failure states: `DEPLOY_FAILED`, `SETTLEMENT_FAILED`.
- Deploy requires valid `DeploymentAuthorization` (fail-closed gate).
- Authorization is consumed before deploy and stays consumed if deploy fails.
- After deploy, `INIT_GAME` + `OPEN_PAYMENTS` are called for GameEscrow mode.
- `requestPartialPaymentEscrowUnwind` handles EmergencyCancel for partial payment scenarios.
- Never imports `@ton/*` SDK. Never talks to TON directly.

### Settlement orchestration

`ContractSettlementManager` owns post-winner settlement orchestration. Key characteristics:

- Listens for `WINNER_DETERMINED` and creates a durable settlement handoff synchronously before any async adapter work.
- Settlement session transitions: `CREATED` → `PREPARING` → `READY` → `SETTLEMENT_PENDING` / `SETTLEMENT_PENDING_CONFIRMATION` → `SETTLEMENT_CONFIRMED` → `SETTLEMENT_COMPLETED`.
- Terminal states: `SETTLEMENT_COMPLETED`, `SETTLEMENT_FAILED`, `SETTLEMENT_TIMEOUT`.
- `RECOVERED` can transition to `SETTLEMENT_PENDING`, `SETTLEMENT_PENDING_CONFIRMATION`, `SETTLEMENT_CONFIRMED`, `SETTLEMENT_FAILED`, `SETTLEMENT_TIMEOUT`.
- Validates settlement: contract must be `PAYMENTS_COMPLETE`, payment session must be `FULLY_PAID`/`COMPLETED` (not `CANCELLED`), winner must be determined, winner wallet must be verified, owner wallet must be available.
- On-chain settlement probe uses tri-state: `SETTLED`, `NOT_SETTLED`, `UNKNOWN`. `UNKNOWN` never authorizes `settleContract()`.
- GameEscrow mode uses `SETTLEMENT_PENDING_CONFIRMATION` and watches for winner/owner payout proofs.
- v4 mode uses `SETTLEMENT_PENDING` and watches for transaction confirmation.
- Never determines winner. Never polls blockchain. Never uses TON SDK directly.

### Blockchain monitoring

`BlockchainMonitor` observes TON blockchain facts. Key characteristics:

- Reports observation events only — never owns payment/settlement decisions.
- Communicates via `TonService` transport and optional `TonGameContractAdapter`.
- Never imports `@ton/*` SDK.
- Watch types: contract watch, transaction watch, GameEscrow settlement watch, GameEscrow refund watch.
- Recovery checkpoint export/restore for temporary monitor state.
- Health monitoring with states: `STOPPED`, `STARTING`, `RUNNING`, `DEGRADED`, `ERROR`, `SHUTDOWN`.
- `amountsMatch` normalizes GRM amounts for comparison (2 decimal places).
- `isFailedTonTransaction` detects aborted/failed TON transactions.
- `parseDepositCandidate` extracts structured payment fields from TonCenter transaction objects.

### Financial persistence

`TonFinancialPersistence` is the authoritative durable storage for financial state. Key characteristics:

- File-based JSON storage with atomic writes (via `renameSync`).
- Passive persistence only — no business logic, blockchain, gameplay, or EventBus.
- Record types: `GAME_CONTRACT`, `PAYMENT_SESSION`, `DEPOSIT_SESSION`, `DEPLOYMENT_AUTHORIZATION`, `DEPOSIT_OBSERVATION`, `WALLET_SESSION`, `SETTLEMENT`, `SNAPSHOT`, `AUDIT`, `ARCHIVED_CONTRACT`.
- Storage categories: `active`, `immutable`, `archived`.
- Immutable records (snapshots, observations) cannot be updated.
- Version checking for optimistic concurrency (`expectedVersion`).
- Indexes by room, game, contract.
- Integrity check capability (validates envelopes against disk).
- Checkpoint/manifest system.
- `CorruptedRecordError` thrown on validation failure during restore.

### Financial recovery

`TonFinancialRecovery` is the financial recovery coordinator. Key characteristics:

- Restores consistency between financial managers after restart or outage.
- Owns orchestration only — no financial, blockchain, or payment state.
- Recovery pipeline (strict phase order):
  1. `WALLETS` — restore wallet sessions.
  2. `CONTRACTS` — restore game contracts.
  3. `PAYMENTS` — restore payment sessions (syncs from GameEscrow).
  4. Deposit sessions restore.
  5. Deposit monitor watches restore.
  6. Deployment authorizations restore.
  7. `SETTLEMENTS` — restore settlement sessions.
  8. `BLOCKCHAIN` — restore blockchain monitor checkpoint + reregister watches.
  9. Settlement resume (probe on-chain state).
  10. `VALIDATION` — consistency validation across all domains.
- Phase order guard prevents out-of-order execution.
- Fail-closed: errors are collected but recovery continues; consistency errors cause failure.
- Recovery states: `NOT_STARTED` → `RECOVERING` → `VALIDATING` → `COMPLETED` / `FAILED`.
- Restoring states: `RESTORING_WALLETS`, `RESTORING_CONTRACTS`, `RESTORING_PAYMENTS`, `RESTORING_SETTLEMENTS`, `RESTORING_BLOCKCHAIN`.

### GameEscrow smart contract

`GameEscrow.tact` defines the on-chain escrow logic. Key characteristics:

- Status: `UNINITIALIZED` → `DEPLOYED` → `WAITING_PAYMENTS` → `PAYMENTS_OPEN` → `READY` → `SETTLING` → `SETTLED` / `CANCELLED` / `FAILED`.
- Messages: `InitGame`, `OpenPayments`, `Stake`, `Settle`, `EmergencyCancel`.
- Only the declared oracle can `INIT_GAME`, `SETTLE`, and `EMERGENCY_CANCEL`.
- Players must send exact stake amount from the correct wallet (`sender() == expectedPlayer`, `context().value == required`).
- Settlement requires all players to have paid (`STATUS_READY`).
- Settlement requires snapshot hash match (`msg.snapshotHash == self.snapshotHash`).
- Settlement requires sufficient balance including gas reserve (`SETTLE_GAS_RESERVE = ton("0.05")`).
- Emergency cancel refunds only paid, non-refunded seats.
- Cancel requires sufficient balance including gas reserve (`CANCEL_GAS_RESERVE = ton("0.08")`).
- Get methods: `get_status`, `get_contract_id_hash`, `get_snapshot_hash`, `get_settlement_info`, `get_paid_mask`, `get_total_paid`, `get_required_total`, `get_player_payment`, `get_refund_mask`, `get_refunded_total`, `get_cancel_status`.

### DepositContract smart contract

`DepositContract.tact` defines the on-chain deposit logic. Key characteristics:

- Status: `UNINITIALIZED` → `AWAITING_FUNDS` → `PARTIALLY_FUNDED` → `FULL` → `RELEASED` / `REFUNDING` → `REFUNDED` / `EXPIRED`.
- Messages: `FundSeat`, `Release`, `Expire`, `Refund`.
- Immutable binding fields: player addresses, expected stakes, creation fee, expiry, release authority, network tag.
- Only the correct player can fund their seat (`sender() == expectedPlayer`).
- Surplus tracking: excess funds are tracked as `surplusNano` and distributed pro-rata on refund.
- Gas reserves: `RELEASE_GAS_RESERVE = ton("0.05")`, `REFUND_GAS_RESERVE = ton("0.08")`.
- Release requires `releaseAuthority` authorization and game binding hash match.
- Expiry-based refund path: anyone can trigger `Expire` after deadline, then `Refund`.
- Get methods: `get_version`, `get_deposit_id`, `get_room_id_hash`, `get_game_id_hash`, `get_player0/1/2`, `get_expected_stake0/1/2`, `get_creation_fee_per_seat`, `get_expected_amount0/1/2`, `get_paid_mask`, `get_status`, `get_credited_amount0/1/2`, `get_surplus_nano`, `get_expires_at`, `get_release_authority`, `get_network_tag`, `get_released_to`, `get_refund_mask`, `get_total_credited`.

### Financial safety mechanisms

1. **Financial evidence retention** (`financialEvidenceGuards.js`):
   - Shared fail-safe for financial evidence retention.
   - After `GAME_INITIALIZED` / entry-payment activation, missing live references are treated as `UNKNOWN` (keep alive), never as proof the game was unpaid.
   - `SESSION_FINISHED` / `ROOM_DESTROYED` may clean up only when settlement is already terminal (or no financially activated lifecycle exists).

2. **Partial payment escrow unwind** (`partialPaymentEscrowUnwind.js`):
   - `sessionNeedsEscrowUnwind`: true if session is partially paid (some but not all confirmed).
   - `buildPartialPaymentRefundTargets`: builds refund targets for paid seats with expected refund mask.
   - `allConfirmedParticipantsRefunded`: true if all paid participants have been refunded.

3. **Payment session state machine** (`PaymentSessionStates.js`):
   - Explicit transition table prevents illegal state transitions.
   - `FULLY_PAID` can only transition to `CANCELLED` (emergency cancel).
   - `REFUND_PENDING` can only transition to `CANCELLED`.
   - `CANCELLED` is terminal (no transitions).

4. **Settlement session state machine** (`SettlementSessionStates.js`):
   - Explicit transition table prevents illegal state transitions.
   - `SETTLEMENT_COMPLETED`, `SETTLEMENT_FAILED`, `SETTLEMENT_TIMEOUT` are terminal.
   - `RECOVERED` can transition to active states for resume.

5. **Deployment authorization gate** (`GameContractManager._consumeDeploymentAuthorizationOrThrow`):
   - Fail-closed gate before TON adapter spend.
   - Consumes valid `DeploymentAuthorization` before deploy.
   - If deploy transaction fails, authorization stays consumed.
   - A new authorization is never minted during deploy.

6. **Settlement validation** (`ContractSettlementManager._validateSettlement`):
   - Contract must be `PAYMENTS_COMPLETE`.
   - Payment session must be `FULLY_PAID`/`COMPLETED` (not `CANCELLED`).
   - Winner must be determined.
   - Winner wallet must be verified.
   - Owner wallet must be available.

7. **On-chain settlement probe** (`ContractSettlementManager._probeOnChainSettlement`):
   - Tri-state: `SETTLED`, `NOT_SETTLED`, `UNKNOWN`.
   - `UNKNOWN` never authorizes `settleContract()`.
   - Prevents double-settlement and false-negative resume.

## 4. Lifecycle Flow

### GameEscrow payment flow (production)

1. Client connects wallet → `PAYMENT_CONNECTION_READY` event.
2. `PaymentSessionManager.createAndRequest()` creates payment session.
3. `GameContractManager.createContractRequest()` creates contract domain record with immutable snapshot.
4. `GameContractManager._scheduleCreated()` transitions through `CREATING` → `CREATED` → `AWAITING_PAYMENTS` → `READY_FOR_BLOCKCHAIN`.
5. `GameContractManager._beginDeploy()` consumes `DeploymentAuthorization` and transitions to `DEPLOYING`.
6. `GameContractDeployAdapter.deploy()` deploys the GameEscrow contract on-chain.
7. After deploy, `INIT_GAME` + `OPEN_PAYMENTS` are called for GameEscrow mode.
8. Contract transitions to `DEPLOYED` → `AWAITING_PLAYER_PAYMENTS`.
9. `GAME_CONTRACT_READY_FOR_PAYMENTS` event emitted with contract address.
10. `PaymentSessionManager._activatePaymentRequests()` issues payment requests to players.
11. `BlockchainMonitor.watchPayment()` registers payment watches.
12. Players send `STAKE` messages to GameEscrow contract on-chain.
13. `BlockchainMonitor` observes stake transactions and emits `GAME_ESCROW_STAKE_CONFIRMED`.
14. `PaymentSessionManager._handlePaymentTransactionConfirmed()` confirms payments.
15. When all players paid, `PaymentSessionManager._maybeCompleteSession()` transitions to `FULLY_PAID`.
16. `PAYMENT_SESSION_COMPLETED` event emitted.
17. `GameContractManager._handlePaymentSessionCompleted()` transitions contract to `PAYMENTS_COMPLETE`.
18. Game starts. `WinnerEngine` determines winner.
19. `WINNER_DETERMINED` event emitted.
20. `ContractSettlementManager._onWinnerDetermined()` creates durable settlement handoff.
21. `ContractSettlementManager._advanceSettlementAfterHandoff()` transitions through `PREPARING` → `READY`.
22. `ContractSettlementManager._submitSettlementAdapter()` calls `settlementAdapter.settleContract()`.
23. For GameEscrow mode: `SETTLEMENT_PENDING_CONFIRMATION` + payout watch.
24. For v4 mode: `SETTLEMENT_PENDING` + transaction watch.
25. `BlockchainMonitor` observes settlement/payout transactions.
26. `ContractSettlementManager._handleSettlementTransactionConfirmed()` or `_handleGameEscrowSettlementVerified()` confirms settlement.
27. Settlement transitions to `SETTLEMENT_CONFIRMED` → `SETTLEMENT_COMPLETED`.
28. Contract transitions to `SETTLEMENT_COMPLETED` → `ARCHIVED`.

### Partial payment escrow unwind flow

1. Payment session fails after partial confirmation (timeout or failure).
2. `PaymentSessionManager.failSession()` checks `sessionNeedsEscrowUnwind()`.
3. If unwind needed, session transitions to `REFUND_PENDING`.
4. `GameContractManager.requestPartialPaymentEscrowUnwind()` sends `EmergencyCancel` to GameEscrow.
5. GameEscrow refunds paid seats on-chain.
6. `BlockchainMonitor.watchGameEscrowRefunds()` observes refund transactions.
7. `PaymentSessionManager._handleGameEscrowRefundConfirmed()` marks participants as refunded.
8. When all confirmed participants refunded, `_finalizePartialPaymentUnwind()` transitions session to `CANCELLED`.
9. `PAYMENT_SESSION_FAILED` event emitted for room teardown.

### Financial recovery flow

1. Server restarts.
2. `TonFinancialRecovery.recover()` starts recovery pipeline.
3. `WALLETS` phase: restore wallet sessions.
4. `CONTRACTS` phase: restore game contracts from persistence.
5. `PAYMENTS` phase: restore payment sessions from persistence + sync from GameEscrow.
6. Deposit sessions restore.
7. Deposit monitor watches restore.
8. Deployment authorizations restore.
9. `SETTLEMENTS` phase: restore settlement sessions from persistence.
10. `BLOCKCHAIN` phase: restore blockchain monitor checkpoint + reregister watches.
11. Settlement resume: probe on-chain state and resume/adopt/submit settlements.
12. `VALIDATION` phase: consistency validation across all domains.
13. Recovery completes (`COMPLETED`) or fails (`FAILED`).

## 5. Ownership Boundaries

### Payment session domain

Owned by `PaymentSessionManager`:
- Payment session lifecycle (create, update, fail, destroy).
- Payment participant state (requested, submitted, pending, confirmed, refunded).
- Payment confirmation (blockchain confirmed, GameEscrow stake confirmed).
- Payment deadline expiry.
- Partial payment escrow unwind coordination.
- GameEscrow payment state sync (chain is authoritative).

### GameEscrow contract domain

Owned by `GameContractManager`:
- Contract lifecycle (create, deploy, settle, archive).
- Immutable snapshot creation and hashing.
- Deployment authorization consumption.
- `INIT_GAME` + `OPEN_PAYMENTS` coordination.
- Emergency cancel (partial payment escrow unwind).
- Contract persistence and hydration.

### Settlement domain

Owned by `ContractSettlementManager`:
- Settlement session lifecycle (create, prepare, submit, confirm, complete).
- Settlement validation (contract, payment, winner, wallets).
- Settlement adapter submission.
- On-chain settlement probe (tri-state).
- Settlement recovery and resume.
- Settlement persistence.

### Blockchain observation domain

Owned by `BlockchainMonitor`:
- Contract watch (deployment confirmation).
- Transaction watch (confirmation, failure, timeout).
- GameEscrow settlement watch (winner/owner payout proofs).
- GameEscrow refund watch (per-seat refund proofs).
- Payment watch (legacy/v4 payment observation).
- Checkpoint export/restore.
- Health monitoring.

### Financial persistence domain

Owned by `TonFinancialPersistence`:
- Durable storage for all financial record types.
- Record envelope creation, validation, and integrity checking.
- Indexing by room, game, contract.
- Archival of completed contracts.
- Checkpoint/manifest system.

### Financial recovery domain

Owned by `TonFinancialRecovery`:
- Recovery pipeline orchestration.
- Phase ordering and validation.
- Consistency validation across all financial domains.
- Recovery state management.
- Recovery reporting.

### Deposit domain

Owned by `DepositOrchestrator` + `DepositSessionCoordinator`:
- Deposit session lifecycle.
- Deposit monitoring and observation.
- Deployment authorization coordination.
- Deposit activation verification.

### Wallet session domain

Owned by `WalletManager` + `SessionWalletStore`:
- Wallet session lifecycle.
- Wallet verification.
- Financial wallet locking.

### v4/legacy payment domain

Owned by `PaymentEngine` + `PaymentActivation`:
- Prize calculation.
- Payment preparation and processing.
- Payment event emission.
- This path appears retired (noted in `app.js`).

## 6. Risks

### Critical

- **Financial recovery gap**: `WHEELWIN_MASTER_CONTEXT.md` explicitly documents that runtime gameplay objects cannot yet be reconstructed after restart. While financial state can be restored from durable persistence, the `attachExistingRoom()` / `attachExistingGame()` / `PaymentSession rehydration` / `Guarded contract reconciliation` capabilities are identified as missing. This is an active development area (R17.9T.6).
- **Two payment paths coexist**: The v4/legacy path (`PaymentEngine` + `PaymentActivation` + `EntryPaymentLifecycle`) and the GameEscrow path (`PaymentSessionManager` + `GameContractManager` + `ContractSettlementManager`) are both wired in `app.js`. The v4/legacy path uses in-memory storage and simulation/stubs. If the wrong path is active in production, payments are not real and financial state is not durable. The `PaymentEngine` demonstration is noted as "Retired after C3.8+/C4.x" but the module is still imported and wired.
- **Any future change that treats client payment state, local UI state, or `READY`-style client state as financial truth would violate financial safety rules.** The current architecture correctly prevents this, but the risk remains for future modifications.

### High

- **File-based JSON persistence**: `TonFinancialPersistence` uses synchronous file I/O (`writeFileSync`, `readFileSync`, `readdirSync`) for all financial records. This may not scale for production under load. Synchronous I/O blocks the event loop and can cause latency spikes. Consider a database (PostgreSQL is already a dependency) for production financial persistence.
- **Strong interconnection**: Payment, contract deployment, deposit, reimbursement, settlement, and recovery systems are strongly interconnected. `PaymentSessionManager` depends on `GameContractManager`, `ContractSettlementManager`, `BlockchainMonitor`, `FinancialPersistence`, `WalletManager`, and `SessionWalletStore`. `GameContractManager` depends on `PaymentSessionManager`, `ContractSettlementManager`, `BlockchainMonitor`, `FinancialPersistence`, and `DeploymentAuthorizationCoordinator`. Future modifications require careful ownership analysis before implementation.
- **`server/app.js` is a very large composition root**: Many financial domains are initialized and connected from one file. This centralizes wiring but increases risk when making changes because many domains are initialized in sequence.
- **Console.log diagnostics in production code**: `PaymentSessionManager` contains extensive `console.log("[R7.50 DIAG] ...")` diagnostics that should be removed or converted to proper logging in production. These can leak sensitive financial state to stdout.

### Medium

- **`GameContractManager` deploy timeout**: The deploy timeout is configurable (`deployTimeoutMs`, default 2 minutes). If the deploy adapter hangs, the timeout will fire and mark the contract as `DEPLOY_FAILED`. However, the on-chain transaction may still succeed after the timeout, leaving the contract in an inconsistent state. The recovery flow handles this via on-chain probes, but the window exists.
- **`BlockchainMonitor` poll-based observation**: The monitor uses polling (`pollIntervalMs`, default 2000ms) rather than real-time blockchain subscriptions. This means there is a delay between on-chain events and server observation. Payment confirmation, settlement confirmation, and refund confirmation all depend on this polling.
- **`amountsMatch` precision**: The `amountsMatch` function normalizes to 2 decimal places (`Math.round(left * 100) === Math.round(right * 100)`). For nanoton amounts, this may cause false positives or negatives. The function is used for payment validation, so precision is critical.
- **`DepositContract` surplus distribution**: The `distributeSurplusProRata` function uses integer division (`(pool * credited) / self.totalCredited`), which can leave dust amounts in `surplusNano`. This is not a financial safety issue (the dust stays in the contract), but it could accumulate over time.
- **`PaymentSessionManager` restore sets `RECOVERED` status**: When restoring payment sessions, if the session is not in progress and not `RECOVERED`, the status is set to `RECOVERED`. This is a state mutation during recovery that could mask the original terminal status. The code comments suggest this is intentional, but it should be reviewed.

### Low

- **`EntryPaymentLifecycle` simulation**: This module explicitly simulates payments and does not call real TON blockchain. It should be clearly documented as a development/simulation component and not used in production.
- **`PaymentEngine` in-memory storage**: The v4/legacy `PaymentEngine` uses in-memory `Map` storage. If this path is still active, payment state is lost on server restart. The module appears retired, but this should be confirmed.
- **Multiple historical docs**: The `docs/` directory contains many historical audit and forensic reports (R17.8 series). While valuable for context, they increase onboarding surface area and may contain outdated information.

## 7. Recommendations

- **Preserve the documented server-authoritative model exactly as-is.** The financial architecture correctly implements server authority, chain authority, fail-closed recovery, and financial evidence retention.
- **Clarify which payment path is active in production.** The v4/legacy path (`PaymentEngine` + `PaymentActivation` + `EntryPaymentLifecycle`) and the GameEscrow path coexist in `app.js`. If the v4/legacy path is retired, consider removing it or clearly documenting it as deprecated. If both paths are active, document which path is used for which escrow mode.
- **Consider migrating `TonFinancialPersistence` to a database.** PostgreSQL is already a project dependency. File-based JSON storage with synchronous I/O may not scale for production. A database would provide transactions, concurrency control, and better performance.
- **Remove or convert `console.log` diagnostics to proper logging.** `PaymentSessionManager` contains extensive `console.log("[R7.50 DIAG] ...")` diagnostics that should use the project logger instead.
- **Review `amountsMatch` precision for nanoton amounts.** The 2-decimal-place normalization may not be appropriate for nanoton-scale amounts. Consider using exact integer comparison or a higher precision threshold.
- **Continue the preferred WheelWin workflow**: analyze, report, architecture review, approval, implementation, validation, Git checkpoint.
- **Before payment, escrow, settlement, deposit, reimbursement, or recovery changes, first identify the responsible server module and authoritative source of truth.**
- **Do not create parallel recovery, payment, configuration, input, physics, or winner systems.**
- **Consider documenting the financial architecture in a dedicated architecture document.** The current documentation in `AI_CONTEXT/` provides high-level principles, but a detailed financial architecture document would help future developers understand the two payment paths, the escrow modes, the settlement flow, and the recovery pipeline.

## 8. Changes Made

Created this report only:

- `AI_CONTEXT/CLINE_REPORTS/2026-08-21_financial_architecture_audit.md`

No source code files modified.