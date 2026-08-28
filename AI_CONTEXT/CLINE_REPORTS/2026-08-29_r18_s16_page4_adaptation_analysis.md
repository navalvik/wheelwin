# R18-S16 — Page4 Adaptation Analysis Against the Verified R18-S15 Server Contract

Date: 2026-08-29

Task: Analysis only. Compare the current Web Page4 implementation with the verified R18-S15 server lifecycle through `OPEN_PAGE5`. Produce a precise adaptation map. Do not implement.

Classification: **ANALYSIS**. No Page4 / Page5 / server / test source was modified.

The R18-S15 server-side path is treated as the comparison contract. This document does not reopen DepositContract, GameEscrow, TonCenter, GameStartAuthorization, or RoomLobbyBridge internals except where a Page4-facing interface is required.

---

## 1. Scope

Current Web Page4 (the payment page in the live application), its socket/session mirrors, wallet/payment builders, and the Page4-facing subset of the verified R18-S15 lobby protocol.

Out of scope: Page5 gameplay, FunC, financial-gate redesign, architecture audit of already verified server components.

---

## 2. Files Inspected

**Page4 and routing**

- `client/src/pages/Page4Payment.jsx`
- `client/src/styles/page4payment.css`
- `client/src/components/PlayerPaymentRow.jsx`
- `client/src/App.jsx`
- `client/src/components/OpenPage5Navigator.jsx`
- `client/src/pages/Page3VerifyPlayers.jsx`
- `client/src/game/sessionRecovery/recoveryFlow.js`
- `client/src/config/devMode.js`

**Session / views**

- `client/src/game/session/authoritativeSessionModel.js`
- `client/src/game/session/authoritativePaymentSessionView.js`
- `client/src/game/session/authoritativeGameContractView.js`
- `client/src/game/session/authoritativeWalletConnectionView.js`
- `client/src/game/session/authoritativePaymentView.js`
- `client/src/game/session/authoritativeEntryPaymentView.js`
- `client/src/game/session/authoritativePlayerView.js`
- `client/src/game/session/index.js`
- `client/src/context/AuthoritativeSessionContext.jsx`
- `client/src/context/PlayerIdentityContext.jsx`
- `client/src/context/RecoveryExperienceContext.jsx`

**Socket**

- `client/src/socket/socketEvents.js`
- `client/src/socket/EngineBridge.js`
- `client/src/socket/SocketSyncLayer.js`
- `server/socket/lobbyProtocol.js`

**Payment builders**

- `client/src/payment/buildTonConnectPaymentTransaction.js`
- `client/src/payment/buildFundDepositTransaction.js`
- `client/src/payment/buildDepositDeploymentTransaction.js`

**Page4-facing server interfaces only**

- `server/deposit/projectDepositForPlayer.js`
- `server/deposit/DepositSessionStates.js`
- `server/socket/RoomLobbyBridge.js` (`DEPOSIT_PACKAGE_PUBLISHED` delivery, reconnect restore, `OPEN_PAGE5`)
- `server/deposit/DepositOrchestrator.js` (when the package is published vs activation verify)

**.clinerules** report format.

No other Page4 component exists under `client/src`.

---

## 3. Architecture Findings

# 1. CURRENT PAGE4 IMPLEMENTATION

**SOURCE VERIFIED**

There is one live Web Page4:

| Item | Path / value |
|---|---|
| Component | `client/src/pages/Page4Payment.jsx` (`export default function Page4Payment`) |
| Styles | `client/src/styles/page4payment.css` |
| Seat row UI | `client/src/components/PlayerPaymentRow.jsx` |
| App page number | `APP_PAGES.PAYMENT = 6` (`client/src/game/sessionRecovery/recoveryFlow.js`) |
| Route | Not a URL route. `App.jsx` `GameFlow.renderPage()` `case 6` renders `<Page4Payment onNavigate={navigate} />`. React Router in `App.jsx` is only used around this flow; page index is React state. |
| Entry | `Page3VerifyPlayers` `useEffect` calls `onNavigate(6)` when `paymentStageReady` is true (`PAYMENT_STAGE_READY`). |
| Exit to Page5 | Not inside Page4. `OpenPage5Navigator` registers `onOpenPage5` → `onNavigate(APP_PAGES.GAMEPLAY)` (`7`). |
| State | `useAuthoritativeSession()` plus local TonConnect / error / confirming flags. |
| Network | `socket` from `client/src/socket/socket.js`; outgoing `LOBBY_OUTGOING_EVENTS`. Incoming via `SocketSyncLayer` → `EngineBridge` → authoritative session / navigator. |

