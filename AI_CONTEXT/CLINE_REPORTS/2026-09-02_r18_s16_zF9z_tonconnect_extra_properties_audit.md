# R18-S16 — TESTNET zF9z TonConnect Extra-Property Audit

Date: 2026-09-02

Task: Forensic-only diagnosis of room `zF9z` / `game_8ab47031-675a-4a28-a8b3-dddcf3f4fc26` still showing `TON_CONNECT_SDK_ERROR` / `Request contains extra properties` after `e52b737`.

```text
NONE
```

No source edits. No commit. No push. No deploy. No TESTNET transaction.

---

## 1. Executive Verdict

```text
DEPLOYMENT_STALE
```

The live TESTNET Telegram WebApp is still serving the `origin/main` one-wallet build (`070181d`). That build passes `{ validUntil, messages, totalNanotons }` into `tonConnectUI.sendTransaction()`. Commit `e52b737` exists only on `cursor/strip-tonconnect-extra-properties` and is not an ancestor of `origin/main`.

---

## 2. Actual TESTNET Deployment

```text
URL:          https://wheelwin-nine.vercel.app
Deployment:   Vercel production (Server: Vercel, X-Vercel-Cache: HIT)
Commit:       source-equivalent to 070181d (origin/main). Vercel git SHA is not printed in the HTML shell.
Branch:       origin/main  (070181d). e52b737 is NOT on this branch.
Build:        /assets/index-DvzG8B-e.js
              HTML ETag e141f922fe3f1f48fd7968798681f872
              JS   ETag d75a378b18f06886e74623d157025643
Timestamp:    Last-Modified Wed, 02 Sep 2026 13:30:05 GMT (HTML)
              Last-Modified Wed, 02 Sep 2026 13:30:06 GMT (JS)
```

Backend used by this Mini App remains Railway `https://wheelwin-production.up.railway.app` (established by prior R18-S16 reports; `clientOrigin` includes this Vercel host). No `zF9z` diagnostic log files were present in the workspace.

`e52b737` commit time: `2026-09-02 18:08:05 +0300` = `15:08 UTC`. That is **after** the live asset `Last-Modified` of `13:30 UTC`.

---

## 3. e52b737 Presence

```text
Present in deployed build: NO
```

Evidence:

- `git merge-base --is-ancestor e52b737 origin/main` → not an ancestor.
- `origin/main` Page4 still contains `tonConnectUI.sendTransaction(transactionObject)`.
- Live bundle `/assets/index-DvzG8B-e.js` contains `totalNanotons` (4 hits) and `i.sendTransaction(t)` where `t` is the builder return.
- Live bundle `tonConnectTransaction` count = **0**.

```text
DEPLOYED CODE CONTAINS FIX = NO
```

TESTNET `zF9z` ran an older production build because the fix was pushed only to `origin/cursor/strip-tonconnect-extra-properties`. Vercel production is the `main` SPA. Pushing the feature branch does not update `https://wheelwin-nine.vercel.app`.

---

## 4. Actual sendTransaction Path

Deployed (`070181d` / live bundle):

```text
Page4 handleConfirmInTelegramWallet
  → buildEntryPaymentTransaction(...)
  → transactionObject = { validUntil, messages, totalNanotons }
  → no strip
  → tonConnectUI.sendTransaction(transactionObject)
  → @tonconnect/sdk vo() / SendTransactionRequest validator
  → throw [TON_CONNECT_SDK_ERROR] SendTransactionRequest validation failed: Request contains extra properties
```

Local unreleased `e52b737` (not deployed):

```text
Page4
  → buildEntryPaymentTransaction(...)
  → { totalNanotons, ...tonConnectTransaction }
  → sendTransaction(tonConnectTransaction)
```

There is exactly one Page4 `sendTransaction` call site. No second Page4 payment path, no wrapper that re-adds fields, no service worker.

---

## 5. Actual Runtime Request

From the live minified builder + Page4 send path:

```text
sendTransaction() received:

{
  validUntil,      // number
  messages,        // array (creator: 3 messages)
  totalNanotons    // application helper string — NOT a TonConnect field
}
```

