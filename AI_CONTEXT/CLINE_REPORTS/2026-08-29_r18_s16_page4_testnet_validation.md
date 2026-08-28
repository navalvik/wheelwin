# R18-S16 — Page4 Real TESTNET Validation and Git Verification

Date: 2026-08-29

Task: Verify the implemented Page4 against the real TESTNET production stack (Vercel client + Railway `app.js`). Not an architecture audit. Not a redesign.

Classification: **VALIDATION**. Production financial code was not modified.

## 1. Scope

Confirm git/push of R18-S16, confirm the Vercel client contains that implementation, preflight TESTNET (never MAINNET), then attempt a fresh three-wallet Telegram Mini App Page4 lifecycle through `OPEN_PAGE5`.

## 2. Files Inspected

- Git: `HEAD`, `origin/main`, commit `4fbf459`
- Deployed client: `https://wheelwin-nine.vercel.app/` (`/assets/index-DvP3rIAL.js`)
- Production backend health: `https://wheelwin-production.up.railway.app/health`
- `https://wheelwin-nine.vercel.app/debug` (unauthenticated)
- Local: `server/.env` keys `TON_NETWORK` and `TON_DEPLOY_MODE` only
- Focused tests: `page4PaymentPhase.test.js`, `authoritativeSessionModel.test.js`, `socketSyncLayer.test.js`, `r18DepositProjection.test.js`
- Client `npm run build`

---

## 1. STARTING GIT STATE

**SOURCE VERIFIED**

Commands executed:

```text
git status --short
git rev-parse HEAD
git log -5 --oneline
git diff --check
```

```text
HEAD     4fbf4598df2836bcefb390f2e7b7d3624af62356
branch   main...origin/main  (no ahead/behind)
log-1    4fbf459 Adapt Page4 to R18-S16 payment lifecycle
log-2    7453a9e docs: record R18-S15 READY-to-Page5 continuation commit SHA
log-3    38169b9 R18-S15 wait for production OPEN_PAGE5 after GameEscrow READY
log-4    adcc087 docs: record R18-S15 Deposit activation ordering and OPEN_PAGE5
log-5    1d41480 R18-S15 wait for Deposit activation VERIFIED before E2E FundSeat
diff --check  no conflict/whitespace errors on R18-S16 files
```

Uncommitted / untracked items at start were **not** R18-S16 production source: sample banners, prior CLINE reports, probes, `.vscode`, `_forensic_Seik`, etc.

## 2. R18-S16 COMMIT / PUSH STATUS

**SOURCE VERIFIED**

| Question | Result |
|---|---|
| Are R18-S16 Page4 changes committed? | **Yes.** `4fbf459` |
| Pushed to `origin/main`? | **Yes.** `git rev-parse origin/main` = `4fbf459…`. `git ls-remote origin refs/heads/main` = same SHA. GitHub API `commits/main` = `4fbf459` dated `2026-08-28T22:55:25Z` |
| Remaining uncommitted R18-S16 production code? | **No.** |
| Duplicate implementation commit created this task? | **No.** |

The prior implementation report left section 16 as a placeholder. This validation pass recorded the SHA above (and filled it in that report).

## 3. VERCEL DEPLOYMENT STATUS

**SOURCE VERIFIED** (bundle contents + timestamps). Vercel dashboard CLI was not available (`gh` not installed; no `vercel` inspect from this shell).

| Item | Evidence |
|---|---|
| URL | `https://wheelwin-nine.vercel.app/` |
| `index.html` asset | `/assets/index-DvP3rIAL.js` |
| Response | `Server: Vercel`, `Last-Modified: Fri, 28 Aug 2026 23:09:36 GMT` (~14 minutes after commit `22:55:25Z`) |
| Baked backend | `https://wheelwin-production.up.railway.app` inside the JS bundle |
| R18-S16 markers in live JS | `Waiting for deposit activation` (1), `DEPOSIT_ACTIVATION_VERIFIED` (10), `depositActivationVerified` (5), `GAMEESCROW_STAKE` (5), `{funded} of 3 seats funded` (1), `Seat funding is unavailable` (1) |

Local `npm run build` in this task emitted `index-Cf9JPiDZ.js` (no `VITE_SOCKET_URL`). Vercel hash differs because production injects the Railway URL. **The live bundle still contains the R18-S16 Page4 strings.**

