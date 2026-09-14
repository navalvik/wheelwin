# R20 — Owner Room-Network Selection (Vertical Slice 1)

Date: 2026-09-14

Task: Implement the first vertical slice of the post-room-creation network
selection architecture — the authenticated Room Owner chooses Testnet or
Mainnet immediately after CREATE_ROOM; the choice is authoritative for all
players. Branch: `payment/room-wallet-integration`.

## 1. Scope

- Lobby protocol + EventBus event layer (additive).
- `RoomLobbyBridge` owner-only one-time network selection handler.
- Authoritative room-state projection (`network` field).
- SocketGateway client-event forwarding (socketId + network only).
- Creator-facing UI in `CreateRoomPanel.jsx`.
- Focused lobby protocol/lifecycle tests.

Explicitly NOT in scope (untouched): Page1, Page3/4/5, gameplay, physics,
clock, winner, payment, recovery, wallet monitoring, `/debug`, deployment
config, `Room.js`, database state, HTTP endpoints, EventBus cross-runtime
transport.

## 2. Files Inspected

- `server/socket/RoomLobbyBridge.js` (7787 lines — create path, cleanup
  paths, `_buildRoomState`, socket/player maps, delivery helpers)
- `server/socket/lobbyProtocol.js`, `server/events/EventTypes.js`
- `server/socket/SocketGateway.js` (client event bindings, `_emitLobbyRequest`)
- `client/src/components/CreateRoomPanel.jsx`, `client/src/pages/RoomLobby.jsx`,
  `client/src/utils/roomDefaults.js`, `client/src/i18n/translations.js`,
  `client/src/context/LanguageContext.jsx`
- `server/tests/roomCreationTelegramAuthorization.r179t6c.test.js` (harness
  conventions), `server/scripts/run-tests.js`
- `server/network/RoomNetworkHandoffStore.js` (present on branch; verified
  remains unwired)

## 3. Files Changed

- `server/socket/lobbyProtocol.js` — added `LOBBY_CLIENT_EVENTS.SELECT_ROOM_NETWORK`
  (`"selectRoomNetwork"`), `LOBBY_SERVER_EVENTS.ROOM_NETWORK_SELECTED`
  (`"roomNetworkSelected"`), error codes/messages
  `ROOM_NETWORK_SELECT_FORBIDDEN`, `ROOM_NETWORK_ALREADY_SELECTED`,
  `ROOM_NETWORK_INVALID`. No existing events renamed or altered.
- `server/events/EventTypes.js` — added
  `LOBBY_SELECT_ROOM_NETWORK_REQUEST` (internal EventBus only; not used as
  cross-runtime transport).
- `server/socket/SocketGateway.js` — bound `SELECT_ROOM_NETWORK`; forwards
  only `{ socketId, network }`. Any other client payload fields are dropped.
- `server/socket/RoomLobbyBridge.js` —
  - new in-memory map `_roomNetworkByRoom` (`roomId -> "testnet" | "mainnet"`);
  - subscription for `LOBBY_SELECT_ROOM_NETWORK_REQUEST`;
  - `_handleSelectRoomNetwork()` (see §4);
  - `_buildRoomState()` now exposes `network: <value> | null`;
  - cleanup added at the three existing room-destruction sites
    (setup-expired "room already gone", empty-room destroy, `_closeRoom`)
    and in `shutdown()`.
- `client/src/utils/roomDefaults.js` — `network: null` default.
- `client/src/components/CreateRoomPanel.jsx` — creator-only selection UI;
  listens to `roomNetworkSelected`; renders authoritative network for all.
- `client/src/i18n/translations.js` — 4 new `room.network*` keys (en catalog;
  `translate()` falls back to en for other languages).
- `client/src/styles/createRoomPanel.css` — selector styles (append-only).
- `server/tests/roomNetworkSelection.r20.test.js` — NEW: 9 focused tests.

## 4. Exact Behavior Implemented

1. `CREATE_ROOM` unchanged: still strictly gated by the trusted Telegram
   identity resolver (`_resolveSocketTelegramUserId`), fail-closed.
2. After `ROOM_CREATED` (delivered to the creating socket only), the Owner
   sees Testnet/Mainnet buttons inside the existing room-created panel.
   No choice is rendered before creation; joiners never see controls.
3. Client emits `selectRoomNetwork` with `{ network }` only.
4. `_handleSelectRoomNetwork`:
   - `_assertAuthoritativeMutation(socketId, "selectRoomNetwork")` — rejects
     obsolete/pending sockets and sockets without a server-side
     socket->player binding;
   - room derived from the authoritative player binding (never the payload);
   - ownership verified as `this._roomCreators.get(roomId) === playerId`
     (exact map identity; joiners rejected with
     `ROOM_NETWORK_SELECT_FORBIDDEN`);
   - network normalized strictly: `String.trim().toLowerCase()`; accepted
     only as exactly `testnet` or `mainnet`; everything else rejected with
     `ROOM_NETWORK_INVALID` (malformed attempts do NOT consume the one-time
     selection);
   - one-time enforcement: a committed room rejects any further selection
     with `ROOM_NETWORK_ALREADY_SELECTED` (switch or same value);
   - commits `_roomNetworkByRoom.set(roomId, network)`;
   - broadcasts `ROOM_NETWORK_SELECTED` to all sockets in the room with
     payload exactly `{ roomId, network }`;
   - rebroadcasts authoritative `roomState` (now carrying `network`).
