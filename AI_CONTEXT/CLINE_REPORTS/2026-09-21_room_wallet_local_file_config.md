# Room Wallet Testnet — Local File-Path Configuration

Date: 2026-09-21

Task: Resolve the local Testnet startup error
`"ROOM_WALLETS_TESTNET_JSON is required for testnet Room Wallet payments"` by
adding a local file-path configuration source
(`ROOM_WALLETS_TESTNET_JSON_PATH`) to the existing Room Wallet configuration
resolver. No changes to Page4, payment flow, or Room Wallet financial policy.

## 1. Scope

- Local Testnet Room Wallet configuration only.
- Configuration-domain change inside the existing resolver
  (`RoomWalletRuntimeResolver.js`); no payment logic touched.
- Local-only file source; Railway production behavior unchanged.

## 2. Files Inspected

- `AI_CONTEXT/WHEELWIN_MASTER_CONTEXT.md`, `ARCHITECTURE_RULES.md`,
  `CURRENT_STATE.md`, `AI_WORKING_RULES.md` (project rules).
- `server/payment/roomWallet/RoomWalletRuntimeResolver.js` (owner of the
  Room Wallet runtime catalog resolution).
- `server/app.js` (startup call site: `createRoomWalletRegistryFromEnv(process.env)`,
  line ~1734 — the fail-closed point that previously crashed startup).
- `server/config/validators/validateSecrets.js`,
  `server/config/schemas/environmentSchema.js`,
  `server/config/secrets.js` (validation pipeline; confirmed no unknown-env-key
  enforcement and no schema change required).
- `server/payment/roomWallet/roomWalletConfig.js` (intake gate).
- `server/tests/roomWalletRuntimeResolver.test.js`,
  `server/tests/roomWalletSecretHardening.test.js`,
  `server/tests/helpers/dummyRoomWallet.js` (test conventions).
- `server/.env`, `.gitignore` (local config + secret protection).
- `C:\Users\DAAT\WheelWin-offline-secrets\2026-09-04-room-wallets-testnet\`
  (source of the wallet JSON; contents never printed).

## 3. Architecture Findings

`RoomWalletRuntimeResolver.loadRoomWalletRuntimeConfig(env)` is the single
owner of Room Wallet runtime catalog resolution. Before the change the Testnet
catalog could come only from the direct `ROOM_WALLETS_TESTNET_JSON` variable
(or legacy `ROOM_WALLETS_JSON`). Locally neither was set, so `app.js`
startup failed closed with the reported error. Server authority, fail-closed
behavior, and the validation pipeline (64-wallet catalog, key/address
consistency, network tags) are untouched.
## 4. Lifecycle Flow

Startup: `app.js` → dotenv loads `server/.env` → initialization reaches
`createRoomWalletRegistryFromEnv(process.env)` →
`loadRoomWalletRuntimeConfig(env)` → resolves catalog with the new precedence:

1. `ROOM_WALLETS_TESTNET_JSON` (direct variable; Railway keeps using this)
2. `ROOM_WALLETS_TESTNET_JSON_PATH` (new local file-path source, Testnet only;
   file read + JSON validation, contents never logged)
3. `ROOM_WALLETS_JSON` (existing legacy Testnet compatibility fallback)
4. Otherwise: the unchanged existing error
   `"ROOM_WALLETS_TESTNET_JSON is required for testnet Room Wallet payments
   (ROOM_WALLETS_JSON is accepted as a Testnet compatibility fallback)"`.

Failure modes of the file source are fail-closed with clear messages that
include only the resolved path and reason:
- file not found → `ROOM_WALLETS_TESTNET_JSON_PATH file not found: <path>`
- unreadable → `ROOM_WALLETS_TESTNET_JSON_PATH could not be read (<code>): <path>`
- empty file → `Room Wallet catalog file is empty: <path>`
- malformed JSON → `Room Wallet catalog file is not valid JSON: <path>`

## 5. Ownership Boundaries