No second Page4 implementation is used by `App.jsx`.

# 2. CURRENT PAGE4 LIFECYCLE

**SOURCE VERIFIED**

```
PAYMENT_STAGE_READY
    → Page3 onNavigate(6)
    → Page4Payment mounts
    → AuthoritativeSession: roomId, players, walletConnection, later paymentSession / gameContract / deposit
    → Wallet-connect UI while !inPaymentPhase
    → User: Connect (TonConnect) / Disconnect
    → Client emits WALLET_CONNECT_STARTED / WALLET_CONNECT_REPORT / WALLET_DISCONNECT_REPORT
    → Server WALLET_CONNECTION_SESSION_UPDATED
    → When paymentConnectionReady || paymentSession.participants.length > 0:
          inPaymentPhase = true
          UI switches to GameEscrow confirm button (handleConfirmPayment)
    → canConfirm requires seat AWAITING_PLAYER_CONFIRMATION AND isGameContractDeployed
    → sendTransaction(GameEscrow STAKE) then PAYMENT_CONFIRM_INTENT
    → Rows follow PAYMENT_SESSION_UPDATED statuses
    → COMPLETED / FAILED / DEPLOY_FAILED show copy; Next stays disabled
    → OpenPage5Navigator on OPEN_PAGE5 → page 7
```

`handleConfirmInTelegramWallet` (Deposit deploy vs FundSeat) exists in `Page4Payment.jsx` but is **not** referenced by any JSX `onClick`. `depositSubmitError` is never rendered.

**INFERRED FROM SOURCE:** if the `useCallback` dependency array at the Deposit handler is evaluated as written (`t`, `tonConnectUI`, `tonWallet` before those consts), mounting Page4 throws `ReferenceError` (TDZ). That is a source defect, not a verified runtime observation from this analysis session.

# 3. VERIFIED SERVER CONTRACT USED FOR COMPARISON

**SOURCE VERIFIED** (lobby-facing names; server internals not re-audited)

```
PAYMENT_STAGE_READY
    → wallet connect (WALLET_CONNECTION_SESSION_UPDATED)
    → PAYMENT_CONNECTION_READY
    → PaymentSession create (PAYMENT_SESSION_CREATED)
    → DEPOSIT_PACKAGE_PUBLISHED (requester-scoped projection)
    → creator DepositContract deploy (client TonConnect; server activation)
    → DEPOSIT_ACTIVATION_WAITING / VERIFIED  (EventBus; not in lobbyProtocol)
    → FundSeat × 3 (client TonConnect; server observation)
    → DEPOSIT_FULL → DEPLOY_AUTHORIZATION_VALID
    → GameEscrow deploy (server) → INIT_GAME → OPEN_PAYMENTS
    → PAYMENT_REQUEST / GAME_CONTRACT_DEPLOYED
    → STAKE × 3 (client TonConnect + PAYMENT_CONFIRM_INTENT)
    → GameEscrow READY (on-chain; server PaymentSession completion)
    → PAYMENT_SESSION_COMPLETED
    → GAME_CONTRACT_PAYMENTS_COMPLETE (EventBus; not in lobbyProtocol)
    → GAME_START_AUTHORIZED / GAME_INITIALIZING (sockets)
    → GAME_START_BOOTSTRAP_READY (EventBus; RoomLobbyBridge consumes)
    → ENTRY_PAYMENT_COMPLETED (socket + EventBus)
    → OPEN_PAGE5 (socket { roomId })
```

Page4 must not deploy GameEscrow, authorize start, or navigate to Page5 locally.

---

## 4. Lifecycle Flow

Stage classification vs Page4:

