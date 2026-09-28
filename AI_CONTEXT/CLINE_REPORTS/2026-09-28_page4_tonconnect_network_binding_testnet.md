# Page4 TonConnect Network Binding — Testnet Payment Fix

Date: 2026-09-28

Task: Fix the Testnet production payment failure (room `2vjN`,
`game_3f614386-c125-46bd-81bd-0469fc878b4f`,
`pay_ab681f96-e948-4082-8c3e-6ddda9161578`; no `PAYMENT_CONFIRM_INTENT` from
Lena in three consecutive Testnet games) by binding the Page4 Room Wallet
TonConnect transaction to the server-authoritative `PaymentSession.network`.
Mainnet development was explicitly frozen: no dual-network registries, no
Mainnet wallets, no Railway/Vercel Mainnet changes.

## 1. Scope

- `client/src/payment/buildEntryPaymentTransaction.js` — the existing payment
  transaction helper already accepted a `network` argument but discarded it;
  `toTonConnectSendTransactionRequest()` returned only `validUntil` and
  `messages`.
- `client/src/pages/Page4Payment.jsx` — called
  `buildEntryPaymentTransaction()` without `paymentSession.network`; the
  `sendTransaction` catch block logged the raw error object.
- Focused unit tests for the helper and the Page4 wiring.

Explicitly out of scope (untouched): PaymentSessionManager, Room Wallet
observer logic, refund/recovery logic, Page2, Mainnet configuration, all
smart-contract payment paths (GameEscrow / DepositContract / DepositPackage),
RoomLobbyBridge, deployment configuration.

## 2. Files Inspected

Context (per `.clinerules`): `AI_CONTEXT/WHEELWIN_MASTER_CONTEXT.md`,
`AI_CONTEXT/ARCHITECTURE_RULES.md`, `AI_CONTEXT/CURRENT_STATE.md`,
`AI_CONTEXT/AI_WORKING_RULES.md`,
`AI_CONTEXT/CLINE_REPORTS/2026-09-28_stage2_payment_session_room_network_propagation.md`,
`AI_CONTEXT/CLINE_REPORTS/2026-09-28_stage3_room_wallet_catalog_inventory.md`.

Source read directly:

- `client/src/payment/buildEntryPaymentTransaction.js` (full)
- `client/src/payment/buildTonConnectPaymentTransaction.js` (full)
- `client/src/pages/Page4Payment.jsx` (payment submission + catch block)
- `client/src/game/session/page4PaymentPhase.test.js`
- `client/src/tonconnect/telegramMiniAppGramWalletHandoff.test.js`
- `client/scripts/run-tests.js`, `client/scripts/register.js`
- `server/gameplay/PaymentSessionManager.js` (network validation at
  `createAndRequest`: only `testnet` / `mainnet` are authoritative values;
  everything else fails closed with
  "Authoritative room network unavailable for PaymentSession")
- `server/tests/paymentSessionRoomNetwork.test.js` (proves
  `PaymentSession.network` is the lowercase authoritative value `testnet` or
  `mainnet`)

Search result: no existing client-side network→chain-id utility exists
(`client/src/network/roomNetworkHandoff.js` is the unrelated R24 Mainnet
handoff storage module and was deliberately NOT reused or modified). The
mapping therefore lives inside the existing transaction helper — no second
network abstraction was created.

## 3. Architecture Findings

- Payment truth (destination, amount, network) is server-owned:
  `PAYMENT_SESSION_UPDATED` / `PAYMENT_SESSION_CREATED` carry the
  `paymentSession` snapshot, including `network` (`testnet` | `mainnet`,
  enforced fail-closed server-side by `PaymentSessionManager.createAndRequest`).
- The client transaction helper accepted `network` but silently dropped it,
  so `tonConnectUI.sendTransaction()` received `{ validUntil, messages }`
  with no chain binding — ambiguous network handling on Testnet wallets and a
  plausible cause of the wallet-side silent rejections observed in production
  (no `PAYMENT_CONFIRM_INTENT` ever emitted for Lena).
- Page4's catch block logged the raw error object; safe fields are now logged
  explicitly so no wallet material can leak.

## 4. Lifecycle Flow (after this change)

