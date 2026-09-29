# MAINNET REFUND VALIDATION — Failed-Game Room Wallet Refund Operator Procedure

**Date:** 2026-09-30
**Scope:** Mainnet (`TON_NETWORK=mainnet`) Room-Wallet-only player finance
**Baseline commit:** `810372b060b4e1cfcd4178e8c1fc62947c696a36` (branch `payment/room-wallet-integration`)
**Reference (Testnet model):** `docs/R17.8O2_REAL_TESTNET_REFUND_VALIDATION.md`
**Related:** `AI_CONTEXT/CLINE_REPORTS/2026-09-29_room_wallet_refund_player_wallet_reconciliation.md` (Stage 1), `AI_CONTEXT/CLINE_REPORTS/2026-09-29_stage2_refund_reconciliation_provenance.md` (Stage 2)

---

## 1. Purpose

Mainnet failed-game refunds MUST follow the same validation model already
established and documented for Testnet. This document defines the authoritative
Mainnet operator verification chain, including the FINAL HUMAN verification
step on the TON Explorer.

Player finance on Mainnet is Room-Wallet-only. There is no GameEscrow
player-payment path and none is introduced by this procedure.

---

## 2. Authoritative Mainnet refund verification chain

```
Room Wallet outbound history
   ↓
Player wallet inbound reconciliation (when required)
   ↓
Refund broadcast (same Room Wallet)
   ↓
TON Center on-chain confirmation (automated)
   ↓
TON Explorer final MANUAL verification (operator)
```

Stages 1–4 are automated in server code. Stage 5 is a FINAL HUMAN step —
it never replaces Stage 4 and never authorizes money movement.

---

## 3. Stage 1 — Automated Room Wallet outbound history inspection

Owner: `RoomWalletSettlementAdapter` (`server/payment/roomWallet/RoomWalletSettlementAdapter.js`).

- The adapter first inspects the refunding Room Wallet's OWN outbound history:
  `getTransactions(roomNumber, { limit: 40, archival: true })` via
  `RoomWalletAdapter` (read-only; signing material never leaves the resolver).
- `extractOutboundTransfers(tx)` (`roomWalletTerminalRecoveryChain.js`) yields
  candidates matched strictly against: refund success, non-bounced, exact
  `amountNano`, exact destination (`tonWalletAccountsEqual`), `utime` after the
  ms→s-normalized refund cutoff.
- On a match the existing transaction is adopted (`REFUND_ADOPTED`) and NO new
  refund is broadcast.

## 4. Stage 2 — Player-wallet inbound reconciliation (fallback, when required)

- When the Room Wallet outbound history contains no matching refund, the
  DESTINATION player wallet's inbound history is inspected (read-only):
  `RoomWalletAdapter.getAddressTransactions(playerWallet, { limit: 40, archival: true })`
  + `extractInbound(tx)`.
- A strictly-matching inbound transaction (same exactness rules as Stage 1)
  is adopted as an already-completed refund with provenance
  `PLAYER_WALLET_INBOUND` (`REFUND_RECONCILED_FROM_PLAYER_WALLET`), recorded
  in `session.recoveryMetadata.refundReconciliations[]` and in the operator
  log line `ROOM_WALLET_REFUND_RECONCILED`.
- No second refund is broadcast when reconciliation succeeds.

## 5. Stage 3 — Refund broadcast from the same Room Wallet

