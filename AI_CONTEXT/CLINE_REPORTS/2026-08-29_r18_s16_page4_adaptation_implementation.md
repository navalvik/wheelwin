# R18-S16 — Page4 Adaptation Implementation

Date: 2026-08-29

Task: Adapt the existing Web Page4 (`Page4Payment.jsx`) to the verified R18-S15 server payment lifecycle through `OPEN_PAGE5`. Smallest safe client/lobby-contract change. Do not redesign Page4 visuals, Page5, or server financial verification.

Classification: **IMPLEMENTATION**.

## 1. Scope

Bring the live Page4 payment UI onto the already verified R18-S15 contract:

```text
Wallet → DepositContract → DEPOSIT_ACTIVATION_VERIFIED → FundSeat
  → DEPOSIT_FULL → GameEscrow STAKE → server payment completion → OPEN_PAGE5
```

Out of scope: Page5, FunC, BlockchainMonitor, GameStartAuthorization internals, RoomLobbyBridge financial logic except the narrow lobby projection of already-authoritative activation state.

## 2. Files Inspected

- `client/src/pages/Page4Payment.jsx`
- `client/src/game/session/page4PaymentPhase.js`
- `client/src/game/session/authoritativeSessionModel.js`
- `client/src/socket/socketEvents.js`, `SocketSyncLayer.js`, `EngineBridge.js`
- `server/deposit/projectDepositForPlayer.js`
- `server/socket/lobbyProtocol.js`, `RoomLobbyBridge.js`
- `server/deposit/DepositActivationVerificationCoordinator.js` (read-only; semantics unchanged)
- `AI_CONTEXT/CLINE_REPORTS/2026-08-29_r18_s16_page4_adaptation_analysis.md`

## 1. STARTING GIT STATE

**SOURCE VERIFIED**

```text
HEAD  7453a9e715204c6ca61a021c85c0a8f3e55b50af
      docs: record R18-S15 READY-to-Page5 continuation commit SHA
38169b9 R18-S15 wait for production OPEN_PAGE5 after GameEscrow READY
adcc087 docs: record R18-S15 Deposit activation ordering and OPEN_PAGE5
1d41480 R18-S15 wait for Deposit activation VERIFIED before E2E FundSeat
c1ec4a2 R18-S15 prune stale recovered Deposit watches to stop TonCenter 429
```

No reset, rebase, amend, or force-push was used.

## 2. FILES CHANGED

**IMPLEMENTED**

**Client**

- `client/src/pages/Page4Payment.jsx`
- `client/src/game/session/page4PaymentPhase.js` (new)
- `client/src/game/session/page4PaymentPhase.test.js` (new)
- `client/src/game/session/depositSessionStatus.js` (new)
- `client/src/game/session/authoritativeSessionModel.js`
- `client/src/game/session/authoritativeSessionModel.test.js`
- `client/src/game/session/index.js`
- `client/src/socket/socketEvents.js`
- `client/src/socket/SocketSyncLayer.js`
- `client/src/socket/socketSyncLayer.test.js`
- `client/src/socket/EngineBridge.js`
- `client/src/context/AuthoritativeSessionContext.jsx`
- `client/src/i18n/translations.js`
- `client/src/i18n/language.i18n.test.js`

**Server (narrow Page4-facing contract only)**

- `server/deposit/projectDepositForPlayer.js` — add `activationStatus` from existing `metadata.activationVerification.status`
- `server/socket/lobbyProtocol.js` — `DEPOSIT_ACTIVATION_VERIFIED`
- `server/socket/RoomLobbyBridge.js` — deliver existing EventBus activation + re-project on verified / seat funded / full; reclaim restores VERIFIED
- `server/tests/r18DepositProjection.test.js`

**Report**

- `AI_CONTEXT/CLINE_REPORTS/2026-08-29_r18_s16_page4_adaptation_implementation.md`

## 3. TDZ / HOOK-ORDER FIX

**IMPLEMENTED** · **TEST VERIFIED** (source-order test)

`handleConfirmInTelegramWallet` previously referenced `t`, `tonConnectUI`, and `tonWallet` before those hooks ran (`ReferenceError` / TDZ on mount).

Hooks now run in this order before the Deposit handler:

1. `useAuthoritativeSession`
2. `useLanguage`
3. `usePlayerIdentity`
4. `useTonConnectUI`
5. `useTonWallet`
6. Deposit `useState`
7. `useCallback(handleConfirmInTelegramWallet)`

No conditional hooks. No new state-management system.

Test: `R18-S16: Page4 declares language/TonConnect hooks before Deposit handler` — **passed**.

## 4. PAGE4 PAYMENT STATE MACHINE

**IMPLEMENTED** · **TEST VERIFIED**

Pure helper `resolvePage4PaymentPhase` in `client/src/game/session/page4PaymentPhase.js`:

```text
WALLET
  → DEPOSIT_DEPLOY | DEPOSIT_ACTIVATION
  → FUND_SEAT | DEPOSIT_WAIT_FULL
  → DEPOSIT_FULL
  → GAMEESCROW_STAKE
  → WAITING_PAGE5
```

