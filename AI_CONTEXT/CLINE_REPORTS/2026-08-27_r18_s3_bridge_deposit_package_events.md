# R18 S3 — Deposit Package Published Client Bridge Implementation Report

Date: 2026-08-27

Task: Bridge DEPOSIT_PACKAGE_PUBLISHED from DepositOrchestrator through RoomLobbyBridge to authenticated player sockets via requester-scoped projection.

## A. Scope

Only S3 was implemented. S1 and S2 remain unchanged and verified.

## B. Root Cause

`DEPOSIT_PACKAGE_PUBLISHED` was emitted by `DepositOrchestrator._emitPackagePublished()` but had no production consumer. `RoomLobbyBridge.initialize()` contained no subscription for this event, so the frozen deposit package never reached authenticated clients.

## C. Implementation

1. Added `LOBBY_SERVER_EVENTS.DEPOSIT_PACKAGE_PUBLISHED` in `server/socket/lobbyProtocol.js`.
2. Added `depositSessionCoordinator` constructor parameter to `RoomLobbyBridge` and stored it as `this._depositSessionCoordinator`.
3. Added EventBus subscription for `EVENT_TYPES.DEPOSIT_PACKAGE_PUBLISHED` in `RoomLobbyBridge.initialize()`.
4. Implemented `_deliverDepositPackagePublished(payload)` in `RoomLobbyBridge`:
   - Extracts `roomId` and `gameId` from the event payload.
   - Resolves the room via `_roomManager.getRoom(roomId)`.
   - Iterates `room.players`, looks up each player's authenticated socket via `_playerToSocket`.
   - Calls `projectDepositForPlayer({ playerId, roomId, gameId, depositSessionCoordinator, roomLobbyBridge: this })` for each player.
   - Skips players with no authenticated socket.
   - Skips players where `projectDepositForPlayer` returns null/undefined.
   - Delivers individually via `_deliverToSocket(socketId, LOBBY_SERVER_EVENTS.DEPOSIT_PACKAGE_PUBLISHED, { deposit: projection })`.
5. Wired `depositSessionCoordinator` into `RoomLobbyBridge` from `app.js`.

## D. Production Event Path

```
DepositOrchestrator
    ↓
DEPOSIT_PACKAGE_PUBLISHED
    ↓
RoomLobbyBridge._deliverDepositPackagePublished()
    ↓
for each room player:
    projectDepositForPlayer(playerId)
    ↓
_deliverToSocket(socketId, DEPOSIT_PACKAGE_PUBLISHED, { deposit: projection })
    ↓
SocketGateway._handleLobbyDelivery()
    ↓
authenticated player socket
```

## E. Requester Scoping

Each player receives their own independently generated projection:

- `projectDepositForPlayer` is called with the specific `playerId` for each socket.
- The S2 projection logic determines `mySeatIndex`, `isCreator`, `myExpectedAmountNanotons`, and `mySeatStatus` from authoritative bindings and creator identity.
- Player A never receives Player B's expected amount, wallet, or seat index.
- Creator receives the frozen package only while it is still needed (pre-deployment, pre-funded).

## F. Security

- The bridge is informational only. It does not create `DepositContract`, mutate `DepositSession`, call `DepositMonitor`, call `DeploymentAuthorization`, call `GameContractManager`, or initiate blockchain transactions.
- `DEPOSIT_PACKAGE_PUBLISHED` remains informational and does not become an authorization gate.
- Client-supplied `playerId` is never accepted as authority; the bridge resolves `playerId` exclusively from the server-side `_playerToSocket` mapping.
- Financial data is never broadcast to the room; each socket receives only their own requester-scoped projection.

## G. Financial Safety

No server funds are spent by S3. The bridge performs read-only projection and socket delivery. No TON transactions, no contract deployment, no authorization state changes.

## H. Tests

Added 9 focused S3 tests to `server/tests/r18DepositProjection.test.js`:

1. `S3.1` — `RoomLobbyBridge` subscribes to `DEPOSIT_PACKAGE_PUBLISHED`.
2. `S3.2` — Event handler executes when `DEPOSIT_PACKAGE_PUBLISHED` is emitted; delivers to 3 sockets.
3. `S3.3` — Handler invokes delivery for each room player socket.
4. `S3.4` — Each player receives their own requester-scoped projection with correct `mySeatIndex` and `isCreator`.
5. `S3.5` — No cross-player financial leakage (wallets, other players' expected amounts absent from delivered payloads).
6. `S3.3` — Delivery uses existing authenticated player/socket mapping.
7. `S3.7` — Processing `DEPOSIT_PACKAGE_PUBLISHED` does not call `GameContractManager`.
8. `S3.8` — Missing projection/identity fails closed without throwing.
9. `S3.9` — Missing `depositSessionCoordinator` fails closed without throwing.

All S1/S2/S3 tests pass.

## I. Regression

S1 and S2 tests in `r18DepositProjection.test.js` pass unchanged. No S1/S2 code was modified.

## J. Files Changed

- `server/socket/lobbyProtocol.js`
- `server/socket/RoomLobbyBridge.js`
- `server/app.js`
- `server/tests/r18DepositProjection.test.js`

## K. Git

Commit hash: pending

## L. Remaining Work

- Client Deposit session integration.
- Client recovery integration.
- Page4 Deposit phase.
- GAP-B (GameContract deployment).
- Production `TON_DEPOSIT_CREATION_FEE_PER_SEAT_NANO` configuration.

None of these were implemented.

## M. Final Verdict

`S3_VERIFIED`

## Safety Confirmation

- No Page3 changes.
- No Page4 changes.
- No client changes.
- No DepositOrchestrator changes.
- No DepositMonitor changes.
- No DeploymentAuthorization changes.
- No GameContractManager changes.
- No `.env` changes.
- No blockchain transactions.
- No deployment.
- No unrelated files staged.