- Fresh refunds are broadcast ONLY by `RoomWalletAdapter.sendTransfer` from the
  SAME Room Wallet assigned to the room (`roomNumber` → `RoomWalletRegistry` →

---

## 7. Stage 5 — FINAL MANUAL verification on the TON Explorer (operator)

**This is a FINAL HUMAN VERIFICATION step performed by the operator AFTER
Stage 4 reported success. It is NOT an automated step and MUST NOT replace the
TON Center confirmation.**

Mainnet Explorer base (existing network preset, `explorerBaseUrl`):
**https://tonviewer.com**

Procedure:

1. Open the Developer Console (`/debug`) → **History** → open the failed
   session record → section **“TON Explorer Verification (Manual)”**.
   The console lists the transaction hashes already recorded in the session
   archive together with operator-facing links (display-only).
2. For EACH refund transaction relevant to the failed game (and, when needed,
   the stake payments), open the explorer reference and record in the
   validation log:

| Field | Source on Explorer | Example shape |
|-------|--------------------|---------------|
| Transaction hash | Explorer transaction page | 64-hex |
| Source address | From (sender) | `EQ…`/`UQ…` |
| Destination address | To (recipient) | `EQ…`/`UQ…` |
| Transfer amount | Value (TON) | decimal TON |
| Transaction success / non-bounce state | Status / no `bounced` marker | success |
| Timestamp | Explorer UTime | UTC |

3. Cross-check each recorded refund against the expected target: the refund
   must originate from the SAME Room Wallet that received the player's stake
   and land on the player's wallet with the expected amount.
4. Record the manual verdict (PASS/FAIL) in the game's validation notes.

Hard rules for Stage 5:

- WheelWin does NOT read Explorer data back into the system. There is no
  automated Explorer ingestion anywhere in the codebase.
- WheelWin does NOT create any “Explorer confirmed” status. The only automated
  statuses come from TON Center confirmation (Stage 4).
- Explorer confirmation is NEVER an authorization condition for sending money.
  Refunds are gated exclusively by the existing Room Wallet financial logic
  and Stage 4 confirmation. Stage 5 is post-hoc operator verification only.

---

## 8. Operator checklist (complete Mainnet failed-game validation)

1. Confirm the Mainnet backend deploy includes the Room-Wallet-only refund
   chain (commit ≥ baseline above) and that `/console/auth/status` shows
   `enabled=true`, `openAccess=false`, `environment=MAINNET`.
2. Open `/debug` (Developer Console SPA) and sign in with the operator
   Developer credentials.
3. Reproduce / identify the failed game (partial payment failure, payment
   timeout, creator leave, setup expiry) and let the automated chain run.
4. In Developer Console logs confirm the automated sequence: refund attempt →
   outbound-history inspection → (fallback) player-wallet inbound
   reconciliation → broadcast → `confirmPayoutOnChain` success.
5. Open **History** → session record → **“TON Explorer Verification
   (Manual)”**; for each listed transaction hash perform the Stage 5 table
   and record the six fields.
6. Where the archive contains no hash for a required refund (refund hashes are
   not persisted into the immutable archive by design), pull the hash from the
   server log (`ROOM_WALLET_REFUND_RECONCILED` / refund broadcast logs) or the
   persisted payment-session record, then verify it on the Explorer the same
   way.
7. Record the overall verdict (PASS/FAIL) and keep the six-field table with
   the game's forensic notes.

---

## 9. Developer Console access model on Mainnet (same as Testnet)

- Browser route `/debug` is the Developer Console SPA route
  (`client/src/pages/PageDeveloperConsole.jsx` →
  `client/src/console/DeveloperConsole.jsx`).
- Included in a Vite production build only when
  `VITE_DEV_CONSOLE_ENABLED=true` (`client/src/config/devMode.js`); enabled on
  the Mainnet Vercel Production project (`wheelwin-main`) only.
- Authentication uses `/console/auth/*` (Administrator credentials) and all
  console data flows through the protected `/console/*` APIs.
- The legacy backend JSON endpoints `/debug/health` and `/debug/games` remain
  DEVELOPMENT-ONLY and return 404 in Mainnet production. This SPA/legacy
  distinction is intentional and must be preserved.

  `WalletContractV4` R2 identity). No other wallet and no smart-contract path
  participates in failed-game refunds.
- Idempotency: Stages 1–2 run before every broadcast attempt so a replayed
  refund request cannot double-pay.

## 6. Stage 4 — Automated TON Center on-chain confirmation

- After broadcast, the transfer is confirmed through the configured TON Center
  RPC: `confirmPayoutOnChain({ ... })`
  (`server/payment/roomWallet/roomWalletTerminalRecoveryChain.js`), Mainnet
  endpoint per the network preset
  (`server/payment/ton/networks/mainnet.js` →
  `https://toncenter.com/api/v2/jsonRPC`).
- Confirmation timeout: 60 s (`confirmationTimeoutMs`). A non-confirmed refund
  stays retryable (`REFUND_PENDING` / `ROOM_WALLET_REFUND_PENDING`); the Room
  Wallet is preserved and Stages 1–2 will adopt the transfer on retry once it
  actually landed.
- This stage is the ONLY automated financial confirmation. Its verdict is
  authoritative for code-level state.
