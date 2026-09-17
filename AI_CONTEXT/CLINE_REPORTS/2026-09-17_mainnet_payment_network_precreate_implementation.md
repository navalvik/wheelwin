# Mainnet Payment Network Pre-Create Implementation

Date: 2026-09-17

Task: Route the Owner's pre-create payment-network selection (Page2 MAINNET
button) through CREATE_ROOM → room session state → Page3 → Page4 payment
orchestration (DepositSession / DeploymentAuthorization / GameContract /
PaymentSession), remove the obsolete R24.1 room-network START_GAME gate, and
preserve the existing Testnet/Mainnet payment infrastructure per room.

## 1. GitHub Baseline

- Repository: https://github.com/navalvik/wheelwin.git
- Authoritative branch: `mainnet/payment-network-precreate`
- Starting commit: `30b09804d434576b0897b11a99da63d96404d930`
  (`ui: style pre-create Mainnet button`); local HEAD was verified equal to
  `origin/mainnet/payment-network-precreate` before implementation.
- Branch history from `mainnet/production` (`d6699ee`): `81d5bb4`
  (remove legacy Mainnet switch from layout), `5374e0f` (remove legacy Page1
  Mainnet handoff), `08a5bf0` (move Mainnet payment selection before room
  creation), `30b0980` (style pre-create Mainnet button).
- Already-present UI state honored (not undone):
  - Page1: old MAINNET Telegram Mini App handoff button removed
    (`Page1Welcome.jsx`, `GameLayout.jsx`, `HeaderBar.jsx`).
  - Page2 (`CreateRoomPanel.jsx`): red MAINNET button above CREATE ROOM,
    local toggle defaulting to Testnet, `createRoom` emits
    `{ paymentNetwork }`, post-CREATE-ROOM owner selector removed.
- Local checkout notes: the local tree was on `mainnet/production` with
  pre-existing uncommitted user modifications. Checkout was blocked by one
  stale local variant of `client/src/components/HeaderBar.jsx` (an old
  R18-era Mainnet-handoff experiment that reintroduced what the branch
  removed). That file's working-tree content was preserved byte-exact in the
  untracked scratch file `_backup_r241_local_HeaderBar.jsx` (no stash, no
  reset, no clean used) and the branch version was checked out. All other
  user modifications and untracked files were carried over untouched and are
  NOT part of this change.

## 2. Architecture Implemented

Flow implemented:

```
Page1
→ Page2 (Owner toggles red MAINNET payment button; default Testnet)
→ CREATE ROOM (createRoom { paymentNetwork }) — authenticated Telegram gate
→ normal room creation / normal 3-player setup (unchanged RoomManager model)
→ Page3 — each player enters their own TON wallet (unchanged flow)
→ Page4 — payments use the authoritative payment-network selection
→ Page5 — normal game
```

Explicit statement: **Mainnet selection does not create a Mainnet room.**
There is exactly one room/game architecture. The selection is an authoritative
FINANCIAL payment-routing signal stored per room; it does not change the
RoomManager runtime network, the server TON runtime (`TON_NETWORK`), the game
engine, Page3, or the 3-player room model.

## 3. Server Changes

Exact files/functions changed:

1. `server/socket/SocketGateway.js`
   - `_handleConnection`: CREATE_ROOM handler now forwards ONLY
     `payload?.paymentNetwork ?? null` to `LOBBY_CREATE_ROOM_REQUEST`.
     Removed the retired `SELECT_ROOM_NETWORK` socket binding.
2. `server/socket/RoomLobbyBridge.js`
   - constructor: replaced `_roomNetworkByRoom` / `_startGamePendingByRoom` /
     `_roomNetworkRuntime` (R24.1 gate) with the new authoritative map
     `_paymentNetworkByRoom` (roomId → "testnet" | "mainnet"); removed the
     unused `runtimeNetwork` constructor option.
   - `initialize()`: CREATE_ROOM subscription now passes
     `envelope.payload.paymentNetwork`; removed the
     `LOBBY_SELECT_ROOM_NETWORK_REQUEST` subscription.
   - `_handleCreateRoom(socketId, requestedPaymentNetwork)`: strictly
     normalizes the requested network (`"mainnet"` → mainnet; everything
     else/absent → testnet, the established safe default) and commits it
     after the room/creator exist; ROOM_CREATED payload now carries
     `paymentNetwork`.
   - `_buildRoomState()` / ROOM_STATE: replaced the old `network` field with
     `paymentNetwork` (join / reconnect / recovery hydration).
   - `_handleGameCreated()`: the R24.1 START_GAME gate is removed —
     startGame is always delivered at ROOM_FULL / game-prep.
   - removed `_handleSelectRoomNetwork`, `_shouldReleaseStartGame`,
     `_releasePendingStartGame`.
   - `_deliverPaymentConnectionReady()`: EventBus
     `PAYMENT_CONNECTION_READY` payload extended to
     `{ roomId, paymentNetwork, timestamp }`.
   - new public `getPaymentNetwork(roomId)` accessor (single source of
     truth for the payment orchestration).
   - room destruction paths (setup-expired map cleanup, empty-room close,
     `_closeRoom`) and `shutdown()`: clear `_paymentNetworkByRoom`.
