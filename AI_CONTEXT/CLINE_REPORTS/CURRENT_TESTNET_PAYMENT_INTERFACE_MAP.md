# CURRENT TESTNET PAYMENT INTERFACE MAP

Date: 2026-09-20

Task: Diagnostics only — map the CURRENT Testnet payment path between the server and Page4
based strictly on the current local code. No source-code files were modified.

Target architecture (confirmed by current code): the player pays by a PLAIN TON transfer from a
TonConnect wallet to ONE server-selected Room Wallet (catalog of 64 server-side game wallets).
The old smart-contract payment system (GameEscrow / DepositPackage) is abandoned for Testnet
and is not a fallback anywhere in the active player-payment path.

---

## 1. Page4 Payment Entry

- Component: `Page4Payment` — `client/src/pages/Page4Payment.jsx` (3818 lines).
- User action: button `CONFIRM IN TELEGRAM WALLET` (`t("payment.confirmInWallet")`).
  Two render sites call the same handler:
  - Line 3668: entry-action button, gated `disabled={!entryActionEnabled || depositSubmitting}`
    (`entryActionEnabled` defined at line 1333).
  - Line 3803: "TEMPORARY PAYMENT DIAGNOSTIC BUTTON" (comment lines 3796-3798),
    `disabled={false}` — always clickable, independent of all phase gates.
- Function chain (UI → wallet):
  1. `handleConfirmInTelegramWallet` (`Page4Payment.jsx:742`, useCallback).
  2. `resolvePlayerPaymentDestination` — `client/src/game/session/page4PaymentPhase.js:63`
     (returns `paymentSession.roomWalletAddress` only).
  3. `getLocalPaymentRequest` — `client/src/game/session/authoritativePaymentSessionView.js:142`
     (local participant from `paymentSession.participants`).
  4. `buildEntryPaymentTransaction` — `client/src/payment/buildEntryPaymentTransaction.js:125`
     (Room-Wallet-only; deploy/fund components disabled at lines 145-155).
  5. `buildTonConnectPaymentTransaction` — `client/src/payment/buildTonConnectPaymentTransaction.js:50`
     (requires `plainTransfer === true`; plain wallet-to-wallet transfer).
  6. `toTonConnectSendTransactionRequest` — `buildEntryPaymentTransaction.js:88`
     (whitelists only `validUntil` / `messages[].address` / `messages[].amount`;
     `payload` / `stateInit` omitted when absent).
  7. `await tonConnectUI.sendTransaction(tonConnectTransaction)` — `Page4Payment.jsx:1033`.

## 2. Server Payment Session

- Creation trigger chain:
  - Page4 wallet connect: `reportConnectedWallet` (`Page4Payment.jsx:2084`) emits
    `WALLET_CONNECT_STARTED` + `WALLET_CONNECT_REPORT` (raw socket events,
    `server/socket/lobbyProtocol.js:23-24`).
  - When all wallets are verified, `RoomLobbyBridge` delivers `PAYMENT_CONNECTION_READY` to the
    room (`RoomLobbyBridge.js:6128` / `_deliverPaymentConnectionReady:6665`) and emits the
    domain event `EVENT_TYPES.PAYMENT_CONNECTION_READY` (`RoomLobbyBridge.js:5830`).
  - `PaymentSessionManager.initialize()` subscribes it (`server/gameplay/PaymentSessionManager.js:217`)
    → `_handlePaymentConnectionReady` (`:2349`) → `createAndRequest` (`:619`) →
    `createPaymentSession` (`:417`).
- Session construction (`PaymentSessionManager.createPaymentSession`, lines 417-614):
  - `paymentSessionId = pay_<uuid>`; participants built from `room.players` via PlayerManager
    identities; per-seat `requiredGram` from `calculateRequiredGram(baseStake, sectorCount)`
    (`server/payment/calculateRequiredGram.js`); participant wallet from verified wallet session
    (`_resolveWalletSession`, line 506; missing/unverified wallet → PaymentValidationError).
  - `roomWalletAddress = _resolveRoomWalletPaymentAddress(room)` (line 567; helper at 2850).
    Missing Room Wallet address → session creation fails (lines 569-576; comment 564-566:
    "Never create a payment session that lacks the server-selected Room Wallet destination").
  - Status `CREATED` → `transitionTo(WAITING_FOR_PAYMENTS)` (line 580); deadline
    `createdAt + this._durationMs` (line 487); persisted via TonFinancialPersistence (584).
  - `_activatePaymentRequests` (line 602; helper at 2581): for every participant sets
    `paymentDestination = roomWalletAddress`, `contractAddress = null` (line 2619 — legacy field
    neutralized), `paymentReference = payref_<sessionId>_<playerId>` (2621), status
    `AWAITING_PLAYER_CONFIRMATION` (2625), and emits per-seat `PAYMENT_REQUEST` (2627) plus
    session-wide `PAYMENT_SESSION_UPDATED` (2649).
