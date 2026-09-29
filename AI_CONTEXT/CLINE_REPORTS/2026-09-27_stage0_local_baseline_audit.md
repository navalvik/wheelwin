# Stage 0 — Mainnet Local Baseline Audit (READ-ONLY)

Date: 2026-09-27

Task: READ-ONLY audit of the current local WheelWin repository
(`G:\WheelWin`, branch `payment/room-wallet-integration`, HEAD `dfa8832`
"fix(recovery): repair setup session recovery credential") to establish the
actual current implementation baseline before any Mainnet work. No
application code, configuration, dependency, deployment or architecture
element was modified; GameEscrow / DepositContract / DepositPackage were not
restored, reactivated, or deleted.

Terminology mapping used throughout this report (client page indices from
`client/src/game/sessionRecovery/recoveryFlow.js` `APP_PAGES`):
WELCOME=1, **LOBBY=2** ("Page2" — room creation + network selection),
PLAYER_SETUP=3, MATRIX=4, VERIFY=5, **PAYMENT=6** ("Page4",
`Page4Payment.jsx`), **GAMEPLAY=7** ("Page5", `Page5Game.jsx`), RESULT=8.

---

## 1. Scope

- Page2 (RoomLobby) network selection / room creation flow.
- Page4 payment flow and its data sources.
- Server room creation, room state, and Room Wallet assignment.
- Server payment/session state and confirmation.
- Testnet Room Wallet loading, allocation, and lifecycle.
- Existing Mainnet-related infrastructure and its classification.
- API/socket events connecting Page2, server, and Page4.
- Page4 → Page5 transition condition.
- Payment recovery / refund implementation.
- TESTNET/MAINNET configuration keys (no secret values printed).
- Payment/network logging adequacy.
- Legacy GameEscrow / DepositContract / DepositPackage residue.

The `.kilo/worktrees/powerful-trunk/` parallel checkout was excluded from
every finding; all findings are from the main tree working state.

## 2. Files Inspected

Context (per `.clinerules`): `AI_CONTEXT/WHEELWIN_MASTER_CONTEXT.md`,
`AI_CONTEXT/ARCHITECTURE_RULES.md`, `AI_CONTEXT/CURRENT_STATE.md`,
`AI_CONTEXT/AI_WORKING_RULES.md`, plus recent reports:
`2026-09-27_stage3_final_validation_commit_push.md`,
`2026-09-27_gameescrow_depositcontract_remaining_links_analysis.md`,
`2026-09-27_payment_session_restore_room_wallet_refund_gap.md`,
`2026-09-27_creator_left_room_wallet_refund_fix.md`,
`2026-09-15_r21_network_handoff_server_contract.md`,
`2026-09-14_r20_network_selection_owner_implementation.md`.

Source read directly:

- `server/payment/roomWallet/roomWalletConfig.js`,
  `RoomWalletRegistry.js`, `RoomWalletRuntimeResolver.js`,
  `RoomWalletIncomingObserver.js`, `ROOM_WALLET_RUNTIME.md`
- `server/console/environment/AppEnvironment.js`
- `server/app.js` (composition root: 1340–1420, 1645–1700)
- `server/socket/RoomLobbyBridge.js` (440–620, 1378–1560, 2300–2420,
  3030–3140, 7050–7130, 7240–7310)
- `server/gameplay/PaymentSessionManager.js` (405–660, 2740–2925)
- `server/gameplay/GameStartAuthorization.js` (440–560)
- `server/managers/RoomManager.js` (130–230, 845–925)
- `server/models/PaymentSession.js` (460–560), `server/models/Room.js`
- `client/src/components/CreateRoomPanel.jsx`,
  `RoomNetworkHandoffBootstrap.jsx`, `client/src/network/roomNetworkHandoff.js`
- `client/src/pages/Page2PlayerSetup.jsx`, `Page4Payment.jsx` (full),
  `Page5Game.jsx`
- `client/src/game/sessionRecovery/recoveryFlow.js`
- `server/.env.example` (template only; `server/.env` was intentionally NOT
  read), `docs/MAINNET_ROOM_WALLET_PROVISIONER.md`
- Git: `git status --short`, targeted `git grep` over tracked files.

## 3. Executive Summary

The repository already implements a complete, server-authoritative
**Room-Wallet-only Testnet payment architecture**: the server allocates a
room number 1..64 at room creation, binds that room to the corresponding
server-side TESTNET Room Wallet address at payment-session creation, Page4
sends ONE plain TON transfer via TonConnect to that address, the server
independently observes the transfer, and Page4 → Page5 opens only after the
Room Wallet ledger proves all three participants funded the game.

A **network concept already exists in three distinct layers**:
1. Runtime environment (`TON_NETWORK` / `APP_ENVIRONMENT`) — server
   authoritative; currently decides which 64-wallet catalog is loaded and is
   the value stamped into `paymentSession.network`.
2. Per-room Owner selection (R20: one-time `testnet|mainnet` choice,
   broadcast via `ROOM_NETWORK_SELECTED` + `roomState.network`) —
   server-enforced but in-memory only and currently **decoupled from wallet
   selection and from the payment session network**.
3. Wallet credential tag (`network: "testnet"|"mainnet"` per catalog entry),
   validated against `TON_NETWORK` at load.