5. Until selection, room state exposes `network: null`
   (network-selection-pending).
6. MAINNET selection establishes only authoritative `network: "mainnet"`
   state. **The actual Testnet -> Mainnet handoff is NOT implemented yet.**
7. All network-selection state is removed by the existing destruction paths
   (creator leave / empty room / setup expiry / shutdown). No new cleanup
   subsystem, no persistence.

## 5. Authorization / Security Rules

- Player identity: server-side `_socketToPlayer` binding only.
- Room: derived from that binding (via `_getSocketContext`).
- Ownership: exact `_roomCreators` map match — never a client claim.
- Client payload may contain ONLY the requested network; SocketGateway
  forwards `socketId` + `network` and nothing else. `playerId`,
  `telegramUserId`, `ownerPlayerId`, and `roomId` from clients are ignored.
- No client-supplied identity accepted anywhere in the flow.
- CREATE_ROOM authentication untouched (re-verified by the existing
  protection suites, §7).

## 6. Lifecycle Flow

```
Client (creator)                Server
emit createRoom  --> SocketGateway --> EventBus LOBBY_CREATE_ROOM_REQUEST
                     --> RoomLobbyBridge._handleCreateRoom
                         (Telegram-gated; room + creator registered)
                     <-- ROOM_CREATED (creator socket only)
                     <-- ROOM_STATE { ..., network: null }
UI: Owner sees Testnet / Mainnet

emit selectRoomNetwork {network}
             --> SocketGateway (strips all but network)
                 --> EventBus LOBBY_SELECT_ROOM_NETWORK_REQUEST
                     --> _handleSelectRoomNetwork
                         (binding -> room; _roomCreators check; strict
                          normalization; one-time rule)
                         <-- on any failure: roomError with the matching
                             R20 error code
                     --> ROOM_NETWORK_SELECTED { roomId, network } to room
                     --> ROOM_STATE { ..., network } to room
UI: selector hidden; authoritative network shown to creator + joiners
```

Destruction (creator leave / empty room / setup expiry) removes
`_roomNetworkByRoom` entries in the same blocks that already clear
`_roomCreators`.

## 7. Tests Executed and Results

Runner: plain Node (project convention; `server/scripts/run-tests.js`).
Working copy: git worktree at `G:\WheelWin_r20` on
`payment/room-wallet-integration` @ 0207c16 + this change.

| Suite | Result |
|---|---|
| `tests/roomNetworkSelection.r20.test.js` (NEW) | exit 0 — 9/9 tests passed |
| `tests/roomCreationTelegramAuthorization.r179t6c.test.js` | exit 0 — passed |
| `tests/roomCreationProtection.integration.test.js` | exit 0 — all assertions passed |
| `tests/roomProtection.r131b.test.js` | exit 0 — passed |
| `tests/r18DepositProjection.test.js` | exit 0 — 24 passed, 0 failed |
| `tests/r18S4DepositReconnect.test.js` | exit 0 — passed |
| `tests/secretMatrix.status.test.js` | exit 0 — passed |
| `tests/sessionRebind.integration.test.js` | exit 0 — passed |
| `tests/identityRecovery.r131e.test.js` | exit 0 — passed |
| `tests/attackEObservability.r179t8.test.js` | exit 0 — passed |
| `tests/roomLobby.integration.test.js` | exit 1 — see note |

New-test coverage (r20): authenticated creator creates room (network
pending null); creator selects TESTNET (uppercase normalized, forged
ownership fields ignored, broadcast payload exactly `{roomId, network}`,
room-targeted); creator selects MAINNET (no extra room,
`RoomNetworkHandoffStore` stays unwired); joiner cannot select
(FORBIDDEN, no broadcast); no cross-room selection (room always from the
player binding; unbound socket rejected); 12 malformed values rejected
without burning the one-shot; unauthenticated CREATE_ROOM still rejected
with zero allocation; selection immutable after commit (exactly one
broadcast ever); network state removed when the room is destroyed.

Note on `roomLobby.integration.test.js`: it fails with
`Timed out waiting for roomCreated` on the PRISTINE branch commit 0207c16
as well (verified in a separate clean worktree `G:\WheelWin_base`). The
test connects a plain web socket without Telegram identity and predates
the R17.9T.6-C Telegram-only CREATE_ROOM gate; it is stale on this branch
independent of this change. Not caused by this implementation.

## 8. Risks

- Low: `ROOM_STATE` payload gained a `network` key — additive; no consumer
  asserts exact payload shape (verified by grep).
- Low: joiner UI renders the authoritative network label from room state;
  joiners have no selection controls.
- Pre-existing (not introduced here): stale `roomLobby.integration.test.js`
  documented above.
- Out-of-scope by design: handoff, Mainnet room creation, cross-runtime
  transport, persistence.

## 9. Recommendations (next stage only)

1. Wire `RoomNetworkHandoffStore` to MAINNET selection (create handoff
   record server-side from `_roomCreators` + trusted Telegram identity).
2. Mainnet room bootstrap + handoff claim/complete lifecycle.
3. Cross-runtime transport decision (EventBus stays single-runtime).
4. Update or retire the stale `roomLobby.integration.test.js` to
   authenticate its sockets per R17.9T.6-C.

## 10. Changes Made

Committed as ONE commit on `payment/room-wallet-integration`:
`lobby: add owner network selection`. No push performed (per instruction).
No other report or document files created.
