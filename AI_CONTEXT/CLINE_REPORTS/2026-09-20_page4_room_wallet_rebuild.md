# Page4 Room-Wallet Rebuild (Testnet)

Date: 2026-09-20

Task: Rebuild Page4 payment functionality on the existing server-authoritative
Room Wallet Testnet payment system, preserving the outer Page4 layout
(WheelWin banner + bottom ROOM ID / PLAYERS / room-lifetime panel). Single
report; no unrelated files touched.

## 1. Files Changed

| File | Change |
|---|---|
| `client/src/pages/Page4Payment.jsx` | Full rewrite (3818 → 1243 lines). Rebuilt middle content as a clean Testnet Room-Wallet payment component. |
| `AI_CONTEXT/CLINE_REPORTS/2026-09-20_page4_room_wallet_rebuild.md` | This report. |

No other project file was modified. The pre-existing dirty working tree
(`server/socket/RoomLobbyBridge.js`, four server test files, `LOCAL_SYNC_REPORT.txt`,
`server/tests/roomCreationWebOrigin.test.js`, the previous interface-map report) was
touched by earlier work and left exactly as found.

## 2. Removed / Isolated from Legacy Page4

All of the following were present in the old `Page4Payment.jsx` and are now GONE from
the active component (files themselves were NOT deleted — isolation by non-import):

- **GameEscrow payment paths**: GameEscrow STAKE transaction construction, `gameContract`
  deploy-status display branch (`payment.deploymentFailed`), GameEscrow-only gating.
- **DepositPackage logic**: `depositProjection` gating branch, deposit package
  args (`stateInit`/`deployValueNanotons`/`depositAddress`/`mySeatIndex`/
  `myExpectedAmountNanotons`), creator-vs-player deposit branches, deposit status texts
  (`payment.waitingCreatorDeposit`, `payment.waitingDepositActivation`, etc.).
- **Diagnostic/autopsy machinery**: the entire TonConnect autopsy subsystem
  (`ensureTonConnectAutopsy`, `pushAutopsyTimeline`, `dumpTonConnectError`,
  `describePage4SendTransactionForensicContext`, `installAutopsyGlobalHandlers`,
  `printAttemptAutopsyReport`, handshake trace refs), the
  `TONCONNECT_AUTOPSY_SNAPSHOT` socket emission, and the autopsy beacon transport
  (`configureAutopsySnapshotTransport` / `resolveBackendUrl`).
- **TEMPORARY diagnostic payment button** (`disabled={false}`, lines 3796-3808 of the
  old file) — removed. Exactly ONE gated payment button remains, which is also the
  only `tonConnectUI.sendTransaction` call in the source.
- **Mainnet remnants**: none present in the new component; no Mainnet switch; the
  network string from the server is display-only.

Kept (unchanged behavior): `PlayerPaymentRow` status rows, wallet
connect/disconnect flow (`WALLET_CONNECT_STARTED` / `WALLET_CONNECT_REPORT` /
`WALLET_DISCONNECT_REPORT`), Gram-Wallet Telegram Mini App handoff for the desktop
universal link, single-payment-intent protocol.

## 3. Existing Server Events / Fields Used

No new protocol was invented. The rebuilt Page4 consumes the existing contract:

Incoming (server → Page4, via AuthoritativeSession store):

| Event / field | Use |
|---|---|
| `PAYMENT_STAGE_READY` | Page3 → Page4 stage transition (unchanged). |
| `WALLET_CONNECTION_SESSION_UPDATED` | Wallet rows + `WAITING/CONNECTING/CONNECTED/ADDRESS_MISMATCH` seat status. |
| `PAYMENT_CONNECTION_READY` | `lifecycle.paymentConnectionReady` gate. |
| `PAYMENT_SESSION_CREATED` / `PAYMENT_SESSION_UPDATED` / `PAYMENT_SESSION_COMPLETED` / `PAYMENT_SESSION_FAILED` | Authoritative payment snapshot: `paymentSessionId`, `roomId`, `network`, `roomWalletAddress`, `status`, `participants[] {playerId, requiredGram, wallet, status, paymentReference}`. |
| `roomClosed` / `SETUP_SESSION_EXPIRED` / `PAYMENT_SESSION_FAILED` | Handled by the existing `GameSessionContext` global listeners (navigate to Welcome; no Page4-local room destruction). |

