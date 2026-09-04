# Room Wallet Game Payment Readiness Implementation

Date: 2026-09-04

Branch: `payment/room-wallet-integration`

Task: Connect the already implemented Room Wallet incoming-payment path to the existing `GameStartAuthorization` so three valid **game-specific** player payments can authorize Page 5. No TESTNET funds were sent. No live Telegram testing was performed.

Commit: `feat(payment): enable room wallet game readiness`


## Architecture Implemented

The previous investigation (`2026-09-04_r18_s17_game_payment_readiness_gate_architecture.md`) is treated as authoritative. This task did **not** invent a second readiness gate, a second three-player counter, or a new Page 5 emitter.

Implemented chain:

```
Player Wallet
      ↓
Room Wallet N                    (roomNumber 1..64; reused across sequential games)
      ↓
BlockchainMonitor                (detects transactions; unchanged)
      ↓
RoomWalletIncomingObserver       (attribute / validate / ledger-then-confirm)
      ↓
PaymentSessionManager            (three seats; PAYMENT_SESSION_COMPLETED)
      +
RoomWalletLedger                 (per-gameId PLAYER_PAYMENT CREDIT entries)
      ↓
GameStartAuthorization           (single payment-readiness gate)
      ↓
GAME_START_BOOTSTRAP_READY
      ↓
RoomLobbyBridge._handleGameStartBootstrapReady
      ↓
_completeEntryPayment
      ↓
OPEN_PAGE5 + ENTRY_PAYMENT_COMPLETED
```

Room identity remains:

```
public 4-character roomId
        ↓
authoritative roomNumber (1..64)
        ↓
RoomWalletRegistry
        ↓
Room Wallet N
```

`gameId` remains the per-game financial identity. Sequential games in the same room reuse Wallet N and must not inherit each other's payment state.

`RoomWalletSettlementAdapter` remains post-winner payout/settlement only.

**Runtime mode (smallest new flag):**

| Flag | Controls | Default |
|------|----------|---------|
| `ROOM_WALLET_SETTLEMENT_MODE=ROOM_WALLET` | Post-winner settlement router | off (legacy settlement) |
| `ROOM_WALLET_PAYMENT_INTAKE_MODE=ROOM_WALLET` | Player-payment intake / GSA readiness | off (legacy Deposit + GameEscrow) |

These are independent. Settlement mode does **not** enable player intake. Helper: `isRoomWalletPaymentIntakeEnabled(env)` in `server/payment/roomWallet/roomWalletConfig.js`. True only when the env value trims/uppercases to `ROOM_WALLET`.

When intake is **off** (default): Deposit FULL + GameEscrow `PAYMENTS_COMPLETE` remain authoritative.

When intake is **on**: those two conditions are **not** authoritative. Readiness is current-game PaymentSession completeness plus game-scoped Room Wallet ledger corroboration.


## Payment Flow

1. `BlockchainMonitor` detects a transaction to a configured Room Wallet.
2. `RoomWalletIncomingObserver` resolves destination → `roomNumber` → live room → current `PaymentSession` / `gameId` / player (sender + amount + context).
3. On a valid payment, the observer **records the ledger entry first**. Ledger failure does not emit confirmation (avoids confirmed-without-ledger).
4. Observation persistence enforces transaction idempotency. Duplicate polls do not credit twice.
5. The observer emits the existing `PAYMENT_TRANSACTION_DETECTED` / `PAYMENT_TRANSACTION_CONFIRMED` events.
6. `PaymentSessionManager` confirms the matching seat. It alone decides session completion.
7. Third confirmed seat → existing `PAYMENT_SESSION_COMPLETED`.
8. `GameStartAuthorization._evaluate` → `_checkStartConditions` → `_authorizeAndBootstrap` → `GAME_START_BOOTSTRAP_READY`.
9. `RoomLobbyBridge` remains the only `OPEN_PAGE5` socket emitter.

Invalid / incomplete / wrong-game / duplicate / ambiguous payments never satisfy the gate. Room Wallet `getBalance()` / total blockchain balance / historical transaction count are not consulted.


## RoomWalletLedger Integration

Existing `RoomWalletLedger` terminology is preserved (`PLAYER_PAYMENT`, `CREDIT`, `entryId`, `counterparty`, `reference`, `metadata`).

Additions (smallest):

- Optional `roomNumber` / `playerId` on entries.
- `hasEntry(entryId)` and `listPlayerPayments(gameId)`.
- `RoomWalletLedgerRegistry`: in-process per-`gameId` ledgers.
- `recordPlayerPayment(...)` writes `PLAYER_PAYMENT` CREDIT with `entryId = rwp:{txHash}`.
- Duplicate same-game / same-player hash is idempotent (returns the existing entry).
- Duplicate hash attributed to a different `gameId` or `playerId` throws; the observer treats that as `ledger_failure` and does not confirm the seat.

