# Room Wallet Incoming Payment Implementation

Date: 2026-09-04

Task: Implement the minimal Room Wallet incoming payment observation and attribution layer, feeding the existing payment-session lifecycle without replacing settlement, DepositMonitor, GameEscrow, or PaymentSessionManager.

Checkpoint before this change: `02229acf42796778ca8d7eb3f72927e2dfa4f659`

Branch: `payment/room-wallet-integration`

## Scope

Add the smallest production-capable path:

Player Wallet → TON inbound transfer → configured Room Wallet → sender attribution to an in-progress payment participant → existing `PAYMENT_TRANSACTION_DETECTED` / `PAYMENT_TRANSACTION_CONFIRMED` → `PaymentSessionManager`.

Out of scope (unchanged):

- Room Wallet settlement adapter / policy / plan
- DepositContract, FundSeat, DepositMonitor, GameEscrow watches
- GameStartAuthorization triple gate
- RoomWalletLedger redesign
- TESTNET E2E

## Implementation Summary

New class `RoomWalletIncomingObserver` (`server/payment/roomWallet/RoomWalletIncomingObserver.js`):

- Polls each unique configured Room Wallet address through existing `TonService.getTransactions` / transport (same as BlockchainMonitor).
- Parses transactions with existing `parseDepositCandidate()` (sender, destination, comment, amountGram, txHash, lt).
- Amount unit convention is explicit: TonCenter nanotons → Gram via `/ 1e9` (`nanotonToGram`, same as `parseDepositCandidate` unless `amountIsGram`).
- Expected amount is `participant.requiredGram` compared with existing `amountsMatch`.
- Attributes by canonical sender wallet against in-progress `PaymentSession` participants.
- Intended destination: `registry.get(numeric roomId)` when `roomId` is 1..64; if the registry has exactly one wallet, that address is shared. Otherwise unmapped rooms are not credited.
- Credits only after a durable TFP `audit` record is created. Observation id: `rwin__{destination}__{txHash}` (Windows-safe, no colon).
- Emits existing payment events. Does not set `payload.address` to the Room Wallet (avoids PaymentSessionManager “wrong contract” check against GameEscrow).

BlockchainMonitor is not replaced. It gained `setRoomWalletIncomingObserver` and calls `observer.poll()` from the existing global poll timer (same pattern as DepositMonitor). No second timer.

## Runtime Integration

`server/app.js`:

1. `createRoomWalletRegistryFromEnv(process.env)` (addresses only; no extra signing service).
2. Construct `RoomWalletIncomingObserver` with payment session manager, TFP, transport, audit ledger.
3. `blockchainMonitor.setRoomWalletIncomingObserver(observer)` before `start()`.
4. `observer.shutdown()` during application shutdown.

If `ROOM_WALLETS_JSON` is empty, the observer polls zero addresses (no-op). Settlement mode is unchanged.

## Attribution Flow

```
BlockchainMonitor._pollGlobal
  → RoomWalletIncomingObserver.poll
  → getTransactions(roomWalletAddress)
  → parseDepositCandidate
  → destination must be a configured Room Wallet
  → unique in-progress participant: sender wallet + intended dest match
  → amountsMatch(requiredGram, amountGram)
  → persist immutable audit observation
  → PAYMENT_TRANSACTION_DETECTED
  → PAYMENT_TRANSACTION_CONFIRMED
  → PaymentSessionManager.confirmBlockchainPayment
```

Ambiguous (same sender in two in-progress sessions paying the same intended wallet): no credit, terminal reject, durable observation.

Unknown sender: no credit, **not** durably locked, so a later session bind can still match if the tx remains in the poll window.

## Idempotency

Durable identity: `rwin__{canonicalDestination}__{txHash}` in TFP `audit` records (`createAuditRecord` / `loadAuditRecord`). Duplicate create → `DuplicateRecordError` → no second credit.

Repeated poll of the same tx is idempotent. One tx cannot credit two players or two games: uniqueness is the chain hash bound to one destination, and attribution requires exactly one candidate.

## Persistence

TFP `audit` records with `payload.kind = ROOM_WALLET_INCOMING_OBSERVATION`. Immutable on create (existing AUDIT type). Survives restart via TFP restore. `RoomWalletLedger` was inspected and **not** used: it is in-memory, unused in `app.js`, and not a durable incoming ledger.

## Payment Session Integration

Existing subscribers on `PAYMENT_TRANSACTION_DETECTED` and `PAYMENT_TRANSACTION_CONFIRMED` are reused. Observed chain transfer is treated as confirmation for this stage (same as non-paidMask BlockchainMonitor confirms). GameEscrow `paidMask` is not consulted for Room Wallet transfers.

Three-player readiness remains `GameStartAuthorization` (payment session + deposit layer + GameEscrow `PAYMENTS_COMPLETE`). This path only updates payment-session participant state.

## Legacy Compatibility

DepositMonitor, FundSeat, GameEscrow watches, and Room Wallet settlement were not removed or redesigned. Settlement tests still pass.

## Tests Added

`server/tests/roomWalletIncomingObserver.test.js` (mocked TON only):

| Case | Coverage |
|---|---|
| A–D | valid payment, sender, game/session, exact 1 Gram |
| E | wrong amount |
| F | wrong destination |
| G | unknown sender (no durable lock) |
| H | ambiguous shared sender |
| I/J | duplicate + repeated poll |
| K | two games, no cross-credit |
| L/M | restore payment session + replay tx |
| N | PaymentSessionManager CONFIRMED via existing events |
| O | existing Room Wallet settlement tests (separate command) |
| extra | expired context, missing fields, persistence unavailable, BM poll hook, nano→Gram |

