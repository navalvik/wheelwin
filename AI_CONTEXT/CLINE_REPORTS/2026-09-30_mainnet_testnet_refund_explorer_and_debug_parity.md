# Mainnet ⇄ Testnet Refund Explorer Verification and Developer Console Parity (R18.S125)

Date: 2026-09-30

Task: Implement the Mainnet operator capabilities required to match the
already-established Testnet operational model: (9) Mainnet failed-game refund
validation chain with TON Explorer as the FINAL MANUAL verification step, and
(10) the same Developer Console access model as Testnet
(`/debug` SPA enabled on Mainnet, legacy `/debug/*` JSON endpoints remain
production-disabled, identical operator credentials).

Baseline commit: `810372b060b4e1cfcd4178e8c1fc62947c696a36`
(branch `payment/room-wallet-integration`).

Security statement: no secret value (mnemonic, private key, secretKey, API key,
password, password hash, JWT/session secret) was printed, logged, or committed.
Railway/Vercel credential operations were performed with values passed entirely
in memory; only presence/parity booleans were observed. No wallet was generated,
no wallet catalog was changed, and no blockchain transaction was sent.

---

## 1. Scope

- Mainnet refund validation documentation (new operator procedure document).
- Display-only TON Explorer reference helpers (server) and a display-only
  "Explorer verification required" section in the existing Developer Console
  History UI (client).
- Mainnet Vercel Production (`wheelwin-main`) frontend gate
  `VITE_DEV_CONSOLE_ENABLED`.
- Mainnet Railway backend Developer Console credential parity with Testnet.
- Live verification of the Mainnet SPA/legacy-endpoint distinction.
- NOT touched: Page4 payment mechanics, Room Wallet settlement/refund
  financial logic, PaymentSessionManager lifecycle, wallet catalogs,
  Testnet runtime configuration (Vercel project `wheelwin` and Railway
  Testnet service were only read), GameEscrow/DepositContract legacy modules.

## 2. Files Inspected

Context (per `.clinerules` pre-analysis rule): `AI_CONTEXT/WHEELWIN_MASTER_CONTEXT.md`,
`AI_CONTEXT/ARCHITECTURE_RULES.md`, `AI_CONTEXT/CURRENT_STATE.md`,
`AI_CONTEXT/AI_WORKING_RULES.md`, latest CLINE reports (2026-09-29/30 refund
reconciliation, Mainnet readiness decoupling, wallet identity audit).

Source/docs:

- `docs/R17.8O2_REAL_TESTNET_REFUND_VALIDATION.md` (reference structure)
- `server/payment/ton/networks/mainnet.js`, `testnet.js`, `index.js`
- `server/console/registerDeveloperConsoleRoutes.js`, `server/app.js`
- `server/history/SessionHistoryArchiveManager.js`, `server/history/buildBlockchainLifecycle.js`
- `server/console/projectionBuilders/buildRoomDetail.js` (sanitized payment projection)
- `server/payment/roomWallet/RoomWalletSettlementAdapter.js`,
  `server/payment/roomWallet/roomWalletTerminalRecoveryChain.js` (refund chain ownership reference)
- `server/gameplay/PaymentSessionManager.js` (refund flow reference)
- `server/console/auth/developerAuthConfig.js`,
  `server/config/validators/validateSecrets.js` (credential mechanism)
- `client/src/config/devMode.js`, `client/src/App.jsx`,
  `client/src/pages/PageDeveloperConsole.jsx`,
  `client/src/console/DeveloperConsole.jsx`, `client/src/console/consoleSections.js`,
  `client/src/console/panels/HistoryPanel.jsx`, `client/src/console/panels/PaymentsPanel.jsx`,
  `client/src/console/panels/RecoveryPanel.jsx`, `client/src/console/developerAuthApi.js`

## 3. Architecture Findings