`PAYMENT_CONNECTION_READY` selects `DEPOSIT_ACTIVATION`, not `GAMEESCROW_STAKE`.

Page4 no longer uses `inPaymentPhase = paymentConnectionReady || hasPaymentSession` to expose GameEscrow STAKE.

## 5. DEPOSITCONTRACT INTEGRATION

**IMPLEMENTED** · **TEST VERIFIED** (unit) · **REAL TESTNET VERIFIED** — no

Reuse only:

- `buildDepositDeploymentTransaction`
- `buildFundDepositTransaction`
- server projection `isCreator`, `mySeatIndex`, `myExpectedAmountNanotons`

Creator deploy is gated by `canDeployDeposit` (`isCreator === true` + package + address + not yet activation-verified). After `DEPOSIT_ACTIVATION_VERIFIED`, the creator FundSeats; they do not re-deploy.

No local `seatIndex === 0` authority.

## 6. DEPOSIT_ACTIVATION_VERIFIED GATE

**IMPLEMENTED** · **TEST VERIFIED** (unit + lobby delivery)

`canFundSeat` requires `activationStatus` in `{VERIFIED, ALREADY_VERIFIED}` or `lifecycle.depositActivationVerified`.

FundSeat is not enabled before that gate.

## 7. FUNDSEAT INTEGRATION

**IMPLEMENTED** · **TEST VERIFIED** (unit)

FundSeat uses projection `mySeatIndex` and `myExpectedAmountNanotons`. `mySeatIndex == null` is rejected (`Number(null) === 0` is not treated as seat 0).

UI shows server `confirmedSeats` and `mySeatStatus` (PENDING / FUNDED). Wallet submit does not set FUNDED locally.

## 8. GAMEESCROW STAKE GATING

**IMPLEMENTED** · **TEST VERIFIED** (unit)

STAKE uses existing `handleConfirmPayment` / `buildTonConnectPaymentTransaction` / `PAYMENT_CONFIRM_INTENT`.

The STAKE button is shown only in `GAMEESCROW_STAKE`, which requires `isGameContractDeployed`. Wallet connection is not enough.

## 9. PAYMENT COMPLETION HANDLING

**IMPLEMENTED** · **TEST VERIFIED** (unit)

`paymentSession.status === "COMPLETED"` → `WAITING_PAGE5`. Page4 does not declare Deposit FULL, GameEscrow READY, or payment-session complete from a local counter or `hasPaid`.

## 10. OPEN_PAGE5 HANDLING

**SOURCE VERIFIED** · **IMPLEMENTED** (unchanged path) · **TEST VERIFIED** (source: `nextEnabled={false}`, no `onNavigate(7)`, no Page5 `setTimeout`)

Existing path is unchanged:

```text
OPEN_PAGE5 → EngineBridge → OpenPage5Navigator → APP_PAGES.GAMEPLAY
```

Page4 does not navigate locally.

## 11. SERVER-FACING EVENT/CONTRACT CHANGE

**IMPLEMENTED** · **TEST VERIFIED**

Minimal contract only. Financial verification was not changed. `DepositActivationVerificationCoordinator` semantics were not changed.

1. `projectDepositForPlayer` adds `activationStatus` from existing `session.metadata.activationVerification.status`.
2. `LOBBY_SERVER_EVENTS.DEPOSIT_ACTIVATION_VERIFIED` — same EventBus name already emitted by the coordinator.
3. `RoomLobbyBridge` subscribes to `EVENT_TYPES.DEPOSIT_ACTIVATION_VERIFIED` and `_deliverToRoom`s it, then re-projects the package.
4. Reclaim: if projection `activationStatus` is `VERIFIED` / `ALREADY_VERIFIED`, the socket also receives `DEPOSIT_ACTIVATION_VERIFIED`.
5. Outbound re-projection on `DEPOSIT_SEAT_FUNDED` and `DEPOSIT_FULL_ONCHAIN` so `confirmedSeats` / `mySeatStatus` stay live. No new financial authority.

## 12. TESTS RUN

**TEST VERIFIED** (commands below were executed)

### Client focused

Command: `node --import ./scripts/register.js src/game/session/page4PaymentPhase.test.js`

```text
passed  9
failed  0
skipped 0
```

Command: `node --import ./scripts/register.js src/i18n/language.i18n.test.js`

```text
passed  5
failed  0
skipped 0
```

Command: `node --import ./scripts/register.js src/game/session/authoritativeSessionModel.test.js`

```text
passed  all assertions in file (includes DEPOSIT_ACTIVATION_VERIFIED mirror)
failed  0
skipped 0
```

Command: `node --import ./scripts/register.js src/socket/socketSyncLayer.test.js`

```text
passed  all assertions in file (includes DEPOSIT_ACTIVATION_VERIFIED routing)
failed  0
skipped 0
```

### Server focused

Command: `node tests/r18DepositProjection.test.js`

```text
passed  23
failed  0
skipped 0
```

