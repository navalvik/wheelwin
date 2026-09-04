# Authoritative Room Number ↔ Room Wallet Implementation

Date: 2026-09-04

Branch: `payment/room-wallet-integration`

Task: Implement the missing authoritative live-room identity join (`public roomId` → Room Number `1..64` → Room Wallet `N`) and fix Room Wallet intake + settlement so they never treat gameplay `roomId` as a numeric wallet key.


## Confirmed Architecture

The originally agreed mapping is a **fixed 1:1** relationship:

```
Room Number N  ↔  Room Wallet N
```

for `N` in `1..64`.

The Room Wallet belongs to the **live room**, not to an individual game. Sequential games in the same room reuse the same Room Number and therefore the same Room Wallet. Each game keeps its own financial identity via `gameId` and the existing payment/settlement records.

Public gameplay `roomId` remains the existing 4-character room code from `generateRoomId()`. It is **not** converted with `Number(roomId)`, hashed, or assigned by occupancy order.

Authoritative resolution chain now implemented:

```
public gameplay roomId
        ↓
RoomManager (live Room.roomNumber, allocated 1..64)
        ↓
Room Wallet Number 1..64
        ↓
RoomWalletRegistry
        ↓
fixed Room Wallet address
```

Game-specific ledger remains:

```
gameId → PaymentSession / settlement session / TFP records
```

Room Wallet blockchain balance is **not** current-game balance.

**VERIFIED BY TESTS** for allocation uniqueness, reuse after destroy, `roomId` non-numeric identity, Room 17 → Wallet 17 across Game A then Game B, incoming attribution, and settlement `roomNumber` resolution.

**IMPLEMENTED BUT NOT E2E VERIFIED** for live TESTNET rooms.

**NOT PROVEN** that every historical financial record created before this change already stores `roomNumber`.


## Implementation

No `RoomIDManager` was created. `RoomManager` already owns live room lifecycle and is the authoritative allocator.

Changes:

1. `Room.roomNumber` — integer `1..64`, unique among live rooms, stable for the room lifetime.
2. `RoomManager` allocates the lowest free number in `1..64` at `createRoom()`, releases it on `destroyRoom()` / `detachRoom()`, and claims or allocates on recovery `attachRoom()`.
3. `Game.roomNumber` is copied from the live room at `GameManager.createGame()` when bootstrap `roomManager` is present. Wallet selection still uses `roomNumber`, never `gameId`.
4. `PaymentSession.roomNumber` is copied from the live room at session creation and persisted in `toPayload` / `fromRecord`.
5. `RoomWalletIncomingObserver` resolves intended destination from authoritative `roomNumber` (session and/or `RoomManager`). The `Number(roomId)` and sole-wallet fallback paths were removed.
6. `RoomWalletSettlementAdapter.resolveRoomNumber()` requires explicit `request.roomNumber` and normalizes `"01"` → `1`. It does **not** fall back to `request.roomId`.
7. `ContractSettlementManager` injects `roomManager` and attaches `roomNumber` onto settlement requests via `_resolveRoomNumberForSettlement` / `_withAuthoritativeRoomNumber`.
8. `app.js` wires `roomManager` into both the incoming observer and `ContractSettlementManager`.

`RoomWalletRegistry` remains the catalog: `roomNumber` → address from `ROOM_WALLETS_JSON`. Catalog semantics were not redesigned. `tryNormalizeRoomNumber` and `getByAddress` were added as helpers.


## Room Lifecycle

```
CREATE ROOM
    → allocate Room Number (lowest free in 1..64)
    → create Room(roomId, roomNumber)
    → players join
    → Game A (same roomNumber / same wallet)
    → Game A finishes
    → Game B (same roomNumber / same wallet)
    → ROOM DESTROY
    → release roomNumber
    → a future room may reuse that number
```

Live rooms remain process-ephemeral: no new durable live-room table was invented. While a room exists in the running process, `roomNumber` is authoritative. After restart, financial records may retain `roomNumber` / `gameId`; the live room is not resurrected from the wallet catalog.


## Room Number Allocation

