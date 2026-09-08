# Page4 TonConnect sendTransaction forensic capture (r18-s90)

Date: 2026-09-08

Task: Diagnostics-only: when Page4 `tonConnectUI.sendTransaction()` rejects, persist the original error object and exact send-attempt context into the existing TonConnect autopsy. Do not change the wallet request, payment amounts, destinations, retries, reconnects, or `PAYMENT_CONFIRM_INTENT` timing.


## 1. Scope

Investigated the Player3/Bob Page4 payment failure in production test room QWXS. Changed only the client forensic capture around the existing `sendTransaction()` rejection path. No server, Room Wallet, amount, destination, recovery, or TonConnect lifecycle changes. No blockchain writes.


## 2. Files Inspected

- `client/src/pages/Page4Payment.jsx` (`handleConfirmInTelegramWallet`, `dumpTonConnectError`, `dumpRawTonConnectAutopsyObject`)
- `client/src/diagnostics/tonConnectAutopsy.js` (`pushAutopsySdkError`, `pushAutopsyRawObject`, `captureErrorForensic`)
- `client/src/payment/page4DepositDeployDiagnostics.js`
- `client/src/payment/buildEntryPaymentTransaction.js` (`toTonConnectSendTransactionRequest`)
- `AI_CONTEXT/CLINE_REPORTS/2026-09-07_r18_s87_room_wallet_address_identity_security_audit.md` (not modified; payment identity unchanged)


## 3. Architecture Findings

### Problem statement

Bob’s Page4 pay failed in QWXS with a visible autopsy timeline event `PAGE4_SEND_TRANSACTION_VALIDATION` and message `[TON_CONNECT_SDK_ERROR] e` / `Unhandled error`, while `sdkErrors` and `rawObjects` stayed empty. The wallet never broadcast; Olga and Lena paid; Room Wallet dest was correct; Bob stayed `AWAITING_PLAYER_CONFIRMATION`.

### QWXS evidence that motivated the change

- Room `QWXS`, game `game_d658fd51-7ea6-42c1-8352-cac57dfc45c3`, Bob playerIndex `2`
- Wallet `EQAtggW7l5wfQcPyy38Y7mVuXnh0wRHcpFKPIdtCbcRHb8wM` VERIFIED
- Room Wallet `EQDGQjwaP0OSExa9MfZih61De5TQuUITQPYiYZyfqAFzpvQB`, testnet, 1 TON
- Timeline: reused TonConnect session (`SDK_ALREADY_CONNECTED` → `REUSE_EXISTING_WALLET` → `SERVER_SYNCHRONIZED`) then `PAGE4_SEND_TRANSACTION_REQUEST` then ~5s later `PAGE4_SEND_TRANSACTION_VALIDATION` with truncated Unhandled error
- Same autopsy session reused from the previous day
- No Bob inbound on the Room Wallet

### Exact code path

`buildEntryPaymentTransaction` → `toTonConnectSendTransactionRequest` → diagnostic logging → `await tonConnectUI.sendTransaction(tonConnectTransaction)` → success emits `PAYMENT_CONFIRM_INTENT`; catch previously only sliced `error.message` to 240 chars into `PAGE4_SEND_TRANSACTION_VALIDATION`.

### Why `sdkErrors: []` despite Unhandled error

`dumpTonConnectError()` already calls `pushAutopsySdkError()` / `pushAutopsyRawObject()`. The send catch never called it. Only `pushAutopsyTimeline` with `validationError = String(error?.message).slice(0, 240)` ran, so the archive showed a short SDK string and empty `sdkErrors`/`rawObjects`.

`pushAutopsySdkError` / `pushAutopsyRawObject` were already sufficient to persist a serialized forensic snapshot. Minimal extra: `captureErrorForensic` now also copies `ERROR_PROPERTY_CANDIDATES` (cause/payload/code/…) into `raw` when JSON own-properties omit them.


## 4. Lifecycle Flow

Unchanged financially:

build request → convert to TonConnect keys → forensic describe (read-only) → `sendTransaction(tonConnectTransaction)` unchanged → wallet result OR catch → `PAYMENT_CONFIRM_INTENT` only after successful return.

On send rejection (`sendAttempted === true`): `dumpTonConnectError("PAGE4_SEND_TRANSACTION_REJECTION", originalError, context)` then timeline `PAGE4_SEND_TRANSACTION_REJECTION`. Existing truncated `PAGE4_SEND_TRANSACTION_VALIDATION` timeline entry remains. User-facing `setDepositSubmitError` unchanged.


## 5. Ownership Boundaries

- Forensic store: `window.__TONCONNECT_AUTOPSY__` + existing snapshot transport
- Payment authority: still server Payment Session / Room Wallet observer
- Client still does not invent dest/amount or confirm payment on send failure


## 6. Risks

- **Low:** Autopsy payloads are larger (full error JSON + request context). Snapshot caps (`rawObjects` 80, persist slice 40) still apply.
- **Informational:** Root cause of QWXS Unhandled error is still unknown until this capture runs in production.
- **Informational:** Full `npm test` hit an unrelated pre-existing failure in `playerUI.productionIdentity.test.js` (PLAYER_UPDATE locates by authoritative playerId). Not caused by this change; not fixed here.


## 7. Recommendations

Reproduce Bob’s Page4 pay on a deployed client that includes this commit and export the autopsy. Inspect `sdkErrors[0].raw` and `PAGE4_SEND_TRANSACTION_REJECTION` context (validUntil remaining, chain, reused session, dest/amount). Then decide whether a real wallet/SDK fix is warranted. Do not change the send request until that evidence exists.


## 8. Changes Made

Files:

- `client/src/pages/Page4Payment.jsx`
- `client/src/payment/page4DepositDeployDiagnostics.js`
- `client/src/diagnostics/tonConnectAutopsy.js`
- `client/src/payment/page4DepositDeployDiagnostics.test.js`
- `client/src/diagnostics/tonConnectAutopsy.test.js`
- `client/src/game/session/page4PaymentPhase.test.js`

Diagnostic behavior added:

- Before send: read-only request structure (keys, message count, dest, amount, payload/stateInit presence, validUntil, now, remaining seconds, network, wallet chain) plus player/room/wallet/device/session context. Stored as timeline + `rawObjects` kind `page4SendTransactionRequest`. Request object is not mutated and is still passed as `tonConnectTransaction` only.
- On send rejection: original thrown value passed to `dumpTonConnectError` unchanged; event `PAGE4_SEND_TRANSACTION_REJECTION`.
- `captureErrorForensic` copies known nested forensic fields into `raw`.

Confirmations:

- Actual TonConnect request construction (`toTonConnectSendTransactionRequest`) was not changed. No `network` added to the send payload. Single `sendTransaction` call. No retry/reconnect.
- Payment flow unchanged: confirm intent only after successful send; catch does not emit confirm.
- No secrets/mnemonics/tokens/walletStateInit in forensic context.

Tests (all passed):

- `src/payment/page4DepositDeployDiagnostics.test.js` (6)
- `src/diagnostics/tonConnectAutopsy.test.js` (2)
- `src/game/session/page4PaymentPhase.test.js` (18)
- `src/payment/buildEntryPaymentTransaction.test.js` (11)

Build: `npx vite build` succeeded (`✓ built in 8.74s`). Chunk-size warning unchanged.

Commit / push: filled after git.

Remaining uncertainty: the live TonConnect Unhandled error payload is still unknown until production capture. QWXS itself was not replayed. No TON was sent.

Explicit: **no blockchain transaction was performed.**