- Owner module unchanged: `RoomWalletRuntimeResolver.js` still owns catalog
  resolution; `RoomWalletRegistry`, payment flow, and settlement are untouched.
- The file source is only an additional configuration input to the same
  parser/validator; no parallel resolution system was created.
- Relative paths are resolved from the server project root derived from the
  module location (`…/server`), independent of process CWD; absolute paths are
  used as-is.
- Mainnet behavior unchanged: no file-path source, no legacy fallback.

## 6. Risks

- Critical: none.
- High: none.
- Medium: none.
- Low:
  - If a path file exists while the direct variable is also set, the file is
    deliberately not read (lazy evaluation) — the direct variable always wins.
  - A configured path file that is missing/malformed fails startup
    (fail-closed); this is intentional and never falls back silently.
  - Pre-existing failures in `roomWalletSecretHardening.test.js` (10/14) were
    already failing before this change (tests predate the `TON_NETWORK` gate)
    and are unchanged; fixing them is out of scope.

## 7. Recommendations

- (Optional, separate stage) Update `roomWalletSecretHardening.test.js`
  fixtures to the current `TON_NETWORK`-gated resolver API.
- (Optional) Add `ROOM_WALLETS_TESTNET_JSON_PATH` documentation to the
  environment schema suggested-fix text. Not required for behavior.

## 8. Changes Made

### Files changed

1. `server/payment/roomWallet/RoomWalletRuntimeResolver.js`
   - Header documentation updated (precedence + file-source rules).
   - New constant `ROOM_WALLETS_TESTNET_JSON_PATH_ENV`.
   - New `SERVER_PROJECT_ROOT` (module-location derived, `…/server`).
   - `loadRoomWalletRuntimeConfig`: lazy Testnet file-path source between the
     direct variable and the legacy fallback; the error for "neither source
     exists" is byte-for-byte unchanged.
   - New helper `readTestnetRoomWalletCatalogFromPath()` — reads the file
     without ever logging its contents; errors carry path + reason only.
2. `server/.env`
   - Added `ROOM_WALLETS_TESTNET_JSON_PATH=./config/room-wallets-testnet-ROOM_WALLETS_JSON.json`
     (the wallet JSON itself is NOT in `.env`).
3. `.gitignore`
   - Added explicit `server/config/room-wallets-testnet-ROOM_WALLETS_JSON.json`.
   - Existing wildcard patterns (`*room-wallets-testnet*.json`,
     `*ROOM_WALLETS_JSON.json`, incl. `server/.gitignore`) remain; the config
     directory itself is NOT broadly ignored.
4. `server/config/room-wallets-testnet-ROOM_WALLETS_JSON.json` — copied
   (byte-identical) from the offline-secrets directory; see Section 9.
5. `server/tests/roomWalletTestnetFilePathConfig.test.js` (new focused tests;
   deterministic dummy fixtures only — the real wallet file is never read by
   tests and no secret material is printed).

Not modified (as instructed): Page4, payment flow, Room Wallet financial
policy, Railway Variables, wallet data, environment schema/validators.

## 9. Configuration Mechanism Implemented (exact) + Wallet Copy Confirmation