Includes S16.1 / S16.2 / S16.3 (activationStatus projection, lobby VERIFIED delivery, REJECTED not delivered).

### Full client suite

Command: `cd client && npm test`

**Stopped at first failure** (pre-existing, files not in this change set):

```text
src/game/playerUI/playerUI.productionIdentity.test.js
Error: PLAYER_UPDATE locates by authoritative playerId
```

That file was not modified. **NOT VERIFIED** as caused by R18-S16. Full client suite was **not** completed after this failure (`scripts/run-tests.js` exits on first failure).

## 13. BUILD / LINT / TYPECHECK RESULTS

**Build — TEST VERIFIED (command executed, exit 0)**

```text
cd client && npm run build
vite v8.1.0  ✓ built in 15.18s
```

**Lint**

```text
cd client && npm run lint
exit 1
```

Full-tree ESLint already fails on many files not in this change set (refs-during-render, setState-in-effect, react-refresh). **NOT VERIFIED** as clean.

Focused: `npx eslint src/game/session/page4PaymentPhase.js` — **exit 0**.

`Page4Payment.jsx` still reports pre-existing TonConnect autopsy / setState-in-effect / immutability errors. The new useCallback dependency error was fixed (`authoritative.lifecycle`). Remaining Page4 lint issues were not introduced as a redesign.

**Typecheck**

Client `package.json` has no `typecheck` script (JS + Vite). **NOT VERIFIED** / not applicable.

## 14. REAL TESTNET VALIDATION

**BLOCKED**

First concrete blocker: this session cannot complete a live Telegram Mini App + three TESTNET TonConnect wallets against production `app.js` (`TON_NETWORK=testnet`) for Deposit deploy, activation wait, FundSeat × 3, GameEscrow STAKE × 3, and `OPEN_PAGE5`.

Stop conditions honored:

- Do not fake wallet transactions.
- Do not manually emit server events.
- Do not reuse rooms `PNyS`, `wMCC`, `GLSi`, `pyzv`.
- Do not use MAINNET.

The R18-S15 **server** path to `OPEN_PAGE5` remains previously evidenced (room `GLSi`). That is not evidence that the adapted Page4 UI completed the same path in a browser.

## 15. DEBUG/LOG EVIDENCE

**NOT VERIFIED** (no live Page4 TESTNET run in this task)

No new permanent diagnostic logging was added. Existing `/debug` and repository logs were not required because TESTNET UI validation did not start.

## 16. GIT COMMIT SHA

Recorded after commit in this task (see git section below / final status).

## 17. FINAL STATUS

**IMPLEMENTED** for Page4 lifecycle gating, TDZ fix, Deposit/FundSeat builders, activation lobby contract, and focused tests.

**TEST VERIFIED** for the focused Page4/client/server tests listed above and for `npm run build`.

**REAL TESTNET VERIFIED** — no. **BLOCKED** on Mini App / wallet environment.

**Do not treat PAYMENT_CONNECTION_READY as GameEscrow STAKE ready.** That old Page4 assumption is removed.

---

## Architecture Findings

Page4 is now a coordinator of server-authoritative phases. Blockchain authority stays on the server. Deposit activation is the same EventBus event as before; it is now visible on the lobby socket and in the Deposit projection.

## Lifecycle Flow

```text
WALLET
  → PAYMENT_CONNECTION_READY  (Deposit phase, not STAKE)
  → DEPOSIT_PACKAGE_PUBLISHED
  → creator DepositContract deploy (isCreator)
  → DEPOSIT_ACTIVATION_VERIFIED  (lobby + projection)
  → FundSeat (mySeatIndex / myExpectedAmountNanotons)
  → DEPOSIT_FULL (server phase / confirmedSeats)
  → GameEscrow deployed → STAKE
  → PAYMENT_SESSION_COMPLETED → WAITING_PAGE5
  → OPEN_PAGE5 (existing navigator)
```

## Ownership Boundaries

| Concern | Owner |
|---|---|
| Activation proof | `DepositActivationVerificationCoordinator` (unchanged) |
| Projection `activationStatus` | `projectDepositForPlayer` |
| Lobby delivery | `RoomLobbyBridge` |
| Phase UI / wallet tx | `Page4Payment.jsx` + `page4PaymentPhase.js` |
| Page5 navigation | `OpenPage5Navigator` (unchanged) |

## Risks

- **High (operational):** Page4 TESTNET path not exercised in a browser in this task.
- **Medium:** Full `npm test` / `npm run lint` still fail on pre-existing files.
- **Low:** Re-projection on `DEPOSIT_SEAT_FUNDED` / `DEPOSIT_FULL_ONCHAIN` increases lobby traffic; outbound only.

## Recommendations

Run a fresh TESTNET Mini App room (not GLSi/pyzv) through adapted Page4: wallet → deposit deploy → wait VERIFIED → FundSeat × 3 → STAKE × 3 → `OPEN_PAGE5`.

## Changes Made

See FILES CHANGED. No Page5, FunC, or financial-verification edits.
