# Vercel Mainnet Production Promotion — Commit 872562d (Recovery After Network Failure)

Date: 2026-09-30

Task: Continue the interrupted Vercel operation for the Mainnet project
`wheelwin-main` after a network connection loss. Determine whether the
promotion of deployment `dpl_GkKHu4NRRSGCy73dXzPrFPPgUkvS` (expected commit
`872562d85b08ba534e9f47f089c093a06ad678c7`) had already completed before the
SocketError; promote it only if it was not already Production; then verify the
final Production state, the `/debug` Developer Console, and the absence of the
older `810372` production deployment.

Security statement: no secret value (Vercel token, Railway credential,
mnemonic, private key, password hash, session secret) was printed, logged, or
written to any file. All Vercel CLI commands ran under the pre-existing local
CLI login (`navalvik-4664`). No environment variables, domains, project
settings, or deployments were created, modified, or deleted. No rebuild was
triggered. No blockchain transaction was sent.

---

## 1. Scope

- Read-only inspection of the Vercel project `wheelwin-main`
  (scope/team `navalvik-4664s-projects`, project id `prj_jgzGps3u2YBSeaoFWCM0HBBysYPg`).
- Determination of the current Production deployment and its commit.
- Determination of the status/target of `dpl_GkKHu4NRRSGCy73dXzPrFPPgUkvS`.
- Decision: promote only if not already Production (per operator instruction).
- Independent verification of the Production commit SHA and the live
  `/debug` Developer Console on the Mainnet production site.
- Verification that no older `810372` deployment remains the active
  Production deployment.
- NOT touched: source code, `vercel.json`, Railway (any environment),
  Vercel environment variables, domains, project settings, Testnet Vercel
  project `wheelwin`, wallet catalogs, payment/settlement logic.

## 2. Files Inspected

Context (per `.clinerules` pre-analysis rule):

- `AI_CONTEXT/CLINE_REPORTS/2026-09-30_mainnet_testnet_refund_explorer_and_debug_parity.md`
  (immediately preceding stage report; defines this deployment stage, the
  `/debug` SPA enablement on Mainnet, and the live-verification method)
- Prior reports referencing the `810372b` baseline:
  `2026-09-30_mainnet_wallet_identity_balance_and_storage_audit.md`

Local repository state:

- `git log` / `git reflog` / `git rev-parse` at `g:\WheelWin`
  (HEAD = `872562d85b08ba534e9f47f089c093a06ad678c7`,
  branch `payment/room-wallet-integration`, remote tip `origin/...` = same SHA)
- `.vercel/project.json` (local link: project `wheelwin-main`)
- `_audit_tmp/frontend-checks.ps1` (pre-existing secret-safe live frontend
  verification script; reused as-is for the `/debug` check)

Vercel CLI outputs (captured to local scratch files, later removed):

- `vercel inspect dpl_GkKHu4NRRSGCy73dXzPrFPPgUkvS -F json`
- `vercel ls wheelwin-main -F json` (20 most recent deployments, incl. meta)
- `vercel alias ls` (scope-wide alias table)
- `vercel inspect wheelwin-main.vercel.app -F json` (domain → deployment resolution)

Live HTTP probes (read-only):

- `https://wheelwin-main.vercel.app/`
- `https://wheelwin-main.vercel.app/debug` (+ main JS asset + console chunk)

## 3. Findings — Direct Answers

### 3.1 Had the promotion already completed before the network failure?

**YES.** The promotion of `dpl_GkKHu4NRRSGCy73dXzPrFPPgUkvS` to Production
completed successfully at **2026-09-30 00:20:41 UTC** (03:20:41 local, UTC+3),
~34 minutes after the original deployment became READY. Evidence:

- Vercel implements `vercel promote` not by re-tagging the original
  deployment, but by creating a **promotion deployment record** that reuses
  the original build output and carries `target: "production"` plus the
  metadata pair:
  - `"action": "promote"`
  - `"originalDeploymentId": "dpl_GkKHu4NRRSGCy73dXzPrFPPgUkvS"`
- That record exists, is `READY`, and currently holds ALL production aliases
  of the project.

### 3.2 Was any additional promotion necessary?