| Stage | Visible to Page4 | Initiated by Page4 | Observed by Page4 | Server-automatic | Not in Page4 UI |
|---|---|---|---|---|---|
| PaymentSession create | Partial (rows after session exists) | No | `PAYMENT_SESSION_*` into session | Yes after wallets ready | Distinct “session created” copy |
| Deposit package | Stored in `authoritative.deposit` | No | `DEPOSIT_PACKAGE_PUBLISHED` | Yes | **No UI** |
| Deposit activation | No | Creator deploy would, if wired | **No socket event** | Verify after creator deploy | **Missing** |
| Deposit FundSeat | Handler exists, unwired | Would be, if wired | `mySeatStatus` only if package re-delivered | Observation | **Unwired** |
| GameEscrow deploy | `gameContract.status` used for failed/deployed gates | No | `GAME_CONTRACT_*` | Yes after VALID | Weak copy only |
| INIT_GAME / OPEN_PAYMENTS | No | No | Indirect via `PAYMENT_REQUEST` / deployed | Yes | Hidden |
| STAKE × 3 | Yes (`handleConfirmPayment`) | Yes | Session participant status | Confirm + chain | OK if GameEscrow stage |
| READY / payments complete | `paymentSession.status === COMPLETED` | No | `PAYMENT_SESSION_COMPLETED` | Yes | “all confirmed”; still waits OPEN_PAGE5 |
| GAME_START_* / bootstrap | lifecycle flags; no dedicated UI | No | AUTHORIZED / INITIALIZING sockets | Yes | Hidden (acceptable) |
| ENTRY_PAYMENT_COMPLETED | lifecycle stamp | No | Socket stored; **does not navigate** | Yes | Hidden (correct) |
| OPEN_PAGE5 | Navigator, not Page4 JSX | No | `OpenPage5Navigator` | Yes | Correct |

---

## 5. Ownership Boundaries

# 4. PAGE4 ↔ SERVER RESPONSIBILITY MATRIX

| Responsibility | Page4 should own | Server should own | Evidence |
|---|---|---|---|
| Display room/game information | Yes (mirror) | Authoritative `roomId` / `gameId` on events | `authoritative.roomId`; payloads; Page4 title is i18n `"page.payment.title"` only |
| Display player seats | Yes (mirror) | Roster + session participants | `mapWalletConnectionRows` / `mapPaymentSessionRows` |
| Creator identification | Display only from projection | `_roomCreators` + binding index; fail-closed on conflict | `projectDepositForPlayer.js` `isCreator` / `mySeatIndex` / conflict |
| Wallet connection | TonConnect UI + reports | Session wallet status | `WALLET_CONNECT_*` out; `WALLET_CONNECTION_SESSION_UPDATED` in |
| Deposit creation | No | DepositOrchestrator + package freeze | `_emitPackagePublished` then socket deliver |
| Deposit activation | Creator **broadcasts deploy tx** only | `verifyActivation` / WAITING / VERIFIED | Orchestrator `_verifyActivation` after publish; EventBus `DEPOSIT_ACTIVATION_*` |
| Deposit funding | Non-creator **broadcasts FundSeat** after allowed | Observation + `assertInitialMutableState` | `buildFundDepositTransaction.js`; S15 gate |
| FundSeat actions | Yes, using server `mySeatIndex` / amount / address | Never trust client-invented seat | Projection + FundSeat builder |
| GameEscrow deployment | No | GCM after VALID | Page4 `isGameContractDeployed` is display/gate only |
| GameEscrow STAKE | Yes, using server `contractAddress` / `playerIndex` / `requiredGram` | Watch + session complete | `buildTonConnectPaymentTransaction` + `PAYMENT_CONFIRM_INTENT` |
| Payment completion state | Display | `PAYMENT_SESSION_COMPLETED` | Page4 `COMPLETED` copy; `nextEnabled={false}` |
| Game start authorization | No | GSA | Client stores flags; does not start game |
| Page5 navigation | No (must not) | `OPEN_PAGE5` | `OpenPage5Navigator`; Page4 `onNext={() => {}}` |

---

# 5. PAYMENT STATE MAPPING

**SOURCE VERIFIED** client names.

Wallet (`WALLET_CONNECTION_STATUS`): `WAITING` | `CONNECTING` | `CONNECTED` | `ADDRESS_MISMATCH`.

Payment session (`PAYMENT_PARTICIPANT_STATUS`): `WAITING` | `PAYMENT_REQUESTED` | `AWAITING_PLAYER_CONFIRMATION` | `PAYMENT_SUBMITTED` | `BLOCKCHAIN_PENDING` | `PAYMENT_CONFIRMED` | `PAYMENT_FAILED`.

Session status used for confirm: `ACTIVE` \| `WAITING_FOR_PAYMENTS` \| `PARTIALLY_PAID` \| `RECOVERED`. Terminal UI: `COMPLETED` \| `FAILED`. Game contract: `DEPLOY_FAILED` and deployed family via `isGameContractDeployed`.