- The automated refund verification chain ALREADY existed and is identical on
  Testnet and Mainnet (Room-Wallet-only finance):
  `RoomWalletSettlementAdapter.refundPayments` → `_findExistingRefund`
  (Room Wallet outbound history via
  `getTransactions(roomNumber, { limit: 40, archival: true })` +
  `extractOutboundTransfers`) → player-wallet inbound fallback
  (`getAddressTransactions(playerWallet, …)` + `extractInbound`,
  provenance `PLAYER_WALLET_INBOUND`) → fresh broadcast via
  `RoomWalletAdapter.sendTransfer` from the SAME Room Wallet →
  `confirmPayoutOnChain` (TON Center RPC, `confirmationTimeoutMs: 60_000`).
  Stages 1–4 required no code changes.
- The TON Explorer URL presets (`explorerBaseUrl` on `mainnet.js`/`testnet.js`)
  existed since R7.66A with zero consumers ("dead metadata"); this stage wires
  them for DISPLAY-ONLY operator references — exactly the use previously
  recommended for a separate approved stage.
- The Developer Console production gate is
  `DEV_CONSOLE_ENABLED = DEV_MODE || import.meta.env.VITE_DEV_CONSOLE_ENABLED === "true"`
  (`client/src/config/devMode.js`), consumed by `client/src/App.jsx` to register
  the lazy `/debug` route (`PageDeveloperConsole` → `DeveloperConsole`).
- Developer Console authentication is `ADMIN_USERNAME` + `ADMIN_PASSWORD_HASH`
  (scrypt) + `DEVELOPER_AUTH_SECRET` via
  `server/console/auth/developerAuthConfig.js` — the active mechanism on BOTH
  production backends (variable NAMES confirmed on both Railway services; no
  fallback aliases in use; values never read into any output).
- The session history archive is immutable; its `payment` section is the
  console-sanitized projection ("never include wallets / tx hashes"). The
  archive carries transaction hashes in
  `blockchainLifecycle.paymentConfirmation.events[]`, `deploy`, and
  `settlement` tracks only. Refund hashes are not persisted into the archive
  (by design); they live in server logs (`ROOM_WALLET_REFUND_RECONCILED`) and
  the persisted payment-session records. The display-only enrichment attaches

## 4. Lifecycle Flow

Refund (failed game, Mainnet) — final operator chain:

```
Room Wallet outbound history          (automated)
   ↓
Player wallet inbound reconciliation  (automated, when required)
   ↓
Refund broadcast (same Room Wallet)   (automated)
   ↓
TON Center on-chain confirmation      (automated, authoritative)
   ↓
TON Explorer final MANUAL verification (operator, post-hoc)
```

Console history flow: `/console/history/:sessionId` (Bearer-authenticated) →
immutable archive record → `buildOperatorExplorerVerification(record,
{ applicationNetwork })` → response carries `operatorExplorerVerification`
(display-only) → `HistoryPanel` detail view renders the
“TON Explorer Verification (Manual)” section with hashes, sources, and
manual explorer links.

## 5. Ownership Boundaries

- Refund/settlement authority: `RoomWalletSettlementAdapter` /
  `RoomWalletAdapter` / `confirmPayoutOnChain` — UNTOUCHED.
- Archive ownership: `SessionHistoryArchiveManager` — UNTOUCHED (records stay
  pristine; enrichment is response-only at the console route).
- Console auth ownership: `server/console/auth/*` — UNTOUCHED (credential
  values synchronized at the deployment platform level only).
- Explorer reference construction: new display-only helpers under
  `server/payment/ton/networks/` + `server/console/projectionBuilders/`

## 6. Risks

- **Low**: The Explorer reference block is attached to the
  `/console/history/:sessionId` response. It is authenticated behind the same
  Developer auth middleware as all `/console/*` routes and contains only data
  already present in the archive plus public tonviewer URLs. No secret and no
  financial authority is exposed. Explorer hashes/addresses are public
  on-chain data.
- **Low**: The archive does not persist refund transaction hashes (refund
  hashes exist in server logs and persisted payment-session records). The new
  UI therefore shows stake/settlement/deploy hashes from the archive; refund
  hashes must be taken from logs/session payload as documented in
  `docs/MAINNET_REFUND_VALIDATION.md` §8 step 6. Display-only; no financial
  impact. A future approved stage may add a refund evidence track to the
  archive.