3. `server/socket/lobbyProtocol.js` — removed `SELECT_ROOM_NETWORK`,
   `ROOM_NETWORK_SELECTED`, `ROOM_NETWORK_SELECT_FORBIDDEN`,
   `ROOM_NETWORK_ALREADY_SELECTED`, `ROOM_NETWORK_INVALID` (+ messages).
4. `server/events/EventTypes.js` — removed
   `LOBBY_SELECT_ROOM_NETWORK_REQUEST`.

<!-- PART2 -->

5. `server/gameplay/PaymentSessionManager.js`
   - `createAndRequest(roomId, { gameId, network })` — forwards `network` to
     `createPaymentSession` (existing `activeNetwork = network ??
     contract?.tonNetwork ?? this._tonNetwork` resolution preserved).
   - `_handlePaymentConnectionReady(payload)` — passes
     `network: payload?.paymentNetwork ?? null` (server-emitted value).
6. `server/gameplay/GameContractManager.js`
   - new `setPaymentNetworkResolver(resolver)` and
     `_resolveContractNetwork(roomId)` (authoritative room payment network →
     fallback runtime `_resolveTonNetwork()`).
   - `createContractRequest()` — contract snapshot + `tonNetwork` now use
     `_resolveContractNetwork(roomId)`; the snapshot network stays immutable.
   - `_handleDeploymentAuthorizationValid()` — the network check compares the
     authorization against the room's authoritative payment network instead
     of the runtime, so a valid Mainnet authorization is never rejected on a
     Testnet runtime. Without a wired resolver the legacy runtime check is
     preserved.
   - `_consumeDeploymentAuthorizationOrThrow(contract)` — deploy-time
     consume now passes `contract.tonNetwork ??
     _resolveContractNetwork(roomId)` (was runtime `this._tonNetwork`).
7. `server/deposit/DepositOrchestrator.js`
   - new `setPaymentNetworkResolver(resolver)`; `_resolveFinancials(roomId)`
     resolves the per-room financial network (authoritative room payment
     network first, runtime env fallback); `handlePaymentConnectionReady()`
     calls `_resolveFinancials(roomId)`. `metadata.network/tonNetwork`,
     `depositPackage.network` and `releaseAuthority` therefore follow the
     room's selection via the existing infrastructure
     (`resolveDepositOrchestrationFinancials`, `resolveReleaseAuthority`,
     `resolveOracleWalletConfig` — the already-present Mainnet profile infra
     in `server/config/tonNetworkProfiles.js`).
8. `server/app.js`
   - removed the retired `runtimeNetwork` injection into RoomLobbyBridge.
   - after `RoomLobbyBridge.initialize()`, wires
     `resolveRoomPaymentNetwork = (roomId) =>
     this._roomLobbyBridge?.getPaymentNetwork?.(roomId) ?? "testnet"` into
     `DepositOrchestrator.setPaymentNetworkResolver` and
     `GameContractManager.setPaymentNetworkResolver`.
   - the `DepositOrchestrator` `resolveFinancialParameters` closure now
     accepts an optional `{ network }` override (runtime network unchanged
     when no override).

## 4. Payment Network Propagation

