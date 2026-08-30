# R18-S16 — Gram Wallet TESTNET Telegram Mini App Handoff Fix

Date: 2026-08-30

Task: Fix Telegram Mini App → Gram Wallet TESTNET TonConnect handoff. Gram Wallet remains required. Do not switch to Telegram Wallet. Do not change Page4 financial state machine or server financial lifecycle.

Classification: **IMPLEMENTATION**. Real Mini App TESTNET of the deployed fix is recorded separately below.

---

## 1. Scope

Fix the proven `MtJn` / `ytr` failure: Gram Wallet universal link is generated, then the Mini App unloads (`pagehide_beforeunload`) with no wallet callback.

Preserve:

- Gram Wallet in the TonConnect wallet list
- TESTNET
- TonConnect connect lifecycle
- ADDRESS_MISMATCH
- bvc / ger successful connect paths (`t.me` Telegram Wallet is not intercepted)

Out of scope: Page4 Deposit / FundSeat / GameEscrow / OPEN_PAGE5.

---

## 2. Files Inspected

- `client/src/pages/Page4Payment.jsx` — `handleOpenTonConnectLink`, connector wrap
- `client/src/main.jsx` — TonConnect provider bootstrap
- `client/src/ads/openAdvertisementDestination.js` — existing Mini App `WebApp.openLink` pattern
- `client/src/diagnostics/tonConnectAutopsy.js` — `pagehide_beforeunload`
- `@tonconnect/ui` `redirectToWallet` / `openLink` / `sendOpenTelegramLink` (dependency)
- Official Telegram Mini Apps docs: `https://core.telegram.org/bots/webapps` (`WebApp.openLink`)
- Official wallets list `gramwallet` entry
- `AI_CONTEXT/CLINE_REPORTS/2026-08-30_r18_s16_telegram_wallet_handoff_diagnosis.md`

---

## 3. Architecture Findings

`@tonconnect/ui` `connector.connect()` returns the Gram HTTPS universal link, then `redirectToWallet` calls `window.open` with `_self` (deeplink `gramwallet-tc://`) or `_blank` (HTTPS). Telegram `openTelegramLink` only accepts `t.me` hosts, so Gram never uses that API. `WebApp.openLink` is the documented Mini App API for HTTPS URLs and **does not close the Mini App**.

The production fix patches `window.open` in Mini App so Gram URLs call `WebApp.openLink` instead of navigating the WebView.

---

## 4. Lifecycle Flow

```text
CONNECT TELEGRAM WALLET → openModal → user selects Gram Wallet
  → connector.connect({ universalLink, bridgeUrl })
  → universal link string (QR_UNIVERSAL_LINK_CAPTURED)
  → @tonconnect/ui window.open(gramwallet-tc://|_blank https)
       intercepted in Mini App
  → Telegram.WebApp.openLink(https://connect.gramwallet.io/?…)
  → Mini App stays loaded; Gram Wallet opens externally
  → TonConnect SSE bridge callback
  → onStatusChange → WALLET_CONNECT_REPORT (only after real wallet)
```

---

## 5. Ownership Boundaries

- Handoff module: URL classification and Mini App `openLink` only.
- `@tonconnect/ui`: still generates the link and owns the connect session.
- Server: still the only wallet verifier. No client fake CONNECTED.

---

## 6. Risks

- **High** — `WebApp.openLink` must run from a user gesture (wallet tile click). If the SDK opens after an async gap, Telegram may ignore `openLink`. The Page4 “Open Wallet” button remains a second gesture.
- **Medium** — Desktop Telegram + Gram Wallet (`platforms: ios, android` in the registry) may still fail at the wallet app, not in WheelWin.
- **Low** — Interceptor is Gram-host-only; `t.me/wallet` is unchanged for bvc-style connects.

---

## 7. Recommendations

Operator: after Vercel ships `3f990b2`, run a **fresh** Mini App TESTNET room (not `MtJn`), select Gram Wallet, confirm Mini App does not unload, then continue Page4 financial flow.

---

## 8. Changes Made