Deposit projection (stored, unused in UI): `phase` (= `DepositSession.state`), `mySeatStatus` `PENDING` \| `FUNDED`, `isCreator`, `confirmedSeats`.

Local UI flags: `connecting`, `confirmingPayment`, `depositSubmitting`, `localError`, `depositSubmitError`.

| OLD / current client state | CURRENT server event/state | REQUIRED new client state |
|---|---|---|
| `!inPaymentPhase` → Connect wallet | `WALLET_CONNECTION_SESSION_UPDATED` | Keep |
| `inPaymentPhase` = `PAYMENT_CONNECTION_READY` \|\| session exists | Wallets done; **Deposit not done** | **Mismatch.** Do not treat connection-ready as GameEscrow pay phase |
| Confirm button = GameEscrow STAKE | Valid only after `GAME_CONTRACT_DEPLOYED` + `PAYMENT_REQUEST` | Keep that button for **stage 2** |
| Unwired Deposit handler | `DEPOSIT_PACKAGE_PUBLISHED` + activation + FundSeat | **Deposit stage** using `isCreator` from projection |
| No activation UI | EventBus `DEPOSIT_ACTIVATION_VERIFIED` | Need Page4-facing signal (existing event name) |
| `paymentSession.COMPLETED` | `PAYMENT_SESSION_COMPLETED` | Keep “waiting for start”; do not navigate |
| `nextEnabled={false}` | `OPEN_PAGE5` | Keep; navigator owns Page5 |
| Legacy `AuthoritativeSession.payment` STARTED/COMPLETED | Settlement / old PAYMENT_* | **Do not use for Page4 entry** (`authoritativePaymentView.js` unused by Page4Payment) |
| `entryPayment` helpers | `ENTRY_PAYMENT_*` | Unused by Page4Payment JSX; do not revive as Page5 trigger |

# 6. WEBSOCKET / EVENT CONTRACT

**Outgoing (Page4 / wallet path) — SOURCE VERIFIED**

| Event | Still valid? |
|---|---|
| `WALLET_CONNECT_STARTED` | Yes |
| `WALLET_CONNECT_REPORT` | Yes |
| `WALLET_DISCONNECT_REPORT` | Yes |
| `TONCONNECT_AUTOPSY_SNAPSHOT` | Diagnostics only |
| `PAYMENT_CONFIRM_INTENT` | Yes, **after GameEscrow STAKE sendTransaction** |
| `PAYMENT_CANCEL_INTENT` | In protocol; Page4Payment does not emit it (**NOT FOUND** in Page4) |
| `DEBUG_START_GAME` | Dev jump in `App.jsx` only; not Page4 |

**Incoming — still valid for Page4**

`PAYMENT_STAGE_READY`, `WALLET_CONNECTION_SESSION_UPDATED`, `PAYMENT_CONNECTION_READY`, `PAYMENT_SESSION_*`, `PAYMENT_REQUEST`, `GAME_CONTRACT_*`, `DEPOSIT_PACKAGE_PUBLISHED`, `GAME_START_AUTHORIZED`, `GAME_INITIALIZING`, `ENTRY_PAYMENT_COMPLETED`, `OPEN_PAGE5`, `WALLET_REJECTED` (Page3), reconnect `DEPOSIT_PACKAGE_PUBLISHED`.

**Obsolete / incorrectly interpreted**

- Using `PAYMENT_CONNECTION_READY` as “show GameEscrow pay UI” — **incorrectly interpreted**.
- `index === 0` → `"player.yourNickname"` in wallet/payment rows — treats seat 0 as “you”, not `localPlayerId` (**incorrectly interpreted**).
- `PAYMENT_STARTED` / `PAYMENT_COMPLETED` / settlement `payment` view — not the R18-S15 entry path.
- `GAME_START_BOOTSTRAP_READY` / `GAME_CONTRACT_PAYMENTS_COMPLETE` / `DEPOSIT_ACTIVATION_*` / `DEPOSIT_FULL` / `DEPLOY_AUTHORIZATION_VALID` — **not in** `lobbyProtocol.js`. Server-owned. Page4 must not invent them. Activation is the exception: FundSeat gating needs the **existing** EventBus name on the socket if the client must wait.

**Payload identities**