Outgoing (Page4 → server):

| Event | Use |
|---|---|
| `WALLET_CONNECT_STARTED` / `WALLET_CONNECT_REPORT` | Wallet proof (once per proof, idempotent). |
| `WALLET_DISCONNECT_REPORT` | Disconnect / modal-closed-without-wallet. |
| `PAYMENT_CONFIRM_INTENT` | ONLY after a successful `sendTransaction`, no payload. |

Reused helpers (unchanged modules): `resolvePlayerPaymentDestination`,
`getLocalPaymentRequest`, `canSubmitEntryPayment`, `resolveEntryPaymentComponents`,
`resolvePage4PaymentPhase`, `mapPaymentSessionRows`, `mapWalletConnectionRows`,
`resolveLocalPlayerId`, `buildEntryPaymentTransaction`,
`toTonConnectSendTransactionRequest`, `requiredGramToNanotonString`,
`nanotonsToTonDisplay`, `toSessionWalletAddress`, `tonWalletAccountsEqual`,
`launchGramWalletHandoff`.

## 4. Final Testnet Payment Flow (as implemented)

```
PAY button (shown only when server seat is PAYMENT_REQUESTED /
            AWAITING_PLAYER_CONFIRMATION and roomWalletAddress exists)
   ↓  reads paymentSession.roomWalletAddress      (SERVER)
   ↓  reads participant.requiredGram              (SERVER; formatted via toNano)
   ↓  buildEntryPaymentTransaction → ONE plain TON transfer
   ↓     { validUntil: now+600s, messages: [{ address: roomWallet, amount }] }
   ↓     no payload, no stateInit, no contract destination
TonConnect sendTransaction()
   ↓  success only →
socket.emit("PAYMENT_CONFIRM_INTENT")             (no payload)
   ↓
server: SocketGateway → LOBBY_PAYMENT_CONFIRM_INTENT_REQUEST
        → RoomLobbyBridge._handlePaymentConfirmIntent
        → PaymentSessionManager.submitPlayerConfirmation
        → seat PAYMENT_SUBMITTED → BLOCKCHAIN_PENDING (intent only)
   ↓
server: RoomWalletIncomingObserver / BlockchainMonitor observe the
        Room Wallet on-chain, validate destination + sender + exact amount
   ↓
confirmBlockchainPayment → seat PAYMENT_CONFIRMED
   ↓  all seats confirmed → PAYMENT_SESSION_COMPLETED → OPEN_PAGE5
```

The client never marks a payment confirmed by itself. UI states map 1:1 to server
truth via `resolvePage4PaymentUiState` (new local pure mapper):
`WAITING_FOR_PAYMENT` / `PAYMENT_SUBMITTING` (transient local flag during the await)
/ `PAYMENT_PENDING` (seat PAYMENT_SUBMITTED or BLOCKCHAIN_PENDING) /
`PAYMENT_CONFIRMED` (seat PAYMENT_CONFIRMED or session COMPLETED) /
`PAYMENT_FAILED` / `ROOM_EXPIRED` (session FAILED or PAYMENT_TIMEOUT).

## 5. Reconnect / Reload Behavior

- Payment state is DERIVED from the authoritative store (`authoritative.paymentSession`),
  so a socket reconnect or full reload cannot reset it: on reconnect the server re-delivers
  the existing session snapshot to the socket
  (`RoomLobbyBridge` rehydration → `PAYMENT_SESSION_UPDATED` with
  `paymentSession.toSnapshot()` containing `roomWalletAddress` + per-seat statuses,
  plus `WALLET_CONNECTION_SESSION_UPDATED` / `PAYMENT_CONNECTION_READY`).