```
Page2 toggle (testnet | mainnet)
→ createRoom { paymentNetwork }            (client, already on branch)
→ SocketGateway CREATE_ROOM                (forwards paymentNetwork ONLY)
→ EventBus LOBBY_CREATE_ROOM_REQUEST
→ RoomLobbyBridge._handleCreateRoom        (strict normalize + commit
                                            _paymentNetworkByRoom)
→ ROOM_CREATED { paymentNetwork } / ROOM_STATE { paymentNetwork }
→ Page2 hydration (existing client code) / join / reconnect / recovery
→ Page3 wallet entry (unchanged; VERIFY_NEXT_REQUEST → SessionWalletStore)
→ all 3 wallets submitted → PAYMENT_STAGE_READY (unchanged)
→ wallet connections ready
→ EventBus PAYMENT_CONNECTION_READY { roomId, paymentNetwork, timestamp }
→ PaymentSessionManager._handlePaymentConnectionReady
   → createAndRequest(roomId, { network }) → PaymentSession.network
→ DepositOrchestrator.handlePaymentConnectionReady
   → _resolveFinancials(roomId)            (per-room financial network)
   → DepositSession metadata.network/tonNetwork + DepositPackage.network
   → releaseAuthority via resolveReleaseAuthority(financials.network)
→ DeploymentAuthorization.network          (fromDepositSession /
   resolveAuthorizationNetwork — existing path, fed by session metadata)
→ GameContractManager
   → createContractRequest network = _resolveContractNetwork(roomId)
   → GameContract snapshot network (immutable) + contract.tonNetwork
   → consumeValidForDeploy({ network: contract.tonNetwork })
→ PaymentSession activeNetwork (network → contract.tonNetwork → runtime)
```

## 5. Page3 Wallet Preservation

Confirmed unchanged. Each player still enters their own wallet on Page3; the
server stores it through the existing session-wallet mechanism
(`RoomLobbyBridge._handleVerifyNextRequest` → `normalizeTelegramWallet` →
`_sessionWalletStore.setWallet(roomId, playerId, wallet)` →
`_deliverOwnWallet`), and the payment stage later reads the same
authoritative wallets (`_createAndBroadcastWalletConnectionSession`,
`_createAndBroadcastEntryPaymentSession`, `DepositOrchestrator` bindings via
`sessionWalletStore.getWallet`). No wallet field was added to Page2 or
CREATE_ROOM; no separate Mainnet wallet storage was created;
`SessionWalletStore` and wallet validation are untouched.

## 6. Page4 Payment Routing

Page4 is not redesigned. Routing is selected server-side before Page4
payment data is produced:

- paymentNetwork = "testnet" → `DepositOrchestrator` financial network
  "testnet" → existing Testnet deposit package / DeploymentAuthorization /
  PaymentSession infrastructure (unchanged behavior).
- paymentNetwork = "mainnet" → financial network "mainnet" → the existing
  Mainnet profile infrastructure (`resolveOracleWalletConfig` /
  `resolveReleaseAuthority` / Mainnet profile in
  `server/config/tonNetworkProfiles.js`, existing
  `buildDepositStateInit({ network })` handling). No new Mainnet payment
  system, no TON_NETWORK mutation, no process-wide network configuration
  change, no server restart logic.

The client-facing events remain minimal; Page4 continues to consume the
existing authoritative `DepositPackage` / `PaymentSession` /
`GAME_CONTRACT_*` payloads, which now carry the selected network in their
existing network fields.

<!-- PART3 -->

## 7. Old R24.1 Room Network Logic

Removed (complete removal — no recovery/payment logic depended on it):

- `RoomLobbyBridge`: `_roomNetworkByRoom`, `_startGamePendingByRoom`,
  `_roomNetworkRuntime`, `_handleSelectRoomNetwork`,
  `_shouldReleaseStartGame`, `_releasePendingStartGame`, the
  `LOBBY_SELECT_ROOM_NETWORK_REQUEST` subscription, the WITHHOLD gate in
  `_handleGameCreated`, the `network` room-state field, the
  `ROOM_NETWORK_SELECTED` broadcast, and the retired map releases in the
  destruction paths / `shutdown()`.
- `SocketGateway`: the `selectRoomNetwork` socket binding.
- `lobbyProtocol.js`: `SELECT_ROOM_NETWORK`, `ROOM_NETWORK_SELECTED`,
  `ROOM_NETWORK_*` error codes and messages.
- `EventTypes.js`: `LOBBY_SELECT_ROOM_NETWORK_REQUEST`.
- `app.js`: the `runtimeNetwork` injection.
- Tests: `server/tests/roomNetworkGate.r241.test.js` (tested the removed
  gate) and `client/src/components/CreateRoomPanel.networkGate.r241.test.js`
  (tested the removed post-CREATE-ROOM selector) were deleted and replaced
  by the focused suites listed in §9.

The only network concept that remains active is `paymentNetwork` (pre-create
financial payment route). R22/R23 cross-runtime handoff files
(`RoomNetworkHandoffStore` etc.) were left untouched in the repository; they
are no longer referenced by the lobby CREATE/START path.

## 8. Security

Preserved:

- authenticated Telegram CREATE_ROOM gate
  (`ROOM_CREATION_REQUIRES_TELEGRAM`, identity from the server-side socket
  context only) — verified by test;
