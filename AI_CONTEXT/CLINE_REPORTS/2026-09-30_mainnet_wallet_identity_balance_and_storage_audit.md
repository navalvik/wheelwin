# Mainnet Wallet Identity, Balance and Storage Audit (READ-ONLY)

Date: 2026-09-30 (balance/RPC queries executed 2026-09-29T21:40–21:48Z UTC)

Task: READ-ONLY Mainnet wallet identity and balance audit of the CURRENT deployed
WheelWin source at commit `810372b060b4e1cfcd4178e8c1fc62947c696a36`
(branch `payment/room-wallet-integration`; working tree clean of tracked changes at audit time).
No source code, Railway/Vercel configuration, environment variables, wallet catalogs or
deployment settings were modified. No wallets were generated. No wallet keys or mnemonics
were regenerated. No blockchain transaction was sent. No private key, secretKey, mnemonic,
seed, API key, password, password hash, JWT secret or complete secret catalog contents were
reproduced by this report. Public addresses and on-chain balances are reported.

Numbering note: operator questions are answered as items 1–8 (matching the eight numbered
audit instructions). Items 9 and 10 are the mandated read-only attestation and evidence annex.

---

## ANSWER 1 — ROOM WALLET No.1

Catalog inspected (existing Mainnet catalog, outside the project directory, operator PC):

`C:\Users\DAAT\WheelWin-offline-secrets\2026-09-09-room-wallets-mainnet\room-wallets-mainnet-ROOM_WALLETS_JSON.json`

- File exists; top-level JSON **array**; parsed read-only via PowerShell `ConvertFrom-Json`.
- Entry schema (field names only): `roomNumber`, `address`, `publicKey`, `secretKey`, `workchain`, `network`.
  Both key-material fields were redacted at parse time and are NOT reported.
- **roomNumber = 1 is present.**
- Reported public fields for roomNumber=1:
  - roomNumber: `1`
  - **public address: `EQAh7qNgZDv2F3p13B_5BTk5CiqQxrRn1TluPfq3A4vOJpOS`**
    (raw: `0:21eea360643bf6177a75dc1ff90539390a2a90c6b467d5396e3dfab7038bce26`)
  - workchain: `0`
  - network: `mainnet`
- **Wallet contract type**: the catalog carries no explicit contract-type field. The code-enforced
  identity is **WalletContractV4 (R2 revision)**:
  - `server/payment/roomWallet/RoomWalletRuntimeResolver.js` derives `WalletContractV4.create({ workchain: 0, publicKey })` and fails closed unless the catalog `address` equals the derived V4 address for that key;
  - `server/scripts/lib/provisionRoomWallets.js` pins `ROOM_WALLET_CONTRACT_TYPE = "WalletContractV4R2"` (same derivation as the runtime resolver).
  - On-chain, toncenter `getWalletInformation` returns an **empty `wallet_type`** because the account is currently **uninitialized** (no code, no balance); the V4R2 identity is enforced by the loader's offline derivation checks, not by on-chain code.
- **CURRENT Mainnet balance of Room Wallet No.1 (READ-ONLY query):**
  - `getAddressInformation` → `balance = 0` nanoTON = **0 TON**, account state `uninit` (uninitialized)
  - Observed at **2026-09-29T21:47:23Z** (consistent with the 2026-09-29T21:40:19Z raw probe)
  - RPC source: **toncenter.com** Mainnet v2 API (`https://toncenter.com/api/v2/...`), read-only.

## ANSWER 2 — ACTIVE OWNER WALLET

Active Room-Wallet settlement path (current code):

`WINNER_DETERMINED` → `ContractSettlementManager` (Room-Wallet active branch,
`server/payment/ContractSettlementManager.js:2360-2426`) builds the settlement handoff with
`ownerWallet` taken from **`this._ownerConfiguration.getOwnerWallet()`**
(`ContractSettlementManager.js:2399` and fallback re-resolution at `:2571-2572`) →
`RoomWalletSettlementRouter` → `RoomWalletSettlementAdapter.settleContract`
(`server/payment/roomWallet/RoomWalletSettlementAdapter.js:425-563`), which sends the owner
payout **from Room Wallet N** to `request.ownerWallet`.

OwnerConfiguration resolution (`server/config/OwnerConfiguration.js:30-31,46-141`):
**Priority: `OWNER_WALLET` env → `<repo>/config/owner.json`.** No other module may read the file.

Evidence about the two sources on this workstation:

- `config/owner.json` (repo root, local file) contains `ownerWallet: 0QBaklBYMdMsuq7a2eTYhMkz1OF7ZSHaO1mnFd1MZd3YjC5t`
  (raw `0:5a92505831d32cbaaedad9e4d884c933d4e17b6521da3b59a715dd4c65ddd88c`; bounceable form
  `EQBaklBYMdMsuq7a2eTYhMkz1OF7ZSHaO1mnFd1MZd3YjMgi`).
  **This file is gitignored (`.gitignore:11`) and is NOT part of the deployed tree**, so it cannot be
  the Mainnet runtime's owner source unless manually injected into the container (no evidence of that).