- Confirmed seats re-render as `PAYMENT_CONFIRMED`; pending verification renders as
  `PAYMENT_PENDING`. The client never creates a session (only the server does, on
  `PAYMENT_CONNECTION_READY`) and never re-pays on UI reload: a lost local
  `sendTransaction` result leaves the seat in `AWAITING_PLAYER_CONFIRMATION`
  (button available again) — the user action, not the UI, decides a retry.
- Wallet proof re-report after reload is idempotent (same proof → same
  `WALLET_CONNECT_REPORT`; `WALLET_CONNECT_STARTED` once per proof, ref cleared only on
  SDK disconnect / modal-close-without-wallet).
- No second payment session can be created by Page4: no client code path calls any
  session-creation event.

## 6. Room Lifetime Countdown

- The bottom panel is the existing `InfoBar` rendered by `GameLayout`
  (`showInfoBar = currentPage >= PAGE_SETUP_START` → true on Page4). It shows
  ROOM ID (`formatAuthoritativeRoomId`), PLAYERS (`formatAuthoritativeRoomPlayersDisplay`
  → "3 / 3"), and the timer labelled `infobar.setupTimer`
  ("MINUTEUR DE CONFIGURATION" in French) — value from
  `authoritative.setup.expiresAt` (SERVER-authoritative deadline).
- The rebuilt Page4 continues to render through `GameLayout`; banner (`HeaderBar` +
  `AdvertisementSlot`) and the bottom panel are therefore untouched and identical.
- NO second Page4 payment timer was added. The only timers in the component are the
  1-second countdown tick inside the pre-existing `InfoBar` and TonConnect's own
  `validUntil` inside the wallet request. Page4 never extends or replaces the server
  deadline; expiry is owned by the server (`PaymentSessionManager._onExpiry` →
  `failSession("payment_timeout")` → `PAYMENT_SESSION_FAILED` → room close; refunds
  remain 100% server-side in the existing Room Wallet financial system — nothing was
  added or changed in `RoomWalletFinancialPolicy.js`, the observer, the registry, or
  the settlement/recovery code).

## 7. Validation Results

Commands run in `client/`:

| Check | Command | Result |
|---|---|---|
| Page4 contract tests + Gram handoff wiring | `node --test src/game/session/page4PaymentPhase.test.js src/tonconnect/telegramMiniAppGramWalletHandoff.test.js` | **16 pass / 0 fail** — incl. "exactly one TonConnect sendTransaction path", "no participant contractAddress fallback", "production wiring installs handoff". |
| Page4/payment/session cluster (10 files) | `node --test` on page4PaymentPhase, authoritativeSessionModel, page4GameEscrowAuthoritativeState, authoritativeEntryPaymentView, authoritativePaymentView, buildEntryPaymentTransaction, buildTonConnectPaymentTransaction, page4DepositActivationHandoff, page4DepositDeployDiagnostics, telegramMiniAppGramWalletHandoff | **37 tests: 35 pass / 2 fail** — both failures are PRE-EXISTING legacy-Deposit staleness (see §8). |
| Production build | `npm run build` (vite) | **✓ built in 7.14s** — no errors (only chunk-size warnings). |
| Lint | `npx eslint src/pages/Page4Payment.jsx` | **Clean** (no errors, no warnings). |
| Full suite | `npm test` | Aborts at a PRE-EXISTING unrelated failure (`src/game/playerUI/playerUI.productionIdentity.test.js`, PlayerUIEngine roster). |
| Pre-existence proof | `git stash push -- src/pages/Page4Payment.jsx` → rerun the 3 failing files → `git stash pop` | Same **3 pass / 3 fail** WITHOUT my change — all three failures exist on HEAD; the rebuild introduces **zero** new test failures. |

Source-contract spot checks on the new file: exactly 1 `tonConnectUI.sendTransaction`;
contains `buildEntryPaymentTransaction`, `resolvePlayerPaymentDestination`,
`launchGramWalletHandoff`/`telegramMiniAppGramWalletHandoff`; zero
`participant?.contractAddress`; no `PAYMENT_CANCEL_INTENT` bypass, no diagnostic
button, no GameEscrow/Deposit transaction code.

## 8. Pre-Existing Failures (NOT caused by this task; untouched)