- Deposit: `deposit.{depositId,depositAddress,network,package,mySeatIndex,isCreator,mySeatStatus,myExpectedAmountNanotons,confirmedSeats,phase}` — requester-scoped; client reducer stores verbatim.
- Payment: `paymentSessionId`, `roomId`, `gameId`, `participants[].playerId|playerIndex|requiredGram|contractAddress|status`.
- `OPEN_PAGE5`: `{ roomId }`.
- Creator is **not** a client-supplied seat number; `isCreator` is `creatorId === playerId` from `_roomCreators`.

# 7. CREATOR / PLAYER IDENTITY HANDLING

**SOURCE VERIFIED**

- Local player: `resolveLocalPlayerId(identity.playerId, authoritative.players, { verifyCompleted })`. Prefers stored `identity.playerId` matching roster. After verify, does not guess from color if identity missing.
- Deposit creator: server `projectDepositForPlayer` — `readCreatorId(_roomCreators)` vs `playerId`; `mySeatIndex` = binding index. Conflict `isCreator === true && seatIndex !== 0` or inverse → `isCreator: null`, `mySeatIndex: null` (fail closed).
- Page4 Deposit handler **does** require `isCreator === true|false` from projection; it does **not** invent seat 0.
- Page4 **does not** show different visible controls for creator vs others today (unwired). Wallet/payment rows label index 0 as “your nickname” regardless of local player.
- GameEscrow STAKE uses `localPaymentRequest.playerIndex` from **server** participant record (`R7.70C10` in reducer). Compatible if that field is present.
- **Do not change** the server creator ≡ first admitted / seat 0 consistency rule.

# 8. RECONNECT / RECOVERY

**SOURCE VERIFIED**

- Pre-game identity: `sessionStorage` `wheelwin.setupRecoveryIdentity` (`roomId`, `playerId`, `recoveryCredential`).
- Page index: `wheelwin.setupRecoveryPage` via `RecoveryExperienceContext` (`writeStoredRecoveryPage` / `readStoredRecoveryPage`).
- Lobby reclaim re-delivers requester-scoped `DEPOSIT_PACKAGE_PUBLISHED` (`RoomLobbyBridge` ~2334–2363).
- `SESSION_SNAPSHOT` reducer **does not** restore `deposit` (gameplay snapshot). Page4 is pre-game; snapshot is not the Deposit restore path.

**Concrete mismatch**

| Layer | Restored today | Lost / stale |
|---|---|---|
| PaymentSession | Lobby reclaim events | OK if server re-sends session |
| GameContract | `GAME_CONTRACT_*` on reclaim | OK |
| GameStart / OPEN_PAGE5 | Reclaim can re-deliver `OPEN_PAGE5` | If already on Page5, navigator handles |
| Deposit projection | Re-published on reclaim | Between first publish and reclaim, **no live updates**: package is emitted **once** at freeze (`DepositOrchestrator._emitPackagePublished`). `phase` / `mySeatStatus` / `confirmedSeats` stay frozen until reconnect |
| Activation VERIFIED | Not on socket | Non-creator cannot know FundSeat is allowed after refresh unless projection is extended or VERIFIED is delivered |
| TonConnect | SDK session may survive tab; server seat may be WAITING | Existing ADDRESS_MISMATCH / reconnect wallet path |

# 9. PAGE4 → PAGE5 TRANSITION

**SOURCE VERIFIED**

| Item | Current |
|---|---|
| Trigger | Server socket `OPEN_PAGE5` |
| Client event | `INCOMING_SOCKET_EVENTS.OPEN_PAGE5` |
| Function | `EngineBridge` → `modules.pageNavigation.onOpenPage5` |
| Navigation | `OpenPage5Navigator` → `onNavigate(APP_PAGES.GAMEPLAY)` (`7`) |
| Page4 | `nextEnabled={false}`, `onNext={() => {}}`. Comment: “never local navigation”. |

Not: local timer, client paid-count, `ENTRY_PAYMENT_COMPLETED` (stored only), `PAYMENT_SESSION_COMPLETED` (copy only), `DEBUG_START_GAME` (dev `App.jsx` jump).

This matches the verified production trigger. **DO NOT CHANGE** this path.

---

## 6. Risks