- Server-side payment states:
  - Session: `server/gameplay/PaymentSessionStates.js` — CREATED → WAITING_FOR_PAYMENTS →
    PARTIALLY_PAID → FULLY_PAID; terminal FAILED / PAYMENT_TIMEOUT / CANCELLED.
  - Participant: `server/models/PaymentSession.js` — PAYMENT_REQUESTED →
    AWAITING_PLAYER_CONFIRMATION → PAYMENT_SUBMITTED → BLOCKCHAIN_PENDING → PAYMENT_CONFIRMED.
- Server → Page4 socket messages (lobby protocol `server/socket/lobbyProtocol.js:68-79`,
  delivered by `RoomLobbyBridge._deliverPaymentSessionCreated/_Updated/_Request/_Completed`,
  `RoomLobbyBridge.js:6826-6899`): `PAYMENT_STAGE_READY`, `PAYMENT_CONNECTION_READY`,
  `PAYMENT_SESSION_CREATED`, `PAYMENT_SESSION_UPDATED`, `PAYMENT_REQUEST`,
  `PAYMENT_SESSION_COMPLETED`, `PAYMENT_SESSION_FAILED`.
- Client → server payment socket messages: `PAYMENT_CONFIRM_INTENT`
  (`lobbyProtocol.js:29`), `PAYMENT_CANCEL_INTENT` (`:31`, not emitted by current Page4),
  wallet reports `WALLET_CONNECT_*` (`:23-25`), `TONCONNECT_AUTOPSY_SNAPSHOT` (`:27`).
- Expiry: `_scheduleExpiry` (`PaymentSessionManager.js:2982`) → `_onExpiry` →
  `failSession(roomId, "payment_timeout")` (line 3008).

## 3. Current Payment Package

What Page4 obtains, and the actual source of each item:

| Item | Source | Detail |
|---|---|---|
| Player identity (playerId) | CLIENT + SERVER | `usePlayerIdentity` (`Page4Payment.jsx:728`) reconciled against `paymentSession.participants` by wallet match (lines 796-830, 1263-1284). The server participant list is authoritative. |
| Player wallet address | CLIENT (TonConnect SDK) | `resolveTonConnectSdkAddress` (line 77) / `tonWallet.account.address`. Used only for participant matching + diagnostics. The authoritative binding lives server-side (verified wallet session at session creation, line 506). |
| Payment amount | SERVER | `participant.requiredGram` (GRM) from the `PAYMENT_SESSION_UPDATED` snapshot (`authoritativeSessionModel.js:845`), computed server-side by `calculateRequiredGram`. Client converts to nanotons via `requiredGramToNanotonString` (`buildTonConnectPaymentTransaction.js:30`, `toNano`) — DERIVED conversion only. |
| Destination address | SERVER | `paymentSession.roomWalletAddress` (stored client-side at `authoritativeSessionModel.js:877`). |
| Payment/session identifier | SERVER | `paymentSession.paymentSessionId`; per-seat `paymentReference = payref_<sessionId>_<playerId>` (`PaymentSessionManager.js:2621`). Neither is embedded in the transaction (plain transfer, no payload). |
| Expiration / validUntil | CLIENT | `Date.now()/1000 + 600` (DEFAULT_VALID_UNTIL_SECONDS = 600, `buildEntryPaymentTransaction.js:11` / `buildTonConnectPaymentTransaction.js:8`). The server deadline (`session.paymentDeadline`) is NOT sent into the TonConnect request. |
| Network / chain | SERVER (+ CLIENT diagnostics) | `paymentSession.network` (server-derived, `PaymentSessionManager.js:489-492,553`) used only by `describeTonConnectSendRequestDiagnostics` (Page4 lines 917-933) — diagnostics only. Wallet chain (`tonWallet.account.chain`, lines 921-924) diagnostics only. Nothing network-specific is sent to the wallet. |
| Transaction payload / stateInit | NONE | Plain transfer. Legacy builders `buildTonCommentPayload` / `buildGameEscrowStakePayload` throw "disabled" (`buildTonConnectPaymentTransaction.js:15-25`). |

## 4. Destination Wallet

- The destination is SERVER-selected from the 64 server game wallets.
- Catalog definition: `server/payment/roomWallet/RoomWalletRegistry.js` — `ROOM_WALLET_COUNT = 64`
  (line 13), `roomNumber` 1..64 ↔ canonical TON address (lines 46-71).
- Catalog source (ENV): `server/payment/roomWallet/RoomWalletRuntimeResolver.js` —
  `createRoomWalletRegistryFromEnv` / `loadRoomWalletRuntimeConfig` (line 35). Network keyed by
  `TON_NETWORK`: Testnet = `ROOM_WALLETS_TESTNET_JSON` (legacy fallback `ROOM_WALLETS_JSON`,
  line 51); Mainnet = `ROOM_WALLETS_MAINNET_JSON` (no cross-network fallback).
- Selection point: `PaymentSessionManager.createPaymentSession` line 567 →
  `_resolveRoomWalletPaymentAddress` (line 2850) →
  `resolveIntendedRoomWalletAddress` (`RoomWalletIncomingObserver.js:208`) →
  `registry.get(roomNumber).address`, roomNumber from `room.roomNumber` / roomManager.