- Source: `RoomManager._allocateRoomNumber()`.
- Range: `1..ROOM_WALLET_COUNT` (`64`).
- Strategy: lowest currently unoccupied integer. This is **not** “current occupancy count + 1”.
- If all 64 numbers are occupied, `createRoom()` returns `null`.
- Concurrent-room capacity (`maxConcurrentRooms`, default 64) still rejects overflow before/alongside the number pool.
- Destroyed numbers become reusable. Example: rooms `1,2,3` live; destroy `2`; the next created room receives `2`.
- Two simultaneous live rooms cannot hold the same Room Number.

**VERIFIED BY TESTS** (A–E in `roomNumberWalletMapping.test.js` and `roomManager.test.js`).


## Room Wallet Resolution

```
roomId → RoomManager.resolveRoomNumber(roomId) → registry.get(roomNumber) → address
```

Also accepted: explicit integer `roomNumber` on payment/settlement context (`"01"` normalizes to `1`).

Rejected:

- `Number(roomId)`
- string hashing of `roomId`
- occupancy-position → wallet number
- `gameId` → wallet number
- sole-configured-wallet fallback for unknown `roomId`

**VERIFIED BY TESTS** (F, G, H, I, K, S, T).


## Incoming Payment Integration

`RoomWalletIncomingObserver`:

1. Watches configured Room Wallet addresses (existing TonCenter transport / `parseDepositCandidate`).
2. Parses sender, destination, amount, tx hash, lt, comment.
3. Resolves `roomNumber` from the in-progress `PaymentSession` and/or `RoomManager`.
4. Resolves expected Room Wallet address from `RoomWalletRegistry`.
5. Validates destination, sender, amount.
6. Attributes to exactly one `(roomNumber, gameId, playerId, paymentReference, sender, txHash)` tuple.
7. Ambiguous sender matches that resolve to the same destination are rejected, not guessed.
8. Duplicate `txHash`+destination observation ids are not credited twice.
9. Emits existing `PAYMENT_TRANSACTION_DETECTED` / `PAYMENT_TRANSACTION_CONFIRMED`.

Does not duplicate TON parsing or add a second SDK.

**VERIFIED BY TESTS** (incoming observer suite + mapping L–R, P).

**IMPLEMENTED BUT NOT E2E VERIFIED** against real TESTNET transfers.


## Settlement Integration

Path:

```
gameId
  → game.roomId
  → authoritative roomNumber (RoomManager / Game / PaymentSession)
  → RoomWalletRegistry
  → Room Wallet N
  → RoomWalletSettlementAdapter
```

`request.roomNumber ?? request.roomId` was removed. A 4-character `roomId` such as `"Keah"` without `roomNumber` now throws `roomNumber is required` at the adapter. `ContractSettlementManager` supplies `roomNumber` before the adapter call when a live room (or payment session) still exists.

Payout policy, Winner/Owner amounts, and GameEscrow settlement math were not redesigned.

**VERIFIED BY TESTS** (settlement adapter + mapping S/T + existing Room Wallet settlement tests).

**IMPLEMENTED BUT NOT E2E VERIFIED** for live ROOM_WALLET mode on TESTNET.


## Game Financial Isolation

Room Wallet address alone does not identify a game. Game A and Game B in Room 17:

- share Wallet 17;
- use different `gameId` values;
- use different payment sessions;
- do not inherit each other's `txHash` / confirmation state;
- settlement records keep their own `gameId`;
- Room Wallet `getBalance` is used only as settlement **funding** preflight, not as Game B's pot.

**VERIFIED BY TESTS** (mandatory Game A → Game B case in `roomNumberWalletMapping.test.js`).

**NOT PROVEN** on a live wallet that still holds leftover funds from a previous game.


## Legacy Compatibility

Not removed and not cut over:

- DepositContract
- FundSeat
- DepositMonitor
- GameEscrow
- existing legacy settlement adapter path through `RoomWalletSettlementRouter` when `ROOM_WALLET_SETTLEMENT_MODE` is not `ROOM_WALLET`

This task only added room identity and made Room Wallet intake/settlement resolve the correct wallet.

**VERIFIED BY TESTS** that composition still routes legacy when Room Wallet mode is off, and that PaymentSessionManager / ContractSettlementManager / BlockchainMonitor focused tests still pass.

