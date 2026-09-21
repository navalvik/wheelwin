# Deployment Readiness — GitHub / Vercel / Railway (Testnet 3-Phone Page4 Test)

Date: 2026-09-21

Task: Verify deployment readiness of the current WheelWin working tree for the
real Testnet Page4 test on three Telegram mobile clients. Preparation and
verification only. No code changes were made by this task.

## A. Current repository state

- Branch: `payment/room-wallet-integration`; HEAD `dc742003` ("Room Wallet
  Testnet: local ROOM_WALLETS_TESTNET_JSON_PATH file source"), already pushed
  to origin. Parent `511d8cad` (2026-09-20 clean synchronization point, see
  `LOCAL_SYNC_REPORT.txt`).
- Working tree is NOT clean. Pre-existing uncommitted changes (present before
  this task; none created by this task):
  - Modified: `client/src/pages/Page4Payment.jsx` (deliberate full rewrite,
    3818 → 1243 lines, documented in
    `AI_CONTEXT/CLINE_REPORTS/2026-09-20_page4_room_wallet_rebuild.md`)
  - Modified: `server/socket/RoomLobbyBridge.js` — see section F (blocker)
  - Modified: `server/tests/roomCreationTelegramAuthorization.r179t6c.test.js`,
    `server/tests/attackEObservability.r179t8.test.js`,
    `server/tests/telegramIdentityResolverWiring.r179t6d.test.js`,
    `server/tests/roomCreationProtection.integration.test.js`
  - Untracked: `server/tests/roomCreationWebOrigin.test.js` (new),
    `AI_CONTEXT/CLINE_REPORTS/2026-09-20_page4_room_wallet_rebuild.md`,
    `AI_CONTEXT/CLINE_REPORTS/CURRENT_TESTNET_PAYMENT_INTERFACE_MAP.md`,
    `LOCAL_SYNC_REPORT.txt` (docs only)
- `git ls-files` for wallet/.env patterns returns ONLY `server/.env.example`.
  The real `server/.env` and the wallet JSON are NOT tracked.

## B. Changes detected (review of the uncommitted diff)

1. `Page4Payment.jsx` — intentional Room-Wallet rebuild (Testnet-only,
   server-authoritative; GameEscrow/Deposit branches and diagnostic machinery
   removed per its report). Full-diff scan found NO wallet addresses, NO
   secrets/mnemonics, NO `mainnet` references, NO `ROOM_WALLETS*` /
   `room-wallets` file-path references, NO `TON_NETWORK` logic.
2. `RoomLobbyBridge.js` + 4 room-creation test files + 1 new test file — an
   UNFINISHED "dual-origin room creation" change that removes the fail-closed
   Telegram-only `CREATE_ROOM` rejection and allows Standard-Web (browser)
   sockets to create rooms. Its own rewritten tests currently FAIL (section I).
   This is reported, not rewritten, per task instructions (section F/J).

## C. Deployment readiness status

- Committed HEAD (`dc742003`): deployment-ready from a code/security standpoint
  (Telegram-only protection intact at HEAD; all four room-creation security
  suites pass at HEAD; wallet configuration isolated).
- Working tree as-is: NOT ready to push. Blocker J-1 (the uncommitted
  room-creation weakening) must be reverted (or explicitly re-decided by the
  owner) before anything is pushed to GitHub, because a plain `git add .`
  would publish it.

## D. Vercel configuration findings

- `vercel.json` exists at repo root and in `client/`; both contain ONLY the SPA
  rewrite (`/(.*)` → `/index.html`). No build command/output settings in repo.
- No root `package.json` exists → the Vercel project must be configured with
  Root Directory = `client`, Framework = Vite, Build Command = `npm run build`
  (client/package.json), Output Directory = `dist`.
- Client production build verified locally: `vite build` exit 0 (641 modules,
  ~1.36 MB main chunk; only non-blocking chunk-size / dynamic-import warnings).
- Backend URL resolution (`client/src/config/backendUrl.js`, tests pass):
  1. `VITE_SOCKET_URL` (build-time env) — MUST be set in the Vercel project to
     the Testnet Railway public URL; without it the bundle falls back to
     `window.location.hostname:3001`, which Vercel does not serve.
  2. `wheelwin-main*.vercel.app` host family → hardwired Mainnet Railway URL
     (isolated; does not affect the Testnet project).
  3. Same host port 3001 (LAN), 4. `http://localhost:3001`.
- Optional: `VITE_DEV_CONSOLE_ENABLED=true` (developer console; auth still
  required). `dist` is git-ignored (`client/.gitignore:11`).
- Documented Testnet frontend URL: `https://wheelwin-nine.vercel.app`
  (appears in `server/.env.example` CLIENT_ORIGIN example).

## E. Railway configuration findings

- No `railway.json` / `railway.toml` / `nixpacks.toml` / `Procfile` /
  `Dockerfile` anywhere → the Railway service must be configured in the
  Dashboard: Root Directory = `server`, Start Command = `npm start`
  (`server/package.json` → `node app.js`). No `engines` field is pinned (local
  verification ran on Node 24; Railway default Node is untested by this task).
- Environment-variable NAMES required on Railway (values must be supplied by
  the operator; none are stored in the repo — `server/.env.example` documents
  them): `NODE_ENV=production`, `CLIENT_ORIGIN` (= the Testnet Vercel URL,
  explicit match required in production; dev LAN auto-allow does not apply),
  `PORT` (Railway injects), `TON_NETWORK=testnet`, `TON_API_KEY`,
  `TON_DEPLOY_MODE=live`, `TELEGRAM_BOT_TOKEN` (required — without it every
  socket presenting initData is rejected and Telegram room creation is
  impossible), `ROOM_WALLETS_TESTNET_JSON` (the 64-wallet catalog, direct
  variable), `DEVELOPER_AUTH_ENABLED=true`, `DEVELOPER_AUTH_SECRET`,
  `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH` (+ optional `VIEWER_*`),
  `TON_DEPLOYER_MNEMONIC`, `TON_REIMBURSEMENT_EXPECTED_ADDRESS` /
  `TON_RESIDUES_EXPECTED_ADDRESS` / `TON_RESIDUES_MNEMONIC`,
  `PAYMENT_SESSION_DURATION_MS` and stake/profile vars as needed.
- `ROOM_WALLETS_TESTNET_JSON_PATH` must NOT be set on Railway (local-only
  mechanism; the resolver only reads it when the direct variable is absent, so
  its accidental presence with no file would fail startup fail-closed).
- Socket.IO server config (`server/config/socket.js`): transports
  `["websocket","polling"]`, CORS object shared with Express
  (`CLIENT_ORIGIN`), connection-state recovery 2 min.
- Mainnet: all Mainnet variables in `.env.example` are commented out; nothing
  in the repo activates Mainnet. `TON_NETWORK=testnet` everywhere.

## F. Telegram-only Room Creation protection verification

Production chain (unchanged at HEAD): `client/index.html` loads the official
Telegram WebApp SDK (bootstrap test passes) → `client/src/socket/socket.js`
sends raw `window.Telegram.WebApp.initData` as `auth.telegramInitData` →
SocketGateway middleware validates it against `TELEGRAM_BOT_TOKEN`
(`server/auth/telegramInitDataValidator.js`, 16/16 tests pass) and sets
`socket.data.telegramUserId` (invalid initData → connection rejected; missing
→ Web guest with null id) → `server/app.js:2084` wires the production resolver
(`configureTelegramIdentityResolver`) that reads ONLY the authenticated socket
context → `RoomLobbyBridge._handleCreateRoom` fails closed.
Bot: `@wheel_win_bot` (BotFather; Mini App URL is an operator setting).

- HEAD (`dc742003`): **Telegram-only protection INTACT.**
  `RoomLobbyBridge.js` lines 1181-1193 reject `telegramUserId == null` with
  `ROOM_CREATION_REQUIRES_TELEGRAM` before any allocation; all four
  room-creation security suites pass at HEAD (section I, worktree run).
- Working tree (UNCOMMITTED): **WEAKENED.** The null-identity rejection was
  removed; web-origin creation is active — a diagnostics trace captured an
  unauthenticated socket reaching `RoomManager.createRoom()` via
  `RoomLobbyBridge.js:1272`. The four rewritten suites FAIL against this code
  (their expected `ROOM_CREATED` deliveries do not match actual emissions), so
  the change is both insecure AND incoherent/incomplete. Per instruction this
  change is reported, not silently rewritten: it must not be pushed
  (exact remediation in K).

## G. Page4/payment readiness

- Page4 receives payment data exclusively through the server-authoritative
  session store (`authoritativeSessionModel` / `authoritativePaymentView` /
  `authoritativeEntryPaymentView` — all suites pass). `page4PaymentPhase`
  tests: 7/7 pass, including "Page4 uses only the server-authoritative Room
  Wallet destination", "Page4 fails closed when the Room Wallet destination is
  missing", and "exactly one TonConnect sendTransaction path".
- Page4 has ZERO references to the local wallet file path
  (`ROOM_WALLETS_TESTNET_JSON` / `ROOM_WALLETS_JSON_PATH` / `room-wallets-*`):
  the wallet file exists only in the server resolver; Railway behavior is
  identical to local behavior from Page4's point of view.
- One legacy client test fails:
  `page4GameEscrowAuthoritativeState.test.js` — "v4 Deposit wait remains when
  escrowMode is v4" (3/4 pass). This is the expected consequence of the
  deliberate Page4 rebuild (legacy Deposit/GameEscrow wait branches removed);
  pre-existing, unrelated to deployment configuration, left as found.
- Wallet connect/disconnect and Gram-Wallet Telegram handoff flows are
  preserved per the rebuild report and the passing view tests.

## H. Room Wallet Testnet configuration readiness

- Local: `server/.env` sets
  `ROOM_WALLETS_TESTNET_JSON_PATH=./config/room-wallets-testnet-ROOM_WALLETS_JSON.json`;
  the resolver (Testnet-only, lazy) reads the file only when the direct
  variable is absent; relative paths resolve from the server project root.
  Server startup was verified in the prior session: `RoomWalletIncomingObserver
  (64 wallets) OK`, `Startup complete`, no configuration errors.
- Railway: `ROOM_WALLETS_TESTNET_JSON` direct variable (unchanged resolver
  path, precedence 1). The PATH variable is a local-only additional source;
  it does not replace or shadow the Railway variable.
- Isolation verified: `git check-ignore -v` →
  `server/.gitignore:15:*ROOM_WALLETS_JSON.json` matches
  `server/config/room-wallets-testnet-ROOM_WALLETS_JSON.json` (+ explicit root
  `.gitignore` entry and wildcard `*room-wallets-testnet*.json`); `git
  ls-files` shows the file is NOT tracked; `server/.env` is ignored by root
  `.gitignore`. Resolver suites `roomWalletRuntimeResolver.test.js` and
  `roomWalletTestnetFilePathConfig.test.js` pass (green in the batch run).

## I. Tests/builds executed and exact results

HEAD-state verification (temporary detached worktree at `dc742003`, removed
afterwards; main tree untouched):
- `roomCreationTelegramAuthorization.r179t6c.test.js` — "all assertions passed"
- `attackEObservability.r179t8.test.js` — "all passed"
- `telegramIdentityResolverWiring.r179t6d.test.js` — "all assertions passed"
- `roomCreationProtection.integration.test.js` — "all assertions passed"

Working-tree verification (current uncommitted state), `node --test` batch:
- 36 tests total: 32 pass / 4 file-level failures.
- PASS: `telegramInitDataValidator.test.js` (16/16),
  `roomCreationProtection.integration.test.js`,
  `roomWalletRuntimeResolver.test.js` (6),
  `roomWalletTestnetFilePathConfig.test.js` (9).
- FAIL: `roomCreationTelegramAuthorization.r179t6c.test.js`
  ("web-origin create must return ROOM_CREATED"),
  `attackEObservability.r179t8.test.js`
  ("forged payload must fall through to web-origin creation"),
  `roomCreationWebOrigin.test.js` ("web joiner 3 must join normally"),
  `telegramIdentityResolverWiring.r179t6d.test.js`
  ("throwing resolver must fall back to web-origin creation").

Client (Node test runner with loader hooks):
- `page4PaymentPhase.test.js` — 7/7 pass.
- `authoritativePaymentView.test.js`, `authoritativeEntryPaymentView.test.js`,
  `authoritativeSessionModel.test.js` — all pass.
- `socket.telegramAuth.test.js`, `telegramWebAppBootstrap.test.js`,
  `config/backendUrl.test.js` — all pass.
- `page4GameEscrowAuthoritativeState.test.js` — 3/4 (1 pre-existing failure,
  see G).

Builds:
- Client production build (`npm run build`, Vite 8): exit 0.
- Server startup/configuration check (prior session, same committed resolver
  content): `node app.js` → `Startup complete`,
  `RoomWalletIncomingObserver (64 wallets) OK`.

## J. Concrete blockers

1. CRITICAL — uncommitted "dual-origin room creation" change in the working
   tree (`server/socket/RoomLobbyBridge.js` + 4 modified test files + untracked
   `server/tests/roomCreationWebOrigin.test.js`). It weakens the Telegram-only
   Room creation protection (forbidden by the project security rule), and its
   own tests fail. It MUST NOT be pushed. Revert it (commands in K) or obtain
   an explicit owner decision otherwise; as found it is not shippable.
2. CONFIG — deployment values must be supplied by the operator (they are
   correctly absent from the repo): Vercel Root Directory = `client` +
   `VITE_SOCKET_URL` = Testnet Railway URL; Railway Root Directory = `server` +
   start command `npm start` + the Variable set in section E (including
   `TELEGRAM_BOT_TOKEN` and `ROOM_WALLETS_TESTNET_JSON`).
3. MINOR — one pre-existing legacy client test failure (G) caused by the
   approved Page4 rebuild; no deployment impact. No `engines` pin in
   `server/package.json` (recommend pinning Node in Railway settings).

## K. Exact next deployment steps required

1. Resolve blocker J-1 (owner decision, then):
   `git restore -- server/socket/RoomLobbyBridge.js server/tests/roomCreationTelegramAuthorization.r179t6c.test.js server/tests/attackEObservability.r179t8.test.js server/tests/telegramIdentityResolverWiring.r179t6d.test.js server/tests/roomCreationProtection.integration.test.js`
   and delete untracked `server/tests/roomCreationWebOrigin.test.js`
   (returns these files to the verified Telegram-only HEAD state; the Page4
   rebuild and reports stay).
2. Commit the intentional remaining work (Page4 rebuild + reports) — stage
   files explicitly, do NOT `git add .` blindly — and push. Verify with
   `git status` that `server/.env` and
   `server/config/room-wallets-testnet-ROOM_WALLETS_JSON.json` never appear.
3. Vercel (Testnet project, e.g. wheelwin-nine): import repo; Root Directory
   `client`; Build `npm run build`; Output `dist`; Environment Variable
   `VITE_SOCKET_URL=https://<testnet-service>.up.railway.app`; deploy.
4. Railway (Testnet service): Root Directory `server`; Start `npm start`;
   Variables per section E. Do NOT set `ROOM_WALLETS_TESTNET_JSON_PATH`.
   Do NOT change Mainnet Variables.
5. BotFather: set the Mini App Web App URL of `@wheel_win_bot` to the Testnet
   Vercel URL so the three Telegram mobile clients open the deployed build.
6. Post-deploy verification before the 3-phone test: server `/health`,
   `/ready`; from a plain browser CREATE_ROOM must be REJECTED
   (Telegram-only); then run the three-phone Testnet Page4 flow.

## Files that must NOT be committed (local wallet data / secrets)

- `server/.env` (all local secrets; git-ignored)
- `server/config/room-wallets-testnet-ROOM_WALLETS_JSON.json` (64-wallet
  signing material; git-ignored, verified)
- Any offline-secrets copies under `C:\Users\DAAT\WheelWin-offline-secrets\`
  (outside the repo)

## Changes made by this task

No code changes. One report only (this file). Verification scratch files were
kept under the git-ignored `_audit_tmp/` working directory.
