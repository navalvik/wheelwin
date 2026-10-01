# Mainnet Railway Deployment — Commit 19a88f7 (positive-clarity)

Date: 2026-09-30

Task: Deploy the already-pushed commit `19a88f7` to the existing WheelWin
Mainnet Railway service `positive-clarity` by changing ONLY the Railway
source commit (pin) and deploying it. No other Railway settings, variables,
domains, volumes, scaling, build/start settings, GitHub, or Vercel objects
were to be touched.

Security statement: no secret value (API key, mnemonic, password hash, JWT
secret, wallet catalog content) was printed, logged, or persisted. Variable
verification was done by SHA-256 hashing the raw variable-list payload in
memory and comparing hashes; only variable NAMES were written to scratch
files, which were deleted after the task.

---

## 1. Scope

- Railway project `WheelWin Mainnet` (`bb9c6518-e1c7-4cb5-8fc6-ae534b5ff47e`),
  service `positive-clarity` (`17ba0048-f4ba-4bc2-ac5a-0dafd0895183`),
  environment `production` (`69468759-36f6-4154-bd95-f9fdd87474e1`).
- One deployment trigger action + read-only verification.
- No code changes, no configuration changes, no financial state changes.

## 2. Files Inspected / Tools Used

- `git log` / `git status` / `git ls-remote` at `g:\WheelWin`
  (HEAD = `origin/payment/room-wallet-integration` = `19a88f7…`).
- Railway CLI `v5.62.1` (authenticated session `navalvik@gmail.com`):
  - `railway project list --json` (project/service/environment IDs),
  - `railway api` (public GraphQL API) for state reads, the deployment
    mutation, deployment logs, and the service instance identity,
  - `railway variable list --json` (in-memory hash only).
- Live HTTPS probe: `GET https://positive-clarity-production-d1a1.up.railway.app/health`.
- Prior reports: `2026-09-30_active_room_wallet_only_polling.md` (the change
  deployed here), `2026-09-30_vercel_mainnet_872562d_production_promotion.md`.

## 3. Deployment Action (exact)

Mechanism: Railway-native commit-pinned deploy via GraphQL mutation
`serviceInstanceDeployV2(environmentId, serviceId, commitSha)` executed
through `railway api` (CLI v5.62.1). This is the same mechanism that produced
the previous `872562d` pin; it changes only the source commit of the running
deployment. Repo/branch connection (`navalvik/wheelwin` /
`payment/room-wallet-integration`), root directory `/server`, builder
(RAILPACK), region/replicas (us-west2 x1), and volume mount (`/data`) were
read back after deployment and are identical to the previous deployment.

## 4. Commit / Deployment Identity

| Item | Value |
|---|---|
| Previous Railway commit (pinned) | `872562d85b08ba534e9f47f089c093a06ad678c7` — deployment `bf59c13c-1754-4825-af43-cf59b8108eae` (SUCCESS, created 2026-09-30T00:52:53.402Z, message `feat(mainnet): match testnet explorer refund verification and debug console`) |
| Target commit | `19a88f7a` = `19a88f7713a40a95fd3f55cd2ac5fefd99ecd0ae` |
| Commit message | `fix(room-wallet): poll only active assigned wallets` |
| Deployment ID (new) | `ea935848-390c-4266-96b5-a3e174e6d8ec` |
| Created at | 2026-09-30T04:00:47.193Z |
| Final deployment status | **SUCCESS** |
| Final running commit | **`19a88f7713a40a95fd3f55cd2ac5fefd99ecd0ae`** (`meta.commitHash`, author `navalvik`) |
| New image digest | `sha256:6721da6463426a45b6e506c0bd95d74599b551fed42ef74776a7309bfe8757c2` (previous image: `sha256:8648900e…` → genuinely new build, not a reused image) |
| Old deployment after switch | `bf59c13c…` → `REMOVED` (normal Railway supersede; old build serves until the new one is healthy) |

## 5. Verification Results

1. **Deployment reaches SUCCESS** — polled `deployment(id)` until terminal
   state; the first poll already returned `status=SUCCESS`.
2. **Running commit is exactly 19a88f7a** — `meta.commitHash =
   19a88f7713a40a95fd3f55cd2ac5fefd99ecd0ae`, `meta.commitMessage =
   fix(room-wallet): poll only active assigned wallets`. Behavioural proof:
   the deployment log contains the NEW idle line introduced by this commit —
   `RoomWalletIncomingObserver idle | no active payment sessions |
   activeSessions=0 | walletsPolled=0 | catalog=64`.
3. **Service remains the existing positive-clarity Mainnet service** —
   deployment `serviceId=17ba0048-f4ba-4bc2-ac5a-0dafd0895183` and
   `serviceInstance.serviceName="positive-clarity"`; project
   `bb9c6518-…` (WheelWin Mainnet), environment `69468759-…` (production);
   `staticUrl=positive-clarity-production-d1a1.up.railway.app` unchanged;
   `rootDirectory=/server`, `volumeMounts=["/data"]`, `numReplicas=1`
   (us-west2), builder `RAILPACK`, runtime `V2` — all identical to the
   previous deployment. No new service was created.