**NOT PROVEN** that a full live FundSeat → GameEscrow round still succeeds after this commit (not re-run as TESTNET E2E).


## Tests Added

New: `server/tests/roomNumberWalletMapping.test.js`

Covers:

| Id | Case |
|----|------|
| A | First room receives Room Number 1 |
| B | Simultaneous rooms receive unique Room Numbers |
| C | 64 simultaneous rooms supported |
| D | 65th room rejected |
| E | Destroyed Room Number becomes reusable |
| F | `roomId` remains 4-character public identifier |
| G | `roomId` is never interpreted numerically |
| H | Room Number N resolves to Room Wallet N |
| I | Room 17 resolves to Wallet 17 during its lifetime |
| J | Game A and Game B in Room 17 both use Wallet 17, isolated ledgers |
| K | Two simultaneous rooms never cross-use wallets |
| L–N | Incoming payment resolves destination, player, game |
| O | Duplicate transaction is not credited twice |
| P | Ambiguous attribution is rejected |
| Q | Wrong destination is rejected |
| R | Wrong amount is rejected |
| S | Settlement resolves authoritative Room Number |
| T | Settlement never treats `roomId` as `roomNumber` |

Updated:

- `server/tests/roomManager.test.js` — first room has `roomNumber` `1..64`; `roomId` stays distinct.
- `server/tests/roomWalletIncomingObserver.test.js` — 4-character `roomId` + explicit `roomNumber`; removed numeric/`Keah` sole-wallet mapping.
- `server/tests/roomWalletSettlementAdapter.test.js` — `"01"` normalizes to `1`; `roomId: "Keah"` without `roomNumber` throws.
- `server/tests/roomWalletAppComposition.test.js` — `app.js` wires `roomManager` into CSM and the incoming observer.


## Tests Executed

From `server/`:

```
node --test tests/roomNumberWalletMapping.test.js tests/roomWalletIncomingObserver.test.js tests/roomWalletSettlementAdapter.test.js tests/roomWalletAppComposition.test.js tests/roomWalletSettlementRouter.test.js tests/roomWalletRuntimeResolver.test.js tests/roomWalletService.test.js tests/roomWalletSettlementPlan.test.js tests/blockchainMonitor.test.js tests/paymentSession.manager.test.js tests/contractSettlement.manager.test.js
```

After fixing a syntax error in the new mapping file, re-ran:

```
node --test tests/roomNumberWalletMapping.test.js
node tests/roomManager.test.js
node tests/roomWalletFinancialPolicy.test.js
```

The entire repository suite was **not** run.


## Test Results

**VERIFIED BY TESTS**

- `roomNumberWalletMapping.test.js`: 8/8 pass (A–T and mandatory Game A/B).
- `roomWalletIncomingObserver.test.js`: 14 pass (after identity fix).
- `roomWalletSettlementAdapter.test.js`: all pass, including the new `roomId` rejection case.
- `roomWalletAppComposition.test.js`: 10 pass, including `roomManager` wiring assertions.
- `roomWalletSettlementRouter.test.js`: 4 pass.
- `roomWalletRuntimeResolver.test.js`: pass.
- `roomWalletService.test.js`: pass.
- `roomWalletSettlementPlan.test.js`: pass.
- `blockchainMonitor.test.js`: all assertions passed.
- `paymentSession.manager.test.js`: pass.
- `contractSettlement.manager.test.js`: all assertions passed.
- `roomManager.test.js`: passed (`RoomManager tests passed`), including 4-character `roomId` + `roomNumber`.
- `roomWalletFinancialPolicy.test.js`: OK.

U/V: existing Room Wallet settlement tests and the focused payment/session/settlement regressions listed above remain passing.

First combined `node --test ...` run failed only because `roomNumberWalletMapping.test.js` had a leftover `));` after replacing `awaitMaybe`. That syntax error was fixed; the mapping file then passed 8/8. The other files in that first command had already passed.


## Safety Invariants