Verdict: the current Vercel client **contains the R18-S16 Page4 implementation**. It is not assumed from a local build alone.

## 4. TESTNET PREFLIGHT

**SOURCE VERIFIED**. Not MAINNET. Did not STOP.

| Source | Value |
|---|---|
| Local `server/.env` | `TON_NETWORK=testnet` (twice), `TON_DEPLOY_MODE=live` |
| Railway `GET /health` → `configuration.ton.network` | `testnet` |
| Railway `configuration.features.tonDeployMode` | `live` |
| Railway `configuration.ton.mainnetProfileConfigured` | `false` |
| Deployed welcome UI | “THIS PROJECT IS CURRENTLY RUNNING ON THE TON TESTNET.” / “USE TESTNET GRAM (TON) WALLETS ONLY.” |
| Deployed JS `mainnet` hits | 2 — both `Object.freeze(['testnet','mainnet'])` allow-lists in builders, not an active MAINNET selection |

No MAINNET transaction was sent.

## 5. FRESH TEST ROOM

**BLOCKED**

No new room was created. Rooms `PNyS`, `wMCC`, `GLSi`, `pyzv` were not reused.

CREATE ROOM from the ordinary Vercel page did not produce a `roomId`. Telegram Mini App `initData` length was `0`.

## 6. PAGE4 WALLET VALIDATION

**NOT VERIFIED** as a payment-page mount. **BLOCKED** before Page4.

Attempted: open deployed client, dismiss TESTNET overlay, NEXT to lobby. Page4 (`APP_PAGES.PAYMENT`) was never reached.

Welcome/lobby rendered without a JS `ReferenceError` in this browser. That is **not** evidence that Page4 hooks mount in a real payment session.

## 7. PAYMENT_CONNECTION_READY VALIDATION

**CLIENT TEST VERIFIED** (unit). **REAL TESTNET VERIFIED** — no. **BLOCKED**.

Unit: `PAYMENT_CONNECTION_READY does not select GameEscrow STAKE` passed (`page4PaymentPhase.test.js`).

No live `PAYMENT_CONNECTION_READY` lobby event was observed from Page4.

## 8. DEPOSIT PACKAGE VALIDATION

**CLIENT TEST VERIFIED** (session/socket unit). **REAL TESTNET VERIFIED** — no. **BLOCKED**.

## 9. CREATOR DEPOSIT DEPLOYMENT

**CLIENT TEST VERIFIED** (`isCreator === true` required; `seatIndex === 0` is not local authority). **REAL TESTNET VERIFIED** — no. **BLOCKED**.

## 10. DEPOSIT_ACTIVATION_VERIFIED

**CLIENT TEST VERIFIED** + **SOURCE VERIFIED** (lobby projection tests S16.1–S16.3). **REAL TESTNET VERIFIED** — no. **BLOCKED**.

## 11. FUNDSEAT × 3

**NOT VERIFIED**. **BLOCKED**. No TESTNET FundSeat transactions.

## 12. DEPOSIT_FULL

**NOT VERIFIED**. **BLOCKED**. No server `DEPOSIT_FULL` for a fresh room in this run.

## 13. GAMEESCROW STAKE × 3

**CLIENT TEST VERIFIED** (STAKE gated on deployed GameEscrow). **REAL TESTNET VERIFIED** — no. **BLOCKED**.

## 14. PAYMENT_SESSION_COMPLETED

**CLIENT TEST VERIFIED** (`COMPLETED` → `WAITING_PAGE5`). **REAL TESTNET VERIFIED** — no. **BLOCKED**.

## 15. OPEN_PAGE5

**SOURCE VERIFIED** (path unchanged: `OPEN_PAGE5` → EngineBridge → OpenPage5Navigator → `APP_PAGES.GAMEPLAY`). **REAL TESTNET VERIFIED** — no. **BLOCKED**.

No `OPEN_PAGE5` was observed. None was synthesized.

## 16. DEBUG / LOG EVIDENCE

**SOURCE VERIFIED** (public health + unauthenticated /debug). No gameplay room events.

Railway `GET https://wheelwin-production.up.railway.app/health` (HTTP 200):

- `status: ok`, `lifecycle: RUNNING`
- `ton.network: testnet`, `ton.deployMode: live`
- `activeRooms: 0`, `pendingPayments: 0` at probe time
- `clientOrigin` includes `https://wheelwin-nine.vercel.app`