## Tests Executed

```
node --test server/tests/roomWalletIncomingObserver.test.js
```

Result: 14 pass, 0 fail.

```
node --test server/tests/roomWalletIncomingObserver.test.js server/tests/roomWalletAppComposition.test.js server/tests/roomWalletFinancialPolicy.test.js server/tests/roomWalletSettlementAdapter.test.js server/tests/roomWalletSettlementPlan.test.js server/tests/roomWalletSettlementRouter.test.js server/tests/roomWalletService.test.js server/tests/roomWalletRuntimeResolver.test.js server/tests/paymentSession.manager.test.js server/tests/blockchainMonitor.test.js
```

Result: 43 pass, 0 fail.

## Test Results

**VERIFIED BY TESTS:** destination/sender/amount/uniqueness/ambiguity/restart identity; PaymentSessionManager event compatibility; Room Wallet settlement regression; BlockchainMonitor still starts and now invokes the observer poll.

**IMPLEMENTED BUT NOT E2E VERIFIED:** live TonConnect Player Wallet → Room Wallet → payment session in Telegram.

**NOT PROVEN:** TESTNET; four-character gameplay `roomId` mapped onto a specific `roomNumber` when multiple Room Wallets exist; GameStartAuthorization becoming ready from Room Wallet intake alone (deposit + GameEscrow gates still required).

## Safety Invariants

| Invariant | Status |
|---|---|
| One tx cannot credit two players | VERIFIED BY TESTS (unique hash + unique candidate) |
| One tx cannot credit two games | VERIFIED BY TESTS (K, H) |
| Duplicate observation cannot duplicate payment | VERIFIED BY TESTS (I/J, L/M) |
| Unknown sender cannot credit | VERIFIED BY TESTS (G) |
| Wrong destination cannot credit | VERIFIED BY TESTS (F, K) |
| Wrong amount cannot credit | VERIFIED BY TESTS (E) |
| Ambiguous attribution cannot credit | VERIFIED BY TESTS (H) |
| Restart keeps durable tx identity | VERIFIED BY TESTS (L/M) |
| Legacy payment path remains | VERIFIED BY TESTS (paymentSession + blockchainMonitor) |
| Room Wallet settlement unchanged | VERIFIED BY TESTS (roomWallet* settlement suite) |
| Three-player game-start authority unchanged | IMPLEMENTED BUT NOT E2E VERIFIED (code not modified) |

## Files Changed

- `server/payment/roomWallet/RoomWalletIncomingObserver.js` (added)
- `server/tests/roomWalletIncomingObserver.test.js` (added)
- `server/payment/BlockchainMonitor.js` (observer hook on existing global poll)
- `server/events/EventSources.js` (`ROOM_WALLET_INCOMING_OBSERVER`)
- `server/app.js` (compose, start, shutdown)
- `AI_CONTEXT/CLINE_REPORTS/2026-09-04_r18_s16_room_wallet_incoming_payment_implementation.md` (this report)

## Architecture Findings

Intake is a poll+attribute adapter beside DepositMonitor. Settlement remains outbound-only. PaymentSessionManager remains the payment-session authority.

## Lifecycle Flow

See Attribution Flow. Application start wires the observer before `BlockchainMonitor.start()`. Shutdown stops the observer then the monitor.

## Ownership Boundaries

- Blockchain facts: observer + `parseDepositCandidate`
- Player/session binding: existing PaymentSession / SessionWalletStore
- Durable tx identity: TFP audit observation
- Payment confirmation: PaymentSessionManager
- Game start: GameStartAuthorization (unchanged)
- Settlement: RoomWalletSettlementAdapter (unchanged)

## Risks

- **High:** Gameplay `roomId` strings (e.g. `Keah`) do not map to `roomNumber` when more than one Room Wallet is configured; those sessions will not be credited by this path.
- **High:** Confirming a payment session via Room Wallet does not satisfy deposit or GameEscrow start gates.
- **Medium:** Unknown-sender txs are not durably reserved; they can be attributed later if a session appears while the tx is still in the 32-transaction lookback.
- **Low:** Audit records are a reuse of TFP AUDIT, not a dedicated ledger type.

## Recommendations

Do not cut over from Deposit/GameEscrow until `roomId`→`roomNumber` is explicit for live rooms and GameStartAuthorization is deliberately updated. Next work should not redesign settlement.

## Commit

`feat(payment): add room wallet incoming payment attribution`

## Remaining Limitations

- No client TonConnect builder targeting Room Wallet.
- No RoomWalletLedger integration.
- Shared destination across sequential games is safe only while at most one in-progress session binds a given sender.
- Poll lookback is the transport page (32), same family as current deposit polling.

## TESTNET E2E Status

**NOT PERFORMED.** Unit/integration tests used mocked transactions only. Do not treat this as TESTNET proof.

## Changes Made

- application code: Room Wallet incoming observer + BlockchainMonitor poll hook + app.js wiring + EventSources
- tests: added `server/tests/roomWalletIncomingObserver.test.js`; unrelated tests unchanged
- configuration: unchanged (uses existing `ROOM_WALLETS_JSON`)
- deployment: unchanged
- commits: one (this task)
