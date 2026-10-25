# WheelWin — Controlled TON Testnet three-player session (main)

**Prepared:** 2026-10-25  
**Target repository:** `navalvik/wheelwin`  
**Target branch:** `main`  
**Execution status:** **BLOCKED — preparation only; NO LIVE PAYMENT OR DEPLOYMENT AUTHORIZATION**

This is an operational preflight for a complete Testnet game; it is **not** a request to reactivate Railway, accept deposits, switch payment flags, merge PR #21 or make any GRAM transfers.

## 1. Verified external chain-history gate

A **read-only** scan of the real Testnet Room Wallet #1 from failed game `oj7v` was completed from an isolated cloud sandbox using the protected scanner in draft PR #21 (`fix/testnet-dual-chain-reconciliation`), not software running on `main`.

- Room wallet: `0:c6423c1a3f43921316bd31f66287ad437b94d0b9421340f622619c9fa80173a6`
- Window: session start `1792892394000` milliseconds UTC, with 15-second start margin.
- TonAPI: **3 descending pages, 6 observed transactions** using exclusive `before_lt`.
- TON Center v3: **3 descending pages, 6 observed transactions** using inclusive `end_lt` with previous oldest LT minus one.
- Page size: 2, hence pagination exercised beyond the first page.
- Both providers agreed on the wallet history head LT `105271924000001`, hash `decf4284978c28153475f4ac94668f77e233bed93d6aaf32f3ed9e737514565c`.
- Original deposits all matched (LT Olga `105264227000003`; Lena `105264234000003`; Bob `105264240000003`), with no unmatched provider transactions in the chosen session window.
- **Important discovered compatibility issue:** TON Center v3 encodes external-in wallet messages as `source:null, value:null, import_fee:"0"`; TonAPI encodes the same message with zero numeric value. PR #21 now recognizes that exact external-only form while still rejecting malformed internal payment evidence. The focused regression suite passed **33/33** after the fix. It is not yet merged into `main`.
- A TON Center HTTP 429 occurred during the initial unpaced scan; subsequent rate-limited requests completed. A provider failure must not mean zero payments.
- The scanner's `walletReleaseAuthorized` remained **false** as designed. Full history through session start does not, by itself, authorize reuse or payout.

## 2. Current main / infrastructure hard blockers

Confirmed without modifying deployments:

| Gate | Actual state | Action required before a real game |
| --- | --- | --- |
| Backend Railway `wheelwin` linked to `main` | Deployment `SUCCESS`, but start command intentionally parks Node in a `setInterval` loop; actual game backend **not running** | Explicitly authorize a controlled backend start only after the financial gates below pass |
| Main frontend Vercel project `wheelwin` | Production deployment `READY` for `main` commit `e12ec0acd931d86697682e8163972500e6a2e2d6` | Verify actual Telegram launch link and that it targets the authorized backend |
| Live payments in `main` | `LIVE_PAYMENT_ACCEPTANCE_ENABLED = false`, reason `REFUND_EXECUTION_NOT_READY` | **Do not flip flag alone.** Confirm a genuine signed-refund and payout implementation with restart recovery |
| Room timer defaults in `main` | 8 minutes | Align total Page2–Page4 deadline with the required **5 minutes**; test single authoritative server timer |
| Concurrent room default in `main` | 64 | Enforce **50 maximum** (and fewer when wallets are quarantined) |
| Deep dual-provider scanner in `main` | Not present; implemented in PR #21 instead | Integrate and validate an approved scoped candidate rather than merging the diverged 58-file PR wholesale |
| Old debt on Room Wallet #1 | Olga's refund confirmed; Lena and Bob unpaid as of the read-only check | Keep wallet #1 out of any new allocation until its obligations are resolved; no double-refund |
| Financial persistent volume | Railway `wheelwin-volume` at `/app/data/ton-financial` | Verify durability and single-writer ownership; never launch an independent signer against the same pool |
| Main narrow offline checks | 3 selected suites passing, but native SQLite installation unavailable in isolated sandbox because fetching Node build headers failed | Do **not** count this as full payment/recovery release certification |

Because these blockers remain, a new three-player live session **must not be started yet**.

## 3. Exact controlled-game procedure, after all gates pass

1. Obtain explicit go-ahead to start only the authorized Testnet backend, with no Mainnet activity or unrelated automatic financial workers.
2. Ensure the Telegram game opens the matching, verified frontend/backend; room **creation only inside Telegram**.
3. Use **exactly three real Telegram accounts**, Olga, Lena, Bob, connected on three devices. No browser-based room creation, no 1- or 2-player payment tests.
4. Select Testnet by default, a new game room with a **free, non-quarantined** room wallet, **one sector per player**, base stake **1 native GRAM** (all three must match).
5. Observe Page2 -> Page3 -> Page4. The **whole preparation/payment period is 5 minutes**; no timer resets on reconnection.
6. On Page4 all three independently sign transfers to the **one allocated room wallet**. Check that each confirmed inbound on-chain transaction has the correct wallet, source, native GRAM amount, unique LT/hash and session time.
7. Page5 may begin **only after all three distinct real payments are confirmed**, never after a one- or two-payer subtotal.
8. Once Page5 starts, confirm server-led gameplay finishes even with connectivity interruption, winner decided exactly once, and Page6 appears with FINISH (no automatic navigation by result timer).
9. Verify all payout receipts by block explorer / two-source monitor: for a 3 GRAM total, planned **2.85 GRAM winner share, 0.14 GRAM owner share and 0.01 GRAM reserved**, taking actual recipient-paid gas policy into account. Verify exact outgoing LT/hash, recipient and value; never infer payment from RPC ACK alone.
10. Confirm that a completed-game archive actually arrived in Cloudflare R2 and can be located by room/game identifier. Do not expose secrets in logs or archive.
11. Verify persistence and eventual wallet release only after complete independent evidence for all obligations, then run a separate **approved** wallet-reuse/restart scenario. Do not casually reuse a wallet with pending refunds or unknown outgoing signatures.

## 4. Stop / rollback criteria

- Backend and frontend route do not match, a Telegram creator cannot create a room, wrong network, or wallet assignment points to #1 or any quarantined wallet.
- Page4 missing payment button, discrepancy in stake/recipient, inconsistent provider receipts, or expiration of the single 5-minute payment deadline.
- Any one/two-payer transition to Page5, duplicate payments, wrong game/session assignment.
- HTTP 429/542 or indexing delays prevent confirmation. Keep status **UNKNOWN**, never infer missing funds or blind-retry outgoing transfers.
- Missing or ambiguous winner/owner receipt, incomplete wallet journal, or missing R2 archive.
- Never enable live payments just to make a test pass. If a room did accept payments but cannot reach Page5, retain durable **refundable obligations**, and do not destroy financial evidence.

**Not authorized:** live transfers, Railway settings/deployments, `main` financial code flags, any Mainnet changes, or refunds for the old `oj7v` debt during this preparation.