A valid incoming payment records at least:

- `roomNumber`
- `gameId`
- `playerId`
- `paymentReference` (when present on the seat)
- `txHash` / unique blockchain identity (`rwp:{txHash}`)
- `amountNano` / `amountGram`
- sender, destination, `lt`, comment in `metadata`

Game A and Game B in Room 17 have separate ledger instances keyed by `gameId`. Funding is never derived from the Room Wallet's blockchain balance or total transaction count.

The registry is in-memory. It is wired in `app.js` and injected into the incoming observer and `GameStartAuthorization`. Durable TFP persistence of this ledger is **not** part of this task.


## PaymentSessionManager Integration

`PaymentSessionManager` remains the authoritative three-seat engine.

- Constructor accepts `roomWalletPaymentIntakeEnabled` (default `false`).
- Room Wallet confirmations still use the existing `PAYMENT_TRANSACTION_CONFIRMED` handler.
- Completeness is still `allConfirmed()` → `_maybeCompleteSession()` → `PAYMENT_SESSION_COMPLETED`.
- No second three-player event was created.
- `syncFromGameEscrow` is **not** deleted.
  - Intake **off**: existing GameEscrow `paidMask` authority, including demotion, is unchanged.
  - Intake **on**: sync returns `{ ok: true, synced: 0, demoted: 0, skipped: "room_wallet_intake" }` so legacy `paidMask` cannot erase valid Room Wallet seat confirmations.

The observer does not decide that three payments are complete.


## GameStartAuthorization Changes

`GameStartAuthorization` was extended, not replaced. `_evaluate`, `_checkStartConditions`, and `_authorizeAndBootstrap` remain the start path.

`_checkStartConditions` still requires:

- live room
- current `PaymentSession` `COMPLETED`
- `allConfirmed()`
- every seat `PAYMENT_CONFIRMED`
- participant count === expected players (3)
- session `gameId` matches the resolved current game

**Intake on:**

- `_checkRoomWalletLedger(session)` requires a `PLAYER_PAYMENT` CREDIT on **that `gameId`** for each confirmed `playerId`.
- `isDepositLayerComplete` / `deposit_not_full` is skipped.
- GameContract `PAYMENTS_COMPLETE` is skipped.
- Missing registry → `room_wallet_ledger_missing`.
- Missing per-player current-game entries → `room_wallet_ledger_incomplete`.

**Intake off (default / legacy):**

- Deposit FULL (or later deposit-layer complete states) remains required when `depositSessionCoordinator` is wired.
- GameContract `PAYMENTS_COMPLETE` remains required.

`PAYMENT_SESSION_CREATED` resets the per-room start latch when the new session's `gameId` differs from the previous OPENED game, so Game B cannot inherit Game A's `GAME_START_PHASE.OPENED`.

`_authorizeAndBootstrap` still emits `GAME_START_AUTHORIZED` → `GAME_INITIALIZING` → `GAME_START_BOOTSTRAP_READY`. It does not emit socket `OPEN_PAGE5`.


## Legacy Compatibility

Not deleted and still composed:

- DepositContract / FundSeat / DepositMonitor / DepositSessionCoordinator / DepositOnChainVerificationCoordinator
- GameEscrow / GameContractManager
- existing watchers, persistence, and legacy settlement path
- GSA subscriptions to `DEPOSIT_FULL` and `GAME_CONTRACT_PAYMENTS_COMPLETE` (re-evaluate only; they are not sufficient in intake mode)

Both paths are **not** authoritative at the same time. The intake flag selects exactly one payment-completeness proof.


## Game Isolation

Covered by tests D and E:

- Room 17 / Game A: three valid payments → Game A authorized.
- Same room / Game B with zero new payments → blocked (latch reset; session not complete; Game A ledger is out of scope).
- Game B with 1 then 2 payments → still blocked.
- Game B with three new game-specific payments → ready.
- Game A ledger credits cannot satisfy Game B even if Game B's session object is already `COMPLETED`.


## Page 5 Flow

Unchanged:

```
GameStartAuthorization
        ↓
GAME_START_BOOTSTRAP_READY
        ↓
RoomLobbyBridge._handleGameStartBootstrapReady
        ↓
_completeEntryPayment
        ↓
OPEN_PAGE5 + ENTRY_PAYMENT_COMPLETED
```

Source assertion (test G): `OPEN_PAGE5` does **not** appear in:

- `RoomWalletIncomingObserver.js`
- `RoomWalletLedger.js`
- `PaymentSessionManager.js`
- `RoomWalletSettlementAdapter.js`