| Invariant | Status |
|-----------|--------|
| One live room has exactly one Room Number | **VERIFIED BY TESTS** |
| One Room Number maps to exactly one Room Wallet in the registry catalog | **VERIFIED BY TESTS** (registry still rejects conflicting address for the same number) |
| One Room Wallet is never simultaneously assigned to two live rooms | **VERIFIED BY TESTS** (unique live `roomNumber`; two rooms cannot occupy the same number) |
| `roomId` is not numeric identity | **VERIFIED BY TESTS** |
| `roomId` is not used as `roomNumber` | **VERIFIED BY TESTS** |
| `gameId` does not determine Room Wallet | **VERIFIED BY TESTS** |
| Same room reuses same Room Wallet across games | **VERIFIED BY TESTS** |
| Different simultaneous rooms use different Room Wallets | **VERIFIED BY TESTS** |
| One transaction cannot credit two players / two games | **VERIFIED BY TESTS** (unique attribution or `AMBIGUOUS_ATTRIBUTION`) |
| Duplicate transaction cannot create duplicate credit | **VERIFIED BY TESTS** |
| Room Wallet balance is not current-game balance | **VERIFIED BY TESTS** (Game B required Gram stays player stake; `getBalance` is settlement funding only) |
| Settlement uses authoritative `roomNumber` | **VERIFIED BY TESTS** |
| Incoming intake uses authoritative `roomNumber` | **VERIFIED BY TESTS** |
| Legacy payment path remains operational | **VERIFIED BY TESTS** at composition/unit level; **NOT PROVEN** as live TESTNET FundSeat/GameEscrow E2E |


## Files Changed

Production:

- `server/models/Room.js`
- `server/models/Game.js`
- `server/models/PaymentSession.js`
- `server/managers/RoomManager.js`
- `server/managers/GameManager.js`
- `server/gameplay/PaymentSessionManager.js`
- `server/payment/roomWallet/RoomWalletRegistry.js`
- `server/payment/roomWallet/RoomWalletIncomingObserver.js`
- `server/payment/roomWallet/RoomWalletSettlementAdapter.js`
- `server/payment/ContractSettlementManager.js`
- `server/app.js`

Tests:

- `server/tests/roomNumberWalletMapping.test.js` (new)
- `server/tests/roomManager.test.js`
- `server/tests/roomWalletIncomingObserver.test.js`
- `server/tests/roomWalletSettlementAdapter.test.js`
- `server/tests/roomWalletAppComposition.test.js`

Report:

- `AI_CONTEXT/CLINE_REPORTS/2026-09-04_r18_s16_authoritative_room_wallet_mapping_implementation.md`

No deployment files, no legacy payment removal, no auxiliary Markdown besides this report.


## Commit

Message:

```
feat(room): add authoritative room number wallet mapping
```

One commit, scoped to this task's production files, focused tests, and this report.


## Remaining Limitations

- Live rooms are still in-process only. After process restart, Room Numbers are allocated anew for newly created rooms. Historical `roomNumber` on financial records is the post-restart identity for those games, not a resurrected live room.
- Recovery `attachRoom()` of a room that has no `roomNumber` allocates the lowest free number. That mutates the recovered Room object. If a recovered snapshot already has `roomNumber`, that value is claimed instead.
- Incoming Room Wallet observation still does not replace DepositContract FundSeat / GameEscrow as the default live player-payment path unless those flows are separately pointed at Room Wallets.
- Settlement still requires Room Wallet mode (`ROOM_WALLET_SETTLEMENT_MODE=ROOM_WALLET`) plus `ROOM_WALLETS_JSON` to actually pay from Room Wallets.
- `getByAddress` matches trimmed registry strings, not every TON address encoding variant. Incoming matching uses the existing canonicalizer against watched addresses.

**IMPLEMENTED BUT NOT E2E VERIFIED.**


## TESTNET E2E Status

**NOT PERFORMED.**

No real TESTNET funds, wallets, or live Telegram rooms were used. All payment and settlement cases used deterministic mocks.

### Room N → Room Wallet N — runtime enforcement

**Yes. Room N → Room Wallet N is now enforced by runtime code** while a room is live:

- `RoomManager` assigns unique `roomNumber` `N` for the room lifetime.
- `RoomWalletRegistry.get(N)` is the only wallet lookup.
- Incoming observer and settlement adapter both require that authoritative `roomNumber`.
- Gameplay `roomId` is not a wallet key.

That enforcement is **VERIFIED BY TESTS**. It is **NOT PROVEN** on TESTNET.