Creator `messages` remain:

```text
[0] DepositContract StateInit deploy
[1] FundSeat
[2] GameEscrow STAKE
```

This matches Olga’s displayed `PAY 1.021 TON` (0.01 + 0.011 + 1.000). Amount math is not the failure.

No browser instrumentation of session `zF9z` was available. The object above is the actual constructed object in the **deployed** JS, not a type-level inference.

---

## 6. Rejected Property

```text
totalNanotons
```

Deployed SDK validator (`vo`):

```text
allowed top-level keys = validUntil | network | from | messages | items
if any other key exists → "Request contains extra properties"
```

Thrown as:

```text
[TON_CONNECT_SDK_ERROR]
SendTransactionRequest validation failed: Request contains extra properties
```

(User-facing text used `sendTransactionRequest`; the bundled string is `SendTransactionRequest`.)

This is **not** a per-message extra-property error (`Message at index N contains extra properties`). It is the top-level request validator rejecting `totalNanotons`.

---

## 7. TonConnect SDK

```text
package:  @tonconnect/ui-react  (depends on @tonconnect/ui 3.0.0 → @tonconnect/sdk 4.0.0)
version:  lockfile @tonconnect/sdk 4.0.0, @tonconnect/ui 3.0.0, @tonconnect/protocol 3.0.0
deployed: bundle constants Va=`4.0.0` (sdk) and Ub=`3.0.0` (ui)
```

No local vs deployed SDK mismatch. The same 4.0.0 validator is what rejects extra keys. Telegram WebView is not a different SDK; it hosts this bundle.

---

## 8. Player 2/3 Button State

```text
Player 2/3 button absence = EXPECTED
```

`canFundSeat()` / `canIncludeFundSeatInEntry()` still require Deposit activation verification for non-creators. `canSubmitEntryPayment()` returns false for Lena/Bob while `activationStatus` is not `VERIFIED` / `ALREADY_VERIFIED`. `shouldShowEntryAction` is true only in `ENTRY_PAYMENT`. Creator Olga can still see `PAY 1.021 TON` via `canDeployDeposit` + same-tx FundSeat + STAKE. Do not change this gate.

---

## 9. Files Inspected

- Live `https://wheelwin-nine.vercel.app/` HTML + `/assets/index-DvzG8B-e.js`
- `origin/main` vs `e52b737` Page4 (`git show origin/main:client/src/pages/Page4Payment.jsx`)
- `client/src/pages/Page4Payment.jsx` (current branch = fix, not deployed)
- `client/src/payment/buildEntryPaymentTransaction.js`
- `client/src/payment/buildDepositDeploymentTransaction.js`
- `client/src/payment/buildFundDepositTransaction.js`
- `client/src/payment/buildTonConnectPaymentTransaction.js`
- `client/src/game/session/page4PaymentPhase.js`
- `client/package.json` / `client/package-lock.json`
- `client/src/main.jsx`
- `vercel.json` / `client/vercel.json`

---

## 10. Changes Made

```text
NONE
```

---

## 11. Commit

```text
NONE
```

---

## 12. Final Root Cause

Olga’s wallet never opened because the production Vercel bundle still runs the `070181d` Page4 path that sends `totalNanotons` into `@tonconnect/sdk` 4.0.0. That SDK allow-lists only `validUntil`, `network`, `from`, `messages`, and `items`, so it throws before any blockchain send. `e52b737` correctly strips the field locally but was never merged to `main` and is not in the `13:30 GMT` production assets that Telegram loaded.

Causal chain:

```text
TESTNET session zF9z
    ↓
https://wheelwin-nine.vercel.app
    ↓
assets Last-Modified 2026-09-02 13:30:06 GMT / index-DvzG8B-e.js
    ↓
git origin/main = 070181d (e52b737 not present)
    ↓
Page4 → buildEntryPaymentTransaction → sendTransaction({ validUntil, messages, totalNanotons })
    ↓
@tonconnect/sdk 4.0.0 vo() extra-key check
    ↓
SendTransactionRequest validation failed: Request contains extra properties
```