- **Critical:** Deposit UI unwired; `inPaymentPhase` hides Connect and shows GameEscrow confirm as soon as wallets are ready, before Deposit/GameEscrow. Players cannot perform the verified Deposit → Escrow sequence from Page4.
- **Critical:** No Page4-facing `DEPOSIT_ACTIVATION_VERIFIED`. Non-creator FundSeat before VERIFIED is rejected by the existing activation gate.
- **High:** Deposit projection not refreshed after funding/activation unless reconnect.
- **High:** Seat-0 labeled “you” in rows.
- **High:** `handleConfirmInTelegramWallet` TDZ / hook-variable use before declaration — Page4 may be unmountable as written.
- **Medium:** `PAYMENT_CANCEL_INTENT` unused; wallet/payment errors mix local strings with i18n.
- **Low:** Unused legacy entry-payment / settlement payment view modules still in tree; do not wire them as Page5 triggers.

---

## 7. Recommendations

Analysis only. Implementation belongs to the next prompt (section 13 of the user outline).

# 10. OBSOLETE PAGE4 ASSUMPTIONS

| File | Function/component | Current assumption | Why incompatible with R18-S15 | Required replacement concept |
|---|---|---|---|---|
| `Page4Payment.jsx` | `inPaymentPhase` | Wallet-ready / session exists = GameEscrow pay UI | Deposit + activation + Escrow deploy happen **after** `PAYMENT_CONNECTION_READY` | Split UI: wallet → deposit → escrow stake → wait OPEN_PAGE5 |
| `Page4Payment.jsx` | Render | One confirm control (`handleConfirmPayment`) | Two financial layers | Deposit confirm (existing unwired handler) then Escrow confirm |
| `Page4Payment.jsx` | `handleConfirmPayment` as only pay action | Single contract payment completes entry | Deposit is separate; Escrow STAKE is later | Keep STAKE only after `GAME_CONTRACT_DEPLOYED` + `AWAITING_PLAYER_CONFIRMATION` |
| `authoritativeWalletConnectionView.js` / `authoritativePaymentSessionView.js` | `labelTitle: index === 0` | First row is “you” | Creator/seat 0 ≠ always local player | Label by `localPlayerId` |
| `authoritativePaymentView.js` | `isAuthoritativePaymentComplete` | Settlement `payment.COMPLETED` enables Next | Page4 Next must stay off; Page5 is `OPEN_PAGE5` | Do not re-enable Next from this helper |
| `PlayerPaymentRow.jsx` | `paid` / `confirmed` / `PAYMENT_CONFIRMED` mix | One payment row vocabulary | Deposit FUNDED ≠ Escrow CONFIRMED | Two status columns or staged labels (minimal) |
| `buildTonConnectPaymentTransaction.js` | Legacy comment path | Optional text comment | GameEscrow default is STAKE opcode | Keep fail-closed `playerIndex` required (already) |

# 11. MISSING PAGE4 CAPABILITIES

| File/component | Missing behavior | Server event/state | User-visible effect | Dependencies |
|---|---|---|---|---|
| `Page4Payment.jsx` JSX | Wire Deposit confirm | `DEPOSIT_PACKAGE_PUBLISHED` | Creator deploys; others FundSeat | Fix hook order; `buildDepositDeploymentTransaction` / `buildFundDepositTransaction`; `isCreator` |
| `Page4Payment.jsx` | Gate FundSeat until activation | EventBus `DEPOSIT_ACTIVATION_VERIFIED` **not on lobby socket** | Avoid rejected FundSeat | PHASE C: deliver existing event name to sockets, **or** extend projection and re-publish |
| `Page4Payment.jsx` | Show deposit phase / seat funded | Projection `phase`, `mySeatStatus`, `confirmedSeats` | “Waiting for deposit” vs “pay game contract” | Live updates (re-publish or extra events) |
| `Page4Payment.jsx` | Keep wallet UI until deposit work is done | Do not use `PAYMENT_CONNECTION_READY` as escrow-phase switch | Connect remains until appropriate | `inPaymentPhase` split |
| Session model | Refresh deposit after fund/verify | Today only initial publish + reclaim | Stale FUNDED count | Server re-deliver `DEPOSIT_PACKAGE_PUBLISHED` **or** client accepts reconnect-only (weaker) |
| Rows | Local vs peer labels | `localPlayerId` | Correct “you” | View helpers |
| Errors | Deposit vs Escrow vs activation reject | `GAME_CONTRACT_DEPLOY_FAILED`, session `FAILED`, activation reject (not socketed) | Actionable copy | Existing `localError` pattern |