`RoomLobbyBridge._deliverOpenPage5` remains the socket emitter.

Automated tests in this task cover GSA reaching `GAME_START_BOOTSTRAP_READY` / lifecycle phase `OPEN_PAGE5` (the GSA phase name, not a new socket event). Existing Page 5 lifecycle tests continue to assert the GSA → RoomLobbyBridge contract.

**Is this chain now covered by automated tests?**

```
Room Wallet
  → three valid game-specific player payments
  → GameStartAuthorization
  → GAME_START_BOOTSTRAP_READY
  → OPEN_PAGE5
```

- **Room Wallet → three payments → `PAYMENT_SESSION_COMPLETED`:** **VERIFIED BY AUTOMATED TESTS**
- **Three payments → `GameStartAuthorization` → `GAME_START_BOOTSTRAP_READY`:** **VERIFIED BY AUTOMATED TESTS**
- **`GAME_START_BOOTSTRAP_READY` → socket `OPEN_PAGE5`:** the existing bridge path is **VERIFIED FROM CURRENT CODE** and by existing Page 5 ownership tests; this task adds a source check that no second emitter was introduced. There is **no new live-socket or TESTNET test** that a real Telegram client received `OPEN_PAGE5` from a Room Wallet payment.


## Tests Added

File: `server/tests/roomWalletGameReadiness.test.js`

| Id | Coverage |
|----|----------|
| A | Valid payment creates game-level ledger entry (`gameId`, `roomNumber`, `playerId`, amount, `txHash`); duplicate hash cannot create a second entry |
| A/E | Game A and Game B ledger entries remain separate on the same Room 17 wallet |
| A (hash) | Same hash on another game is rejected; Game B ledger stays empty |
| B | 0/1/2 payments → not complete; 3 valid payments → `PAYMENT_SESSION_COMPLETED` |
| C | Intake mode: 0/1/2 blocked; 3 authorized without Deposit FULL and without GameEscrow `PAYMENTS_COMPLETE` |
| C legacy | Legacy mode still requires Deposit FULL and `PAYMENTS_COMPLETE` |
| D | Sequential Room 17 Game A then Game B isolation |
| E | Game A payments cannot satisfy Game B |
| F | Local huge Room Wallet balance does not authorize a 2-payment game; GSA never calls `getBalance` |
| G | `GAME_START_BOOTSTRAP_READY` + no second `OPEN_PAGE5` emitter |
| sync | `syncFromGameEscrow` skipped in intake mode; confirmed seat not demoted |

Also updated:

- `roomWalletIncomingObserver.test.js` — fixture injects `RoomWalletLedgerRegistry`
- `roomWalletAppComposition.test.js` — intake flag independence + `app.js` wiring assertions

No existing test that encoded obsolete **legacy** Deposit/GameEscrow readiness was rewritten except by adding the parallel intake-mode cases. Legacy GSA tests remain on the default (intake off) path.


## Tests Executed

Focused + regression (deterministic mocks/fakes only):

| File | Result |
|------|--------|
| `roomWalletGameReadiness.test.js` | 11 pass |
| `roomWalletIncomingObserver.test.js` | 14 pass |
| `roomWalletAppComposition.test.js` | 11 pass |
| `gameStartAuthorization.test.js` | passed (legacy gates intact) |
| `paymentSession.manager.test.js` | all assertions passed |
| `roomNumberWalletMapping.test.js` | 8 pass |
| `roomManager.test.js` | passed |
| `roomWalletSettlementAdapter.test.js` | 6 pass |
| `roomWalletSettlementRouter.test.js` | 4 pass |
| `roomWalletSettlementPlan.test.js` | passed |
| `roomWalletService.test.js` | 2 pass |
| `roomWalletFinancialPolicy.test.js` | OK |
| `roomWalletRuntimeResolver.test.js` | 4 pass |
| `page5LifecycleOwnership.r86.test.js` | all assertions passed |
| `page5LifecycleOwnership.r88.test.js` | all assertions passed |
| `r18s15.page5Continuation.r18s15.test.js` | 2 pass |
| `blockchainMonitor.test.js` | all assertions passed |
| `blockchainMonitor.productionStart.r18s15.test.js` | 2 pass |

No TESTNET script was run.


## Test Results

All focused and listed regression tests passed.

No test was updated because it encoded obsolete Room Wallet readiness semantics; the new intake path is additive behind `ROOM_WALLET_PAYMENT_INTAKE_MODE`.

**Deposit FULL + GameEscrow `PAYMENTS_COMPLETE` in Room Wallet player-intake mode:** **not authoritative**. Test C authorizes with deposit `AWAITING_FUNDS` and contract `AWAITING_PLAYER_PAYMENTS`.

