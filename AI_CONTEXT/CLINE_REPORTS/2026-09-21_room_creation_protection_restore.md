# Room Creation Protection Restore — dual-origin experiment reverted

Date: 2026-09-21

Task: Revert ONLY the unfinished "dual-origin room creation" experiment
(identified in `2026-09-21_deployment_readiness.md`) and restore the
Telegram-only Room Creation protection. Nothing else was changed.

## Files restored / deleted

Restored exactly to HEAD `dc742003` via
`git restore --source=dc742003 --worktree --` (unstaged restore; no staging):

- `server/socket/RoomLobbyBridge.js`
- `server/tests/roomCreationTelegramAuthorization.r179t6c.test.js`
- `server/tests/attackEObservability.r179t8.test.js`
- `server/tests/telegramIdentityResolverWiring.r179t6d.test.js`
- `server/tests/roomCreationProtection.integration.test.js`

Deleted (untracked experimental file):

- `server/tests/roomCreationWebOrigin.test.js`

Note: `git status` still lists the two test files
(`attackEObservability.r179t8.test.js`,
`roomCreationProtection.integration.test.js`) as ` M`, but `git diff HEAD`
for them is EMPTY — the residual flag is CRLF/LF normalization noise only
(`core.autocrlf` line-ending state), with zero content difference from
`dc742003`. Nothing is staged.

## Telegram-only Room Creation protection — RESTORED

- `server/socket/RoomLobbyBridge.js` again rejects unauthenticated /
  non-Telegram browser sockets in `_handleCreateRoom`:
  `if (creatorTelegramUserId == null)` (line 1181) →
  `ROOM_CREATION_REQUIRES_TELEGRAM` (line 1193) before any room/player/
  setup-session/recovery-credential allocation. The per-user creation quota
  and the R22/R23 handoff owner-identity boundary are back on the
  Telegram-only path.
- The dual-origin experiment code is fully gone: zero occurrences of
  `isTelegramOrigin` remain in the bridge.
- Verified by the passing security suites below: unauthenticated
  `CREATE_ROOM` is rejected with `ROOM_CREATION_REQUIRES_TELEGRAM` and
  allocates zero rooms, and forged client `telegramUserId`/`initData`
  payloads gain nothing (identity still comes only from the authenticated
  socket context via `server/app.js` → `configureTelegramIdentityResolver`).

## Security test results (main working tree, after restore)

- `server/tests/roomCreationTelegramAuthorization.r179t6c.test.js`
  → "all assertions passed"
- `server/tests/attackEObservability.r179t8.test.js` → "all passed"
- `server/tests/telegramIdentityResolverWiring.r179t6d.test.js`
  → "all assertions passed"
- `server/tests/roomCreationProtection.integration.test.js`
  → "all assertions passed"
  (the logged "concurrent room limit reached" ERROR line is the expected
  saturation scenario inside the suite)

4/4 pass — identical to the HEAD-state results in the deployment-readiness
report.

## Untouched areas — confirmed

- Page4: `client/src/pages/Page4Payment.jsx` still carries exactly the same
  intentional rebuild diff as before the restore
  (`git diff HEAD --numstat`: 680 insertions / 3246 deletions — unchanged);
  no other Page4 file touched.
- Room Wallet configuration: `server/payment/roomWallet/RoomWalletRuntimeResolver.js`
  not modified (absent from `git diff HEAD`); local
  `server/.env` (with `ROOM_WALLETS_TESTNET_JSON_PATH=./config/room-wallets-testnet-ROOM_WALLETS_JSON.json`)
  untouched; no Vercel/Railway configuration touched; no Telegram
  authentication file touched.
- `server/config/room-wallets-testnet-ROOM_WALLETS_JSON.json` remains
  Git-ignored: `git check-ignore -v` → matched by
  `server/.gitignore:15:*ROOM_WALLETS_JSON.json` (plus the explicit root
  `.gitignore` entry). Still not tracked.

## Nothing committed or pushed

- HEAD is still `dc742003`; `git rev-list --count origin/payment/room-wallet-integration..HEAD`
  = 0 (branch not ahead of origin; no new commits).
- `git add .` was not used; nothing was staged; nothing was pushed.