MAINNET infrastructure exists but follows the **old "separate Mainnet
application" model** (R20–R24): MAINNET selection on the Testnet runtime arms
a cross-runtime handoff and launches `wheelwin-main.vercel.app` via Telegram
deep link. A Mainnet Room Wallet *source* exists (the offline provisioner
supports `--network mainnet` and the runtime loader accepts
`ROOM_WALLETS_MAINNET_JSON`), but no Mainnet catalog is present in the repo
(by design) and nothing in the current flow pays to a per-room MAINNET wallet
inside the same application. This directly conflicts with the newly stated
intent ("Mainnet selected from Page2, no separate application,
`wheelwin-main.vercel.app` is not the target").

The payment layer is the smallest safe insertion point for the new model:
`PaymentSessionManager.createPaymentSession` already accepts a `network`
parameter (currently unused by the production caller), and the room's
selected network already exists server-side in `RoomLobbyBridge`.

---

## 4. Current TESTNET Payment Flow (traced from code)

Client page indices: Page2=LOBBY(2), Page4=PAYMENT(6), Page5=GAMEPLAY(7).

1. **Room creation (Page2 / RoomLobby)**
   - `client/src/components/CreateRoomPanel.jsx:169` → `socket.emit("createRoom")`
     → `SocketGateway` forwards `{socketId}` only → EventBus
     `LOBBY_CREATE_ROOM_REQUEST` → `RoomLobbyBridge._handleCreateRoom`.
   - `server/managers/RoomManager.js:151` `createRoom()`:
     `_allocateRoomNumber()` (line 848) returns the **first free integer in
     1..64** (`ROOM_WALLET_COUNT` pool, `_occupiedRoomNumbers` Set); on pool
     exhaustion room creation fails. `Room` model stores `roomNumber`
     (`models/Room.js:7,16`).
   - `ROOM_CREATED` EventBus → bridge delivers `roomCreated` to the creating
     socket only (with `recoveryCredential`); `CreateRoomPanel` stores
     `{roomId, playerId, recoveryCredential}` in `PlayerIdentityContext`.

2. **Network selection (Page2, Owner-only, one-time — R20)**
   - `CreateRoomPanel.selectRoomNetwork()` (line 176) →
     `socket.emit("selectRoomNetwork", { network })`.
   - `SocketGateway` forwards `{socketId, network}` only →
     `LOBBY_SELECT_ROOM_NETWORK_REQUEST` →
     `RoomLobbyBridge._handleSelectRoomNetwork` (line 1378): owner check via
     `_roomCreators`, strict normalization to `testnet|mainnet`, one-time
     (immutable) commit `this._roomNetworkByRoom.set(roomId, network)`
     (line 1523) → broadcast `ROOM_NETWORK_SELECTED {roomId, network}` (1541)
     → `_broadcastRoomState` includes `network` in `roomState` (line 4348).
   - MAINNET branch (lines 1469–1521): arms a cross-runtime handoff
     (`RoomNetworkHandoffStore.create`, line 451) BEFORE commit and delivers
     Owner-only `roomNetworkHandoffReady {roomId, handoffId, targetNetwork,
     expiresAt}` (line 490). See §6.

3. **Profile / verify / wallet connection (Pages 3–5)**
   - `Page2PlayerSetup.jsx` emits `updatePlayerProfile`
     (nickname/age/baseStake/sectorCount/colors) and navigates onward
     (`onNavigate(4)` → PageMatrix → Page3Verify). **No network concept here.**
   - Players connect TonConnect wallets and are verified server-side
     (wallet sessions); when every player's wallet connection is ready the
     bridge emits `PAYMENT_CONNECTION_READY`
     (`_deliverPaymentConnectionReady`, bridge ~6554–6592, plus reconnect
     mirror at 3049–3057).

4. **Payment session creation (server-authoritative wallet binding)**
   - `PaymentSessionManager` subscribes `PAYMENT_CONNECTION_READY`
     (line 219); handler (~2335) calls `createAndRequest(roomId, {gameId})`
     (line 563) → `createPaymentSession` (405–557):
     - `activeNetwork = network ?? contract?.tonNetwork ?? this._tonNetwork
       ?? null` (433–436). The production caller passes **no** `network`, so
       `session.network` = the runtime `TON_NETWORK` injected at composition
       (`app.js:1358` `tonNetwork: this._tonConfig?.network ?? null`).
     - Participants built from player profiles with
       `requiredGram = calculateRequiredGram(baseStake, sectorCount)`;
       each participant wallet must be verified (fail-closed).
     - **Wallet assignment** (fail-closed):
       `session.roomWalletAddress = this._resolveRoomWalletPaymentAddress(room)`
       (511/522) → `resolveIntendedRoomWalletAddress({roomId, roomNumber,
       roomManager}, registry)` (`RoomWalletIncomingObserver.js:208`) →
       `registry.get(roomNumber).address`. Missing address →
       `PaymentValidationError("Room Wallet address is required...")` (513).
     - Transition to `WAITING_FOR_PAYMENTS`, persist, `_scheduleExpiry`,
       emit `PAYMENT_SESSION_CREATED`, `_activatePaymentRequests`
       (participants get `paymentDestination = roomWalletAddress`).

5. **Payment session delivery to Page4**
   - `RoomLobbyBridge` subscribes `PAYMENT_SESSION_CREATED/UPDATED`
     (bridge 813/822) and delivers socket `paymentSessionCreated` /
     `paymentSessionUpdated` with `session.toSnapshot()` (bridge 6719/6737;
     reconnect mirror 3061–3072). `toSnapshot()` includes `network`,
     `roomNumber`, `roomWalletAddress`, participants
     (`models/PaymentSession.js:535–556`).

6. **Page4 payment execution (`client/src/pages/Page4Payment.jsx`)**
   - Destination: `resolvePlayerPaymentDestination({paymentSession,
     localPlayerId})` → `paymentSession.roomWalletAddress` (comment block
     lines 1–15; call at 868).
   - Amount: `getLocalPaymentRequest(...).requiredGram` (863).
   - Builds ONE plain TON transfer via `buildEntryPaymentTransaction`
     (deploy/fund forced off; legacy builders throw "disabled") →
     `toTonConnectSendTransactionRequest` → `tonConnectUI.sendTransaction`
     (926). Client logs include `network: paymentSession?.network` (916–924)
     and render `paymentSession.network` uppercase in the UI (983–985).
   - On wallet success emits **intent only**:
     `socket.emit(LOBBY_OUTGOING_EVENTS.PAYMENT_CONFIRM_INTENT)` (936).

7. **Server-side confirmation (independent observation)**
   - `RoomWalletIncomingObserver` (constructed `app.js:1656`) polls all
     configured Room Wallet addresses (8 wallets/cycle, 2000 ms global
     interval, concurrency 1 → full 64-wallet coverage ≈ 16 s; TonCenter
     read-only `getTransactions`), attributes each inbound transfer to
     exactly one payment-session participant (destination + tx-hash
     idempotency key) and feeds `PAYMENT_TRANSACTION_DETECTED` /
     `PAYMENT_TRANSACTION_CONFIRMED`.
   - `PaymentSessionManager` validation (2740–2781): sender must equal the
     participant wallet; amount must match `requiredGram`;
     `payload.network !== session.network` → `PaymentValidationError("Payment
     network mismatch")` (2766–2776). Confirmed participant →
     `_maybeCompleteSession` (2783): all 3 confirmed → `markCompleted()`
     (FULLY_PAID) → emits `PAYMENT_SESSION_UPDATED` +
     `PAYMENT_SESSION_COMPLETED`.

---

## 5. Current Network State

A network concept **already exists**, in three layers:

1. **Runtime environment (server-authoritative, decides wallets)**
   - Name: `APP_ENVIRONMENT` (`DEVELOPMENT|TESTNET|MAINNET`,
     `server/console/environment/AppEnvironment.js:5`) resolved from
     `APP_ENVIRONMENT` → `BLOCKCHAIN_NETWORK` → `NODE_ENV` → `TON_NETWORK`
     (default `testnet`).
   - Created/stored: process env (`server/.env`, Railway Variables);
     optional persisted dashboard switch (`environmentStateStore.js`,
     `APP_ENVIRONMENT_STATE_PATH`) that overrides after restart.
   - Effect: `_tonConfig.network` is injected into PaymentSessionManager
     (`app.js:1358`), RoomWalletIncomingObserver (`app.js:1667`), settlement
     and repositories; `loadRoomWalletRuntimeConfig(env)` requires explicit
     `TON_NETWORK` and selects the wallet catalog by it.
   - This is what currently reaches Page4 as `paymentSession.network`.

2. **Per-room Owner selection (server-enforced, in-memory, R20)**
   - Name: `network` on room state (`"testnet" | "mainnet" | null`).
   - Stored: `RoomLobbyBridge._roomNetworkByRoom` Map (line 186) — **not**
     in `Room.js`, **not persisted**, cleared at the three room-destruction
     sites (1030, 3512, 3918, 4281) and `shutdown()`.
   - Authoritative broadcast: `ROOM_NETWORK_SELECTED` + `roomState.network`.
   - **Currently does NOT influence** wallet selection, payment-session
     network, or Page4 behavior. It is lobby display state only.

3. **Wallet credential tag (per catalog entry)**
   - Each Room Wallet entry carries `network: "testnet"|"mainnet"`;
     `loadRoomWalletRuntimeConfig` rejects a catalog whose tag does not
     match `TON_NETWORK` (RoomWalletRuntimeResolver.js:140–155).

Client-side: `isTestnetRuntime()` (`roomNetworkHandoff.js:328`) is a
**hostname heuristic** (`hostname.includes("nine" || "testnet")`) used only
to gate the R24 handoff launch — not authoritative. The client has **no**
network environment variable (only `VITE_SOCKET_URL`, `VITE_SOCKET_PORT`,
`VITE_DEV_CONSOLE_ENABLED`).

---

## 6. TESTNET Room Wallet Architecture

- **Source/config (server-side only):**
  `RoomWalletRuntimeResolver.loadRoomWalletRuntimeConfig(env)`
  (`server/payment/roomWallet/RoomWalletRuntimeResolver.js:61`) resolves, in
  order for Testnet: `ROOM_WALLETS_TESTNET_JSON` (direct secret) →
  `ROOM_WALLETS_TESTNET_JSON_PATH` (local file path; relative to the server
  project root; read without ever logging contents) → legacy
  `ROOM_WALLETS_JSON`. Requires explicit `TON_NETWORK` (fail-closed).
- **Validation at load:** JSON array; ≤ 64 entries; unique roomNumber 1..64;
  unique addresses; optional per-entry `network` tag must equal
  `TON_NETWORK`; `secretKey` must derive `publicKey` and the configured
  address must equal the WalletContractV4 bounceable address for that key
  (`assertLocalWalletIdentity`, lines 341–377). With intake enabled the
  catalog must contain **exactly 64** entries (210–226). The same loader is
  re-run at startup by `server/config/validators/validateSecrets.js:233`.
- **Registry:** `RoomWalletRegistry` (in-memory `roomNumber → {roomNumber,
  address, network}`; identities only, never secrets). Instantiated once per
  runtime at `server/app.js:1652`
  (`createRoomWalletRegistryFromEnv(process.env)`).
- **Allocation lifecycle:** wallets are NOT dynamically assigned. The room
  number allocated by `RoomManager` (first free of 1..64) **is** the wallet
  index; the binding to an address happens at payment-session creation
  (`_resolveRoomWalletPaymentAddress`) and is persisted with the session
  (`roomNumber`, `roomWalletAddress` in `PaymentSession` payload/record).
- **Server-side only:** the client never selects anything; it receives only
  the final destination address; the private catalog never leaves the server.
- **Different rooms, different wallets:** yes — while ≤ 64 rooms coexist,
  each holds a distinct roomNumber and therefore a distinct wallet. At the
  65th concurrent room, creation fails (pool exhausted).
- **On room destroy:** `_releaseRoomNumber` (RoomManager 866) frees the
  number; the next room may reuse the same Room Wallet address. Financial
  accounting is per-`gameId` via `RoomWalletLedgerRegistry`, not per wallet
  balance.
- **Restart reconciliation:** the registry is rebuilt from env at boot;
  recovery re-attaches rooms with their persisted `roomNumber` and re-claims
  occupancy (`_claimExistingOrAllocateRoomNumber`, RoomManager 878–923,
  fail-closed on invalid/occupied numbers). Persisted sessions restore
  `roomNumber` (fallback `registry.getByAddress(address).roomNumber`,
  PaymentSessionManager 2007–2011). Secrets remain in runtime env only
  (`SECRET_ENV_KEYS`, redacted from logs and configuration errors).

---

## 7. Existing MAINNET Infrastructure (classification)

No Mainnet activation exists. The following items are present and are
classified without modification:

| Item | Location | Class |
|---|---|---|
| `APP_ENVIRONMENT=MAINNET` resolution + `tonNetworkForAppEnvironment` | `server/console/environment/AppEnvironment.js` | CONFIGURATION (dormant path, reachable only via env) |
| Mainnet Room Wallet runtime key `ROOM_WALLETS_MAINNET_JSON` | `RoomWalletRuntimeResolver.js:45,14`; schema `server/config/schemas/environmentSchema.js:888`; secret list `server/config/secrets.js:19`; validation `server/config/validators/validateEnvironment.js:731` | CONFIGURATION (declared, no value in repo) |
| Mainnet catalog **provisioner path** `--network mainnet` + `docs/MAINNET_ROOM_WALLET_PROVISIONER.md` | `server/scripts/provision-room-wallets.mjs`, `server/scripts/lib/provisionRoomWallets.js` | CONFIGURATION / tooling (operator has not generated a Mainnet catalog; doc explicitly says "do not execute now") |
| Per-room network selection (R20) | `lobbyProtocol.js` `SELECT_ROOM_NETWORK`/`ROOM_NETWORK_SELECTED`; `RoomLobbyBridge._handleSelectRoomNetwork` | ACTIVE (Testnet runtime; MAINNET value currently triggers item below) |
| Cross-runtime handoff store + internal HTTP contract (R21) | `server/network/RoomNetworkHandoffStore.js`; `app.js:202,2387–2404,3347,3351`; routes `/internal/network-handoff/claim|complete`; `ROOM_NETWORK_HANDOFF_SECRET` | ACTIVE (server contract implemented; client navigation is the R24 launch) |
| Handoff creation on MAINNET selection (R22) + release on room destroy | `RoomLobbyBridge` 440–564, 1469–1521, release sites | ACTIVE |
| Mainnet room bootstrap (R23) | `RoomLobbyBridge._handleRoomNetworkHandoffBootstrap`; socket events `roomNetworkHandoffBootstrapRequest/Result`; tests `roomNetworkHandoffBootstrap.r23.test.js` | ACTIVE (server-side) |
| Client Mainnet launch — `launchMainnetMiniApp()` → `https://t.me/wheel_win_bot?startapp=mainnet<handoffId>` or fallback `https://wheelwin-main.vercel.app`; `RoomNetworkHandoffBootstrap.jsx` overlay | `client/src/network/roomNetworkHandoff.js`, `client/src/components/CreateRoomPanel.jsx:116–141` | ACTIVE — **this is the "separate Mainnet application" model; conflicts with the newly stated single-application intent** |
| Mainnet readiness diagnostics (escrow-era profile) | `server/diagnostics/TonMainnetReadiness.js`, `server/scripts/check-mainnet-readiness*`, `TON_MAINNET_*` env block in `.env.example` | LEGACY (GameEscrow-era mainnet readiness; non-financial) |
| `LAUNCH_REQUIRE_MAINNET_FOR_GA`, GA/governance keys | `.env.example` | CONFIGURATION (observational) |
| `.kilo/worktrees/powerful-trunk/` parallel checkout | repo root | DEAD/UNUSED for the main tree (excluded from all searches) |

**Mainnet Room Wallet source:** the *generator* exists (provisioner with
`--network mainnet`, independent seeds mandated, 64-wallet invariant, network
tag validation against `TON_NETWORK`). **No Mainnet catalog exists in the
repository** (by design; catalogs are offline operator artifacts outside
Git). Whether an operator-generated Mainnet catalog exists outside the repo
is UNKNOWN from this audit.

---

## 8. Page4 Payment Flow (data sources)

Page4 (`client/src/pages/Page4Payment.jsx`) obtains everything from the
server-authoritative `paymentSession` snapshot (delivered via
`paymentSessionCreated` / `paymentSessionUpdated` and the reconnect mirror):

| Data | Source |
|---|---|
| Payment target wallet | `paymentSession.roomWalletAddress` via `resolvePlayerPaymentDestination` (`client/src/game/session/page4PaymentPhase.js:63`) |
| Payment amount | `paymentRequest.requiredGram` (server-computed per participant `calculateRequiredGram(baseStake, sectorCount)`) |
| Network | `paymentSession.network` — display only (header "· TESTNET", lines 983–985); **no functional branching** |
| Payment status | `paymentSession.status` + `participants[].status` via `mapPaymentSessionRows`, `resolvePage4PaymentPhase`, `PAGE4_PAYMENT_UI_STATE` |
| Payment confirmation | TonConnect `sendTransaction` success emits `PAYMENT_CONFIRM_INTENT` only; authoritative confirmation is the server's blockchain observation reflected back in `paymentSessionUpdated` |
| Payment timeout | `paymentSession.paymentDeadline` / `expiresAt` (server `_scheduleExpiry`; deadline = createdAt + `_durationMs`) |
| Error state | local `submitError`/`localError` + server `roomError` / `PAYMENT_SESSION_FAILED` transitions |

**Why two networks cannot work cleanly today (no fix applied):**

1. `session.network` is derived from the **runtime** `TON_NETWORK`
   (`_tonNetwork`), not from the room's Owner selection
   (`_roomNetworkByRoom` is bridge-owned and never consulted by
   `PaymentSessionManager`).
2. The Room Wallet registry is **single-network per process** —
   `loadRoomWalletRuntimeConfig` selects the catalog by runtime
   `TON_NETWORK`; there is no per-room (network, roomNumber) wallet lookup.
3. Page4's TonConnect wallet is connected to whatever chain the wallet app
   is on; there is no per-room network routing or network-conditional
   transaction building on the client.
4. The file header is hardwired to "Testnet Room Wallet entry payment".
5. The only existing MAINNET payment topology is a **separate runtime**
   (separate deployment with `TON_NETWORK=mainnet` + its own 64 wallets) or
   the R22/R24 cross-runtime handoff to `wheelwin-main.vercel.app` — not a
   per-room wallet choice inside one application.

---

## 9. Page4 → Page5 Transition

Server-side condition chain (unchanged, documented only):

1. All **three participants** confirmed → `PaymentSession.markCompleted()` →
   status `FULLY_PAID` → `PAYMENT_SESSION_COMPLETED` emitted
   (`PaymentSessionManager._maybeCompleteSession`, 2783–2821).
2. `GameStartAuthorization` validates the **Room Wallet ledger**:
   `_checkRoomWalletLedger` (449–494) requires
   `roomWalletLedgerRegistry.listPlayerPayments(gameId)` to fund **every**
   participant, else `room_wallet_ledger_incomplete` (retry with timeout).
3. `_authorizeAndBootstrap` (496): emits `GAME_START_AUTHORIZED` (525) →
   `GAME_INITIALIZING` (550) → server-authoritative bootstrap validation.
4. On bootstrap success the bridge `_handleGameStartBootstrapReady`
   (7118) → `_completeEntryPayment(roomId)` (7257):
   - adds roomId to `_entryPaymentCompletedByRoom`,
   - delivers socket `ENTRY_PAYMENT_COMPLETED {roomId}`,
   - emits EventBus `ENTRY_PAYMENT_COMPLETED` (GameManager starts physics /
     clock / READY phases),
   - `_deliverOpenPage5(roomId)` → socket `OPEN_PAGE5 {roomId}`.
5. Client navigates to Page5 (GAMEPLAY=7). Reconnect mirror re-delivers
   `ENTRY_PAYMENT_COMPLETED` + `OPEN_PAGE5` when
   `_entryPaymentCompletedByRoom.has(roomId)` (bridge 3118–3133); a fallback
   completion timer exists (`_entryPaymentCompletionTimerByRoom`, 7244), and
   `_handleDebugStartGame` (7299) reuses the same path in development only.

**Dependencies:** payment session state (all three players confirmed) AND
Room Wallet ledger completeness per gameId. It does **not** depend on raw
Room Wallet balance, and it does not depend on any escrow/contract state.

---

## 10. Recovery / Refund Flow (current implementation)

- **Payment timeout:** `_scheduleExpiry(session)` (deadline =
  createdAt + `_durationMs`) → expiry handling in
  `PaymentSessionManager` → `failSession` route. A `FULLY_PAID` session
  never transitions to `PAYMENT_TIMEOUT`/`PAYMENT_FAILED` directly
  (2161–2163: "FULLY_PAID has no transition ... status stays FULLY_PAID
  until the refund flow marks REFUND_PENDING").
- **Reconnect:** bridge reconnect snapshot (3030–3140) re-delivers
  `entryPaymentSessionUpdated`, `walletConnectionSessionUpdated`,
  `PAYMENT_CONNECTION_READY` (when ready), `paymentSessionUpdated`,
  game-start phases (`GAME_START_AUTHORIZED`, `GAME_INITIALIZING`,
  `OPEN_PAGE5`), and `ENTRY_PAYMENT_COMPLETED` + `OPEN_PAGE5` after
  completion. Recovery credentials re-issue via
  `RoomLobbyBridge._deliverSetupSessionSync` (Stage 2 fix, commit `dfa8832`).
- **Room destruction:** creator-left / empty-room / setup-expiry teardown →
  `_closeRoom` / room destroy paths; each clears `_roomNetworkByRoom`
  (1030, 3512, 3918, 4281), releases any pending network handoff
  (`_releaseRoomNetworkHandoff`, 528), and releases the room number
  (RoomManager `_releaseRoomNumber`).
- **Refunds (pre-GAME_INITIALIZED):** triggers `setup_expired`,
  `creator_left` (fixed 2026-09-27), `payment_failed`, `payment_timeout` →
  `PaymentSessionManager.failSession(roomId, reason)` (2076) →
  `refundableFullyPaidBeforeGameInit` gate (2110–2116, allows FULLY_PAID for
  `setup_expired`/`creator_left`) → `needsRoomWalletRefund` (2148–2152) →
  `_requestRoomWalletPartialPaymentRefund` (1961) →
  `RoomWalletSettlementAdapter.refundPayments` (idempotent:
  `_findExistingRefund`, on-chain `REFUND_ADOPTED` dedup, persisted
  `refundRequestedAt` cutoff) → `_finalizePartialPaymentUnwind` →
  `CANCELLED` + `PAYMENT_SESSION_FAILED`. The legacy escrow unwind branch
  (2202–2245) is unreachable in intake mode.
- **Server restart:** `TonFinancialRecovery.recover()` → `recoverPayments()`
  → `PaymentSessionManager.restorePaymentSessions()` (716): per-record gates
  (terminal skip with `isCancelled` exception; the working tree also carries
  an in-progress fix for refundable restored FULLY_PAID sessions) →
  `_finishPaymentSessionRestore()` re-arms chain watches. The known
  restore-refund gap and its fix are documented in
  `2026-09-27_payment_session_restore_room_wallet_refund_gap.md`; the
  corresponding **uncommitted** change is present in the working tree
  (`M server/gameplay/PaymentSessionManager.js` + untracked
  `server/tests/restoreRoomWalletRefund.test.js`).
- **Residual sweep:** `ROOM_WALLET_RESIDUAL_SWEEP_ENABLED` (default OFF)
  moves 0.49 Gram to `TON_RESIDUES_EXPECTED_ADDRESS` at 0.50 Gram balance;
  source wallet retains a 0.01 Gram envelope.

---

## 11. Legacy Payment Contract Residue (GameEscrow / DepositContract / DepositPackage)

Full per-reference tracing was completed today in
`2026-09-27_gameescrow_depositcontract_remaining_links_analysis.md` (786
lines, same tree). Summary classification (no code touched):

- **ACTIVE (non-financial):** the startup artifact integrity gate
  (`verifyGameEscrowArtifact`, `app.js:4622–4660`; Testnet
  `GAME_ESCROW_MODE=game` requires `GameEscrow.code.boc` present/loadable —
  operational boot dependency D-1, not a payment path).
- **ACTIVE (naming only):** `BlockchainMonitor` emits the legacy-named
  `GAME_ESCROW_STAKE_CONFIRMED` for **Room Wallet** confirmations
  (`BlockchainMonitor.js:2886–2908`), consumed only by
  `SessionHistoryArchiveManager` as financial evidence.
- **DEAD/UNREACHABLE:** `GameContractManager` is not instantiated outside
  tests; `DepositOrchestrator` is intentionally not initialized
  (`app.js:1729`); every GameEscrow sync/watch/settlement branch in
  `PaymentSessionManager` / `ContractSettlementManager` is short-circuited
  by `_roomWalletPaymentIntakeEnabled === true` (set via
  `isRoomWalletOnlyFinancialPath()` which returns `true` unconditionally,
  `roomWalletConfig.js:40`) and by the enabled `RoomWalletSettlementRouter`.
- **LEGACY (quarantined):** deposit-era recovery reactivation
  (`TonFinancialRecovery` can re-arm `DepositMonitor` watches on persisted
  historical deposit records; informational only, no financial reach).
- **DOCUMENTATION/TEST-ONLY:** `contracts/` Tact sources, wrappers,
  compilables, tests; `client/src/payment/page4Deposit*` diagnostics/tests;
  `client/src/i18n` `payment.waitingGameEscrow` keys; client helpers with
  legacy names (`isGameEscrowOnlyPlayerPayment`, `canStakeGameEscrow`,
  `PAGE4_PAYMENT_PHASE.GAMEESCROW_STAKE`) that now mean "Room-Wallet
  payable"; `server/events/EventTypes.js` `GAME_ESCROW_*`/`DEPOSIT_*` names.

**Verdict (unchanged from the residue report): none of these references can
interfere with the Room Wallet payment, game-start, refund, or settlement
flow.** Their presence is not a reason to restore smart-contract payments.

---

## 12. Configuration Map (keys only; no secret values)

**TESTNET-specific**

- `ROOM_WALLETS_TESTNET_JSON` (secret; 64-entry runtime catalog)
- `ROOM_WALLETS_TESTNET_JSON_PATH` (local file-path catalog source)
- `ROOM_WALLETS_JSON` (legacy Testnet compatibility fallback)
- `TON_NETWORK=testnet`, `TON_ENDPOINT`, `TON_API_KEY` (testnet TonCenter)
- `GAME_ESCROW_MODE=game` (Testnet default; legacy artifact gate)
- Legacy escrow-era Testnet deploy keys (`TON_TESTNET_DEPOSIT_DEPLOYER_*`,
  `RUN_TESTNET_R179L25*`, `TEST_VALUETON_*`) — legacy residue

**MAINNET-specific**

- `ROOM_WALLETS_MAINNET_JSON` (secret; declared in
  `environmentSchema`/`secrets`/`validateEnvironment`; **no file-path
  fallback**, no cross-network fallback)
- `TON_NETWORK=mainnet`
- `ROOM_NETWORK_HANDOFF_SECRET` (R21 shared secret, both Railway services)
- `ROOM_NETWORK_HANDOFF_TESTNET_URL` (Mainnet-side Testnet base URL)
- Legacy escrow-era Mainnet readiness: `TON_MAINNET_ENDPOINT`,
  `TON_MAINNET_ORACLE_ADDRESS`, `TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS`,
  `TON_MAINNET_GAME_ESCROW_MODE=v4`, `TON_GAME_ESCROW_ARTIFACT_SHA256`,
  `TON_MAINNET_DRY_RUN_DEBUG`, `TON_MAINNET_WALLET_IDENTITY_DEBUG`

**Shared / both networks**

- `APP_ENVIRONMENT` / `BLOCKCHAIN_NETWORK`, `NODE_ENV`
- `ROOM_WALLET_PAYMENT_INTAKE_MODE=ROOM_WALLET`,
  `ROOM_WALLET_SETTLEMENT_MODE=ROOM_WALLET`,
  `ROOM_WALLET_RESIDUAL_SWEEP_ENABLED`,
  `TON_RESIDUES_EXPECTED_ADDRESS` (fallback
  `TON_REIMBURSEMENT_EXPECTED_ADDRESS`), reimbursement knobs
- `ROOM_WALLET_OBSERVER_MAX_CONCURRENCY`, `..._WALLETS_PER_CYCLE`,
  `..._RETRY_MAX_ATTEMPTS`, `..._RETRY_DELAY_MS` (+ fetch timeout constant)
- `ROOM_MAX_PLAYERS=3`, `OWNER_WALLET`, `TON_POLL_INTERVAL_MS`
- Logging/monitoring/probes/failure-policy keys; developer-console and
  Telegram auth keys (`TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_INIT_DATA_MAX_AGE_SECONDS`)
- Client: `VITE_SOCKET_URL`, `VITE_SOCKET_PORT`, `VITE_DEV_CONSOLE_ENABLED`
  — **no client network variable exists**

---

## 13. Logging Gaps (fields only; no changes made)

Sufficient today: room-number allocation (`Room Created ... roomNumber=`),
network-selection decisions (`decisionTrace ROOM_NETWORK_SELECTION` with
`network`), payment-session lifecycle (`PAYMENT_SESSION_CREATED` decision
trace + `[R7.50 DIAG]` logs + `CREATED|COMPLETED` `_log` lines with
roomId/paymentSessionId), disconnect diagnostics (include `RoomWallet`
address and session status), `Entry payment completed | roomId=`,
`GAME_START_AUTHORIZED` audit + log, startup
`RoomWalletIncomingObserver (N wallets)`, and client `[Page4Payment]` logs
including `network` and `destination`.

Missing fields:

1. Payment-session creation logs do not record the **room's Owner-selected
   network** (`_roomNetworkByRoom`) alongside `session.network` — the two
   values are never compared or logged together.
2. No log of the **assigned wallet's catalog `network` tag** at assignment
   time (only the address is logged).
3. `Entry payment completed` / `OPEN_PAGE5` delivery logs carry no network
   field, so a Page4→Page5 transition cannot be attributed to a network in
   logs alone.
4. Observer attribution logging is distributed across the observer, PSM and
   archive paths; a single consolidated "confirmed payment → roomId /
   playerId / wallet / tx / network" line is not guaranteed (verify during
   the next stage before relying on it forensically).

---

## 14. Risks / Conflicts Found

- **High — conflicting MAINNET models.** The current build implements the
  "separate Mainnet application" model (R22/R24: MAINNET selection arms a
  handoff and launches `wheelwin-main.vercel.app` via Telegram deep link),
  while the newly stated intent is a **single application** with per-room
  MAINNET Room Wallets selected from Page2, where `wheelwin-main.vercel.app`
  is explicitly not the target. Both models are ACTIVE in the same tree; the
  R24 launch path must be neutralized/replaced before any per-room Mainnet
  flow is safe, otherwise selecting MAINNET still navigates players away.
- **High — `session.network` is runtime-derived, not room-derived.**
  `createAndRequest` passes no `network`, so every session inherits
  `TON_NETWORK`. Under mixed-network rooms this mislabels sessions and the
  strict guard at `PaymentSessionManager.js:2766` ("Payment network
  mismatch") would reject legitimate payments.
- **Medium — room network state is ephemeral.** `_roomNetworkByRoom` is
  in-memory only; `Room.js` has no `network` field; recovered rooms project
  `network: null` after restart while their persisted payment session keeps
  a runtime-derived network.
- **Medium — wallet↔room-number coupling.** Wallet identity = room number;
  only 64 concurrent rooms; room numbers (and therefore wallet addresses)
  are reused after destroy. Ledger-per-gameId mitigates accounting, but any
  future balance-based logic must not assume one wallet = one game.
- **Medium — uncommitted in-flight work.** `server/gameplay/PaymentSessionManager.js`
  is modified and `server/tests/restoreRoomWalletRefund.test.js` untracked
  (restore-refund gap fix). This must be validated/committed (or explicitly
  dropped) before any Mainnet stage builds on top of it.
- **Low — `.kilo/worktrees/powerful-trunk/` parallel checkout** produces
  grep/search noise and stale copies; exclude it in all future searches.
- **Low — client network detection is a hostname heuristic**
  (`isTestnetRuntime`) and Page4's header comment says "Testnet" — cosmetic
  now, misleading after the architecture change.
- **Informational — legacy naming** on live helpers/events
  (`GAME_ESCROW_STAKE_CONFIRMED`, `sessionNeedsEscrowUnwind`, escrow phase
  names) documented in the residue report to prevent future misreading.

---

## 15. Recommended Next Small Step (ONE step only)

**Propagate the room's authoritative Owner-selected network into the payment
session at creation time.**

Scope (smallest possible, additive):

1. Add a read-only accessor on `RoomLobbyBridge`
   (e.g. `getRoomNetwork(roomId)` reading `_roomNetworkByRoom`).
2. Inject it into `PaymentSessionManager` (constructor or a
   `setRoomWalletFinance`-style setter) as an optional
   `resolveRoomNetwork` callback.
3. In `createPaymentSession`, resolve
   `network = explicitNetwork ?? resolveRoomNetwork?.(roomId) ?? this._tonNetwork ?? null`
   so `session.network` becomes room-authoritative with a fail-safe fallback
   to today's behavior.

Explicitly OUT of this step: any wallet-catalog change (the registry stays
runtime-scoped), any client change, any handoff/launch change, any
persistence schema change (`network` is already persisted), and any
neutralization of the R24 launch path (that is a separate, later approved
stage). Validation: existing suites (`paymentSession.manager.test.js`,
`roomNetworkSelection.r20.test.js`, `setupExpiryRoomWalletRefund.test.js`,
`creatorLeftRoomWalletRefund.test.js`) plus one focused new test asserting
`session.network === "testnet"` when the room selected Testnet and unchanged
behavior when the accessor is absent.

Rationale: it is the minimal change that removes the first structural
conflict (§14 risk 2) without touching wallet selection, and it makes the
existing `paymentSession.network` field that Page4 already displays
truthful per room.

---

## 16. Ownership Boundaries (observed, unchanged)

- **Room Domain:** `RoomManager` (creation, roomNumber pool 1..64, release),
  `Room` model (no network field).
- **Lobby/Socket Domain:** `RoomLobbyBridge` (room lifecycle, Owner network
  selection map, handoff arming/release, socket delivery), `SocketGateway`
  (strict payload forwarding), `lobbyProtocol.js` (event names).
- **Payment Domain:** `PaymentSessionManager` (session state machine,
  fail-closed wallet binding, confirmation validation, expiry/refunds),
  `RoomWalletIncomingObserver` (chain observation + attribution),
  `BlockchainMonitor` (transport + legacy-named evidence event),
  `RoomWalletRegistry`/`RoomWalletRuntimeResolver` (wallet identities),
  `RoomWalletSettlementAdapter`/`Router` (settlement + refunds).
- **Game-start Authority:** `GameStartAuthorization` (ledger validation →
  GAME_START_AUTHORIZED → bootstrap).
- **Network handoff (legacy model):** `RoomNetworkHandoffStore` + internal
  HTTP contract + client launcher.
- **Recovery Domain:** `TonFinancialRecovery`,
  `PaymentSessionManager.restorePaymentSessions` (fail-closed).
- **Client:** renders state, sends commands; never owns wallet selection,
  amounts, confirmation, or network authority.

---

## 17. Recommendations (documentation only — NOT implemented)

1. Execute the single next step in §15 after approval; nothing else.
2. In a later approved stage, decide the fate of the R22/R24
   separate-application launch path (`launchMainnetMiniApp`,
   `wheelwin-main.vercel.app`, handoff store) versus the new single-app
   per-room wallet model — do not silently leave both armed.
3. Consider making room network durable (Room model/persistence or
   recovery-rebuild of `_roomNetworkByRoom`) before Mainnet rooms exist —
   analysis first, no code changes now.
4. Keep all legacy residue per the residue report's recommendations; no
   cleanup in this stage.
5. Before any Mainnet stage: validate/commit or explicitly drop the
   in-progress restore-refund change currently in the working tree.
6. Add the missing log fields of §13 in the same stage that first consumes
   them (network-linked payment/session logs).

## 18. Changes Made

- Created exactly one file:
  `AI_CONTEXT/CLINE_REPORTS/2026-09-27_stage0_local_baseline_audit.md`
  (this report).
- Temporary grep scratch files were written to the git-ignored `_audit_tmp/`
  directory during inspection and deleted afterwards; the working tree
  contains no audit leftovers beyond this report.
- **No application code, configuration, dependency, deployment, `.env`, or
  architecture element was modified. Nothing was committed or pushed.**
- Pre-existing working-tree state observed and left untouched:
  `M server/gameplay/PaymentSessionManager.js`, untracked
  `server/tests/restoreRoomWalletRefund.test.js`, and six untracked
  2026-09-27 reports (this one included).