- `client/src/tonconnect/telegramMiniAppGramWalletHandoff.js` (new)
- `client/src/tonconnect/installTelegramMiniAppGramWalletHandoff.js` (new)
- `client/src/tonconnect/telegramMiniAppGramWalletHandoff.test.js` (new)
- `client/src/main.jsx` — install before `TonConnectUIProvider`
- `client/src/pages/Page4Payment.jsx` — `handleOpenTonConnectLink` uses `launchGramWalletHandoff`

Page4 payment-phase machine, server financial files, wallet registry: **not modified**.

---

## 1. ORIGINAL FAILURE

**SOURCE VERIFIED** (session dump + prior diagnosis).

Room `MtJn`, player `ytr`: Gram universal link generated → no wallet event → `pagehide_beforeunload` → room timeout `ROOM_DESTROYED` / `finalStage = TONCONNECT`.

---

## 2. EXISTING FORENSIC EVIDENCE

**SOURCE VERIFIED.**

```text
CONNECTOR_CONNECT_BEFORE
CONNECTOR_CONNECT_AFTER
QR_UNIVERSAL_LINK_CAPTURED
universalLink host: connect.gramwallet.io
bridge: tonconnectbridge.mytonwallet.org/bridge/
sdkErrors = [] / browserErrors = [] / walletEvents = []
flushReason = pagehide_beforeunload
```

bvc: CONNECTED. ger: CONNECTED then ADDRESS_MISMATCH. Handshake not universally broken.

---

## 3. ROOT CAUSE CONFIRMATION

**SOURCE VERIFIED.**

Gram Wallet is an HTTP-bridge wallet (`connect.gramwallet.io`, not `t.me`). `@tonconnect/ui` `redirectToWallet` uses `window.open(_self|_blank)`. Mini App WebView treats that as document navigation → `pagehide`. `Telegram.WebApp.openTelegramLink` cannot open `connect.gramwallet.io`.

Correct mechanism: `Telegram.WebApp.openLink(httpsUrl)` — Mini App remains open (Telegram Bot API docs).

---

## 4. CURRENT IMPLEMENTATION

**SOURCE VERIFIED.**

| Path | Behavior |
|---|---|
| SDK after `connect()` | `window.open` (now intercepted in Mini App for Gram URLs) |
| Page4 Open Wallet | `launchGramWalletHandoff` |
| Ordinary browser | unchanged `window.open` / `<a target="_blank">` |
| `t.me` Telegram Wallet | not classified as Gram; interceptor passes through |

---

## 5. CORRECT TELEGRAM MINI APP HANDOFF MECHANISM

**SOURCE VERIFIED** (repo ads already use `WebApp.openLink`; Telegram docs).

```text
Telegram Mini App WebView
  → WebApp.openLink("https://connect.gramwallet.io/?…")
  → external browser / Gram Wallet
  → Mini App NOT closed
  → SSE bridge → ConnectEvent
```

`gramwallet-tc://` is rewritten to `https://connect.gramwallet.io/` + original query (TonConnect `v`, `id`, `r`, `ret` preserved). Query tokens are not copied into this report.

External documentation (not repo):

- https://core.telegram.org/bots/webapps — `openLink`: “The Mini App will not be closed.” HTTPS only. User-interaction required.
- `@tonconnect/ui` `tma-api.ts` `sendOpenTelegramLink` rejects non-`t.me` hosts.

---

## 6. PRODUCTION CHANGE

**SOURCE VERIFIED.**

Commit `3f990b28446ec8f8ec7f1eb0a0f658d59f0f33c4` — `Fix Gram Wallet Telegram Mini App handoff`.

Smallest change: Gram-only Mini App `openLink` + `window.open` patch installed before TonConnect UI. No fake wallet, no `WALLET_CONNECT_REPORT` without a real ConnectEvent.

---

## 7. FOCUSED TESTS

**UNIT TEST VERIFIED.**

```text
node --import ./scripts/register.js src/tonconnect/telegramMiniAppGramWalletHandoff.test.js
```

```text
9 pass / 0 fail
```

Coverage:

- Gram HTTPS + `gramwallet-tc://` recognized
- deeplink rewrite to `connect.gramwallet.io` with query preserved
- Mini App uses `openLink`, not `window.open`
- `t.me/wallet` not claimed
- ordinary browser still `window.open`
- interceptor blocks Mini App `_self` Gram navigation
- `main.jsx` installs before `TonConnectUIProvider`; Page4 calls `launchGramWalletHandoff`