- Wiring: `server/app.js:1734` builds the registry; `app.js:1762`
  `setRoomWalletFinance({ registry, settlementAdapter, roomWalletPaymentIntakeEnabled })` where
  `roomWalletPaymentIntakeEnabled = isRoomWalletOnlyFinancialPath(...)` — `roomWalletConfig.js:42-51`
  returns `true` unconditionally ("Smart-contract player-payment paths are intentionally not a fallback").
- Client side: Page4 resolves the destination ONLY via
  `resolvePlayerPaymentDestination` = `paymentSession.roomWalletAddress`
  (`page4PaymentPhase.js:63-74`; comment lines 1-6: "Smart-contract payment destinations are not
  valid player-payment fallbacks"; lines 117-131: participant `contractAddress` is never a fallback).
  No contract fallback exists client-side. Mechanism NOT modified by this task.

## 5. Amount

- Determined server-side at session creation:
  `requiredGram = calculateRequiredGram(identity.baseStake, sectorCount)`
  (`PaymentSessionManager.js:501-504`; `calculateRequiredGram.js` — first sector = 1 × baseStake,
  second sector = 1.5 × baseStake).
- Page4 receives it per seat on `PAYMENT_SESSION_UPDATED` (participant `requiredGram`,
  `authoritativeSessionModel.js:845`) and reads the local seat via `getLocalPaymentRequest`
  (`Page4Payment.jsx:823`) and the `localPaymentRequest` memo (line 1469).
- Page4 converts GRM → nanoton string with `requiredGramToNanotonString` and passes it as the
  TonConnect message `amount` (`buildEntryPaymentTransaction.js:177-183` →
  `buildTonConnectPaymentTransaction.js:70`). `null`/invalid `requiredGram` throws before send
  (build failure, no wallet opened, no server notification).

## 6. TonConnect sendTransaction

- Call: `await tonConnectUI.sendTransaction(tonConnectTransaction)` —
  `client/src/pages/Page4Payment.jsx:1033`, inside `handleConfirmInTelegramWallet`.
- Construction path:
  `buildEntryPaymentTransaction` (`gameEscrowOnly` resolved by
  `isGameEscrowOnlyPlayerPayment` → always `true`; `includeStake` = `canStakeGameEscrow`)
  → `buildTonConnectPaymentTransaction({ contractAddress: <roomWallet>, requiredGram,
  plainTransfer: true, validUntilSeconds: 600 })`
  → `toTonConnectSendTransactionRequest` (SDK-legal keys only).
- Final request object:
  - `validUntil`: now/1000 + 600 (CLIENT-derived).
  - `messages`: exactly one message `{ address: <paymentSession.roomWalletAddress>,
    amount: <requiredGram nanotons string> }`.
  - `payload`: absent. `stateInit`: absent. No `totalNanotons` key is sent to the wallet.
- Destination: `paymentSession.roomWalletAddress` (server Room Wallet).
- Amount: `participant.requiredGram` converted to nanotons.
- validUntil: client constant 600 s (see §3).
- Network/chain information: NOT part of the request. `TonConnectUIProvider` is configured with
  `manifestUrl` only (`client/src/main.jsx:40`, manifest from
  `client/src/config/tonConnectManifest.js`); the wallet itself decides the chain. Client-side
  network/chain values are used exclusively inside forensic diagnostics
  (`describeTonConnectSendRequestDiagnostics`, `page4DepositDeployDiagnostics.js`).
- Retry / reconnect behavior: none automatic. Single `await`; the `depositSubmitting` state guard
  prevents concurrent submissions (lines 744-748, 863); on failure the button stays available for
  a manual retry. Forensic capture: TonConnect autopsy timeline events
  `PAGE4_SEND_TRANSACTION_REQUEST` / `PAGE4_SEND_TRANSACTION_REJECTION` (lines 991, 1073) and
  socket `TONCONNECT_AUTOPSY_SNAPSHOT` — diagnostics only. Telegram wallet handoff UX:
  `launchGramWalletHandoff` (`Page4Payment.jsx:69`, used at 3265) — connection handling, not payment.

## 7. Success Path

After `sendTransaction` resolves (the wallet broadcast succeeded):

1. Client: logs `WALLET_RESULT USER_CONFIRMED` (line 1036) and emits
   `socket.emit("PAYMENT_CONFIRM_INTENT")` with NO payload (line 1044).
2. Server transport: `SocketGateway` handles the socket event
   (`server/socket/SocketGateway.js:1003`) → emits domain event
   `LOBBY_PAYMENT_CONFIRM_INTENT_REQUEST` (`server/events/EventTypes.js:174`).
3. `RoomLobbyBridge._handlePaymentConfirmIntent(socketId)` (`RoomLobbyBridge.js:864, 6958`)
   resolves `playerId`/`roomId` from the authenticated socket context
   (`_getSocketContext`) — the intent itself carries no payment facts — and calls
   `PaymentSessionManager.submitPlayerConfirmation(roomId, playerId)`.
4. `submitPlayerConfirmation` (`PaymentSessionManager.js:1766`): seat
   `AWAITING_PLAYER_CONFIRMATION` → `PAYMENT_SUBMITTED` (emit `PAYMENT_SESSION_UPDATED`) →
   `BLOCKCHAIN_PENDING` (emit `PAYMENT_SESSION_UPDATED`) → `_registerPlayerWatch`
   (line 1806) → `BlockchainMonitor.watchPayment` with
   `contractAddress = session.roomWalletAddress` (`BlockchainMonitor.js:1438`).
   This is an INTENT state only — it is not payment confirmation.
5. Real confirmation is performed only by server-side blockchain observation (§9): PSM subscribes
   `PAYMENT_TRANSACTION_CONFIRMED` (line 257) and `PAYMENT_BLOCKCHAIN_CONFIRMED` (line 294) →
   `_processConfirmedPayment` (`:2521`) → `_validateIncomingPayment` (`:2705`) which enforces:
   destination equals `session.roomWalletAddress` (2734-2753), sender equals
   `participant.wallet` (2755-2766), `amountsMatch(participant.requiredGram, amount)`
   (2768-2777), network equality (2779-2790), deadline not exceeded (2725-2732),
   txHash deduplication (1838-1852, 2715-2723).
6. `confirmBlockchainPayment` (`:1814`): seat → `PAYMENT_CONFIRMED`, `addReceivedPayment`,
   `lockFinancialWallet`, emits domain `PAYMENT_CONFIRMED` + `PAYMENT_SESSION_UPDATED`, unwatches
   (1909-1917) → `_maybeCompleteSession` (`:2796`): when all seats are confirmed →
   `markCompleted()`, emits `PAYMENT_SESSION_UPDATED` + `PAYMENT_SESSION_COMPLETED` (2820-2825).
7. `RoomLobbyBridge._deliverPaymentSessionCompleted` (6883) → client
   `PAYMENT_SESSION_COMPLETED` → store (`authoritativeSessionModel.js:820-889`) →
   Page4 phase `WAITING_PAGE5` (`page4PaymentPhase.js:230-234`); Page5 opens only on the
   server event `OPEN_PAGE5`.

## 8. Failure Path

When `sendTransaction` rejects (`Page4Payment.jsx:1046-1133`):

- If the send was attempted (`sendAttempted === true`, set at line 1031):
  `dumpTonConnectError("PAGE4_SEND_TRANSACTION_REJECTION", ...)` + autopsy timeline
  `PAGE4_SEND_TRANSACTION_REJECTION`; `logPage4DepositDeploy("WALLET_RESULT",
  classifyDepositWalletError)`. If the build itself failed (`sendAttempted === false`):
  outcome `TRANSACTION_BUILD_FAILURE`, no autopsy rejection step.
- Client error surface: `setDepositSubmitError(error?.message || t("payment.entryFailed"))`
  (line 1125) rendered at lines 3619-3630; `finally` clears `depositSubmitting` (1131).
- Server notification: NONE. `PAYMENT_CANCEL_INTENT` exists in the protocol
  (`lobbyProtocol.js:31`) and has a server handler
  (`RoomLobbyBridge._handlePaymentCancelIntent:6974` →
  `PaymentSessionManager.reportPlayerCancel:1928`, which only resets
  `PAYMENT_SUBMITTED`/`BLOCKCHAIN_PENDING` back to `AWAITING_PLAYER_CONFIRMATION`), but the
  current `Page4Payment.jsx` never emits it (verified: no occurrence in the file).
- Payment session state after a rejection: the seat remains in
  `AWAITING_PLAYER_CONFIRMATION` (intent never emitted) or in `PAYMENT_SUBMITTED`/
  `BLOCKCHAIN_PENDING` (intent emitted, on-chain payment never observed). The session expiry
  timer keeps running → `_onExpiry` → `failSession("payment_timeout")` →
  `PAYMENT_SESSION_FAILED` (`PaymentSessionManager.js:725, 3008`) →
  `RoomLobbyBridge._handlePaymentSessionFailed` (6901) delivers `PAYMENT_SESSION_FAILED`
  to the room and closes the room.
- Retry: none automatic; the user may press the button again (a fresh `sendTransaction`).
- Can a failed send mark the payment confirmed? NO. `PAYMENT_CONFIRM_INTENT` only moves the seat
  to `PAYMENT_SUBMITTED`/`BLOCKCHAIN_PENDING`; the only transition to
  `PAYMENT_CONFIRMED` is `confirmBlockchainPayment`, reachable exclusively from the
  observation events `PAYMENT_TRANSACTION_CONFIRMED` / `PAYMENT_BLOCKCHAIN_CONFIRMED`
  (`PaymentSessionManager.js:257, 294`) after `_validateIncomingPayment` on-chain-field checks.
  A client intent alone can never confirm.

## 9. Server Blockchain Observation

- Primary module: `server/payment/roomWallet/RoomWalletIncomingObserver.js` (1241 lines),
  constructed in `server/app.js:1738-1750` with
  `{ eventBus, paymentSessionManager, financialPersistence, registry, roomManager,
  ledgerRegistry, tonService transport, network: tonConfig.network }`, and wired into the
  BlockchainMonitor via `setRoomWalletIncomingObserver` (`app.js:1752`).
- Driving loop: `BlockchainMonitor._pollGlobal` (`server/payment/BlockchainMonitor.js:1660`)
  calls `this._roomWalletIncomingObserver.poll()` (lines 1739-1745).
- `poll()` (Observer lines 317-416): iterates the full Room Wallet catalog
  (`listConfiguredRoomWalletAddresses`, 64 addresses) in slices of
  `ROOM_WALLET_OBSERVER_WALLETS_PER_CYCLE = 8` wallets per cycle, concurrency
  `ROOM_WALLET_OBSERVER_MAX_CONCURRENCY = 1`, TonCenter `getTransactions` page limit 32,
  retry max 2 × 400 ms, fetch timeout 8 s (constants at lines 35-60).
- Wallet selection: ALL configured catalog wallets are polled; the active session's wallet is
  `session.roomWalletAddress` (persisted) with the registry catalog as identity source
  (`_attribute`, lines 704-717).
- `processTransaction` (lines 418-695) — transaction matching criteria:
  1. Reject failed/bounced TON transactions (`isFailedTonTransaction`, via
     `parseDepositCandidate` from `BlockchainMonitor`).
  2. Require `txHash`, `destination`, `sender`, `amountGram > 0`.
  3. `destination` must equal the watched/catalog Room Wallet address (506-534) —
     otherwise terminal `WRONG_DESTINATION`.
  4. Deduplicate by `observationId = rwin__<destination>__<txHash>` (536-546).
  5. Attribution `_attribute` (697-783): among in-progress PaymentSessions, match
     `participant.wallet === sender` AND intended destination
     (`session.roomWalletAddress ?? registry catalog`) `=== destination`; more than one match →
     `AMBIGUOUS_ATTRIBUTION`; deadline exceeded → `EXPIRED_PAYMENT_CONTEXT`; sender match but
     wrong destination → `WRONG_DESTINATION`; otherwise `UNKNOWN_SENDER`.
  6. Amount: `amountsMatch(participant.requiredGram, amountGram)` (574) else `WRONG_AMOUNT`.
  7. Ledger record (`RoomWalletLedgerRegistry.recordPlayerPayment`, 595-615) and durable
     observation record (617-653); audit `ROOM_WALLET_PAYMENT_CONFIRMED` (666-674).
  8. Emits `PAYMENT_TRANSACTION_DETECTED` + `PAYMENT_TRANSACTION_CONFIRMED`
     (lines 676-677) → PaymentSessionManager confirmation path (§7 steps 5-6).

- Player/session correlation: sender wallet → session participant wallet; destination →
  session room wallet; explicit fields carried in the payload: `roomId`, `roomNumber`,
  `gameId`, `playerId`, `paymentReference`, `paymentSessionId`, `amountGram`,
  `expectedGram`, `txHash`, `sender`, `destination`.
- Rejections: terminal rejections persist a REJECTED observation and emit
  `PAYMENT_BLOCKCHAIN_REJECTED` (996-1005) →
  `PaymentSessionManager._handleBlockchainRejected` (2450) sets
  `confirmationStatus = REJECTED` + domain `PAYMENT_REJECTED`. Audit `ROOM_WALLET_PAYMENT_REJECTED`.
- Secondary (converging) path: per-room watch registered on `submitPlayerConfirmation`
  (`PaymentSessionManager.js:1806`) → `BlockchainMonitor._pollRoom` (1811) polls
  `watch.contractAddress` (= the room wallet) → `_evaluateTransaction`
  (`BlockchainMonitor.js:2567`): matches by `paymentReference` text comment OR
  sender + exact amount (2646-2669), then emits `PAYMENT_TRANSACTION_DETECTED`,
  `PAYMENT_TRANSACTION_CONFIRMED`, `GAME_ESCROW_STAKE_CONFIRMED` (ignored by PSM in
  room-wallet intake mode, lines 263-276) and `PAYMENT_BLOCKCHAIN_CONFIRMED` (2911) →
  `_processConfirmedPayment`. Both paths end in the same `confirmBlockchainPayment`.
- Note: at session creation `_activatePaymentRequests` registers blockchain watches ONLY when
  room-wallet intake is DISABLED (`PaymentSessionManager.js:2641-2645`); in the active
  Testnet room-wallet mode the watch appears only after the client confirm intent.

## 10. Legacy Smart-Contract Dependencies

Distinction used below:
- **ACTIVE TESTNET 64-WALLET PATH**: the room-wallet plain-transfer path (§1-§9).
- **LEGACY SMART-CONTRACT PATH**: GameEscrow / DepositContract code paths still present in code.

| File | Function/Element | What it does | Reachable from current Testnet Page4 payment path? |
|---|---|---|---|
| `client/src/payment/buildTonConnectPaymentTransaction.js` | `buildTonCommentPayload` / `buildGameEscrowStakePayload` / `GAME_ESCROW_STAKE_OPCODE` | Legacy contract payload builders; throw "disabled" (lines 15-25). `plainTransfer !== true` → throws (58-62). | The file is on the active path (source of `requiredGramToNanotonString` + plain-transfer request); the contract builders themselves are unreachable (guarded by throws). |
| `client/src/payment/buildEntryPaymentTransaction.js` | legacy parameters `depositPackage`, `depositAddress`, `mySeatIndex`, `includeDeploy`, `includeFund`, creator-only error (163-167) | Accepted but force-voided: `allowDeploy = false`, `allowFund = false` (145-155). | Directly reachable (active builder) but contract components are inert. |
| `client/src/game/session/page4PaymentPhase.js` | phases `DEPOSIT_DEPLOY`, `DEPOSIT_ACTIVATION`, `FUND_SEAT`, `DEPOSIT_WAIT_FULL`, `DEPOSIT_FULL`; `canDeployDeposit`, `canFundSeat`, `canIncludeFundSeatInEntry`, `shouldShowWaitingCreatorDeposit`, `isDepositActivationVerified`, `isDepositFull`, `hasLegacyDepositPackage` | All legacy deposit functions hard-return `false` (lines 133-184); `isGameEscrowOnlyPlayerPayment` returns `true` unconditionally (122-131). | Reachable (imported by Page4) but inert; only `ENTRY_PAYMENT` / `GAMEESCROW_STAKE` / `WAITING_PAGE5` / `WALLET` phases can occur. |
| `client/src/pages/Page4Payment.jsx` | lines 776-794 (depositProjection gating when `!gameEscrowOnly`) and 884-904 (deposit package args, `depositAddress`, `mySeatIndex`, `myExpectedAmountNanotons`) | Legacy DepositContract branch of the confirm handler. | UNREACHABLE dead branch — `gameEscrowOnly` is always `true` (`isGameEscrowOnlyPlayerPayment`). |
| `client/src/pages/Page4Payment.jsx` | lines 3651-3657: `gameContract?.status === "DEPLOY_FAILED"` → `t("payment.deploymentFailed")` | Legacy GameEscrow deploy-failure display copy. | Display-only; requires legacy `GAME_CONTRACT_*` events to ever show. |
| `client/src/game/session/authoritativeSessionModel.js` | `DEPOSIT_PACKAGE_PUBLISHED` projection (`network` at line 1010); `contractAddress` field on participants (line 856) | Legacy deposit-projection mirror (informational only); legacy seat field. | Data mirror only; not used to build the payment (destination comes from `roomWalletAddress`). |
| `client/src/payment/buildFundDepositTransaction.js`, `buildDepositDeploymentTransaction.js` (+ tests) | Legacy contract builders (FundSeat / Deposit deployment) | Construct contract transactions. | NOT imported by any non-test client module (verified) — dormant legacy files. |
| `server/gameplay/PaymentSessionManager.js` | `_subscribe(GAME_CONTRACT_READY_FOR_PAYMENTS)` / `(CONTRACT_DEPLOYMENT_CONFIRMED)` (222-230) with no-op handlers (2380-2394); `_subscribe(GAME_CONTRACT_DEPLOY_FAILED)` → `failSession` (232-250); `_subscribe(GAME_ESCROW_STAKE_CONFIRMED)` ignored in intake mode (263-276); `GAME_ESCROW_REFUND_CONFIRMED` / `GAME_ESCROW_CANCEL_CONFIRMED` handlers (279-287); `_assertContractReadyForPayments` (2866; skipped when room-wallet intake enabled, line 468); `session.contractId` reference field | Legacy contract-event plumbing retained; a contract is NOT a payment prerequisite (comments 2382-2391). | Present on the active path as inert guards/legacy listeners; `GAME_CONTRACT_DEPLOY_FAILED` would still fail the session if such an event ever fired. |

| `server/payment/BlockchainMonitor.js` | `_pollGlobal` loops over `_contracts`, `_transactions`, `_gameEscrowSettlements`, `_gameEscrowRefunds` (1687-1729); `_observeContract` (1918); `GAME_ESCROW_STAKE_CONFIRMED` emission on room-wallet watch matches (2887-2908); `amountsMatch` / `parseDepositCandidate` / `isFailedTonTransaction` | Legacy GameEscrow/contract observation machinery plus shared TON tx parsing used by the active path. | The legacy `_pollGlobal` loop bodies iterate empty watch collections on the room-wallet path; the shared helpers (`parseDepositCandidate`, `amountsMatch`) ARE on the active path. |
| `server/gameplay/GameContractManager.js`, `server/deposit/*` (DepositOrchestrator, DepositMonitor, DepositSessionCoordinator), `contracts/GameEscrow.tact` / DepositContract tact | Legacy contract domain subsystems | Deploy/fund/verify smart contracts; legacy event sources. | Not part of the active Testnet player-payment path; still wired in `server/app.js` (e.g. `setDepositMonitor` 1730, `DepositOnChainVerificationCoordinator` 1795). |
| `server/payment/RoomWalletSettlementRouter.js` + `roomWalletConfig.composeRoomWalletSettlementRouter` | `legacySettlementAdapter` injection | Routes settlement to the Room Wallet adapter; legacy adapter kept as constructor arg (`enabled: true` always, `roomWalletConfig.js:42-51`). | Settlement-side only (post-game); not part of the Page4 payment entry path. |

Summary: no legacy contract path is a live alternative for player payment. All legacy branches
either throw, return `false`, are unreachable (always-true `gameEscrowOnly`), or are inert
listeners. The ACTIVE TESTNET 64-WALLET PATH is the only live player-payment route.

## 11. Mainnet Contamination

Mainnet-related logic that currently intersects the Testnet payment path:

| File | Condition/branch | What it changes | Can it affect Testnet? |
|---|---|---|---|
| `client/src/components/HeaderBar.jsx` (lines 15-88) | `showMainnetSwitch && isTestnet` — "MAINNET" button (`handleMainnetClick`) redirects to the Mainnet Telegram Mini App (`t.me/wheel_win_bot?startapp` / `wheelwin-main.vercel.app`) | Navigation/handoff only. Rendered via `GameLayout` (line 55). Page4 renders `GameLayout` WITHOUT `showMainnetSwitch` (`Page4Payment.jsx:3534-3546`) and the prop defaults to `false` (`HeaderBar.jsx:15`). | No — not rendered on Page4; no payment-logic effect. |
| `client/src/components/RoomNetworkHandoffBootstrap.jsx` + `client/src/network/roomNetworkHandoff.js` | R23 Mainnet-side room handoff bootstrap; `data?.network !== "mainnet"` guard (line 249); `targetNetwork: "mainnet"` (line 140) | Separate Mainnet room-continuation flow mounted in `App.jsx:375`; socket events `roomNetworkHandoffBootstrapRequest` / `...Result`. | No — activates only on the Mainnet runtime; the Testnet Page4 payment path does not call it. |
| `server/payment/roomWallet/RoomWalletRuntimeResolver.js` (lines 30-66) | `TON_NETWORK` selects `ROOM_WALLETS_TESTNET_JSON` vs `ROOM_WALLETS_MAINNET_JSON`; `TON_NETWORK` must be explicitly `testnet` or `mainnet`; Mainnet has no fallback | Network selection determines which 64-wallet catalog and (via tonConfig) which TonCenter endpoints are used. | On Testnet (`TON_NETWORK=testnet`) the Mainnet branch is not taken; a missing/mis-set `TON_NETWORK` fails startup (fail-closed), never silently switching to Mainnet. |
| `server/app.js` (line 107 `loadMainnetTonProfile`, `server/config/tonNetworkProfiles.js`) | Network profile resolution via `this._tonConfig.network` | Chooses TonService endpoints; `tonNetwork: this._tonConfig?.network ?? "testnet"` passed to modules (app.js:1425-1463). | Only via explicit `TON_NETWORK`; default fallback is "testnet". |
| `PaymentSessionManager` session `network` (`:489-492, 553`) and client diagnostics (`Page4Payment.jsx:917-933`) | `paymentSession.network` / wallet `chain` compared in diagnostics only | No behavioral branch; a mismatch is logged, not enforced client-side. | No behavior change on Testnet. |

No mainnet-specific logic was found inside the active client payment files
(`Page4Payment.jsx`, `page4PaymentPhase.js`, `buildEntryPaymentTransaction.js`,
`buildTonConnectPaymentTransaction.js`) — only comments mention network names.

## 12. Minimal New Testnet Payment-Layer Interface

Based strictly on the current code, the minimum information a clean Testnet Page4 Payment
Layer needs from the server (contract — NOT implemented here):

PAYMENT PACKAGE

| Field | Source | Purpose |
|---|---|---|
| `paymentSessionId` | SERVER | Session correlation / audit key. |
| `roomId`, `roomNumber` | SERVER | Room Wallet lookup (roomNumber → wallet) and audit scoping. |
| `network` (e.g. "testnet") | SERVER | Authoritative chain/network binding for diagnostics and server-side validation. |
| `roomWalletAddress` | SERVER | The ONE authoritative payment destination (from the 64-wallet catalog). Must remain the sole client destination source. |
| `requiredGram` (GRM) | SERVER | Exact expected amount per player; the client converts to nanotons at build time (`toNano`). |
| `participant.status` | SERVER | Gating: the payment action is enabled only in `PAYMENT_REQUESTED` / `AWAITING_PLAYER_CONFIRMATION`. |
| `participant.paymentReference` | SERVER | Server-side payment attribution reference (currently display/audit only — not embedded in the tx). |
| `paymentDeadline` / `expiresAt` | SERVER | Authoritative validity bound (the client currently derives TonConnect `validUntil` locally as now+600 s; a new layer can bound it by the server deadline). |

Explicitly NOT needed by the new layer (per current code): contract address, deploy value,
stateInit / codeBoc / dataBoc, seat index for a STAKE body, text-comment payload — the active
payment is a plain TON transfer with no payload/stateInit.

## 13. Critical Observations

Concrete, code-supported observations (no root-cause speculation):

1. **TEMPORARY diagnostic payment button** — `Page4Payment.jsx:3796-3808`: a second
   `CONFIRM IN TELEGRAM WALLET` button with `disabled={false}` and no phase/eligibility gate
   ("Intentionally independent of all Page4 visibility/state gates. Keep visible until the real
   payment flow is verified."). It invokes the real `sendTransaction` path in any phase
   (including `WAITING_PAGE5` / `FAILED`).
2. **validUntil is client-derived** (now + 600 s) and unrelated to the server
   `paymentDeadline` (`PaymentSessionManager.js:487`). On-chain payments observed after the
   server deadline are rejected (`_validateIncomingPayment:2725-2732`; observer
   `EXPIRED_PAYMENT_CONTEXT:760-768`).
3. **`PAYMENT_CONFIRM_INTENT` carries no payload** (`Page4Payment.jsx:1044`); the server resolves
   the player from the authenticated socket context (`RoomLobbyBridge.js:6960-6968`). The intent
   contains zero payment facts and cannot act as confirmation (the server only sets
   SUBMITTED / BLOCKCHAIN_PENDING, `PaymentSessionManager.js:1766-1812`).
4. **Dual observation paths poll the same Room Wallet address**: the global observer poll
   (`_pollGlobal` → `RoomWalletIncomingObserver.poll`) and the per-room watch poll
   (`_pollRoom` on the watch created by `submitPlayerConfirmation`,
   `PaymentSessionManager.js:1806` → `BlockchainMonitor.watchPayment` with
   `contractAddress = roomWalletAddress`). Both converge on
   `_processConfirmedPayment` (deduplication via txHash sets / observation IDs).
5. **`GAME_ESCROW_STAKE_CONFIRMED` is still emitted** by the per-room watch path
   (`BlockchainMonitor.js:2887-2908`) for room-wallet transfers, and is deliberately ignored by
   PSM in room-wallet intake mode (`PaymentSessionManager.js:263-276`) — legacy event noise on
   the active path.
6. **`PAYMENT_CANCEL_INTENT` is never emitted by Page4** (verified: absent from
   `Page4Payment.jsx`), so the server cancel/reset path (`reportPlayerCancel`,
   `PaymentSessionManager.js:1928`) is unreachable from the current client.
7. **Legacy seat field neutralized**: `_activatePaymentRequests` sets
   `participant.contractAddress = null` on the room-wallet path
   (`PaymentSessionManager.js:2619`), and the client never falls back to `contractAddress`
   (`page4PaymentPhase.js:117-131`).
8. **Session creation is fail-closed without a Room Wallet**: a missing room-wallet address
   throws and emits `PAYMENT_SESSION_FAILED` (`PaymentSessionManager.js:567-576, 725`).
9. **Amount derives from player setup**: `calculateRequiredGram(baseStake, sectorCount)` —
   first sector = 1 × baseStake, second sector = 1.5 × baseStake
   (`server/payment/calculateRequiredGram.js`), resolved from PlayerManager identity at session
   creation (`PaymentSessionManager.js:501-504`).
10. **Page4 never navigates itself to Page5** — `nextEnabled={false}`, `onNext={() => {}}`
    (`Page4Payment.jsx:3542-3544`); the completion display waits for `OPEN_PAGE5`.
11. **TonConnect chain is wallet-decided**: `TonConnectUIProvider` is configured with
    `manifestUrl` only (`client/src/main.jsx:40`); no network parameter is passed in
    `sendTransaction`; server-side network equality of the observed payment is validated in
    `_validateIncomingPayment` (`:2779-2790`) when the observation payload carries `network`.

## Files Inspected (main tree only; `.kilo` worktree copies ignored)

- `client/src/pages/Page4Payment.jsx`
- `client/src/game/session/page4PaymentPhase.js`
- `client/src/game/session/authoritativePaymentSessionView.js`
- `client/src/game/session/authoritativeSessionModel.js`
- `client/src/context/AuthoritativeSessionContext.jsx`
- `client/src/payment/buildEntryPaymentTransaction.js`
- `client/src/payment/buildTonConnectPaymentTransaction.js`
- `client/src/socket/socketEvents.js`
- `client/src/main.jsx`, `client/src/App.jsx`, `client/src/layouts/GameLayout.jsx`
- `client/src/components/HeaderBar.jsx`, `client/src/components/RoomNetworkHandoffBootstrap.jsx`
- `server/gameplay/PaymentSessionManager.js`
- `server/payment/BlockchainMonitor.js`
- `server/payment/roomWallet/RoomWalletIncomingObserver.js`
- `server/payment/roomWallet/RoomWalletRegistry.js`
- `server/payment/roomWallet/RoomWalletRuntimeResolver.js`
- `server/payment/roomWallet/roomWalletConfig.js`
- `server/payment/calculateRequiredGram.js`
- `server/socket/RoomLobbyBridge.js`, `server/socket/SocketGateway.js`, `server/socket/lobbyProtocol.js`
- `server/app.js`

## Changes Made

No source-code files modified. Only this report was created
(`AI_CONTEXT/CLINE_REPORTS/CURRENT_TESTNET_PAYMENT_INTERFACE_MAP.md`). No Git commit.