- Local `server/.env` (workstation Testnet runtime) contains **no `OWNER_WALLET`** key.
- Therefore the **deployed Mainnet runtime resolves the ACTIVE GAME owner from the
  `OWNER_WALLET` environment variable** (Railway-side; exact value not readable from this
  workstation). The live Mainnet service is running with MAINNET app environment (Answers 7/8)
  and `OwnerConfiguration.load()` is fatal when neither source exists → owner resolution
  succeeded at startup; an owner identity IS configured on the Mainnet runtime.

- **ACTIVE_GAME_OWNER_ADDRESS**: resolved on the Mainnet runtime from `OWNER_WALLET` (Railway env).
  Direct value: **UNKNOWN from this workstation** (Railway-only). The **operator-confirmed Mainnet
  owner identity embedded in the CURRENT source**
  (`server/tests/walletBalanceMonitor.networkSplit.r18s104.test.js:22-25`, comment
  "r18-s104 — Operator-confirmed Mainnet identities (public addresses only)") is:
  **`EQC_xk04sMe07ttDQHq0ZIFxDAiYJChQ8IzgLgxEXlYmsDuc`**
  (raw `0:bfc64d38b0c7b4eedb43407ab46481710c0898242850f08ce02e0c445e5626b0`).
- **MAINNET_MONITOR_OWNER_PIN** (`WalletBalanceMonitor._resolveMainnetOwnerAddress`,
  `MAINNET_ONLY_ENV_KEYS.OWNER_WALLET = "TON_MAINNET_OWNER_WALLET"`,
  `server/console/wallet/WalletBalanceMonitor.js:52-55,475-486`; code comment there:
  "Mainnet Owner pin: TON_MAINNET_OWNER_WALLET only. OwnerConfiguration / OWNER_WALLET belong to
  the application network and are never reused here."): value lives on Railway; the current-source
  operator-confirmed fixture value is the same
  **`EQC_xk04sMe07ttDQHq0ZIFxDAiYJChQ8IzgLgxEXlYmsDuc`**.
- **Same TON account?** The only two distinct candidate owner addresses found on this workstation
  are **different accounts**:
  - `EQC_xk04sMe07ttDQHq0ZIFxDAiYJChQ8IzgLgxEXlYmsDuc` (raw `0:bfc6…26b0`) — operator-confirmed Mainnet owner identity (current source), live balance **1 TON**.
  - `EQBakl…` / `0QBakl…` (raw `0:5a92…d88c`) — local `config/owner.json` (Testnet-era owner, gitignored, not deployed), live mainnet balance **0 TON**.
  Whether Railway `OWNER_WALLET` equals the monitor pin is **NOT DIRECTLY VERIFIABLE from this
  workstation**; if `OWNER_WALLET` holds the operator-confirmed `EQC_xk04…Duc` identity (as the
  current-source fixture attests), then ACTIVE GAME owner and the Mainnet monitor pin are the **same account**.
- **CURRENT Mainnet balances (READ-ONLY, toncenter.com):**
  - `EQC_xk04sMe07ttDQHq0ZIFxDAiYJChQ8IzgLgxEXlYmsDuc` → `1000000000` nanoTON = **1 TON** @ 2026-09-29T21:47:28Z
  - `0QBaklBYMdMsuq7a2eTYhMkz1OF7ZSHaO1mnFd1MZd3YjC5t` (config/owner.json candidate) → **0 TON** @ 2026-09-29T21:47:26Z

## ANSWER 3 — ACTIVE RESIDUES WALLET

Active residual sweep path (current code):
`RoomWalletResidualSweepWorker` (`server/payment/roomWallet/RoomWalletResidualSweepWorker.js:395,629`)
→ `resolveResiduesWalletDestination(env)` (`server/payment/roomWallet/ResiduesWalletConfig.js:98-167`):
- `TON_RESIDUES_EXPECTED_ADDRESS` preferred; **fallback `TON_REIMBURSEMENT_EXPECTED_ADDRESS`** (compat, same-identity policy);
- dual pins that disagree → `RESIDUES_ADDRESS_CONFLICT` (fail-closed, no send); missing → `RESIDUES_DESTINATION_MISSING` (fail-closed);
- the send itself is additionally gated by `ROOM_WALLET_RESIDUAL_SWEEP_ENABLED` (default **OFF**, `roomWalletConfig.js:52-57`);
- sweep source is always the Room Wallet; `assertSweepSourceDiffersFromDestination` blocks self-sweep.

- **ACTIVE_RESIDUES_ADDRESS** (Mainnet runtime): resolved from Railway env `TON_RESIDUES_EXPECTED_ADDRESS`
  (fallback `TON_REIMBURSEMENT_EXPECTED_ADDRESS`) — exact Railway value not readable from this workstation.
  Current-source evidence (`r18-s104` operator-confirmed fixture) and the workstation runtime config
  (`server/.env`) both pin the **same physical wallet identity**:
  **`EQD-ylhSs7YLUJpZymRiiX2HnovASnwS9LbhK9OidoveBZJE`**
  (raw `0:feca5852b3b60b509a59ca6462897d879e8bc04a7c12f4b6e12bd3a2768bde05`).
- **MAINNET_MONITOR_RESIDUES_PIN** (`WalletBalanceMonitor._resolveMainnetResiduesAddress`,
  `MAINNET_ONLY_ENV_KEYS.RESIDUES_WALLET = "TON_MAINNET_RESIDUES_EXPECTED_ADDRESS"`,
  `WalletBalanceMonitor.js:503-515`; code comment: "Mainnet Residues pin … application-network
  Residues resolution is never reused for Mainnet."): Railway value; the current-source
  operator-confirmed fixture value is the same
  **`EQD-ylhSs7YLUJpZymRiiX2HnovASnwS9LbhK9OidoveBZJE`**.
- **Same TON account?** **YES** — every evidence source available (r18-s104 Mainnet fixture, local
  `TON_RESIDUES_EXPECTED_ADDRESS`, local `TON_REIMBURSEMENT_EXPECTED_ADDRESS`) canonicalizes to the
  same raw account `0:feca5852…bde05` (TON addresses are network-agnostic; the same physical
  WalletContractV4R2 identity serves as the Residues wallet on both networks).
- **CURRENT Mainnet balance (READ-ONLY, toncenter.com):** **0 TON** (`balance = 0` nanoTON)
  @ 2026-09-29T21:47:30Z. (The monitor-pin address is the same account → no second query needed.)

## ANSWER 4 — DEPLOYMENT WALLET PARTICIPATION

Active Mainnet Room-Wallet game path (current code):

- Player stake intake: `PaymentSessionManager` (Room-Wallet intake enabled;
  `roomWalletConfig.js:28-34` — Room Wallet is the only player-payment intake) → Room Wallet N.
- Settlement: `ContractSettlementManager` Room-Wallet branch (`contractAddress: null`,
  `ContractSettlementManager.js:2407-2424`) → `RoomWalletSettlementAdapter.settleContract`
  sends **winner payout** and **owner payout** from Room Wallet N. The adapter's required
  handoff fields are exactly `roomNumber, winnerWallet, ownerWallet, winnerAmount, organizerAmount`
  (`RoomWalletSettlementAdapter.js:47-49,425-444`) — **no Deployment Wallet field exists**.
- Refund: `RoomWalletSettlementAdapter.refundPayments` broadcasts from Room Wallet N (Answer 6).
- Residual sweep: Room Wallet N → Residues address (Answer 3).

Searched usages of the Deployment Wallet identity in the CURRENT tree:
- `WalletBalanceMonitor` — read-only **monitoring identity only** (app-network
  `deployerExpectedAddress` resolution and Mainnet pin `TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS`
  via `loadMainnetTonProfile`, `WalletBalanceMonitor.js:488-501`).
- Legacy retired GameEscrow/DepositContract deploy pipeline (`TonGameContractAdapter`,
  `GameContractManager._deployAdapter`, deploy diagnostics) — **not active**: player finance is
  Room-Wallet-only on both networks (`isRoomWalletOnlyFinancialPath()` returns `true`
  unconditionally, `roomWalletConfig.js:40-47`), and Mainnet blockchain deploy is skipped.
- Forensic archive / observability fields (historical records only).

**Precise answer: NO — the Deployment Wallet does NOT participate in ACTIVE Mainnet game finance.**
It is never the source or recipient of player stake, player refund, winner payout, owner payout,
or residual sweep.

**Exact role it still has in current code:** resolved for identity and observed READ-ONLY
(`WalletBalanceMonitor` `DEPLOYMENT_WALLET` entry, mainnet pin `TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS`,
operator-confirmed fixture value `EQBry-bfWJTLfPBHmft1_Rtt-WUvQhI4tpf2aX96G-FYKe5a`,
raw `0:6bcbe6df5894cb7cf04799fb75fd1b6df9652f421238b697f6697f7a1be15829`), plus residual references
inside the retired legacy GameEscrow deploy path and forensic/observability records.

- CURRENT Mainnet balance of the Deployment Wallet identity (READ-ONLY, toncenter.com):
  **0 TON** @ 2026-09-29T21:47:32Z.

## ANSWER 5 — GAME ARCHIVE DESTINATION

Current forensic archive code (`server/forensic/`, wired in `server/app.js:2230-2261`):

- **Storage backend**: **Cloudflare R2, private bucket**, via the S3-compatible API
  (`@aws-sdk/client-s3` `S3Client`, `PutObjectCommand`/`HeadObjectCommand`;
  `server/forensic/R2ForensicArchiveUploader.js`). The GCS uploader
  (`GcsForensicArchiveUploader.js`) exists as legacy residue; `app.js` instantiates the
  **R2 uploader unconditionally** (`app.js:2233-2241`).
- **Bucket name**: resolved from `R2_BUCKET_NAME` || `WHEELWIN_R2_BUCKET_NAME`
  (`server/forensic/forensicArchiveConfig.js:12-16`). The actual bucket value on the Mainnet
  runtime is Railway-side → **UNKNOWN / NOT VERIFIABLE from this workstation**.
- **Prefix**: `R2_FORENSIC_PREFIX` || `GCS_FORENSIC_PREFIX` || default **`forensic-archives`**
  (`forensicArchiveConfig.js:60-64`); code joins prefix with `/` to the object name
  (`R2ForensicArchiveUploader.js:85-87`).
- **Archive object naming pattern**
  (`server/forensic/forensicArchiveNaming.js:130-154`, `buildForensicArchiveFilename`):
  `<prefix>/YYYY-MM-DD_ROOM_<roomId>_GAME_<gameId|NO_GAME>_<RESULT>.zip`
  where `RESULT ∈ { COMPLETED, ROOM_DESTROYED, FAILED }` (derived from session-history
  `lifecycleResult` or close `reason`).
- **Public URLs**: **NOT generated.** Explicit code contract at
  `R2ForensicArchiveUploader.js:4-6`: "Upload forensic ZIP archives to a **private** Cloudflare
  R2 bucket via the S3-compatible API. **No public URLs are generated.**" No presigned/public
  URL code path exists; objects upload with `CacheControl: private, max-age=0, no-transform`.
- **Is the current Mainnet runtime configured for Cloudflare R2 archival?**
  - Code: R2 archival is the only wired backend and is enabled by default
    (`FORENSIC_ARCHIVE_ENABLED` default `true`); it becomes **blocking** (`required`) only when
    the R2 credential set is fully configured (`forensicArchiveConfig.js:23-37`).
  - Runtime: whether `R2_BUCKET_NAME` / `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` /
    `R2_SECRET_ACCESS_KEY` / `R2_ENDPOINT` are set on the Mainnet Railway service **cannot be
    verified from this workstation** (Railway-only). The startup log line
    `R2_FORENSIC_ARCHIVE_ENABLED | configured=<bool> | required=<bool> | bucket=set|unset`
    (`app.js:2257-2261`) is the authoritative indicator but Railway logs are not accessible here.
  - **Conclusion: R2 is the archival destination in code (YES, code-level, always wired);
    runtime credential presence on the Mainnet service = UNKNOWN (not verifiable here).**
  - Local staging is disk-based: `FORENSIC_ARCHIVE_STAGING_DIR` (default `data/archive-staging`),
    session history `SESSION_HISTORY_DIR` (default `data/session-history`); no credentials reported.

## ANSWER 6 — FAILED-GAME REFUND VERIFICATION CHAIN

Full CURRENT refund path (all code-level; the Mainnet runtime uses the application-network
TonService bound to mainnet):

1. **Entry**: `PaymentSessionManager._requestRoomWalletPartialPaymentRefund`
   (`server/gameplay/PaymentSessionManager.js:1943,2001`) — fail-closed try/catch; consumes only
   `refund.ok` / `refund.txHash` → `RoomWalletSettlementRouter.refundPayments`
   (`server/payment/RoomWalletSettlementRouter.js:61-73`) →
   **`RoomWalletSettlementAdapter.refundPayments`** (`RoomWalletSettlementAdapter.js:121-280`).
2. **Existing Room Wallet outbound history inspection (idempotency)**:
   `_findExistingRefund` (`:286-361`) reads `getTransactions(roomNumber, { limit: 40, archival: true })`
   and `extractOutboundTransfers` (`roomWalletTerminalRecoveryChain.js`), matching: success,
   not bounced, exact `amountNano`, destination equal via fail-closed `tonWalletAccountsEqual`,
   `utime` after the ms→s-normalized cutoff → `REFUND_ADOPTED` (no second broadcast).
3. **Player-wallet inbound reconciliation fallback**: only when no outbound match AND
   `getAddressTransactions` exists: authoritative Room Wallet address via `getWalletAddress(roomNumber)`
   (null → skip), then `getAddressTransactions(playerWallet, { limit: 40, archival: true })` +
   `extractInbound`; accepted only when success ∧ not bounced ∧ exact amount ∧ source == Room Wallet
   address ∧ after cutoff → `REFUND_RECONCILED_FROM_PLAYER_WALLET` (read-only adoption, never a
   second broadcast) (`RoomWalletSettlementAdapter.js:323-358`).
4. **Refund broadcast from the Room Wallet**: `roomWalletAdapter.sendTransfer({ roomNumber,
   destination, amountNano, queryId })` (signed WalletContractV4R2 transfer). Missing txHash →
   `REFUND_UNCERTAIN_BROADCAST` (retryable, fail-closed) (`:200-248`).
5. **On-chain confirmation**: `confirmPayoutOnChain({ tonService: inspectTransport,
   roomWalletAddress, expectedHash, destination, amountNano, timeoutMs })` re-inspects the Room
   Wallet's on-chain history for the exact outbound transfer; failure → `REFUND_NOT_CONFIRMED`
   (retryable) (`:250-257`).
6. **Persistence / reconciliation**: `PaymentSessionManager` persists the refunded state only from
   `result.ok` / `result.txHash` (REFUND_PENDING lifecycle; reconciliation provenance per the
   2026-09-29 Stage 2 report).

- **Exact RPC/API source for blockchain inspection in the ACTIVE Mainnet runtime:**
  `RoomWalletAdapter` → `TonService` (`server/services/TonService.js`) → `TonCenterTransport`
  (`server/payment/ton/TonCenterTransport.js`) → **TON Center JSON-RPC v2**
  (`https://toncenter.com/api/v2/jsonRPC` mainnet default, `TonService.js:32-35`; endpoint
  overridable via network profile / `TON_ENDPOINT`; authenticated with the `X-API-Key` header from
  `TON_API_KEY` when configured, `TonCenterTransport.js:79-82`). Read-only methods used:
  `getBalance`, `getTransactions` (with `archival: true`), `getSeqno`.
- **TON Explorer search over the CURRENT source tree** (repo-wide, incl. client):
  - `tonviewer` → only `server/payment/ton/networks/mainnet.js:9`
    (`explorerBaseUrl: "https://tonviewer.com"`) and `server/payment/ton/networks/testnet.js:9`
    (`https://testnet.tonviewer.com`). Both files are "R7.66A — TON network presets
    (abstraction only; not wired into V4 deploy)".
  - `explorerBaseUrl` → **zero consumers** anywhere in the tree (the only hits are the two
    preset definitions themselves).
  - `tonscan` / `tonscan.org` → **no hits**. A "TON Explorer" feature → no hits.
  - Explorer URL generation → **none**.
- **Conclusion: Ton Explorer is NOT part of the AUTOMATED refund verification chain.** The chain
  verifies exclusively through toncenter RPC reads. (An operator manually opening tonviewer/tonscan
  would be a human action outside this code path; no code generates explorer URLs.)

## ANSWER 7 — MAINNET /debug

- **Registration path (CURRENT production code)**: all legacy JSON debug endpoints are registered
  inside `if (this._eventBusConfig.showDebugPanel) { … }` in `server/app.js`
  (`/debug/health`, `/debug/metrics`, `/debug/event-bus`, `/debug/games`, `/debug/rooms`,
  `/debug/players`, `/debug/catalog`, `/debug/random`, `/debug/configuration/:gameId`,
  `/debug/game-state/:gameId`, `/debug/game-clock/:gameId`, `/debug/physics/:gameId`,
  `/debug/input/:gameId/:playerId`, `/debug/result/:gameId`, `/debug/payment/:gameId`,
  `/debug/recovery/:gameId`, `/debug/audit/:gameId` — current-tree block starts at `app.js:5531`).
- **Gate**: `server/config/events.js:5,15` → `showDebugPanel = isDevelopment` where
  `isDevelopment = (nodeEnv === "development")`. → **`/debug/*` is registered ONLY when
  `NODE_ENV=development`; it is NOT registered when `NODE_ENV=production`.**
  (The client SPA route `/debug` → `PageDeveloperConsole` is a separate frontend page that calls
  authenticated `/console/*` — it is not the legacy server `/debug/*` JSON API.)
- **LIVE Mainnet probes (read-only HTTP GET, 2026-09-29T21:47:34–37Z)** against the Mainnet backend
  hardwired in the current source (`client/src/config/backendUrl.js:34`,
  `MAINNET_BACKEND_URL = "https://positive-clarity-production-d1a1.up.railway.app"`):
  - `GET /health` → HTTP 200: `{"status":"ok","ready":true,"lifecycle":"RUNNING",
    "environment":"production", …}` → **Mainnet NODE_ENV/runtime mode = production**, live.
  - `GET /console/auth/status` → HTTP 200:
    `{"enabled":true,"openAccess":false,"environment":"MAINNET","appEnvironment":"MAINNET"}`
    → app environment **MAINNET** (per `server/console/environment/AppEnvironment.js:17-45`:
    explicit `APP_ENVIRONMENT`/`BLOCKCHAIN_NETWORK` wins, else derived from `TON_NETWORK`
    when `NODE_ENV≠development` → **TON_NETWORK is mainnet on this runtime**).
  - `GET /debug/health` → **HTTP 404**; `GET /debug/games` → **HTTP 404**.
  - (Cross-check on the Testnet production host `wheelwin-production.up.railway.app`:
    `/debug/health` → HTTP 404 at 21:47:37Z; its `/health` shows `environment:"production"`
    and `/console/auth/status` shows `appEnvironment:"TESTNET"` at 21:40:34–35Z — consistent
    isolation of the two runtimes.)
- **Does /debug exist on live Mainnet Production?** **NO** (direct 404 evidence on the Mainnet
  backend, plus the code gate).
- **Therefore there is NO Mainnet /debug password to reuse.** The legacy `/debug/*` endpoints are
  unauthenticated-by-design development-only endpoints; they do not exist in production and no
  password/credential is associated with them. Any credential previously used with `/debug/*`
  on a development runtime has no Mainnet production counterpart.
- **Developer Console authentication (separate mechanism, `/console/*`)**:
  - Code mechanism (`server/console/auth/`): `ADMIN_USERNAME` +
    `ADMIN_PASSWORD_HASH` — **scrypt password hash** (`adminPasswordHash.js`: format
    `scrypt:<salt>:<hash>`, N=16384, r=8, p=1, 64-byte key; `verifyAdminPassword`);
    legacy plain-password fallback (`DEVELOPER_AUTH_PASSWORD`) hashes `sha256(secret:password)`
    and only applies when no scrypt hash is set; session tokens are **HMAC-SHA256 signed JWT-style
    tokens keyed by `DEVELOPER_AUTH_SECRET`** (`jwtTokens.js:29-33`); `DEVELOPER_AUTH_ENABLED`
    explicitly `"false"` → open access, otherwise enabled when configured or `"true"`.
    Optional `VIEWER_USERNAME` / `VIEWER_PASSWORD_HASH` viewer role.
  - **Mainnet Developer Authentication: CONFIGURED and ACTIVE** — live
    `/console/auth/status` proves `enabled=true`, `openAccess=false` on the Mainnet backend.
    Which credential mechanism is used: username + scrypt password hash + HMAC-SHA256 secret-signed
    tokens. No password, hash, secret, token or username value was read or reported; Railway env
    values are not readable from this workstation.
  - **Testnet password == Mainnet password?** **UNKNOWN — no direct safe evidence** exists on this
    workstation (credential values were never read on either runtime). This report explicitly does
    NOT claim they are the same.

## ANSWER 8 — LIVE MAINNET CONSISTENCY CHECK

1. **TON_NETWORK is mainnet** — YES (live): Mainnet backend `/console/auth/status` returns
   `appEnvironment:"MAINNET"`, which per `AppEnvironment.js` is produced by an explicit
   `APP_ENVIRONMENT`/`BLOCKCHAIN_NETWORK` pin or by `TON_NETWORK=mainnet` under
   `NODE_ENV=production`. The direct env var value on Railway is not readable from this
   workstation; the live MAINNET app-environment label plus the Mainnet-only Room Wallet catalog
   requirement (`ROOM_WALLETS_MAINNET_JSON`, `RoomWalletRuntimeResolver.js:43-46`) evidence a
   mainnet runtime.
2. **Room Wallet catalog is exactly 64 entries** — YES: the operator-PC Mainnet runtime JSON
   parsed to **COUNT=64**.
3. **roomNumber 1 is present** — YES (entry with `roomNumber=1`, address
   `EQAh7qNgZDv2F3p13B_5BTk5CiqQxrRn1TluPfq3A4vOJpOS`, `network:"mainnet"`, workchain 0).
   Full catalog mapping verified: roomNumbers **1..64, 64 unique values, all `network:"mainnet"`**.
4. **Observed No.1 wallet is a mainnet WalletContractV4/R2 identity matching the catalog entry** —
   PARTIALLY CONFIRMED: the observed on-chain account address matches the catalog entry exactly
   (same raw hash `0:21eea360…8bce26`, workchain 0). The V4R2 contract identity is enforced
   offline by the loader (publicKey → WalletContractV4 → address equality, fail-closed). On-chain
   the account is currently **uninitialized** (no code, no balance), so an on-chain
   `wallet_type` value cannot be observed (toncenter returns an empty `wallet_type`).
5. **All blockchain balance queries were READ-ONLY** — YES: only toncenter v2
   `getAddressInformation` / `getWalletInformation` (balance/state reads) and unauthenticated
   HTTP GET probes (`/health`, `/console/auth/status`, `/debug/*`) were issued. No transaction
   was broadcast, no wallet was created or funded, no key material was read beyond the redacted
   field-presence check of the catalog, and no Railway/Vercel setting was touched.

## ANSWER 9 — AUDIT ATTESTATION (READ-ONLY)

- Source inspected: working tree at `g:\WheelWin`, HEAD = `810372b060b4e1cfcd4178e8c1fc62947c696a36`
  (verified via `git rev-parse HEAD`), branch `payment/room-wallet-integration`.
- No file inside the tracked source tree, config, `.env`, wallet catalog, Railway or Vercel
  configuration was modified, created or deleted by this audit.
- No wallets were generated; no mnemonic or key was regenerated; no blockchain transaction was sent.
- All secret-bearing values (catalog `publicKey`/`secretKey`, `.env` secret values, Railway
  variables, and the owner mnemonic file `owner-mnemonic.txt` in the offline-secrets directory —
  which was never opened) were excluded from this report.
- Scratch helpers created in the git-ignored `_audit_tmp/` directory (outside tracked source):
  `audit_queries.ps1`, `ton_balances.txt`, `mainnet_probe.txt`. Investigation scratch only
  (per the established `_audit_tmp` convention); not committed.

## ANSWER 10 — EVIDENCE

- **Source commit inspected**: `810372b060b4e1cfcd4178e8c1fc62947c696a36`
  (`payment/room-wallet-integration`).
- **Mainnet RPC endpoint hostname**: `toncenter.com` (read-only v2 REST/JSON-RPC only).
- **Balance query log (all SUCCESS unless noted; source: toncenter.com v2, read-only)**:
  - `EQAh7qNgZDv2F3p13B_5BTk5CiqQxrRn1TluPfq3A4vOJpOS` (Room Wallet №1) — 2026-09-29T21:47:23Z —
    SUCCESS — balance 0 nanoTON = **0 TON** (state uninit); raw probe 21:40:19Z consistent.
  - `EQAh7qNgZDv2F3p13B_5BTk5CiqQxrRn1TluPfq3A4vOJpOS` — 2026-09-29T21:47:34Z — SUCCESS —
    `getWalletInformation`: wallet_type empty (uninitialized), balance 0.
  - `0QBaklBYMdMsuq7a2eTYhMkz1OF7ZSHaO1mnFd1MZd3YjC5t` — 2026-09-29T21:47:26Z — SUCCESS — **0 TON**.
  - `EQC_xk04sMe07ttDQHq0ZIFxDAiYJChQ8IzgLgxEXlYmsDuc` — 2026-09-29T21:47:28Z — SUCCESS —
    1000000000 nanoTON = **1 TON**.
  - `EQD-ylhSs7YLUJpZymRiiX2HnovASnwS9LbhK9OidoveBZJE` — 2026-09-29T21:47:30Z — SUCCESS — **0 TON**.
  - `EQBry-bfWJTLfPBHmft1_Rtt-WUvQhI4tpf2aX96G-FYKe5a` — 2026-09-29T21:47:32Z — SUCCESS — **0 TON**.
  - Earlier attempt 2026-09-29T21:40:19Z (jsonRPC POST) — FAILURE (HTTP 422, tooling encoding
    issue; superseded by the successful REST reads above; no state affected).
- **Live runtime probes (read-only HTTP GET)**:
  - `positive-clarity-production-d1a1.up.railway.app/health` — 2026-09-29T21:47:34Z — HTTP 200 —
    `environment:"production"`, RUNNING.
  - `…/console/auth/status` — 2026-09-29T21:47:35Z — HTTP 200 — `enabled:true, openAccess:false,
    appEnvironment:"MAINNET"`.
  - `…/debug/health` — 2026-09-29T21:47:36Z — **HTTP 404**; `…/debug/games` — 21:47:36Z — **HTTP 404**.
  - `wheelwin-production.up.railway.app/health` — 2026-09-29T21:40:34Z — HTTP 200 (`production`;
    `appEnvironment:"TESTNET"` at 21:40:35Z); `/debug/health` — 2026-09-29T21:47:37Z — HTTP 404.
- **Offline catalog inspection** (names/public fields only): 2026-09-29 — count=64, rooms 1..64
  unique, all `network:"mainnet"`; room 1 public fields as reported in Answer 1.

---

## Files Inspected

Context (per `.clinerules` pre-analysis rule): `AI_CONTEXT/WHEELWIN_MASTER_CONTEXT.md`,
`AI_CONTEXT/ARCHITECTURE_RULES.md`, `AI_CONTEXT/CURRENT_STATE.md`, `AI_CONTEXT/AI_WORKING_RULES.md`,
and recent reports `2026-09-29_mainnet_local_sync_baseline_audit.md`,
`2026-09-29_mainnet_room_wallet_readiness_decoupling.md`,
`2026-09-29_room_wallet_refund_player_wallet_reconciliation.md`,
`2026-09-28_stage3_room_wallet_catalog_inventory.md`.

Source/config inspected: see the full list in Answer 10. Operator-PC artifacts:
`C:\Users\DAAT\WheelWin-offline-secrets\2026-09-09-room-wallets-mainnet\` (directory names +
runtime-JSON public fields only; `owner-mnemonic.txt` never opened; master backup not read).

## Architecture Findings

- Player finance is **Room-Wallet-only** on both networks
  (`isRoomWalletOnlyFinancialPath()` → `true` unconditionally); the retired GameEscrow/
  DepositContract path is not a fallback. `ContractSettlementManager` composes the Room-Wallet
  settlement handoff (`ownerWallet` from `OwnerConfiguration`); `RoomWalletSettlementAdapter`
  executes winner/owner payouts and refunds from Room Wallet N.
- `WalletBalanceMonitor` maintains a strict Testnet/Mainnet split: application-network owner
  resolution (OwnerConfiguration / env) vs Mainnet-only pins
  (`TON_MAINNET_OWNER_WALLET`, `TON_MAINNET_RESIDUES_EXPECTED_ADDRESS`,
  `TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS`) — monitoring only, never financially authoritative.
- Developer Console auth (`/console/*`) is fully separated from the legacy `/debug/*` dev JSON
  endpoints; `/debug/*` exists only under `NODE_ENV=development`.
- Forensic archiving: disk staging (session-history / archive-staging) → ZIP → private
  Cloudflare R2 (the only wired uploader), no public URLs.

## Lifecycle Flow

`WINNER_DETERMINED` → settlement handoff (owner/winner wallets + amounts) → adapter chain-inspect
(reuse/duplicate-payout safety) → preflight balance check → winner payout → owner payout (Room
Wallet N signs both) → on-chain confirmation → persistence. Failure/timeout paths:
`failSession` → `_requestRoomWalletPartialPaymentRefund` → `refundPayments`
(outbound-history idempotency → player-wallet inbound reconciliation → broadcast → on-chain
confirm → persistence). Independent worker: residual sweep (Room Wallet N → Residues pin,
default OFF). On room destruction: session history archived to disk; forensic ZIP uploaded to
private R2 (blocking only when required+configured).

## Ownership Boundaries

- `OwnerConfiguration` — sole owner of the settlement owner identity (env → owner.json).
- `ResiduesWalletConfig` — sole owner of the Residues destination resolution.
- `RoomWalletRegistry` / `RoomWalletRuntimeResolver` — sole owners of Room Wallet identities
  (signing material never leaves the resolver; registry entries carry no secrets).
- `ContractSettlementManager` → `RoomWalletSettlementRouter` → `RoomWalletSettlementAdapter` —
  settlement execution. `WalletBalanceMonitor` — read-only balance/identity observability.
- `ForensicArchiveService` / `R2ForensicArchiveUploader` — archive ownership.

## Risks

- **Medium**: ACTIVE_GAME owner address on the Mainnet runtime is env-resolved (`OWNER_WALLET`,
  Railway-only) and not verifiable from this workstation. The two candidate identities found
  (`EQC_xk04…Duc`, 1 TON live, operator-confirmed in current source; vs `EQBakl…`/`0QBakl…`,
  0 TON live, gitignored local owner.json) are different accounts. Fail-closed startup protects
  against absence, but the operator should confirm the Railway value equals `EQC_xk04…Duc`.
- **Medium**: Room Wallet №1 currently holds **0 TON on mainnet** (uninitialized account). Any
  active game on room 1 would fail settlement/refund preflight
  (`INSUFFICIENT_ROOM_WALLET_BALANCE` / fail-closed retryable refunds) until the wallets are
  funded/deployed per the funding policy. Operational readiness gap, not a code defect.
- **Low**: Residues account mainnet balance 0 (sweep target empty; sweep gate default OFF) and
  Deployment Wallet mainnet balance 0 — monitoring will show zero until funded; no financial risk.
- **Low**: `explorerBaseUrl` (tonviewer) in the network presets is dead metadata (zero consumers) —
  no functional impact; cleanup would require approval.
- **Low**: Whether R2 credentials are set on the Mainnet Railway runtime is unverifiable here; if
  unset, archives remain disk-local and upload is silently skipped (`required=false` auto mode) —
  check the `R2_FORENSIC_ARCHIVE_ENABLED` startup log line.
- **Info**: `/debug` absent on both production runtimes (direct 404s); Developer Console auth
  enabled and closed on Mainnet.

## Recommendations

Do not implement automatically.

1. Operator: verify on Railway that `OWNER_WALLET` equals the operator-confirmed Mainnet owner
   `EQC_xk04sMe07ttDQHq0ZIFxDAiYJChQ8IzgLgxEXlYmsDuc` and matches `TON_MAINNET_OWNER_WALLET`
   (single-owner expectation) before enabling live games.
2. Operator: fund the 64 Mainnet Room Wallets (and confirm the funding/deploy policy) before
   enabling Mainnet room creation; Room Wallet №1 is currently 0 TON / uninitialized.
3. Operator: check the Mainnet startup log line `R2_FORENSIC_ARCHIVE_ENABLED | configured=… |
   bucket=set|unset` to confirm R2 archival is active on the Mainnet service.
4. Optional (separate approved stage): remove or deliberately wire `explorerBaseUrl` (e.g.
   operator-facing links only) — never as part of automated verification.
5. Keep `/debug/*` production-disabled; treat Developer Console credentials as the only production
   access path. Never assume Testnet and Mainnet console passwords are identical.

## Changes Made

- Created exactly ONE report file:
  `AI_CONTEXT/CLINE_REPORTS/2026-09-30_mainnet_wallet_identity_balance_and_storage_audit.md` (this file).
- Git-ignored scratch helpers in `_audit_tmp/` (`audit_queries.ps1`, `ton_balances.txt`,
  `mainnet_probe.txt`) — investigation scratch only, never committed.
- **No source code, configuration, dependency, `.env`, wallet catalog, Railway/Vercel or
  deployment element was modified. Nothing was committed or pushed. No wallets were generated.
  No blockchain transaction was sent.**