Does **not** mock CONNECTED.

`page4PaymentPhase.test.js`: 9 pass (payment machine unchanged).

---

## 8. BUILD RESULT

**SOURCE VERIFIED.**

```text
git diff --check   exit 0 (CRLF warnings only)
npm run build      exit 0
```

Local production bundle: `dist/assets/index-E2msSIhK.js` (Vite hash; Vercel injects `VITE_SOCKET_URL` and will differ).

---

## 9. GIT COMMIT

**SOURCE VERIFIED.**

```text
3f990b28446ec8f8ec7f1eb0a0f658d59f0f33c4
Fix Gram Wallet Telegram Mini App handoff
```

Files: 5 (handoff module, installer, unit test, `main.jsx`, `Page4Payment.jsx` handoff only).

---

## 10. VERCEL DEPLOYMENT

**NOT VERIFIED** at report authoring of this section (filled after push). See post-push note at the end of this file if updated in the same working session.

---

## 11. FRESH TESTNET ROOM

**NOT VERIFIED.** Cursor/ordinary browser has empty `Telegram.WebApp.initData`. CREATE_ROOM requires Mini App identity. `MtJn` was not reused.

---

## 12. GRAM WALLET CONNECTION RESULT

**NOT VERIFIED** (real Telegram Mini App).

**UNIT TEST VERIFIED** for the launch decision (`telegram_openLink`).

---

## 13. SERVER WALLET VERIFICATION

**NOT VERIFIED.** No fake report emitted.

---

## 14. PAGE4 FINANCIAL FLOW

**NOT VERIFIED.** Blocked on real wallet connect.

---

## 15. DEPOSIT ACTIVATION

**NOT VERIFIED.**

---

## 16. FUNDSEAT × 3

**NOT VERIFIED.**

---

## 17. DEPOSIT_FULL

**NOT VERIFIED.**

---

## 18. GAMEESCROW

**NOT VERIFIED.**

---

## 19. STAKE × 3

**NOT VERIFIED.**

---

## 20. PAYMENT_SESSION_COMPLETED

**NOT VERIFIED.**

---

## 21. OPEN_PAGE5

**NOT VERIFIED.**

---

## 22. DEBUG / LOG EVIDENCE

**UNIT TEST VERIFIED** (Node assertions).

**REAL TESTNET VERIFIED** — not available from this environment.

Expected post-fix Mini App autopsy (operator):

```text
QR_UNIVERSAL_LINK_CAPTURED
  → (no immediate pagehide)
  → ON_STATUS_CHANGE_WALLET
  → WALLET_CONNECT_REPORT_EMITTED
  → SERVER_SYNCHRONIZED
```

If `pagehide_beforeunload` still follows immediately after the Gram link, record `WebApp.platform` and stop; do not speculate a second code change in the same task.

---

## 23. FINAL GIT STATE

```text
HEAD  3f990b28446ec8f8ec7f1eb0a0f658d59f0f33c4
      Fix Gram Wallet Telegram Mini App handoff
```

Unrelated dirty files (banners, probes, other reports) were not committed.

---

## 24. REMAINING BLOCKER, IF ANY

**BLOCKED** on real Telegram Mini App TESTNET:

1. This agent cannot open a signed Mini App (`initData` length 0 in ordinary browser).
2. Full Page4 financial E2E therefore cannot run here.

Production fix is in git; Vercel must serve `3f990b2` (or a later docs commit) before the operator retest.

---

## 25. FINAL VERDICT

```text
R18_S16_GRAM_WALLET_HANDOFF_BLOCKED
```

Meaning: the handoff **code** is implemented and unit-tested; **real** Telegram Mini App Gram Wallet connection and Page4 E2E are **not** proven. Do not read this as “the real test failed after reaching Gram Wallet.” The real test was not executed.

If a later operator run connects Gram Wallet in Mini App but Page4 finance stops, change the verdict to `R18_S16_GRAM_WALLET_HANDOFF_VERIFIED_PAGE4_E2E_BLOCKED`. If the full path reaches Page5, use `R18_S16_GRAM_WALLET_TESTNET_VERIFIED`.