`https://wheelwin-nine.vercel.app/debug`:

- Developer Console login gate (“Not authenticated”)
- Environment chip: DEVELOPMENT
- Financial / blockchain widgets show “—” until operator login

Did **not** sign into the developer console. Did **not** dump credentials.

Browser CDP on the game origin:

```text
Telegram.WebApp present: true
initData length: 0
```

That is an ordinary website session, not a Mini App.

## 17. REGRESSION TEST RESULTS

Commands executed in this task:

| Command | passed | failed | skipped |
|---|---|---|---|
| `node --import ./scripts/register.js src/game/session/page4PaymentPhase.test.js` | **9** | **0** | **0** |
| `node --import ./scripts/register.js src/game/session/authoritativeSessionModel.test.js` | all assertions in file | **0** | **0** |
| `node --import ./scripts/register.js src/socket/socketSyncLayer.test.js` | all assertions in file | **0** | **0** |
| `node tests/r18DepositProjection.test.js` | **23** | **0** | **0** |
| `cd client && npm run build` | **exit 0** | — | — |

## 18. FINAL GIT STATE

Recorded after this report is written (pre-commit of docs only):

```text
HEAD  4fbf4598df2836bcefb390f2e7b7d3624af62356
```

Implementation remains that SHA. This task adds documentation only if committed separately.

Unrelated dirty/untracked files (banners, probes, older reports) were left untouched.

## 19. EXACT BLOCKER, IF ANY

```text
EXACT BLOCKER
  Ordinary Chromium on https://wheelwin-nine.vercel.app/ is not a Telegram Mini App.
  window.Telegram.WebApp.initData length is 0.
  CREATE_ROOM requires authenticated Telegram Mini App identity
  (ROOM_CREATION_REQUIRES_TELEGRAM). This environment also cannot present
  three TESTNET TonConnect wallets to drive Deposit deploy / FundSeat / STAKE.

WHAT WAS ATTEMPTED
  Git/push verification of 4fbf459.
  Confirmation that Vercel JS contains R18-S16 Page4 strings.
  TESTNET preflight (local env + Railway health + welcome banner).
  Browser: welcome → lobby → CREATE ROOM; open /debug (no login).
  Focused regression tests + client production build.

LAST VERIFIED STATE
  Deployed S16 client welcome + CREATE OR JOIN ROOM lobby.
  Production app.js RUNNING with ton.network=testnet.
  No Page4 session, no deposit, no GameEscrow STAKE, no OPEN_PAGE5.

EXPECTED NEXT STATE
  Launch Mini App from Telegram (not the public website).
  Three TESTNET wallets, fresh room (not PNyS/wMCC/GLSi/pyzv).
  Page4: wallet → Deposit deploy (creator) → DEPOSIT_ACTIVATION_VERIFIED
  → FundSeat × 3 → DEPOSIT_FULL → STAKE × 3 → OPEN_PAGE5.

WHY THE TEST CANNOT CONTINUE
  Cannot mint Telegram initData, cannot operate three wallets, and must not
  fake transactions or emit OPEN_PAGE5. Production code was not changed to
  bypass the Mini App gate.
```

## 20. FINAL VERDICT

```text
R18_S16_PAGE4_TESTNET_BLOCKED
```

The adapted Page4 is **committed, pushed, and present on Vercel**, and focused tests still pass. The **user-facing TESTNET lifecycle through OPEN_PAGE5 was not completed** in this environment.

---

## Architecture Findings

No production architecture change. Validation stopped at the Telegram room-creation identity gate, which is existing production policy.

## Lifecycle Flow

Observed only:

```text
Vercel welcome (TESTNET banner) → lobby CREATE OR JOIN ROOM → stop
```

Intended remaining flow was not entered.

## Ownership Boundaries

Page4 still must not invent financial completion. Server remains authoritative. This run never reached those gates.

## Risks

- **Critical (this task):** Browser/Mini App/wallet gap — Page4 TESTNET participation is unproven.
- **Low:** Vercel asset hash differs from a local Vite build; mitigated by searching the live bundle for S16 strings.

## Recommendations

Run the next validation from Telegram Mini App with three TESTNET wallets against the already-deployed `4fbf459` client.

## Changes Made

Documentation only (`2026-08-29_r18_s16_page4_testnet_validation.md`; SHA filled in the implementation report). No Page4/Page5/server financial edits.
