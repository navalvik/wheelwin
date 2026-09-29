# Stage 3.0 — Room Wallet Catalog Inventory (TESTNET + MAINNET)

Date: 2026-09-28

Task: READ-ONLY inventory of the existing TESTNET and MAINNET Room Wallet
catalogs and of the configuration/loader path that references them.
Application source, tests, JSON catalogs, `.env` files, deployment files,
package files and configuration files were NOT modified. No wallets were
generated, no catalog was created, nothing was committed, pushed or deployed.
GameEscrow / DepositContract / DepositPackage / smart-contract payment flow and
the separate-Mainnet-application handoff were not restored or activated.

## 1. Scope

- Local TESTNET Room Wallet catalog used by the running application
  (location, schema, entry count, room-number mapping, loader path).
- Search of the repository and local operator directories for an existing
  MAINNET Room Wallet catalog (location, structure, count, mapping), with
  special attention to `ROOM_WALLETS_MAINNET_JSON` /
  `ROOM_WALLETS_TESTNET_JSON` configuration references.
- Configuration/environment resolution of both catalog variables and of
  `TON_NETWORK` (required vs optional, single global catalog, testnet
  assumptions).
- Room Wallet catalog loader/provisioner behavior (schema, validation,
  duplicates, expected count, network support).
- Existing focused tests covering catalog loading, testnet selection,
  mainnet catalog/provisioning and network-specific wallet behavior.

## 2. Files Inspected

Context (per `.clinerules`): `AI_CONTEXT/WHEELWIN_MASTER_CONTEXT.md`,
`AI_CONTEXT/ARCHITECTURE_RULES.md`, `AI_CONTEXT/CURRENT_STATE.md`,
`AI_CONTEXT/AI_WORKING_RULES.md`, latest report
`AI_CONTEXT/CLINE_REPORTS/2026-09-28_stage2_payment_session_room_network_propagation.md`
(and, via targeted search, `2026-09-27_stage0_local_baseline_audit.md`,
`CURRENT_TESTNET_PAYMENT_INTERFACE_MAP.md`, `2026-09-21_*` reports).

Source/configuration read directly:

- `server/payment/roomWallet/RoomWalletRuntimeResolver.js` (full)
- `server/payment/roomWallet/RoomWalletRegistry.js` (full)
- `server/payment/roomWallet/roomWalletConfig.js` (full)
- `server/payment/roomWallet/RoomWalletIncomingObserver.js` (lines 180-280)
- `server/gameplay/PaymentSessionManager.js` (420-445, 500-535, 2740-2900)
- `server/app.js` (lines 1620-1710)
- `server/config/schemas/environmentSchema.js` (lines 840-940)
- `server/config/validators/validateEnvironment.js` (lines 700-760)
- `server/config/validators/validateSecrets.js` (lines 180-290)
- `server/config/secrets.js` (full)
- `server/scripts/lib/provisionRoomWallets.js` (full)
- `server/scripts/provision-room-wallets.mjs` (full)
- `docs/MAINNET_ROOM_WALLET_PROVISIONER.md` (full)
- Tests (targeted reads): `roomWalletRuntimeResolver.test.js`,
  `roomWalletTestnetFilePathConfig.test.js`, `provisionRoomWallets.test.js`,
  `roomWalletSecretHardening.test.js`, `roomWalletAppComposition.test.js`
- `.gitignore` / `server/.gitignore` (wallet/env entries only),
  `server/.env.example` (key names only), `server/.env` (key NAMES only —
  values never read or printed)

Filesystem inspection (names/metadata only, never secret file contents):
`G:\WheelWin\server\config`, repo-wide `room-wallets-*` search,
`G:\secure` (absent), `C:\Users\DAAT\WheelWin-offline-secrets` (names only).

## 3. Git / Worktree State

`git status --short` was run before inspection and again at the end; the tree
state is identical to the Stage 2 working state:

- Branch `payment/room-wallet-integration`, HEAD `0d3f93a`
  ("fix(recovery): finalize room wallet refund restore").