```
server PaymentSession.network ("testnet" | "mainnet")
  -> Page4 (authoritative.paymentSession snapshot)
  -> buildEntryPaymentTransaction({ ..., network: paymentSession?.network ?? null })
       resolveTonConnectChainId(network):  testnet -> "-3", mainnet -> "-239",
       missing/invalid -> throw (fail closed, before any transaction is built)
  -> transaction object { validUntil, messages, network: "-3", totalNanotons }
  -> toTonConnectSendTransactionRequest()  (fail-closed re-check)
  -> TonConnect request { validUntil, network: "-3", messages: [{address, amount}] }
  -> wallet
  -> PAYMENT_CONFIRM_INTENT only after wallet acceptance
```

The network is never taken from a client-selected value; the client only
forwards the server-owned `PaymentSession.network`.

## 5. Ownership Boundaries

- Server remains the only gameplay/financial authority. The client change is
  display/command-layer only: it forwards the authoritative network into the
  wallet request and adds diagnostics.
- Destination remains `resolvePlayerPaymentDestination(...)` ->
  `paymentSession.roomWalletAddress` (server-provided Room Wallet).
- Amount remains `paymentRequest.requiredGram` (server-provided); no amount
  calculation was added or modified (`buildTonConnectPaymentTransaction` is
  unchanged).
- `PaymentSessionManager`, observer logic, refund/recovery logic, Page2 and
  the Room Wallet flow were not modified.

## 6. Exact Network Mapping Implemented

In `client/src/payment/buildEntryPaymentTransaction.js`:

- `TON_CHAIN_ID_TESTNET = "-3"`   <- authoritative session network `"testnet"`
- `TON_CHAIN_ID_MAINNET = "-239"` <- authoritative session network `"mainnet"`
  (kept ready for the later Mainnet stage; no Mainnet deployment,
  configuration or registry was added)
- Anything else (missing, `null`, wrong case, whitespace, unknown values)
  throws "Authoritative payment session network is required (testnet|mainnet)".
- `toTonConnectSendTransactionRequest()` independently fail-closes with
  "TonConnect transaction requires an explicit authoritative network" if the
  transaction object does not carry one of the two chain ids.

TonConnect request for a Testnet session contains exactly:
`{ validUntil, network: "-3", messages: [{ address, amount }] }` — no
unsupported fields, no `payload`, no `stateInit` (plain Room Wallet transfer).

## 7. Risks

- Critical: none introduced. The change removes an ambiguity (missing chain
  binding) rather than adding one.
- High: a stale/absent `paymentSession.network` now blocks the payment
  instead of sending an ambiguous request — this is the required fail-closed
  behaviour; the user sees a submission error instead of a silent wallet
  rejection.
- Medium: pre-existing failing tests unrelated to this task were observed and
  are documented below; they must be triaged separately.
- Low: `validUntil` semantics unchanged (unix seconds, default 600 s TTL).

## 8. Tests Run and Results

Commands: `node --import ./scripts/register.js <test>` from `client/`,
`node tests/<file>` from `server/`. No real wallet credentials required.

Client (focused, all PASS):

- `payment/buildEntryPaymentTransaction.test.js` — 12/12 pass, exit 0
  (includes: testnet -> `"-3"`; mainnet -> `"-239"`; missing network fails
  closed; invalid networks (`TESTNET`, `Mainnet`, `goerli`, `""`,
  `"testnet "`) fail closed; REGRESSION: a Testnet payment request cannot be
  constructed without an explicit Testnet network (builder AND request
  converter); destination remains the server Room Wallet; authoritative
  amount unchanged; `validUntil` unchanged; request keys exactly
  `["messages","network","validUntil"]`).
- `game/session/page4PaymentPhase.test.js` — 8/8 pass, exit 0 (includes new
  source-wiring assertion that Page4 passes
  `network: paymentSession?.network` into `buildEntryPaymentTransaction`, and
  the pre-existing single-`sendTransaction`-path assertion).
- `payment/buildTonConnectPaymentTransaction.test.js` — pass, exit 0
- `payment/page4DepositDeployDiagnostics.test.js` — pass, exit 0
- `game/session/authoritativeEntryPaymentView.test.js` — pass, exit 0
- `game/session/authoritativePaymentView.test.js` — pass, exit 0
- `tonconnect/telegramMiniAppGramWalletHandoff.test.js` — 9/9 pass, exit 0
  (Page4 source-structure assertions unaffected).

Server (Testnet payment-related):

- `tests/paymentSessionRoomNetwork.test.js` — 5/5 pass, exit 0 (TESTNET room
  commits `PaymentSession.network = "testnet"`; MAINNET room commits
  `"mainnet"`; `TON_NETWORK` cannot override the room selection; missing
  network fails closed; bridge payload wiring).