1. `src/game/playerUI/playerUI.productionIdentity.test.js` — PlayerUIEngine roster
   ("PLAYER_UPDATE locates by authoritative playerId"). Disjoint from Page4.
2. `src/game/session/page4GameEscrowAuthoritativeState.test.js` — "v4 Deposit wait"
   asserts the abandoned legacy Deposit phase (`resolvePage4PaymentPhase` on
   `page4PaymentPhase.js`, whose legacy functions are hard-disabled for the
   Room-Wallet-only architecture).
3. `src/payment/page4DepositActivationHandoff.test.js` — asserts the legacy Deposit
   deploy activation (`canDeployDeposit(...) === true`,
   `buildDepositDeploymentTransaction`), stale since the Room-Wallet-only switch.

All three fail identically with the rebuilt Page4 stashed (HEAD state). They belong to
the abandoned legacy smart-contract path; left untouched per task scope ("do not perform
unrelated cleanup").

## 9. Page4 Middle Content (as rebuilt)

Single self-contained component using only existing CSS classes
(`page4`, `paymentPanel`, `paymentPlayers`, `smartContractStatus`,
`page4__connectActions`, `page4__connectButton`, `page4__disconnectButton`,
`page4__desktopConnection*`):

1. **Identity line** — local player's pseudo (`player.yourNickname: <nickname>`)
   + server network (display only, e.g. `TESTNET`).
2. **Player rows** — `PlayerPaymentRow` × 3: wallet-connection statuses during the
   wallet phase, authoritative payment statuses (`requiredGram`, payment status
   labels) once the payment session exists.
3. **Amount + destination** — `payment.payAmount: <X> TON · <shortened Room Wallet
   address>`; both values come from the server snapshot only.
4. **Status line** — mapped from `resolvePage4PaymentUiState` (waiting / submitting /
   pending blockchain / confirmed / failed / room expired); COMPLETED shows
   `payment.allConfirmed`.
5. **Payment button** — rendered exactly when payment is required
   (`roomWalletPaymentReady && uiState === WAITING_FOR_PAYMENT`), disabled while
   submitting or when the server gate (`entryActionEnabled`) is not satisfied.
6. **Wallet connect / disconnect buttons** — wallet phase only; SDK reuse path
   prevents double modals; desktop universal-link panel with copy +
   `launchGramWalletHandoff` open (Telegram Mini App Gram handoff preserved).
7. **Error surfaces** — `localError` (wallet/connection) and `submitError`
   (payment) use existing i18n keys only.

## 10. Page4 → Page5

Unchanged: Page4 sets `nextEnabled={false}` and never navigates to Page5 itself;
the server-driven `OPEN_PAGE5` transition (`GameSessionContext` / App routing) is
preserved. After the transition the Page4 InfoBar countdown simply no longer applies
(Page5 owns its own timers — untouched).

## 11. Explicit Non-Changes

- `PaymentSessionManager.js`, `BlockchainMonitor.js`,
  `RoomWalletIncomingObserver.js`, `RoomWalletRegistry.js`,
  `RoomWalletRuntimeResolver.js`, `RoomWalletFinancialPolicy.js`,
  `RoomWalletSettlementRouter.js`, residual sweep, refund/recovery code: UNTOUCHED.
- 64-Room-Wallet configuration, Mainnet configuration, Railway settings: UNTOUCHED.
- Page3 wallet architecture, Page5 game engine, server room deadline: UNTOUCHED.
- No refund logic in Page4; no Mainnet switch; no diagnostic bypass; no new
  payment protocol.

## 12. Blockers

None. The payment button appears whenever the server publishes the Room Wallet
destination with the local seat in `PAYMENT_REQUESTED` /
`AWAITING_PLAYER_CONFIRMATION`, and functions through the standard
TonConnect + `PAYMENT_CONFIRM_INTENT` + server-verification sequence.
Live on-chain verification (an actual Testnet transfer) was not executed in this
session — that requires a real wallet session in a running Testnet deployment and
is the next manual validation step.

## Changes Made

- `client/src/pages/Page4Payment.jsx` (rebuilt).
- This report. No Git commit performed.