# 12. DO NOT CHANGE

**SOURCE VERIFIED** already compatible:

- `OpenPage5Navigator` + `EngineBridge` `OPEN_PAGE5` → Page5 (`APP_PAGES.GAMEPLAY`).
- Page4 `nextEnabled={false}` / empty `onNext`.
- Not emitting lifecycle events (`PAYMENT_SESSION_COMPLETED`, `OPEN_PAGE5`, etc.).
- Not calling server Page5 open APIs.
- TonConnect as wallet transport.
- `WALLET_CONNECT_*` / `WALLET_DISCONNECT_REPORT`.
- `buildTonConnectPaymentTransaction` GameEscrow STAKE + required `playerIndex`.
- `buildFundDepositTransaction` / `buildDepositDeploymentTransaction` (builders already match server opcodes/package).
- Authoritative session **store-verbatim** of deposit projection (no client-derived funding).
- `canConfirmLocalPayment` + `isGameContractDeployed` for **Escrow** confirm.
- `PAYMENT_CONFIRM_INTENT` only after successful Escrow `sendTransaction`.
- Server `projectDepositForPlayer` creator/seat fail-closed rule (client must consume, not redefine).
- Page3 → Page4 on `PAYMENT_STAGE_READY`.
- Dev `DEBUG_START_GAME` remaining server-side (do not client-navigate to Page5).

Avoid rewriting TonConnect autopsy, layout chrome, i18n keys that still apply, and Page5.

# 13. REQUIRED IMPLEMENTATION PLAN

**PHASE A — required client changes**

1. Move `useLanguage` / `useTonConnectUI` / `useTonWallet` above `handleConfirmInTelegramWallet` (or move the callback below) so Page4 can mount.
2. Split Page4 into staged presentation **without visual redesign**:
   - Stage W: wallet connect (current `!inPaymentPhase` UI).
   - Stage D: Deposit — show/wire `handleConfirmInTelegramWallet`; creator vs non-creator from **projection only**.
   - Stage E: GameEscrow STAKE — current `handleConfirmPayment` when `canConfirm`.
   - Stage W5: wait (`COMPLETED` copy) until `OPEN_PAGE5`.
3. Do **not** set `inPaymentPhase` solely from `PAYMENT_CONNECTION_READY`. Escrow UI only when GameEscrow is deployed / payment request confirmable.
4. Bind Deposit errors into the existing error surface (`depositSubmitError`).
5. Label rows with `localPlayerId`, not `index === 0`.
6. Do not navigate on deposit success, FundSeat success, or `PAYMENT_SESSION_COMPLETED`.

**PHASE B — optional client**

- Deposit progress copy from `phase` / `confirmedSeats` / `mySeatStatus`.
- `PAYMENT_CANCEL_INTENT` if wallet dismisses Escrow send.
- Hide package/debug fields; do not show BOCs to users.

**PHASE C — server, only if required**

Page4 cannot observe `DEPOSIT_ACTIVATION_VERIFIED` today (`lobbyProtocol.js` has no such event). Non-creator FundSeat must wait for that gate.

Smallest compatible change: **deliver the existing EventBus name** `DEPOSIT_ACTIVATION_VERIFIED` to room sockets (payload already has `depositId` / `roomId` / `gameId`), **or** re-emit `DEPOSIT_PACKAGE_PUBLISHED` with an added `activationStatus` after VERIFIED so the client does not invent events.

Do not add a second EventBus. Do not weaken `assertInitialMutableState`. Do not change Page5 or FunC.

Live deposit `phase`/`FUNDED` updates also do not reach the client until reclaim unless `DEPOSIT_PACKAGE_PUBLISHED` is re-delivered. Optional smallest: re-project on FundSeat observation.

**PHASE D — tests**

- Extend `authoritativeSessionModel.test.js` if projection fields added.
- Page4 unit/component tests **do not exist**; add focused tests for stage gating and “no local OPEN_PAGE5”.
- Keep `buildFundDepositTransaction.test.js`, `buildDepositDeploymentTransaction.test.js`, `buildTonConnectPaymentTransaction.test.js`.
- Update `socketSyncLayer.test.js` if new incoming event is forwarded.
- `authoritativePaymentSessionView` row label tests if labels change.
- Do not “fix” `roomLobby.integration.test.js` Telegram CREATE_ROOM in this Page4 phase unless it blocks client tests.