- Source directory:
  `C:\Users\DAAT\WheelWin-offline-secrets\2026-09-04-room-wallets-testnet\`.
- Source file: `room-wallets-testnet-ROOM_WALLETS_JSON.json` (24,122 bytes).
- **Confirmation of copy:** copied byte-identically to
  `server/config/room-wallets-testnet-ROOM_WALLETS_JSON.json`. SHA-256 of
  source and destination are identical:
  `857033046FE8769F0C42445396BD7DED4B838917A75844AE40970CB60AC3C30E`.
  Contents were never printed, logged, or included in any report/test output.
  No wallet data was generated, modified, or regenerated.
- Variable: `ROOM_WALLETS_TESTNET_JSON_PATH` (string path to a catalog JSON
  file).
- Resolution: absolute paths used as-is; relative paths resolved against the
  server project root (`…/server`), derived from the resolver module location
  so it works from any CWD (local value
  `./config/room-wallets-testnet-ROOM_WALLETS_JSON.json` works).
- Read: synchronous UTF-8 read at configuration-load time; file must contain
  the JSON array (parsed once in the helper for a path-qualified error, then
## 10. Tests Executed and Results

Baseline (before change):
- `server/tests/roomWalletRuntimeResolver.test.js`: 6/6 pass.
- `server/tests/roomWalletSecretHardening.test.js`: 4 pass / 10 fail
  (pre-existing failures; unchanged before/after this task).

After change (`node --test`, exit code 0):
- `server/tests/roomWalletTestnetFilePathConfig.test.js`: 9/9 pass —
  1. direct `ROOM_WALLETS_TESTNET_JSON` takes precedence over the file path
     (file source proven untouched while the direct value is present);
  2. file-path fallback via relative path resolved from the server project
     root;
  3. file-path fallback via absolute path;
  4. missing both sources → unchanged existing configuration error;
  5. missing file → clear `ROOM_WALLETS_TESTNET_JSON_PATH file not found`
     error;
  6. malformed JSON file → clear
     `Room Wallet catalog file is not valid JSON` error; asserted the error
     message does NOT contain the planted file marker (no content exposure);
  7. legacy `ROOM_WALLETS_JSON` compatibility fallback still works;
  8. Mainnet ignores the Testnet file-path source and keeps its
     required-variable error;
  9. startup entry point `createRoomWalletRegistryFromEnv` builds the
     registry from the file-path source (signing material stays out of the
     registry).
- `server/tests/roomWalletRuntimeResolver.test.js`: 6/6 pass
  (compatibility intact).
- `server/tests/roomWalletSecretHardening.test.js`: 4 pass / 10 fail —
  identical to baseline (no regression introduced, no change attempted).

## 11. Local Server Startup Result

`node app.js` (server dir, port 3001) after the change — startup completed:

- `RoomWalletSettlementRouter (ROOM_WALLET) OK`
- `RoomWalletTerminalSettlementRecovery OK`
- `RoomWalletIncomingObserver (64 wallets) OK` ← the 64-wallet catalog loaded
  from the new file-path source
- `RoomWalletResidualSweepWorker OK`
- `Startup complete`
- Incoming-observer cycles ran against Testnet (`catalog=64`, cycles
  completed; unrelated testnet traffic rejected fail-closed with
  `missing_sender` / `wrong_destination` warnings — expected behavior).

The previous error
`"ROOM_WALLETS_TESTNET_JSON is required for testnet Room Wallet payments"`
does not appear anywhere in stdout/stderr (verified by string search over both
logs; the variable name and any wallet content appear nowhere in the logs).
The verification instance was stopped after the check (environment left
clean; start the server normally with `npm start`).

## 12. Remaining Issues

- None for this task. Pre-existing, out of scope, unchanged:
  `roomWalletSecretHardening.test.js` has 10 pre-existing failures against the
  current `TON_NETWORK`-gated resolver API (identical before and after this
  change); `LOCAL_SYNC_REPORT.txt` and several other pre-existing modified
  files in the worktree were left untouched.

  processed by the existing validation pipeline).
- Precedence: direct `ROOM_WALLETS_TESTNET_JSON` →
  `ROOM_WALLETS_TESTNET_JSON_PATH` → legacy `ROOM_WALLETS_JSON` → existing
  error (unchanged).
- Testnet-only: the file source is ignored for Mainnet.
- **Confirmation of .gitignore protection:** `git check-ignore -v
  server/config/room-wallets-testnet-ROOM_WALLETS_JSON.json` → ignored
  (pattern `*ROOM_WALLETS_JSON.json` in `server/.gitignore`, plus the new
  explicit root `.gitignore` entry and the testnet wildcard). `git status`
  does not list the file; it cannot be committed.
- Security: file contents are never logged, returned, or printed anywhere;
  all failure messages contain only the resolved path and a reason.