- one-active-room-per-Telegram-user quota, draining check, capacity check —
  untouched;
- server-owned player identity / roomId / ownerPlayerId: the CREATE_ROOM
  envelope carries only `socketId` + `paymentNetwork`; forged
  `ownerPlayerId` / `telegramUserId` / `roomId` / `playerId` claims are
  ignored — verified by test;
- strict payment-network normalization: only "testnet" | "mainnet" commit;
  every invalid value normalizes to the safe default "testnet" (fail-safe —
  an input error can never trigger Mainnet payments) — verified by test;
- `PAYMENT_CONNECTION_READY` network comes from server-owned
  `_paymentNetworkByRoom`, never from a client payload;
- DeploymentAuthorization consume/deploy checks and all existing
  authorization validations are preserved (the network compare target was
  corrected to the authoritative financial network, not removed);
- wallet storage/validation, recovery credentials, 3-player restriction,
  financial evidence and recovery behavior — untouched;
- no secrets, mnemonics, private keys, initData or tokens are exposed by any
  new payload (`paymentNetwork` is a lobby-safe string).

<!-- PART4 -->

## 9. Tests

New focused suites (both executed, both green):

- `server/tests/paymentNetworkPrecreate.test.js` — 9 tests, ALL PASSED:
  1. CREATE_ROOM carries and stores paymentNetwork (mainnet commit,
     ROOM_CREATED + ROOM_STATE propagation, absent → testnet, RoomManager
     runtime network untouched).
  2. Invalid paymentNetwork defaults to testnet; forged identity/roomId/
     ownerPlayerId claims ignored; no state for a forged roomId.
  3. MAINNET selection does not block START_GAME (startGame delivered for
     mainnet, testnet and absent selection).
  4. PAYMENT_CONNECTION_READY EventBus payload carries
     `{ roomId, paymentNetwork: "mainnet", timestamp }`.
  5. Unauthenticated CREATE_ROOM rejected with
     ROOM_CREATION_REQUIRES_TELEGRAM (no room created).
  6. Room destruction (owner leaves) and `shutdown()` clear
     `_paymentNetworkByRoom`; a fresh room gets its own selection.
  7. Source contracts: SocketGateway forwards only paymentNetwork;
     PaymentSessionManager passes `payload.paymentNetwork`;
     DepositOrchestrator `setPaymentNetworkResolver` + per-room financials;
     GameContractManager `_resolveContractNetwork(roomId)`; app.js wiring
     present and the `runtimeNetwork` gate injection gone; RoomLobbyBridge /
     lobbyProtocol / EventTypes contain no retired R24.1 symbols.
  8. DepositOrchestrator `_resolveFinancials` follows the room payment
     network (mainnet room → mainnet financial profile; other rooms keep
     their own testnet rails; no resolver → runtime env network).
  9. GameContractManager `_resolveContractNetwork` follows the room payment
     network (mainnet room on a testnet runtime → mainnet snapshot network).