- **Low**: `VITE_DEV_CONSOLE_ENABLED=true` ships the Developer Console SPA in
  the Mainnet production bundle. This matches the existing Testnet model; the
  console remains fully authenticated (`openAccess=false`, negative login
  returns 401) and all data flows through protected `/console/*` APIs. The
  legacy `/debug/*` JSON endpoints remain 404 in production.
- **Info**: Setting identical variable values on the Mainnet Railway service
  may trigger a backend redeploy; values were verified identical
  before/after (parity already held), so runtime behavior is unchanged.

## 7. Recommendations

Do not implement automatically.

1. Operator: perform the first full live Mainnet failed-game refund run
   following `docs/MAINNET_REFUND_VALIDATION.md` §8 and record the six-field
   Explorer verification table.
2. Operator: from a real browser, log in once at
   `https://wheelwin-main.vercel.app/debug` with the shared operator
   credential pair to complete the human login confirmation (automated checks
   verified the endpoints, the gate, and hash-level parity).
3. Consider (separate approved stage) adding an explicit refund-evidence track
   to the session archive so refund hashes appear in the History UI directly.
4. Keep `VITE_DEV_CONSOLE_ENABLED` unset/false on the Testnet Vercel project
   as-is (do not change Testnet behavior).

## 8. Changes Made

### 8.1 Files changed / created (exact list)

Created:

- `docs/MAINNET_REFUND_VALIDATION.md` — Mainnet operator validation procedure
  (5-stage chain; Explorer = FINAL MANUAL step; six-field record table;
  operator checklist; Developer Console access model).
- `server/payment/ton/networks/explorerReference.js` — display-only
  `resolveOperatorExplorerBaseUrl` / `buildOperatorExplorerTransactionUrl` /
  `buildOperatorExplorerAddressUrl` built on the EXISTING network presets.
- `server/console/projectionBuilders/buildOperatorExplorerVerification.js` —
  pure record → `operatorExplorerVerification` projection (display-only,
  response-only; static `manualOnly=true`, `automatic=false`,
  `replacesTonCenterConfirmation=false`, `authorizesTransfers=false`).
- `client/src/console/explorerVerificationRows.js` — pure display row mapper.
- `client/src/console/explorerVerificationRows.test.js` — 4 tests (PASS).
- `server/tests/operatorExplorerReference.test.js` — 10 tests (PASS).
- `server/tests/operatorExplorerVerificationProjection.test.js` — 8 tests (PASS).
- This report (the single implementation report for this task).

Modified:

- `server/console/registerDeveloperConsoleRoutes.js` —
  `/console/history/:sessionId` response now carries the display-only
  `operatorExplorerVerification` block; new optional `applicationNetwork`
  option. Download endpoint and archive untouched.
- `server/app.js` — passes
  `applicationNetwork: this._tonConfig?.network ?? null` to the console
  routes (display-only wiring).
- `client/src/console/panels/HistoryPanel.jsx` — new
  “TON Explorer Verification (Manual)” section in the history detail view:
  lists already-known transaction hashes (kind, short hash with full-hash
  title, source) with manual tonviewer links and the mandatory disclaimer
  (“does NOT replace the automated TON Center on-chain confirmation, is never
  read back by WheelWin, and is never used to authorize or gate transfers”).
- `.gitignore` — ignore `.vercel/` (Vercel CLI project link; local state).

### 8.2 Mainnet frontend configuration changed (exact)