**Those same conditions in legacy mode:** **still authoritative**. Test C legacy and `gameStartAuthorization.test.js` still require them.


## Safety Invariants

1. Game readiness is scoped to the **current `gameId`**, not the Room Wallet's blockchain balance.
2. Three confirmed PaymentSession seats remain the only player-count engine.
3. Ledger record happens before confirmation emit; ledger failure does not confirm the seat.
4. Duplicate `txHash` cannot create a second ledger entry or a second credit.
5. A hash already attributed to another game/player cannot fund the current game.
6. Game B cannot inherit Game A's session completion, ledger credits, or GSA OPENED latch.
7. Intake mode does not let GameEscrow `paidMask` demote Room Wallet confirmations.
8. Legacy mode does not skip Deposit FULL / `PAYMENTS_COMPLETE`.
9. `OPEN_PAGE5` is not emitted by observer, ledger, PSM, or settlement adapter.
10. Game rules (3 players, 1–2 sectors, 1/10 Gram, 1.5× second sector, 95/5, Room Number 1..64, 4-character `roomId`) were not changed.


## Files Changed

| File | Change |
|------|--------|
| `server/payment/roomWallet/roomWalletConfig.js` | `isRoomWalletPaymentIntakeEnabled` |
| `server/payment/roomWallet/RoomWalletLedger.js` | game-scoped player-payment API + `RoomWalletLedgerRegistry` |
| `server/payment/roomWallet/RoomWalletIncomingObserver.js` | ledger-before-confirm; `ledger_failure` |
| `server/gameplay/PaymentSessionManager.js` | intake-aware `syncFromGameEscrow` skip |
| `server/gameplay/GameStartAuthorization.js` | intake-aware `_checkStartConditions`; ledger corroboration; new-game latch reset |
| `server/app.js` | compose ledger registry; pass intake flag + registry into observer / PSM / GSA |
| `server/tests/roomWalletGameReadiness.test.js` | new focused tests A–G |
| `server/tests/roomWalletIncomingObserver.test.js` | ledger registry in fixture |
| `server/tests/roomWalletAppComposition.test.js` | intake vs settlement independence + wiring |
| `AI_CONTEXT/CLINE_REPORTS/2026-09-04_r18_s18_room_wallet_game_readiness_implementation.md` | this report |

Not redesigned: BlockchainMonitor, RoomWalletRegistry, RoomWalletSettlementAdapter, ContractSettlementManager, GameManager, RoomManager.


## Commit

Message: `feat(payment): enable room wallet game readiness`

Single commit after focused tests passed. Unrelated working-tree files (forensics, banners, other reports) were not included.


## Remaining Limitations

**NOT IMPLEMENTED**

- Durable persistence of `RoomWalletLedger` across process restart (in-memory registry only; PaymentSession TFP persistence still exists separately).
- Enabling intake in production by default. Operators must set `ROOM_WALLET_PAYMENT_INTAKE_MODE=ROOM_WALLET`.
- Coupling settlement mode to intake mode (intentionally separate).
- Removing or migrating off Deposit / FundSeat / GameEscrow.
- Live-socket proof that a Telegram client received `OPEN_PAGE5` from this path.

**IMPLEMENTED BUT NOT TESTNET VERIFIED**

- Full live path: real player wallets → Room Wallet N → TonCenter poll → observer → ledger → three seats → GSA → `GAME_START_BOOTSTRAP_READY` → `OPEN_PAGE5` on a real client.
- Production env combination of intake mode + settlement mode + `ROOM_WALLETS_JSON`.
- Process restart while a Room Wallet intake game is mid-payment (ledger is in-memory).

**VERIFIED BY AUTOMATED TESTS**

- Game-scoped ledger write, idempotency, and Game A / Game B isolation.
- 0/1/2/3 payment completion via existing `PAYMENT_SESSION_COMPLETED`.
- Intake-mode GSA authorization without Deposit FULL and without GameEscrow `PAYMENTS_COMPLETE`.
- Legacy-mode GSA still requiring Deposit FULL + `PAYMENTS_COMPLETE`.
- Sequential Game B not inheriting Game A readiness.
- Wrong-game ledger credits cannot satisfy the current game.
- Room Wallet balance cannot substitute for three current-game confirmations.
- GameEscrow sync skip in intake mode.
- No second `OPEN_PAGE5` emitter in observer / ledger / PSM / settlement adapter.
- `GAME_START_BOOTSTRAP_READY` emission on successful intake-mode readiness.


## TESTNET E2E Status

**NOT VERIFIED.**

This task used deterministic mocks and fakes only. No TESTNET funds were sent. No live Telegram session was run. This report does not claim TESTNET E2E success.