- `tests/entryPaymentSession.test.js` — pass, exit 0.

Pre-existing failures observed on this working tree, all unrelated to this
task (verified: none of these test files import
`buildEntryPaymentTransaction.js`, `Page4Payment.jsx`, or read Page4 source;
they exercise untouched legacy deposit/GameEscrow and player-identity
modules):

- `client/src/game/playerUI/playerUI.productionIdentity.test.js` —
  "PLAYER_UPDATE locates by authoritative playerId" (stops the full client
  suite alphabetically before the payment tests).
- `client/src/payment/buildDepositDeploymentTransaction.test.js` — exit 1.
- `client/src/payment/buildFundDepositTransaction.test.js` — exit 1.
- `client/src/payment/page4DepositActivationHandoff.test.js` — exit 1.
- `client/src/game/session/page4GameEscrowAuthoritativeState.test.js` — exit 1.
- `client/src/game/session/staleDepositGameStart.r18s16.test.js` — exit 1
  (e.g. "GAME_START still clears deposit; live 2/3 rehydrate disables
  FundSeat": `false !== true`).
- `server/tests/roomWalletOnlyPlayerPayment.r18s72.test.js` — 4 failing
  subtests (e.g. "TON_NETWORK must be explicitly set to testnet or mainnet
  for Room Wallet payments" from `RoomWalletRuntimeResolver`), and the
  process hangs after failing (leaked handles). Pre-existing; out of scope.

## 9. Confirmations

- Testnet destination remains server-authoritative: YES —
  `resolvePlayerPaymentDestination({ paymentSession, localPlayerId })` ->
  `paymentSession.roomWalletAddress`; asserted by existing tests.
- Testnet amount remains server-authoritative and unchanged: YES —
  `requiredGram: paymentRequest?.requiredGram` from the paymentSession
  snapshot; no amount calculation added (`buildTonConnectPaymentTransaction`
  untouched).
- Missing/invalid `paymentSession.network` fails closed: YES — the builder
  throws before constructing anything and the request converter throws again;
  no silent default to Mainnet; covered by dedicated unit tests and the
  REGRESSION test.
- No smart-contract payment path restored: YES — GameEscrow, DepositContract
  and DepositPackage payment logic remain disabled (`allowDeploy`/`allowFund`
  hard-coded `false`, payload builders still throw); no contract imports,
  addresses or stateInit were reintroduced.
- No Mainnet deployment/configuration added: YES — only the `-239` constant
  mapping for helper completeness; no registries, env, Vercel or Railway
  changes; no push performed.
- Diagnostics safety: the catch block logs only `roomId`, `playerId`,
  `paymentSession.network`, `errorName`, `errorCode`, `errorMessage`; the raw
  error object is never logged; no keys/mnemonics/secret material can leak.

## 10. Changes Made

- `client/src/payment/buildEntryPaymentTransaction.js` — network->chain-id
  mapping (fail-closed), `network` carried on the transaction object and in
  the TonConnect request.
- `client/src/pages/Page4Payment.jsx` — authoritative network passed to the
  builder; safe structured diagnostic logging in the `sendTransaction` catch
  block; user-facing error behaviour unchanged.
- `client/src/payment/buildEntryPaymentTransaction.test.js` — updated and
  extended focused tests (network mapping, fail-closed, regression,
  field-whitelist, validUntil).
- `client/src/game/session/page4PaymentPhase.test.js` — added Page4 source
  wiring assertion for the authoritative network.
- `AI_CONTEXT/CLINE_REPORTS/2026-09-28_page4_tonconnect_network_binding_testnet.md`
  — this report.

No server files, no configuration files, and no other client files were
modified by this task.

## 11. Git Status / Commit

- Pre-existing working-tree state (from earlier stages, deliberately NOT
  included in this commit): modified `server/gameplay/PaymentSessionManager.js`,
  modified `server/socket/RoomLobbyBridge.js`, untracked
  `server/tests/paymentSessionRoomNetwork.test.js` and untracked
  `AI_CONTEXT/CLINE_REPORTS/2026-09-27_*.md` / `2026-09-28_*.md` reports.
  Because `git add .` would have bundled that unrelated prior-stage server
  work into this payment commit, only this task's files (the four code/test
  files above plus this report) were staged.
- Commit: `fix(payment): bind Page4 transaction to authoritative network`
  (single commit; hash recorded in the handoff summary since a file cannot
  contain its own commit hash — verify with `git log --oneline -1`).
- No push performed (per task instruction).