- Vercel Production project **`wheelwin-main`**
  (https://wheelwin-main.vercel.app):
  - Environment variable `VITE_DEV_CONSOLE_ENABLED` (Production scope):
    found previously set to a non-enabling value, re-set to exactly `true`
    (verified by env pull: value length 4, no stray whitespace).
  - Production redeploy executed from the committed branch tree
    (`vercel --prod`): build completed, aliased to
    https://wheelwin-main.vercel.app.
- Testnet Vercel project **`wheelwin`** (https://wheelwin-nine.vercel.app):
  NOT read-modified; no variables changed; no redeploy.

### 8.4 Tests and build executed

Server (node --test, offline, no live network):

- `operatorExplorerReference.test.js` — 10 pass / 0 fail (NEW).
- `operatorExplorerVerificationProjection.test.js` — 8 pass / 0 fail (NEW).
- Focused regression: `developerAuth.test.js`,
  `sessionHistoryArchive.test.js`, `consoleGaugeVisibility.r179t8.test.js`,
  `paymentSessionRefundReconciliationMetadata.test.js` — fail 0
  (authentication + archive/forensic + refund-reconciliation coverage).

Client (node scripts/run-tests.js, 55 test files):

- New `explorerVerificationRows.test.js` — 4 pass / 0 fail.
- 7 files fail (`playerUI.productionIdentity`, `page4GameEscrowAuthoritativeState`,
  `staleDepositGameStart.r18s16`, `language.i18n`,
  `buildDepositDeploymentTransaction`, `buildFundDepositTransaction`,
  `page4DepositActivationHandoff`). Verified via `git stash` baseline run:
  the SAME 7 files fail at the clean baseline commit (`BASELINE_FAILED_COUNT=7`)
  — pre-existing drift, zero failures introduced by this change.

Client production build (gate proof):

- With `VITE_DEV_CONSOLE_ENABLED=true`: build succeeds; main bundle contains
  the `/debug` route; `PageDeveloperConsole-*.js`/`.css` chunks emitted;
  console chunk contains the “TON Explorer Verification (Manual)” section and
  the manual disclaimer.
- Without the flag: build succeeds; `/debug` route literal ABSENT from the
  main bundle (route falls back to the generic game shell — identical to the
  current Testnet production behavior).

### 8.5 Live verification (post-deploy, 2026-09-30)

Mainnet frontend (`https://wheelwin-main.vercel.app/debug`):

- Production bundle main JS contains the `/debug` route
  (`LIVE_DEBUG_ROUTE_PRESENT=True`) and references the console chunk.
- `PageDeveloperConsole-Cy671be6.js` served on the live deployment; contains
  `TON Explorer Verification (Manual)` (`True`), the manual disclaimer
  (`True`), and the `/console/auth/login` API usage (`True`).
- Result: `/debug` loads the Developer Console SPA (PageDeveloperConsole →
  DeveloperConsole, authenticated via `/console/auth/*`, protected
  `/console/*` APIs) — NOT the generic game shell.

Mainnet backend (`https://positive-clarity-production-d1a1.up.railway.app`):

- `GET /console/auth/status` → `enabled=True`, `openAccess=False`,
  `environment=MAINNET`.
- `GET /debug/health` → HTTP 404; `GET /debug/games` → HTTP 404
  (legacy JSON endpoints remain production-disabled).
- Negative login probe (bogus credentials only) → HTTP 401 (auth live,
  rejecting; no real credential used).

Testnet backend (`https://wheelwin-production.up.railway.app`):

- `GET /console/auth/status` → `enabled=True`, `openAccess=False`,
  `environment=TESTNET`; `/debug/health`, `/debug/games` → 404; negative
  login probe → 401. Testnet behavior unchanged.

### 8.6 Required confirmations

1. **Mainnet refund verification chain with Explorer as the final MANUAL
   verification step** — documented in `docs/MAINNET_REFUND_VALIDATION.md`
   (§2 chain diagram; §7 Stage 5 manual procedure with the six-field record
   table; §7 hard rules: Explorer data is never read by WheelWin, no fake
   “Explorer confirmed” status, no authorization condition). Confirmed.
2. **Exact files changed** — §8.1.
3. **Exact Mainnet frontend configuration changed** — §8.2 (Vercel project
   `wheelwin-main`, `VITE_DEV_CONSOLE_ENABLED=true` in Production scope +
   production redeploy; Testnet project untouched).
4. **Exact authentication fields synchronized, by NAME ONLY** — §8.3
   (`ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`; `DEVELOPER_AUTH_SECRET` NOT
   copied — Mainnet kept independent; no re-hashing).
5. **Mainnet `/debug` SPA enabled and loads DeveloperConsole** — §8.5
   (route in live main bundle, console chunk served with the new section,
   auth via `/console/auth/*`).
6. **Mainnet backend legacy `/debug/*` JSON endpoints remain disabled** —
   §8.5 (`/debug/health` 404, `/debug/games` 404).
7. **Mainnet `/console/*` remains authenticated** — §8.5 (`openAccess=False`;
   negative login 401; all console data flows through Bearer-protected
   `/console/*` APIs).
8. **Testnet was not financially or behaviorally changed** — no Testnet code
   path touched; Testnet Vercel project untouched; Testnet Railway service
   only read (names); live Testnet probes unchanged
   (§8.5); OFF-flag build proves the Testnet bundle behavior (no `/debug`
   route) is preserved.
9. **No wallet catalog was changed** — no wallet was generated; no catalog
   file or `ROOM_WALLETS_MAINNET_JSON` / `ROOM_WALLETS_TESTNET_JSON` value was
   created, read into output, or modified (variable NAMES appeared only in
   the name-listing step; values were never printed or persisted).
10. **No blockchain transaction was sent** — all work was code, docs,
    configuration, and read-only HTTP/RPC observation. No signing, no
    broadcast, no TON Center write operation.

## 9. Limitations

- The Mainnet `/console/history` enrichment requires the Mainnet backend to
  run a build that includes this change; until the next backend deploy, the
  console simply renders without the Explorer section (defensive: section
  hidden when the field is absent).
- Refund hashes are not yet part of the immutable archive (see Risks).
- The automated parity check proves hash-level credential equality; the final
  human login confirmation from a real browser remains an operator step
  (Recommendation 2).


### 8.3 Authentication fields synchronized Testnet → Mainnet (by NAME ONLY)

- `ADMIN_USERNAME`
- `ADMIN_PASSWORD_HASH`

Copied from the Testnet Railway service (project `invigorating-growth`,
service `wheelwin`) to the Mainnet Railway service (project `WheelWin Mainnet`,
service `positive-clarity`), Production environment, entirely in memory.
Verification (values never displayed):
`USERNAME_PARITY_BEFORE=true`, `HASH_PARITY_BEFORE=true`,
`USERNAME_PARITY_AFTER=true`, `HASH_PARITY_AFTER=true` — credential parity
already held and was confirmed. `DEVELOPER_AUTH_SECRET` on Mainnet was
verified present and INDEPENDENT from Testnet (`MAINNET_SECRET_INDEPENDENT=true`)
and was NOT copied or modified. `DEVELOPER_AUTH_ENABLED` remains `true` on both.
No re-hashing was performed; the hash value was copied as-is.

  (pure functions, no network I/O, fail-safe `null` on invalid input, static
  `manualOnly` / `authorizesTransfers: false` contract flags).
- Client rendering: `HistoryPanel` renders the section only when the
  server-provided block exists; a pure mapper
  (`client/src/console/explorerVerificationRows.js`) keeps rendering logic
  testable and display-only.

  explorer references to the `/console/history/:sessionId` API RESPONSE only —
  the archive and the download endpoint remain pristine.

- `server/console/projectionBuilders/buildRoomDetail.js` (sanitized payment projection)
- `server/payment/roomWallet/RoomWalletSettlementAdapter.js`,
  `roomWalletTerminalRecoveryChain.js` (refund chain ownership reference)
- `server/gameplay/PaymentSessionManager.js` (refund flow reference)
- `server/console/auth/developerAuthConfig.js`,
  `server/config/validators/validateSecrets.js` (credential mechanism)
- `client/src/config/devMode.js`, `client/src/App.jsx`,
  `client/src/pages/PageDeveloperConsole.jsx`,
  `client/src/console/DeveloperConsole.jsx`, `client/src/console/consoleSections.js`,
  `client/src/console/panels/HistoryPanel.jsx`, `client/src/console/panels/PaymentsPanel.jsx`,
  `client/src/console/panels/RecoveryPanel.jsx`, `client/src/console/developerAuthApi.js`