- Modified (uncommitted, pre-existing Stage 2 implementation):
  `server/gameplay/PaymentSessionManager.js`,
  `server/socket/RoomLobbyBridge.js`.
- Untracked (pre-existing): eleven `AI_CONTEXT/CLINE_REPORTS/2026-09-27_*` /
  `2026-09-28_stage2_*` reports and
  `server/tests/paymentSessionRoomNetwork.test.js`.
- This stage adds exactly ONE new untracked file: this report.

No pre-existing untracked reports or unrelated changes were altered or cleaned
up. Nothing staged, committed or pushed.

## 4. TESTNET Room Wallet Catalog

- Exact location (local runtime file):
  `G:\WheelWin\server\config\room-wallets-testnet-ROOM_WALLETS_JSON.json`
  (24,122 bytes).
- Git isolation: root `.gitignore` ignores `*room-wallets-testnet*.json`,
  `*ROOM_WALLETS_JSON.json` and explicitly
  `server/config/room-wallets-testnet-ROOM_WALLETS_JSON.json` (comment:
  "Local Testnet Room Wallet runtime catalog (copied from offline secrets —
  never commit)"). `server/.gitignore` mirrors the wildcard entries.
- Offline master copies:
  `C:\Users\DAAT\WheelWin-offline-secrets\2026-09-04-room-wallets-testnet\`
  contains `room-wallets-testnet-ROOM_WALLETS_JSON.json` (24,122 bytes) and
  `room-wallets-testnet-master-backup.json` (30,454 bytes). The local runtime
  file is byte-identical (SHA-256 equality verified) to the offline runtime
  copy.
- Entry count: exactly 64.
- Schema (uniform across all 64 entries): `roomNumber`, `address`,
  `publicKey`, `secretKey`, `workchain`, `network`.
- Room-number mapping: `roomNumber` is 1..64 with no gaps and no duplicates;
  the room number IS the wallet index (`RoomWalletRegistry` keys records by
  `roomNumber`; `RoomManager` allocates room numbers 1..64; the address
  binding happens at payment-session creation via
  `PaymentSessionManager._resolveRoomWalletPaymentAddress` and is persisted on
  the session).
- Observed values: every entry carries `network: "testnet"` and
  `workchain: 0`; addresses are bounceable url-safe `EQ…` form (masked
  samples: room 1 `EQD…pvQB`, room 2 `EQD…rnRU`, room 3 `EQD…4BXe`).
- Local runtime resolution: `server/.env` contains the key
  `ROOM_WALLETS_TESTNET_JSON_PATH=./config/room-wallets-testnet-ROOM_WALLETS_JSON.json`
  (key name recorded only). The direct `ROOM_WALLETS_TESTNET_JSON` variable is
  not set locally; on the Testnet Railway service it is the primary source
  (precedence 1).
- Loader path: `server/payment/roomWallet/RoomWalletRuntimeResolver.js`
  (`loadRoomWalletRuntimeConfig` / `createRoomWalletRegistryFromEnv`),
  composed in `server/app.js:1652`.
- Verified live (read-only execution): the local Testnet catalog loads through
  the unmodified production loader with `TON_NETWORK=testnet` →
  `entries=64 roomMin=1 roomMax=64 unique=64 networks=testnet workchains=0`.

## 5. MAINNET Room Wallet Catalog

- In-repo: NOT FOUND. A recursive search of the whole repository (including
  the `.kilo` worktree copy) for `room-wallets-*` files found exactly one
  match: the Testnet catalog of §4. No `room-wallets-mainnet-*` file exists
  anywhere under `G:\WheelWin`. This matches the documented design
  (`docs/MAINNET_ROOM_WALLET_PROVISIONER.md`: "This repository must never
  contain generated wallet files."). No replacement catalog was created and no
  wallets were generated in this stage.
- Outside the repo: FOUND (offline operator secrets directory):
  `C:\Users\DAAT\WheelWin-offline-secrets\2026-09-09-room-wallets-mainnet\`
  containing:
  - `room-wallets-mainnet-ROOM_WALLETS_JSON.json` (24,122 bytes) — runtime
    catalog in the `ROOM_WALLETS_*_JSON` format;
  - `room-wallets-mainnet-master-backup.json` (30,454 bytes) — master backup
    (adds `walletContractType`, `walletId`, `schemaVersion`, `generatedAt`);
  - `owner-mnemonic.txt` (76 bytes) — NOT opened, NOT read, NOT referenced
    further (secret material).
- Entry count: exactly 64.
- Schema comparison with Testnet: IDENTICAL field set and shape —
  `roomNumber, address, publicKey, secretKey, workchain, network`, uniform
  across all 64 entries; all entries `network: "mainnet"`, `workchain: 0`;
  `roomNumber` 1..64, all unique; bounceable url-safe `EQ…` addresses (masked
  samples: room 1 `EQAh…JpOS`, room 2 `EQCq…0L77`, room 3 `EQAh…YSyu`).
  Offline testnet and offline mainnet runtime files are byte-distinct
  (different key material, as required by the "never reuse Testnet keys on
  Mainnet" rule).
- Verified live (read-only execution): the offline Mainnet runtime catalog
  loads through the unmodified production loader
  `loadRoomWalletRuntimeConfig` with `TON_NETWORK=mainnet` +
  `ROOM_WALLETS_MAINNET_JSON` → `entries=64 roomMin=1 roomMax=64 unique=64
  networks=mainnet workchains=0`. Cross-network isolation verified
  empirically in both directions:
  - Mainnet JSON offered under `TON_NETWORK=testnet` → rejected; the mainnet
    variable is not consulted on the testnet branch at all;
  - Testnet JSON offered under `TON_NETWORK=mainnet` → rejected
    ("ROOM_WALLETS_MAINNET_JSON is required for mainnet Room Wallet payments").
- Provisioner readiness: `server/scripts/provision-room-wallets.mjs` +
  `server/scripts/lib/provisionRoomWallets.js` already support
  `--network mainnet` (dedicated filenames
  `room-wallets-mainnet-master-backup.json` /
  `room-wallets-mainnet-ROOM_WALLETS_JSON.json`, `network` tag propagation,
  directory network-mixing prevention, exclusive-create, output restricted to
  an absolute directory outside the Git work tree, ACL hardening on Windows).
  The existing offline mainnet directory layout matches the provisioner's
  output naming exactly.

## 6. Configuration Findings

1. Schema (`server/config/schemas/environmentSchema.js:871-894`):
   `ROOM_WALLETS_JSON` (legacy), `ROOM_WALLETS_TESTNET_JSON` and
   `ROOM_WALLETS_MAINNET_JSON` are all `required: false`, category TON. Both
   split variables' `suggestedFix` describe them as Railway secrets holding
   "exactly 64 Room Wallet identities".
2. Secret classification (`server/config/secrets.js:17-19`): all three
   variables are in `SECRET_ENV_KEYS` and are redacted everywhere.
3. Environment validation
   (`server/config/validators/validateEnvironment.js:717-733`): both split
   variables are validated as optional strings — neither is required at this
   layer.
4. Runtime resolution
   (`RoomWalletRuntimeResolver.loadRoomWalletRuntimeConfig`, lines 61-162):
   - `TON_NETWORK` must be explicitly `testnet` or `mainnet`; anything else
     fails startup (fail-closed, no default).
   - Exactly ONE catalog is selected per process, keyed by `TON_NETWORK` via
     `ROOM_WALLET_ENV_BY_NETWORK` (testnet → `ROOM_WALLETS_TESTNET_JSON`;
     mainnet → `ROOM_WALLETS_MAINNET_JSON`).
   - Testnet-only extra sources: `ROOM_WALLETS_TESTNET_JSON_PATH` (lazy file
     read; relative paths resolved from the server project root; failures
     report path + reason only, never contents) and legacy `ROOM_WALLETS_JSON`
     fallback. Mainnet has NO file-path source and NO cross-network fallback
     (deliberate).
   - Missing catalog → fail-closed startup error naming the network-specific
     variable.
5. The active catalog is therefore GLOBAL, not per-room: `TON_NETWORK`
   selects one catalog for the whole process. `PaymentSession.network`
   (room-authoritative since Stage 2) is NOT yet used to select the wallet
   catalog. The single registry built from `TON_NETWORK` (`app.js:1652`) is
   shared by `RoomWalletIncomingObserver` (`app.js:1656-1668`),
   `PaymentSessionManager.setRoomWalletFinance` (`app.js:1680-1684`) and
   `RoomWalletResidualSweepWorker` (`app.js:1691`).
6. Testnet-specific assumptions found (all intentional, all relevant to the
   next stage):
   - `ROOM_WALLETS_TESTNET_JSON_PATH` file source and legacy
     `ROOM_WALLETS_JSON` fallback exist only on the testnet branch (resolver
     lines 78-88).
   - `server/.env` (local) does NOT set `ROOM_WALLET_PAYMENT_INTAKE_MODE`, so
     the legacy `validateSecrets` gate ("Room Wallet intake requires
     ROOM_WALLETS_JSON", `validateSecrets.js:214-249`) is dormant locally.
     That validator still keys on the LEGACY variable name and does not know
     about the split variables — stale-but-dormant consistency gap.
   - `server/.env.example` documents `ROOM_WALLETS_JSON` and
     `ROOM_WALLET_PAYMENT_INTAKE_MODE` (as comments) but does NOT mention
     `ROOM_WALLETS_TESTNET_JSON` / `ROOM_WALLETS_MAINNET_JSON` /
     `ROOM_WALLETS_TESTNET_JSON_PATH` (documentation gap, low).
   - Local `server/.env` declares `TON_NETWORK` twice (duplicate key;
     last-wins; cosmetic, low).
   - Room-Wallet payment/settlement code itself contains no testnet
     hardcoding: `isRoomWalletOnlyFinancialPath` returns `true`
     unconditionally ("Room-Wallet-only on both networks",
     `roomWalletConfig.js:40-47`); `RoomWalletIncomingObserver` records
     `network: session.network ?? this._network` (line 869), preferring the
     room-authoritative session network; `PaymentSessionManager` rejects
     `payload.network !== session.network` (lines 2784-2795).
7. Network profile context: `server/config/tonNetworkProfiles.js` selects
   TonCenter endpoints by `TON_NETWORK`; a separate read-only MAINNET
   monitoring profile exists in `app.js` (~2114-2140) and is independent of
   the Room Wallet catalog selection.

## 7. Loader / Provisioner Findings

`loadRoomWalletRuntimeConfig` (single owner of catalog parsing) validates:

- catalog is a JSON array; length ≤ `ROOM_WALLET_COUNT` (64) and, with Room
  Wallet intake enabled (hardcoded `true` inside the resolver), EXACTLY 64
  entries with `roomNumber` 1..64 all present
  (`assertCompleteRoomWalletCatalog`);
- per entry (`normalizeEntry`): integer `roomNumber` 1..64; non-empty
  `address`; `publicKey` exactly 32 bytes; `secretKey` exactly 64 bytes (hex
  preferred, base64 accepted); `workchain` must be integer 0; optional
  `network` tag must be `testnet` or `mainnet`;
- cryptographic identity proof (`assertLocalWalletIdentity`): `secretKey`
  must derive `publicKey` (`keyPairFromSeed` over the first 32 bytes) and the
  configured `address` must equal the `WalletContractV4` bounceable url-safe
  address of that public key;
- duplicate checks: duplicate `roomNumber` and duplicate `address` are both
  rejected; a catalog mixing `network` values is rejected; each entry's
  `network` tag must equal `TON_NETWORK` when present;
- network validation: the resolver itself is network-agnostic except for the
  source-selection branch — BOTH testnet and mainnet go through the exact
  same parsing/validation path. The only format difference is the `network`
  tag value. Mainnet requires NO additional fields that Testnet does not
  have (empirically proven in §5 with the real Mainnet catalog);
- registry (`RoomWalletRegistry`): stores `roomNumber` → canonical address
  (+ optional network tag); NEVER stores key material; `require(roomNumber)`
  is fail-closed; `getByAddress` provides reverse lookup (used by
  `PaymentSessionManager` for room-number attribution, line 2024).

Provisioner (`provisionRoomWallets.js` / `provision-room-wallets.mjs`):

- generates exactly 64 `WalletContractV4R2` identities, workchain 0, one
  independent `randomBytes(32)` seed per wallet (no HD mnemonic, no shared
  master seed), `network` tag per `--network testnet|mainnet` (legacy CLI
  without `--network` is testnet-only);
- `validateProvisionedCatalog`: exactly 64 wallets, unique
  addresses/publicKeys/secretKeys, workchain 0, network match,
  `roomNumber` 1..64 in generation order, `EQ…` address shape;
- output discipline: absolute output directory outside the Git work tree,
  exclusive-create (never overwrites), refuses directories that already
  contain the other network's artifacts, refuses the historical Testnet
  secrets directory basename, Windows ACL restriction; post-write
  re-validation re-reads both files, verifies SHA-256 and runs
  `loadRoomWalletRuntimeConfig` with `TON_NETWORK` equal to the requested
  network;
- stdout policy: public metadata only (network, counts, room numbers,
  addresses, paths, hashes); never `secretKey`/seed/mnemonic/publicKey
  (test-enforced).

## 8. Lifecycle Flow (catalog-related)

1. Startup: dotenv → `TON_NETWORK` present and valid (fail-closed otherwise).
2. `app.js:1652` `createRoomWalletRegistryFromEnv(process.env)` →
   `loadRoomWalletRuntimeConfig` resolves the ONE network-scoped catalog
   (testnet: direct variable → file path → legacy variable; mainnet: direct
   variable only) and validates the full 64-wallet invariants.
3. The registry (addresses only) is wired into `RoomWalletIncomingObserver`,
   `PaymentSessionManager.setRoomWalletFinance` and
   `RoomWalletResidualSweepWorker`; the signing-identity resolver
   (`createRoomWalletRuntimeResolver`, used by `RoomWalletService`) holds the
   secret material in-process only.
4. Session creation: `createPaymentSession` computes
   `activeNetwork = network ?? contract?.tonNetwork ?? this._tonNetwork`
   (lines 433-436; Stage 2 made the room network first in precedence) and
   resolves `session.roomWalletAddress` from the registry by room number
   (lines 508-522, 2855-2869); missing destination fails closed.
5. Incoming payment observation: observer matches transactions against
   `listConfiguredRoomWalletAddresses(registry)` and
   `resolveIntendedRoomWalletAddress`; ledger records carry
   `network: session.network ?? this._network`.
6. Session/payment validation: `payload.network !== session.network` is
   rejected ("Payment network mismatch").

## 9. Existing Relevant Tests (not modified)

Focused coverage that already exists (all under `server/tests/`):

- `roomWalletRuntimeResolver.test.js` — fail-closed when the catalog is
  missing; "requires exactly 64 Testnet wallets"; registry keeps signing
  material out (`publicKey`/`secretKey` absent from registry records);
  malformed signing material rejected; duplicate room mapping rejected;
  "Mainnet never falls back to the Testnet `ROOM_WALLETS_JSON` variable".
- `roomWalletTestnetFilePathConfig.test.js` — 9 tests: direct-variable
  precedence over the file path; relative/absolute file-path sources resolved
  from the server project root; missing sources keep the existing error;
  missing-file error; malformed-file error without exposing file contents;
  legacy `ROOM_WALLETS_JSON` fallback; "Mainnet ignores the Testnet file-path
  source"; startup entry point builds the registry from the file-path source.
- `provisionRoomWallets.test.js` — CLI network parsing (legacy = testnet-only
  compatibility; explicit `testnet`/`mainnet`; unknown values rejected);
  mainnet identity shape and mainnet filenames; mainnet artifacts cannot
  share a Testnet output directory; mainnet runtime JSON accepted by
  `loadRoomWalletRuntimeConfig` with `TON_NETWORK=mainnet`; cross-network
  rejections (`network does not match TON_NETWORK`, `cannot mix network
  values`); no-overwrite protection; stdout summary never contains secret
  material; incomplete catalogs / unknown networks rejected.
- `roomWalletSecretHardening.test.js` — `ROOM_WALLETS_JSON` classified as a
  secret; redaction does not leak catalog content; valid configuration
  accepted; malformed JSON / missing fields rejected; `validateSecrets`
  intake gating (legacy variable name); cross-network rejection
  (`network does not match TON_NETWORK`, `cannot mix network values`,
  `workchain must be 0`).
- `roomNumberWalletMapping.test.js` — authoritative room-number resolution
  and room number ↔ wallet address mapping (`resolveIntendedRoomWalletAddress`
  uses `roomNumber`, never `Number(roomId)`; distinct wallet per room).
- `roomWalletIncomingObserver.test.js` — intended Room Wallet destination
  resolution; observer behavior.
- `roomWalletAppComposition.test.js` — intake / settlement / residual-sweep
  flag independence and settlement-router composition.
- `roomWalletRegistryRegisterIdentity.r18s89.test.js`, `roomWalletService.test.js`,
  `roomWalletAdapter.signingBuffer.r18s85.test.js` — registry identity
  registration, service composition, adapter signing buffer.
- `paymentSessionRoomNetwork.test.js` (Stage 2, untracked) — TESTNET/MAINNET
  propagation into `PaymentSession.network`, `TON_NETWORK` non-override,
  fail-closed when the room network is unavailable.
- Room-Wallet refund/settlement suites (network-scoped behavior exercised on
  Testnet fixtures): `restoreRoomWalletRefund.test.js`,
  `setupExpiryRoomWalletRefund.test.js`, `creatorLeftRoomWalletRefund.test.js`,
  `roomWalletSettlement*.test.js`, `roomWalletSettlementAdapter.test.js`,
  `roomWalletSettlementPlan.test.js`, `roomWalletSettlementRouter.test.js`,
  `roomWalletTerminalSettlementRecovery.r18s82.test.js`,
  `roomWalletResidualSweep.test.js`, `roomWalletOnlyPlayerPayment.r18s72.test.js`,
  `roomWalletFinancialPolicy.test.js`, `roomWalletGameReadiness.test.js`,
  `socketDisconnect.roomWalletDiagnostics.test.js`.

## 10. Security Confirmation

No private keys, `secretKey` values, public keys, mnemonics, seed phrases,
secret environment values or full credential objects are contained in this
report. Only counts, field names, indexes, schema names, file paths, file
sizes and 4–8-character address prefixes/suffixes are quoted. Wallet
addresses were deliberately masked even though they are public configuration
data. `owner-mnemonic.txt` in the offline mainnet directory was never opened
or read. `server/.env` was processed key-NAME-only (values never printed,
never parsed into the report). Master backup JSON files were never read
(only file sizes recorded). The loader validation scripts printed only
structural summaries and error messages (which contain variable names and
room numbers, never key material). No catalog, `.env`, test, source,
deployment or package file was modified; no wallets were generated; nothing
was committed, pushed or deployed.

## 11. Ownership Boundaries

- `RoomWalletRuntimeResolver` is the single owner of Room Wallet catalog
  resolution (source precedence, parsing, validation, network keying).
- `RoomWalletRegistry` owns the roomNumber → address registry (no secrets).
- `RoomWalletIncomingObserver` owns incoming-payment detection and the
  intended-destination lookup by room number.
- `PaymentSessionManager` owns payment-session creation/destination binding
  and the payment-network mismatch guard.
- `provisionRoomWallets.*` owns offline identity generation (both networks),
  outside the application runtime.
- `validateSecrets` / `validateEnvironment` / `environmentSchema` /
  `secrets.js` own configuration validation and secret classification.
- No parallel or replacement implementations were created in this stage.

## 12. Risks

- Critical: none found in the current Testnet deployment path.
- High (forward-looking, the exact gap for the next stage): a room
  authoritative `session.network === "mainnet"` running on a process whose
  registry was built from `TON_NETWORK=testnet` would resolve its payment
  destination from the TESTNET catalog (global single-catalog selection).
  Currently unreachable in production (the process network is testnet and
  MAINNET rooms are handled by the separate handoff flow), but it becomes
  reachable the moment MAINNET rooms are paid inside the same application.
- Medium: `validateSecrets` Room Wallet intake gate still keyed on the legacy
  `ROOM_WALLETS_JSON` variable (dormant unless
  `ROOM_WALLET_PAYMENT_INTAKE_MODE=ROOM_WALLET` is set; the split variables
  are unknown to it).
- Low: `.env.example` does not document the split variables; local `.env`
  contains a duplicate `TON_NETWORK` key; root `.gitignore` covers
  `*room-wallets-testnet*.json` and `*ROOM_WALLETS_JSON.json` but not the
  literal name `room-wallets-mainnet-master-backup.json` (mitigated: the
  provisioner refuses to write inside the repository at all).
- Note: Stage 2's remaining limitation stands — `_roomNetworkByRoom` is
  in-memory; recovered rooms have no committed network and fail closed at
  session creation until room-network durability lands.

## 13. Exact Conclusion

1. Does a Mainnet Room Wallet catalog already exist? YES — locally, outside
   the repository:
   `C:\Users\DAAT\WheelWin-offline-secrets\2026-09-09-room-wallets-mainnet\`
   (runtime JSON + master backup, 64/64 wallets, `roomNumber` 1..64,
   `network: "mainnet"`). It does NOT exist inside the repository (by design,
   ignored artifact category). Deployment-side `ROOM_WALLETS_MAINNET_JSON`
   presence (e.g. on a Mainnet Railway service) cannot be inspected from this
   workstation and is unknown to this report.
2. Is its schema compatible with Testnet? YES — structurally identical (same
   six fields, same 64-count and roomNumber 1..64 mapping; only the
   `network` tag differs: `"mainnet"` vs `"testnet"`). The unmodified
   production loader accepts the Mainnet catalog under `TON_NETWORK=mainnet`
   and rejects cross-network usage in both directions (empirically verified
   against the real files, read-only).
3. What must be created or changed in the next implementation stage?
   - CREATE: nothing material — no new catalog, no wallets, no schema
     migration. The only expected operator supply is the deployment-side
     `ROOM_WALLETS_MAINNET_JSON` value on the Mainnet runtime; the catalog
     content already exists offline.
   - CHANGE (implementation stage, requires approval): per-network wallet
     catalog selection. Today exactly one catalog per process is selected
     globally by `TON_NETWORK` (`app.js:1652` → single `RoomWalletRegistry`
     shared by observer, session manager and residual-sweep worker). The next
     stage must make Room-Wallet address resolution, incoming-payment
     observation and signing-identity resolution honor the room-authoritative
     `PaymentSession.network` / room network (Stage 2 output) — i.e. hold
     BOTH catalogs keyed by network instead of a single `TON_NETWORK`-selected
     registry — while preserving current single-network (Testnet) behavior
     byte-for-byte.
   - ALIGN (low risk, separate small stage): migrate `validateSecrets.js`'s
     Room Wallet intake gate from the legacy `ROOM_WALLETS_JSON` variable to
     the network-split variables (currently dormant;
     `roomWalletSecretHardening.test.js` pins the legacy behavior and would
     need updating in that same stage), and document
     `ROOM_WALLETS_TESTNET_JSON` / `ROOM_WALLETS_MAINNET_JSON` /
     `ROOM_WALLETS_TESTNET_JSON_PATH` in `.env.example`.
   - DO NOT (per task constraints): restore GameEscrow / DepositContract /
     DepositPackage / smart-contract payment flow, or the separate Mainnet
     application handoff, as the payment path.

## 14. Changes Made

No application source, test, JSON catalog, `.env`, deployment or package
files were modified. Exactly one file was created: this report. A temporary
inspection helper under the user TEMP directory (outside the repository) was
used for the read-only loader verification and was deleted afterwards. Git
working tree otherwise unchanged; nothing staged, committed or pushed.