**PHASE E — real TESTNET validation**

Drive **production `app.js`** with three Telegram sockets (same as R18-S15): wallet connect on real Page4 → creator deploy → wait VERIFIED → FundSeat × 3 → Escrow STAKE × 3 → **real** `OPEN_PAGE5`. No synthetic completion events. `TON_NETWORK=testnet` only.

# 14. EXISTING TEST COVERAGE

| Path | Covers | Next phase |
|---|---|---|
| `client/src/game/session/authoritativeSessionModel.test.js` | Deposit mirror, payment session, GAME_START flags, ENTRY_PAYMENT | Extend if schema/events added |
| `client/src/socket/socketSyncLayer.test.js` | `DEPOSIT_PACKAGE_PUBLISHED`, OPEN_PAGE5 routing | Extend if new socket |
| `client/src/payment/buildFundDepositTransaction.test.js` | FundSeat BOC | Keep |
| `client/src/payment/buildDepositDeploymentTransaction.test.js` | Creator deploy tx | Keep |
| `client/src/payment/buildTonConnectPaymentTransaction.test.js` | Escrow STAKE | Keep |
| `client/src/game/session/authoritativePaymentView.test.js` | Legacy settlement payment view | Do not use for Page4 entry |
| `client/src/game/session/authoritativeEntryPaymentView.test.js` | Legacy entry payment view | Unused by Page4Payment |
| `client/src/game/session/gameplayTerminalNavigation.test.js` | OPEN_PAGE5 arm / page 6 expiry | Keep |
| `client/src/game/sessionRecovery/recoveryFlow.test.js` | Page 6 is pre-game | Keep |
| `client/src/game/session/gameSessionSetupExpiry.test.js` | Page 6 expiry | Keep |
| **No** `Page4Payment` component test | — | **Add** in PHASE D |
| `server/tests/r18DepositProjection.test.js` | Projection + S3 bridge | Only if PHASE C projection |
| `server/tests/r18S4DepositReconnect.test.js` | Reclaim package | Keep |

# 15. REAL TESTNET VALIDATION PLAN

Must use: production `app.js`, `PaymentSessionManager`, DepositContract, GameEscrow, `GameStartAuthorization`, `RoomLobbyBridge`.

Page4 actions to prove on TESTNET:

1. Three clients open Page4 after `PAYMENT_STAGE_READY`.
2. Wallet connect reports accepted.
3. Creator TonConnect Deposit deploy using published package (address match).
4. Non-creators FundSeat only after activation allowed.
5. After GameEscrow `PAYMENT_REQUEST`, each seat STAKE via Page4 (not the Node runner builders).
6. No client-side Page5 jump; wait for `OPEN_PAGE5` with matching `roomId`.

Do not: mock chain, emit `PAYMENT_SESSION_COMPLETED` / `OPEN_PAGE5` from the client, or bypass activation.

# 16. OPEN QUESTIONS / BLOCKERS

1. **Missing lobby event for activation VERIFIED** — SOURCE VERIFIED absent from `lobbyProtocol.js`. Blocker for safe non-creator FundSeat UX. Prefer forwarding existing `DEPOSIT_ACTIVATION_VERIFIED` rather than a new name. **REQUIRES IMPLEMENTATION** (PHASE C unless product accepts fail-and-retry against the server gate — not recommended).
2. **Deposit projection freshness** — SOURCE VERIFIED single `_emitPackagePublished`. Blocker for live `FUNDED` UI without reconnect. **REQUIRES IMPLEMENTATION** if Stage D must show peer deposit progress live.
3. **Page4 mount TDZ** — SOURCE VERIFIED in source order. **REQUIRES IMPLEMENTATION** before any UI wiring. Runtime crash **NOT VERIFIED** in this session (no browser run).
4. Whether `PAYMENT_CONNECTION_READY` should remain visible as “wallets ready, preparing deposit” — **INFERRED** as useful copy; not a server change.
5. Server R18-S15 `OPEN_PAGE5` is the comparison contract; this analysis does not claim a new TESTNET Page4 run.

---

## 8. Changes Made

No production, Page4, Page5, server, or test files modified.

This report file was created at `AI_CONTEXT/CLINE_REPORTS/2026-08-29_r18_s16_page4_adaptation_analysis.md`.