4. **Startup logs clean** — 189 log entries captured; fatal/config pattern
   scan (fatal, crash, invalid, EADDRINUSE, EACCES, Cannot find module,
   TypeError, ReferenceError): **0 matches**. Lifecycle `STARTING → RUNNING`,
   `Startup complete | env=production | duration=3317.966ms`, `Server Ready`.
   Volume mounted on the same `/data` volume (`vol_snem8oip77pvuvf2`).
5. **RoomWalletIncomingObserver starts successfully** — log lines:
   `RoomWalletIncomingObserver (64 wallets) OK` and
   `RoomWalletIncomingObserver idle | no active payment sessions |
   activeSessions=0 | walletsPolled=0 | catalog=64` (the new commit's
   behaviour: zero polling with no active sessions). Related startup lines
   all OK: `TonMainnetReadiness=SKIP (RoomWallet-only financial path |
   active=mainnet) OK`, `RoomWalletSettlementRouter (ROOM_WALLET) OK`,
   `RoomWalletTerminalSettlementRecovery OK`,
   `RoomWalletResidualSweepWorker initialized | enabled=false | no sends` OK.
6. **No environment variables changed** — before/after
   `railway variable list --json` SHA-256 comparison:
   - COUNT = 47 before and after,
   - RAW_SHA256 = `F12AD752EA3BD8E14FAFE57E3AE9C114B29A21778FFD53C3D422346F90C9A629`
     (identical before and after),
   - NAMES_SHA256 = `F1565874F23A2294D6F444621F8A8B3805B050C66873D4A04D93C1EFD6870EFA`
     (identical; names include `ROOM_WALLETS_JSON`, `ROOM_WALLETS_MAINNET_JSON`,
     `TON_API_KEY`, `ADMIN_PASSWORD_HASH`, etc. — values never read into
     output).
   No Railway settings (domains, volumes, scaling, build/start, triggers)
   were modified; the only Railway-side object created is the deployment
   itself.

**Live health probe** (after deployment):
`GET /health` → HTTP 200:
`status=ok, ready=true, lifecycle=RUNNING, environment=production,
uptimeMs≈162569 (fresh start), startupDurationMs≈3318, shuttingDown=false`,
all components `true` (logger, gameCatalog, eventBus, gameManager,
roomManager, playerManager, configurationEngine, gameStateEngine,
gameClockEngine, physicsEngine, simulationLoop, paymentSessionManager,
winnerEngine, paymentEngine, inputAuthority, recoveryEngine, auditEngine,
roomLobbyBridge, socketGateway, operationalMetrics, …), runtime:
0 active rooms/games/simulations, monitoring collectors healthy.

## 6. Errors / Anomalies Observed

- `npm warn config production Use --omit=dev instead.` — the ONLY
  `severity=error` entry in the deployment logs; it is npm's deprecation
  warning about the `--production` npm flag, pre-existing in prior
  deployments, benign, no action taken.
- One transient `[warn] Health degradation` line during the
  STARTING→RUNNING switch; immediately followed by
  `Startup complete`/`Server Ready`, and `/health` reports every component
  healthy. Treated as a benign startup-window warning.
- Local tooling notes (no Railway impact): the public GraphQL root query
  `projects` returned `Not Authorized` via `railway api` (worked around with
  `railway project list --json`); a Windows PSReadLine rendering exception
  occurred while a long command line was being typed locally. Neither
  affected the deployment or Railway state.

## 7. Risks

- Critical / High: none identified. The deployment replaced the previous
  build with the audited commit `19a88f7`; the change itself (active-wallet
  polling) was validated in `2026-09-30_active_room_wallet_only_polling.md`
  (regression suites unchanged vs baseline, including pre-existing failures
  reproduced identically).
- Medium: none observed.
- Low: the service is now pinned to `19a88f7…` via the commit-pinned
  deployment. A subsequent `serviceInstanceDeployV2` without `commitSha`
  (or the dashboard Deploy button) will move the pin to the branch HEAD at
  that time. Wallet catalogs and all financial variables remain identical.

## 8. Recommendations

- None required for this task. For future mainnet promotions, reuse the same
  `serviceInstanceDeployV2(commitSha: …)` path to keep the deployed commit
  explicit and auditable.

## 9. Changes Made

- Railway: created deployment `ea935848-390c-4266-96b5-a3e174e6d8ec`
  (commit `19a88f7…`) on service `positive-clarity`, environment
  `production`. Final status SUCCESS. Nothing else changed on Railway.
- GitHub: no changes (commit was already pushed).
- Vercel: no changes.
- Local: this report created at
  `AI_CONTEXT/CLINE_REPORTS/2026-09-30_mainnet_19a88f7_deployment.md`;
  intentionally NOT committed or pushed (per operator instruction).
  Temporary scratch files (`_rw_tmp/`) were deleted after the task.