- `client/src/components/CreateRoomPanel.paymentNetwork.precreate.test.js`
  — 6 test groups, ALL PASSED:
  1. Page1 legacy MAINNET handoff absent (Page1Welcome.jsx, GameLayout.jsx).
  2. Page2 MAINNET button exists, renders ABOVE CREATE ROOM, reflects the
     selected state, toggles to Mainnet, defaults to Testnet, and CREATE
     ROOM emits `paymentNetwork` over `createRoom`.
  3. Authoritative `paymentNetwork` from roomCreated/roomState restores the
     Page2 toggle (hydration).
  4. Page2 contains no wallet entry; JoinRoomPanel has no payment controls.
  5. RoomLobby VERIFY transition remains startGame-driven (`onNavigate(3)`).
  6. `.mainnetPaymentButton` CSS exists with a red background (#DC2626) and
     the stylesheet stays structurally balanced.

Existing suites re-executed after the changes (results as observed):

- `server/tests/roomCreationTelegramAuthorization.r179t6c.test.js` — all
  assertions passed (exit 0).
- `server/tests/depositOrchestrator.r179l23.test.js` — 17 pass / 0 fail.
- `server/tests/depositOrchestrator.r18b_error_observability.test.js` —
  4 pass / 0 fail.
- `server/tests/paymentSession.manager.test.js` — all assertions passed.
- `server/tests/gameContract.manager.test.js` — all assertions passed
  (re-run after the deploy-consume network fix).
- `server/tests/gameContract.deployAuthorizationHandoff.r18s15.test.js` —
  6 pass / 0 fail (re-run after the fix).
- `server/tests/gameContract.deploymentAuthorizationGate.r179l5b.test.js` —
  all assertions passed.
- `server/tests/gameContract.legacyDeployTriggerIsolation.r179l18.test.js` —
  7/7 scenario checks passed, no failures.
- `server/tests/entryPaymentSession.test.js` — all assertions passed.
- `server/tests/depositBackendE2E.r179l19.test.js` — full run completed
  ("scenarios A–P + bot flood complete").
- `server/tests/socketTelegramAuth.r179t6b.test.js` — 7 pass / 0 fail.

Known pre-existing failure (NOT introduced by this change):

- `server/tests/roomLobby.integration.test.js` fails with
  "Timed out waiting for roomCreated". The identical failure was reproduced
  on the pristine branch baseline `30b0980` in a temporary detached worktree
  before/without any of these changes; the worktree was removed afterwards.
  Not rewritten or "fixed" per the no-unrelated-test-rewrite rule.

<!-- PART5 -->

## 10. Git

- Branch: `mainnet/payment-network-precreate` (tracking
  `origin/mainnet/payment-network-precreate`).
- Final commit SHA: recorded in §13 after commit/push execution.
- Commit message: `feat: route payment network from Page2 to Page4`.
- Push: `git push origin mainnet/payment-network-precreate` (result recorded
  in §13).
- No `reset --hard`, `clean -fd`, rebase, force push, or merge into
  `mainnet/production` was used. Unrelated pre-existing local modifications
  and untracked files were left untouched and were not committed.

## 11. Files Changed

Committed in this change:

- `server/socket/SocketGateway.js` (M)
- `server/socket/RoomLobbyBridge.js` (M)
- `server/socket/lobbyProtocol.js` (M)
- `server/events/EventTypes.js` (M)
- `server/gameplay/PaymentSessionManager.js` (M)
- `server/gameplay/GameContractManager.js` (M)
- `server/deposit/DepositOrchestrator.js` (M)
- `server/app.js` (M)
- `server/tests/paymentNetworkPrecreate.test.js` (A)
- `server/tests/roomNetworkGate.r241.test.js` (D)
- `client/src/components/CreateRoomPanel.paymentNetwork.precreate.test.js` (A)
- `client/src/components/CreateRoomPanel.networkGate.r241.test.js` (D)
- `AI_CONTEXT/CLINE_REPORTS/2026-09-17_mainnet_payment_network_precreate_implementation.md` (A)

Deliberately NOT committed (pre-existing local user state, preserved as-is):
`client/src/components/HeaderBar.mainnetHandoff.test.js`,
`client/src/components/TestnetWarningOverlay.jsx`,
`client/src/config/features.js`, `client/src/i18n/translations.js`,
`client/src/main.jsx`, `client/src/socket/socket.js`,
`client/src/socket/socket.telegramAuth.test.js`,
`docs/architecture/R7.0H-Production-Validation-Report.md`, the six deleted
`AI_CONTEXT/CLINE_REPORTS/2026-09-14_*.md` files, the untracked scratch
backup `_backup_r241_local_HeaderBar.jsx`, and all other untracked files.

## 12. Remaining Issues

- `server/tests/roomLobby.integration.test.js` fails on this branch
  identically to the pristine baseline `30b0980` (pre-existing; see §9). It
  was not modified in this change.
- The per-room Mainnet deposit/contract financial routing now selects the
  Mainnet profile; the actual on-chain reachability of Mainnet rails from a
  Testnet-runtime deployment (funded Mainnet oracle/deployer wallets,
  endpoints, artifacts) remains an operator environment concern already
  covered by the existing Mainnet profile/readiness infrastructure — no new
  gap was demonstrated by this implementation.

No other remaining issue was demonstrated for this implementation.

## 13. Final Result

The requested architecture was implemented successfully on
`mainnet/payment-network-precreate`: Page2's pre-create MAINNET selection is
committed server-side at CREATE_ROOM as an authoritative per-room payment
network, propagated through ROOM_CREATED/ROOM_STATE, PAYMENT_CONNECTION_READY,
DepositSession, DeploymentAuthorization, GameContract snapshot and
PaymentSession; the old R24.1 room-network START_GAME gate is fully removed;
Page3 wallet entry and the single 3-player room architecture are unchanged;
Testnet remains the safe default; all focused and related existing test
suites pass (one pre-existing integration failure documented in §9). The
change was committed as `feat: route payment network from Page2 to Page4`
and pushed to `origin/mainnet/payment-network-precreate`.