**NO — and none was performed.** Per the operator instruction ("If that exact
deployment is already Production, do NOT promote it again"), the promotion was
identified as complete and `vercel promote` was NOT executed. Re-promoting
would have created a second, redundant promotion record for no benefit.

### 3.3 Final Production deployment

| Item | Value |
|---|---|
| Project | `wheelwin-main` (scope `navalvik-4664s-projects`) |
| Production deployment ID (live record) | `dpl_TQs8GyGCSwiAy4sTzsNRAEtmjdJ1` |
| Production deployment URL | `wheelwin-main-8cb32z5yd-navalvik-4664s-projects.vercel.app` |
| Promotion record of (original deployment) | `dpl_GkKHu4NRRSGCy73dXzPrFPPgUkvS` |
| Original deployment URL | `wheelwin-main-firznyd38-navalvik-4664s-projects.vercel.app` |
| `target` of promotion record | `production` |
| `readyState` of promotion record | `READY` |
| Production commit SHA | `872562d85b08ba534e9f47f089c093a06ad678c7` |
| Commit message | `feat(mainnet): match testnet explorer refund verification and debug console` |
| Branch | `payment/room-wallet-integration` (matches local HEAD and `origin` tip) |
| Aliases held by the production record | `wheelwin-main.vercel.app`, `wheelwin-main-navalvik-4664s-projects.vercel.app`, `wheelwin-main-git-payment-room-w-4e71e6-navalvik-4664s-projects.vercel.app` |

Interpretation of the success criterion: the Production deployment is the
promotion record **of exactly** `dpl_GkKHu4NRRSGCy73dXzPrFPPgUkvS` (Vercel's
own `originalDeploymentId` linkage) and serves that deployment's build output
for commit `872562d85b08ba534e9f47f089c093a06ad678c7`. This is the canonical,
successful end state of `vercel promote` for that deployment.

### 3.4 Deployment timeline (project `wheelwin-main`, relevant entries)

| Time (UTC) | Deployment | Commit | target | Note |
|---|---|---|---|---|
| Sep 29 19:24:24 | `wheelwin-main-2e7rj0845` | `810372b060b4…` | preview | original of the earlier 810372 promotion |
| Sep 29 20:37:08 | `wheelwin-main-pov66nr6l` | `810372b060b4…` | production | promotion record of `dpl_4VFFB483…` (810372 era) |
| Sep 29 23:27:38 | `wheelwin-main-p32hrhuc1` | `810372b060b4…` | production | CLI production deploy from a dirty working tree (`gitDirty: 1`) |
| Sep 29 23:46:51 | `wheelwin-main-firznyd38` = **`dpl_GkKHu4NRRSGCy73dXzPrFPPgUkvS`** | `872562d85b0…` | preview | the target deployment of this task (READY) |
| Sep 30 00:20:41 | `wheelwin-main-8cb32z5yd` = `dpl_TQs8GyGCSwiAy4sTzsNRAEtmjdJ1` | `872562d85b0…` | **production** | **promotion record of `dpl_GkKHu4NRRSGCy73dXzPrFPPgUkvS`** — promotion completed here, before the network failure |

## 4. Commit Identity Verification (independent, multi-source)

1. **Original deployment metadata** (`vercel ls -F json`, entry
   `wheelwin-main-firznyd38`): `meta.githubCommitSha =
   872562d85b08ba534e9f47f089c093a06ad678c7`, `githubCommitRef =
   payment/room-wallet-integration`, `githubCommitRepo = wheelwin`,
   commit message identical to the local HEAD commit message.
2. **Promotion record metadata** (same listing, entry
   `wheelwin-main-8cb32z5yd`): same `githubCommitSha` (872562d…), plus
   `action = "promote"` and `originalDeploymentId = dpl_GkKHu4NRRSGCy73dXzPrFPPgUkvS`
   — tying the live Production record to the exact requested deployment.
3. **Local git cross-check**: HEAD of `g:\WheelWin` =
   `872562d85b08ba534e9f47f089c093a06ad678c7` on
   `payment/room-wallet-integration`, and `origin/payment/room-wallet-integration`
   points at the same SHA; the commit subject matches the Vercel metadata.
4. **Live behavioral check**: the string
   `TON Explorer Verification (Manual)` exists in the source tree only in
   `client/src/console/panels/HistoryPanel.jsx` (introduced by the `872562d`
   work) and IS present in the live Production console chunk
   (`PageDeveloperConsole-Cy671be6.js`) — proving the served bundle is the
   `872562d` build.

## 5. Live Production Verification (`/debug`)

Base: `https://wheelwin-main.vercel.app` (Production)

| Check | Result |
|---|---|
| `GET /` (site loads) | `PROD_ROOT_STATUS=200` |
| `GET /debug` | `PROD_DEBUG_STATUS=200` |
| `/debug` HTML references app asset | `PROD_DEBUG_HAS_ASSET=True` (`/assets/index-DFK9OWDk.js`) |
| Main bundle registers `/debug` SPA route | `LIVE_DEBUG_ROUTE_PRESENT=True` |
| Main bundle references console chunk | `LIVE_CONSOLE_CHUNK_REF=True` (`PageDeveloperConsole`) |
| Console chunk served | `/assets/PageDeveloperConsole-Cy671be6.js` |
| `872562d`-only feature in chunk: `TON Explorer Verification (Manual)` | `LIVE_EXPLORER_SECTION_IN_CHUNK=True` |
| Manual-explorer disclaimer present | `LIVE_DISCLAIMER_IN_CHUNK=True` |
| Console auth API wired (`/console/auth/login`) | `LIVE_CONSOLE_AUTH_API_IN_CHUNK=True` |

Result: the Developer Console frontend IS present and live at
`https://wheelwin-main.vercel.app/debug` on the Production deployment.

Note (non-blocking): the direct preview URL of the original deployment
(`wheelwin-main-firznyd38-…/debug`) returns Vercel's platform challenge page
(standard Deployment Protection for non-production URLs; HTTP 200, HTML with
`data-dpl-id` of an internal platform deployment, no app asset). This is
expected behavior and was NOT used as evidence; API metadata + the live
Production bundle were used instead.

## 6. No Older `810372` Deployment Is Active Production

- The Production domain `wheelwin-main.vercel.app` resolves (via
  `vercel inspect wheelwin-main.vercel.app -F json`) to
  `dpl_TQs8GyGCSwiAy4sTzsNRAEtmjdJ1` (`wheelwin-main-8cb32z5yd`, commit
  `872562d…`) — not to any `810372…` deployment.
- Scope-wide `vercel alias ls` shows the two superseded `810372b`
  production-target deployments (`wheelwin-main-p32hrhuc1`,
  `wheelwin-main-pov66nr6l`) currently hold **zero aliases** — they serve no
  domain. The only other `wheelwin-main` alias (`…git-main…`) belongs to an
  unrelated `main`-branch deployment from 2026-09-26 and is not a production
  domain.
- The `810372b` deployments remain only as deployment history/retention
  objects, which is normal Vercel behavior and out of scope for this task.

## 7. Clarification: the `4e71e6` branch-alias name is NOT a commit mismatch

The branch alias name
`wheelwin-main-git-payment-room-w-4e71e6-…` was created ~20 days ago from the
first deployment of this branch (that commit no longer exists locally; the
reflog shows the branch was later rebased). Vercel reuses the same
branch-alias NAME for every subsequent deployment of the branch: the
`branchAlias` metadata of ALL recent branch deployments (`810372b`, `1201ba0`,
`872562d`, …) is identical, and the alias currently points to the `872562d`
promotion record. The embedded `4e71e6` is therefore a historical artifact of
the alias name, not the commit of the current deployments. Commit identity was
verified via `meta.githubCommitSha` (see §4), not via the alias name.

## 8. Risks

- Critical: none.
- High: none.
- Medium: none identified by this task.
- Low:
  - `wheelwin-main-p32hrhuc1` (the interim production deploy) was built from a
    dirty working tree on top of `810372b` (`gitDirty: 1`). It is now fully
    superseded by the `872562d` promotion record; no action taken or needed.
    Recorded only so future audits understand the interim state.
  - Superseded `810372b` deployments remain listed under the project until
    Vercel retention removes them; harmless, but they should not be mistaken
    for active deployments (they hold no aliases).
  - The branch-alias name contains a stale hash (`4e71e6`); cosmetic only.

## 9. Recommendations

- None required for this task — the requested end state already exists.
- Process note (for future stages): prefer promoting/deploying Production from
  a clean working tree at the pushed commit SHA (as the final `872562d`
  promotion now does), so the Production commit metadata always matches the
  audited source tree.

## 10. Changes Made

- No source code, configuration, environment variable, domain, project
  setting, or deployment changes. No rebuild was triggered. No new Vercel
  deployment was created. No promotion command was executed (promotion was
  already complete).
- This report was created locally at
  `AI_CONTEXT/CLINE_REPORTS/2026-09-30_vercel_mainnet_872562d_production_promotion.md`
  and intentionally NOT committed or pushed (per operator instruction).
- Temporary scratch files created during verification (CLI output captures and
  probe scripts) were removed after the report was written; pre-existing
  untracked files (`_stage2_tmp_out.txt`, `_audit_tmp/frontend-checks.ps1`)
  were left untouched.


